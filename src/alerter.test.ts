import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { D1Database, D1Result, D1PreparedStatement } from '@cloudflare/workers-types';
import {
  evaluateThresholds,
  postAlert,
  runAlerterTick,
  DEFAULT_THRESHOLDS,
  type AlerterConfig,
  type AlertPayload,
} from './alerter';
import { createBankAccount, insertParseLog, writeEvent } from './db';

// ---- D1 facade over better-sqlite3 ----

function wrapAsD1(sqlite: Database.Database): D1Database {
  function prepare(sql: string): D1PreparedStatement {
    let boundArgs: unknown[] = [];

    const stmt = {
      bind(...args: unknown[]): D1PreparedStatement {
        boundArgs = args.map(a => a === undefined ? null : a);
        return stmt;
      },

      async first<T = Record<string, unknown>>(): Promise<T | null> {
        const s = sqlite.prepare(sql);
        const row = s.get(...(boundArgs as Parameters<typeof s.get>)) as T | undefined;
        return row ?? null;
      },

      async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const s = sqlite.prepare(sql);
        const results = s.all(...(boundArgs as Parameters<typeof s.all>)) as T[];
        return {
          results,
          success: true,
          meta: { changes: 0, last_row_id: 0, duration: 0, size_after: 0, rows_read: results.length, rows_written: 0, changed_db: false },
        };
      },

      async run(): Promise<D1Result<Record<string, unknown>>> {
        const s = sqlite.prepare(sql);
        const info = s.run(...(boundArgs as Parameters<typeof s.run>));
        return {
          results: [],
          success: true,
          meta: {
            changes: info.changes,
            last_row_id: Number(info.lastInsertRowid),
            duration: 0,
            size_after: 0,
            rows_read: 0,
            rows_written: info.changes,
            changed_db: info.changes > 0,
          },
        };
      },
    } as unknown as D1PreparedStatement;

    return stmt;
  }

  return { prepare } as unknown as D1Database;
}

const MIGRATIONS = ['0001_schema.sql'];

function applyMigrations(sqlite: Database.Database): void {
  for (const m of MIGRATIONS) {
    const p = resolve(__dirname, '../migrations', m);
    sqlite.exec(readFileSync(p, 'utf8'));
  }
}

function makeTestDb(): D1Database {
  const sqlite = new Database(':memory:');
  applyMigrations(sqlite);
  return wrapAsD1(sqlite);
}

function makeTestDbWithSqlite(): { db: D1Database; sqlite: Database.Database } {
  const sqlite = new Database(':memory:');
  applyMigrations(sqlite);
  return { db: wrapAsD1(sqlite), sqlite };
}

// Seed enough unmatched parse-log rows to breach unmatched_24h (and, with no
// successful tx events, parse_failure_rate_24h too).
async function seedUnmatched(db: D1Database, count: number): Promise<void> {
  await createBankAccount(db, {
    account_number: '1234/2010',
    pairing_code: 'code-001',
  });
  for (let i = 0; i < count; i++) {
    await insertParseLog(db, { error_message: `unknown_pairing_code:code-${i}` });
  }
}

// ---- tests ----

describe('DEFAULT_THRESHOLDS', () => {
  it('exports documented constants', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ parse_failure_rate_24h: 0.05, unmatched_24h: 10 });
  });
});

describe('evaluateThresholds', () => {
  it('returns null when all thresholds passing', async () => {
    const db = makeTestDb();
    const cfg: AlerterConfig = {
      webhookUrl: 'https://hooks.slack.com/test',
      service: 'banksync.test',
      thresholds: DEFAULT_THRESHOLDS,
    };
    const result = await evaluateThresholds(db, cfg);
    expect(result).toBeNull();
  });

  it('triggers on parse_failure_rate_24h > threshold', async () => {
    const db = makeTestDb();
    await createBankAccount(db, {
      account_number: '1234/2010',
      pairing_code: 'code-001',
    });
    await insertParseLog(db, { error_message: 'unknown_currency:FAKE' });
    await writeEvent(db, { event_type: 'tx_inserted' });
    const cfg: AlerterConfig = {
      webhookUrl: 'https://hooks.slack.com/test',
      service: 'banksync.test',
      thresholds: { ...DEFAULT_THRESHOLDS, parse_failure_rate_24h: 0.3 },
    };
    const result = await evaluateThresholds(db, cfg);
    expect(result).not.toBeNull();
    expect(result!.triggered_thresholds).toContainEqual(
      expect.objectContaining({
        metric: 'parse_failure_rate_24h',
      })
    );
  });

  it('parse_failure_rate_24h > 0.5 triggers severity=error', async () => {
    const db = makeTestDb();
    await createBankAccount(db, {
      account_number: '1234/2010',
      pairing_code: 'code-001',
    });
    for (let i = 0; i < 6; i++) {
      await insertParseLog(db, { error_message: 'unknown_currency:FAKE' });
    }
    for (let i = 0; i < 4; i++) {
      await writeEvent(db, { event_type: 'tx_inserted' });
    }
    const cfg: AlerterConfig = {
      webhookUrl: 'https://hooks.slack.com/test',
      service: 'banksync.test',
      thresholds: { ...DEFAULT_THRESHOLDS, parse_failure_rate_24h: 0.4 },
    };
    const result = await evaluateThresholds(db, cfg);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('error');
  });

  it('triggers on unmatched_24h > threshold', async () => {
    const db = makeTestDb();
    await createBankAccount(db, {
      account_number: '1234/2010',
      pairing_code: 'code-001',
    });
    for (let i = 0; i < 12; i++) {
      await insertParseLog(db, { error_message: `unknown_pairing_code:code-${i}` });
    }
    const cfg: AlerterConfig = {
      webhookUrl: 'https://hooks.slack.com/test',
      service: 'banksync.test',
      thresholds: { ...DEFAULT_THRESHOLDS, unmatched_24h: 10 },
    };
    const result = await evaluateThresholds(db, cfg);
    expect(result).not.toBeNull();
    expect(result!.triggered_thresholds).toContainEqual(
      expect.objectContaining({
        metric: 'unmatched_24h',
        value: 12,
        threshold: 10,
      })
    );
  });

  it('multiple thresholds breached → all listed in triggered_thresholds', async () => {
    const db = makeTestDb();
    // 12 unmatched rows with no successful tx events → unmatched_24h = 12 (>= 10)
    // AND parse_failure_rate_24h = 1.0 (> 0.05), so both aggregates fire.
    await seedUnmatched(db, 12);
    const cfg: AlerterConfig = {
      webhookUrl: 'https://hooks.slack.com/test',
      service: 'banksync.test',
      thresholds: DEFAULT_THRESHOLDS,
    };
    const result = await evaluateThresholds(db, cfg);
    expect(result).not.toBeNull();
    expect(result!.triggered_thresholds.length).toBeGreaterThanOrEqual(2);
    expect(result!.triggered_thresholds.map(t => t.metric)).toContain('parse_failure_rate_24h');
    expect(result!.triggered_thresholds.map(t => t.metric)).toContain('unmatched_24h');
  });

  it('includes complete status_snapshot in result', async () => {
    const db = makeTestDb();
    await seedUnmatched(db, 12);
    const cfg: AlerterConfig = {
      webhookUrl: 'https://hooks.slack.com/test',
      service: 'banksync.test',
      thresholds: DEFAULT_THRESHOLDS,
    };
    const result = await evaluateThresholds(db, cfg);
    expect(result).not.toBeNull();
    expect(result!.status_snapshot).toHaveProperty('parse_failure_rate_24h');
    expect(result!.status_snapshot).toHaveProperty('parse_failures_24h');
    expect(result!.status_snapshot).toHaveProperty('unknown_currency_24h');
    expect(result!.status_snapshot).toHaveProperty('unknown_provider_24h');
    expect(result!.status_snapshot).toHaveProperty('unmatched_24h');
  });

  it('sets probed_at to current ISO timestamp', async () => {
    const db = makeTestDb();
    await seedUnmatched(db, 12);
    const cfg: AlerterConfig = {
      webhookUrl: 'https://hooks.slack.com/test',
      service: 'banksync.test',
      thresholds: DEFAULT_THRESHOLDS,
    };
    const before = new Date().getTime();
    const result = await evaluateThresholds(db, cfg);
    const after = new Date().getTime();
    expect(result).not.toBeNull();
    const probed = new Date(result!.probed_at).getTime();
    expect(probed).toBeGreaterThanOrEqual(before);
    expect(probed).toBeLessThanOrEqual(after);
  });
});

describe('postAlert', () => {
  let fetchMock: any;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends JSON POST to webhookUrl with correct structure', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const payload: AlertPayload = {
      service: 'banksync.test',
      severity: 'warn',
      triggered_thresholds: [{ metric: 'unmatched_24h', value: 15, threshold: 10 }],
      status_snapshot: {
        parse_failure_rate_24h: 0.01,
        parse_failures_24h: 1,
        unknown_currency_24h: 0,
        unknown_provider_24h: 0,
        unmatched_24h: 15,
      },
      probed_at: '2026-05-08T12:00:00Z',
    };
    const cfg: AlerterConfig = {
      webhookUrl: 'https://hooks.slack.com/test-webhook',
      webhookSecret: 'internal-alert-secret',
      service: 'banksync.test',
      thresholds: DEFAULT_THRESHOLDS,
    };
    const result = await postAlert(payload, cfg);
    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('https://hooks.slack.com/test-webhook');
    expect(call[1].method).toBe('POST');
    expect(call[1].headers['Content-Type']).toBe('application/json');
    expect(call[1].headers.Authorization).toBe('Bearer internal-alert-secret');
    const body = JSON.parse(call[1].body);
    expect(body).toHaveProperty('text');
    expect(body).toHaveProperty('severity', 'warn');
    expect(body).toHaveProperty('service', 'banksync.test');
    expect(body).toHaveProperty('triggered_thresholds');
    expect(body).toHaveProperty('status_snapshot');
    expect(body).toHaveProperty('probed_at');
  });

  it('includes emoji and summary in text field', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const payload: AlertPayload = {
      service: 'banksync.test',
      severity: 'error',
      triggered_thresholds: [{ metric: 'parse_failure_rate_24h', value: 0.8, threshold: 0.05 }],
      status_snapshot: {
        parse_failure_rate_24h: 0.8,
        parse_failures_24h: 8,
        unknown_currency_24h: 0,
        unknown_provider_24h: 0,
        unmatched_24h: 0,
      },
      probed_at: '2026-05-08T12:00:00Z',
    };
    const cfg: AlerterConfig = {
      webhookUrl: 'https://hooks.slack.com/test-webhook',
      service: 'banksync.test',
      thresholds: DEFAULT_THRESHOLDS,
    };
    await postAlert(payload, cfg);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain('🚨');
    expect(body.text).toContain('error');
    expect(body.text).toContain('banksync.test');
    expect(body.text).toContain('parse_failure_rate_24h');
  });

  it('text field for warn severity includes warning emoji', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const payload: AlertPayload = {
      service: 'banksync.test',
      severity: 'warn',
      triggered_thresholds: [{ metric: 'unmatched_24h', value: 15, threshold: 10 }],
      status_snapshot: {
        parse_failure_rate_24h: 0.01,
        parse_failures_24h: 1,
        unknown_currency_24h: 0,
        unknown_provider_24h: 0,
        unmatched_24h: 15,
      },
      probed_at: '2026-05-08T12:00:00Z',
    };
    const cfg: AlerterConfig = {
      webhookUrl: 'https://hooks.slack.com/test-webhook',
      service: 'banksync.test',
      thresholds: DEFAULT_THRESHOLDS,
    };
    await postAlert(payload, cfg);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain('⚠️');
    expect(body.text).toContain('warn');
  });

  it('returns false on non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const payload: AlertPayload = {
      service: 'banksync.test',
      severity: 'warn',
      triggered_thresholds: [{ metric: 'unmatched_24h', value: 15, threshold: 10 }],
      status_snapshot: {
        parse_failure_rate_24h: 0.01,
        parse_failures_24h: 1,
        unknown_currency_24h: 0,
        unknown_provider_24h: 0,
        unmatched_24h: 15,
      },
      probed_at: '2026-05-08T12:00:00Z',
    };
    const cfg: AlerterConfig = {
      webhookUrl: 'https://hooks.slack.com/test-webhook',
      service: 'banksync.test',
      thresholds: DEFAULT_THRESHOLDS,
    };
    const result = await postAlert(payload, cfg);
    expect(result).toBe(false);
  });

  it('returns false on fetch exception and logs error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network error'));
    const payload: AlertPayload = {
      service: 'banksync.test',
      severity: 'warn',
      triggered_thresholds: [{ metric: 'unmatched_24h', value: 15, threshold: 10 }],
      status_snapshot: {
        parse_failure_rate_24h: 0.01,
        parse_failures_24h: 1,
        unknown_currency_24h: 0,
        unknown_provider_24h: 0,
        unmatched_24h: 15,
      },
      probed_at: '2026-05-08T12:00:00Z',
    };
    const cfg: AlerterConfig = {
      webhookUrl: 'https://hooks.slack.com/test-webhook',
      service: 'banksync.test',
      thresholds: DEFAULT_THRESHOLDS,
    };
    const result = await postAlert(payload, cfg);
    expect(result).toBe(false);
  });

  it('returns false when webhookUrl is undefined', async () => {
    const payload: AlertPayload = {
      service: 'banksync.test',
      severity: 'warn',
      triggered_thresholds: [{ metric: 'unmatched_24h', value: 15, threshold: 10 }],
      status_snapshot: {
        parse_failure_rate_24h: 0.01,
        parse_failures_24h: 1,
        unknown_currency_24h: 0,
        unknown_provider_24h: 0,
        unmatched_24h: 15,
      },
      probed_at: '2026-05-08T12:00:00Z',
    };
    const cfg: AlerterConfig = {
      webhookUrl: undefined,
      service: 'banksync.test',
      thresholds: DEFAULT_THRESHOLDS,
    };
    const result = await postAlert(payload, cfg);
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('runAlerterTick', () => {
  let fetchMock: any;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  it('debounces an active aggregate incident and posts one recovery after it clears', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { db, sqlite } = makeTestDbWithSqlite();
    await seedUnmatched(db, 12);
    const cfg: AlerterConfig = { webhookUrl: 'https://hooks.slack.com/test', service: 'banksync.test', thresholds: DEFAULT_THRESHOLDS };

    expect((await runAlerterTick(db, cfg)).fired).toBe(true);
    expect(await runAlerterTick(db, cfg)).toEqual({ fired: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare(`SELECT value FROM alert_state WHERE key = 'alerter_active'`).get()).toEqual({ value: 'active' });

    // Clear the breach: remove the unmatched parse-log rows.
    sqlite.prepare(`DELETE FROM parse_log`).run();
    const recovery = await runAlerterTick(db, cfg);
    expect(recovery).toHaveProperty('fired', true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare(`SELECT value FROM alert_state WHERE key = 'alerter_active'`).get()).toEqual({ value: 'resolved' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns { fired: false } when webhookUrl is undefined', async () => {
    const db = makeTestDb();
    const cfg: AlerterConfig = {
      webhookUrl: undefined,
      service: 'banksync.test',
      thresholds: DEFAULT_THRESHOLDS,
    };
    const result = await runAlerterTick(db, cfg);
    expect(result).toEqual({ fired: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns { fired: false } when no thresholds breached', async () => {
    const db = makeTestDb();
    const cfg: AlerterConfig = {
      webhookUrl: 'https://hooks.slack.com/test',
      service: 'banksync.test',
      thresholds: DEFAULT_THRESHOLDS,
    };
    const result = await runAlerterTick(db, cfg);
    expect(result).toEqual({ fired: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns { fired: true, payload, posted: true } on successful alert post', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const db = makeTestDb();
    await seedUnmatched(db, 12);
    const cfg: AlerterConfig = {
      webhookUrl: 'https://hooks.slack.com/test',
      service: 'banksync.test',
      thresholds: DEFAULT_THRESHOLDS,
    };
    const result = await runAlerterTick(db, cfg);
    expect(result).toHaveProperty('fired', true);
    if ('payload' in result) {
      expect(result.payload).toHaveProperty('service', 'banksync.test');
      expect(result.payload).toHaveProperty('severity');
      expect(result.posted).toBe(true);
    }
  });

  it('returns { fired: true, posted: false } on alert post failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network error'));
    const db = makeTestDb();
    await seedUnmatched(db, 12);
    const cfg: AlerterConfig = {
      webhookUrl: 'https://hooks.slack.com/test',
      service: 'banksync.test',
      thresholds: DEFAULT_THRESHOLDS,
    };
    const result = await runAlerterTick(db, cfg);
    expect(result).toHaveProperty('fired', true);
    if ('posted' in result) {
      expect(result.posted).toBe(false);
    }
  });

  it('combines evaluate + post correctly for multiple breaches', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const db = makeTestDb();
    // 12 unmatched rows with no successful tx → both unmatched_24h and
    // parse_failure_rate_24h breach.
    await seedUnmatched(db, 12);
    const cfg: AlerterConfig = {
      webhookUrl: 'https://hooks.slack.com/test',
      service: 'banksync.test',
      thresholds: DEFAULT_THRESHOLDS,
    };
    const result = await runAlerterTick(db, cfg);
    expect(result).toHaveProperty('fired', true);
    if ('payload' in result) {
      expect(result.payload.triggered_thresholds.length).toBeGreaterThanOrEqual(2);
      expect(result.posted).toBe(true);
    }
  });
});
