import { describe, expect, it, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import {
  countPendingDeliveryAlerts,
  detectStalledIncidents,
  drainDeliveryAlerts,
  enqueueRecoveryIfOpen,
  enqueueTerminalIncident,
} from './alertOutbox';

const MIGRATIONS = ['0001_schema.sql'];

function wrapAsD1(sqlite: Database.Database): D1Database {
  return {
    prepare(sql: string): D1PreparedStatement {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { args = values; return statement; },
        async first<T>() { return sqlite.prepare(sql).get(...args) as T ?? null; },
        async all<T>(): Promise<D1Result<T>> {
          const results = sqlite.prepare(sql).all(...args) as T[];
          return { results, success: true, meta: { changes: 0, last_row_id: 0, duration: 0, size_after: 0, rows_read: results.length, rows_written: 0, changed_db: false } };
        },
        async run(): Promise<D1Result<Record<string, unknown>>> {
          const r = sqlite.prepare(sql).run(...args);
          return { results: [], success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid), duration: 0, size_after: 0, rows_read: 0, rows_written: r.changes, changed_db: r.changes > 0 } };
        },
      } as unknown as D1PreparedStatement;
      return statement;
    },
  } as D1Database;
}

function setup(jobOverrides: Record<string, string> = {}) {
  const sqlite = new Database(':memory:');
  for (const m of MIGRATIONS) sqlite.exec(readFileSync(resolve(__dirname, '../migrations', m), 'utf8'));
  const cols = { status: 'queued', created_at: "datetime('now')", ...jobOverrides };
  sqlite.prepare(`
    INSERT INTO webhook_delivery_jobs (id, transaction_id, consumer_app_id, delivery_id, payload, status, next_attempt_at, created_at, incident_version)
    VALUES (1, 1, 'festapp', 'D1', '{}', '${cols.status}', datetime('now'), ${cols.created_at}, 0)
  `).run();
  return { sqlite, db: wrapAsD1(sqlite) };
}

function alerts(sqlite: Database.Database): Array<{ incident_kind: string; incident_key: string; posted_at: string | null }> {
  return sqlite.prepare(`SELECT incident_kind, incident_key, posted_at FROM webhook_delivery_alerts ORDER BY id`).all() as never;
}

afterEach(() => vi.restoreAllMocks());

describe('alert outbox', () => {
  it('enqueues one terminal incident per (job, incident_version)', async () => {
    const { db, sqlite } = setup({ status: 'terminal' });
    const job = { id: 1, delivery_id: 'D1', consumer_app_id: 'festapp', incident_version: 0, last_error: 'boom', last_http_status: 500, status: 'terminal' };
    await enqueueTerminalIncident(db, job, 'banksync');
    await enqueueTerminalIncident(db, job, 'banksync'); // idempotent
    const rows = alerts(sqlite);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ incident_kind: 'terminal', incident_key: 'job:1:terminal:0' });
  });

  it('emits a recovery only when an open posted incident exists', async () => {
    const { db, sqlite } = setup();
    const job = { id: 1, delivery_id: 'D1', consumer_app_id: 'festapp', incident_version: 0, status: 'delivered' };
    // No incident yet → no recovery.
    await enqueueRecoveryIfOpen(db, job, 'banksync');
    expect(alerts(sqlite).filter(a => a.incident_kind === 'recovered')).toHaveLength(0);

    // Open + posted terminal incident → recovery once.
    sqlite.prepare(`INSERT INTO webhook_delivery_alerts (delivery_job_id, incident_kind, incident_key, payload, posted_at) VALUES (1, 'terminal', 'job:1:terminal:0', '{}', datetime('now'))`).run();
    await enqueueRecoveryIfOpen(db, job, 'banksync');
    await enqueueRecoveryIfOpen(db, job, 'banksync');
    expect(alerts(sqlite).filter(a => a.incident_kind === 'recovered')).toHaveLength(1);
  });

  it('detects a stalled active job past the grace period', async () => {
    const { db, sqlite } = setup({ status: 'pending', created_at: "datetime('now', '-20 minutes')" });
    expect(await detectStalledIncidents(db, 'banksync')).toBe(1);
    await detectStalledIncidents(db, 'banksync'); // idempotent
    expect(alerts(sqlite).filter(a => a.incident_kind === 'stalled')).toHaveLength(1);
    // A fresh active job is not stalled.
    sqlite.prepare(`UPDATE webhook_delivery_jobs SET created_at = datetime('now')`).run();
  });

  it('reconciles delivery that completed before its stalled alert was posted', async () => {
    const { db, sqlite } = setup({ status: 'delivered' });
    sqlite.prepare(`INSERT INTO webhook_delivery_alerts
      (delivery_job_id, incident_kind, incident_key, payload, posted_at)
      VALUES (1, 'stalled', 'job:1:stalled:0', '{}', datetime('now'))`).run();

    await detectStalledIncidents(db, 'banksync');

    expect(alerts(sqlite).filter(a => a.incident_kind === 'recovered')).toEqual([
      expect.objectContaining({ incident_key: 'job:1:recovered:1' }),
    ]);
  });

  it('drains due alerts, marks posted, and does not double-post under a claim lease', async () => {
    const { db, sqlite } = setup();
    sqlite.prepare(`INSERT INTO webhook_delivery_alerts (delivery_job_id, incident_kind, incident_key, payload) VALUES (1, 'terminal', 'job:1:terminal:0', '{"x":1}')`).run();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    const r1 = await drainDeliveryAlerts(db, {
      webhookUrl: 'https://hook.test',
      webhookSecret: 'internal-alert-secret',
      service: 'banksync',
    });
    expect(r1).toEqual({ posted: 1, failed: 0 });
    expect(alerts(sqlite)[0]!.posted_at).not.toBeNull();

    // Already posted → not re-drained.
    const r2 = await drainDeliveryAlerts(db, { webhookUrl: 'https://hook.test', service: 'banksync' });
    expect(r2.posted).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://hook.test',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer internal-alert-secret' }),
      }),
    );
    expect(await countPendingDeliveryAlerts(db)).toBe(0);
  });

  it('retries a failed post with backoff without losing the incident', async () => {
    const { db, sqlite } = setup();
    sqlite.prepare(`INSERT INTO webhook_delivery_alerts (delivery_job_id, incident_kind, incident_key, payload) VALUES (1, 'terminal', 'job:1:terminal:0', '{}')`).run();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));

    const r = await drainDeliveryAlerts(db, { webhookUrl: 'https://hook.test', service: 'banksync' });
    expect(r).toEqual({ posted: 0, failed: 1 });
    const row = sqlite.prepare(`SELECT posted_at, post_attempts, last_error FROM webhook_delivery_alerts`).get() as { posted_at: string | null; post_attempts: number; last_error: string };
    expect(row.posted_at).toBeNull();
    expect(row.post_attempts).toBe(1);
    expect(row.last_error).toContain('500');
  });

  it('disabled (no webhook url) drains nothing', async () => {
    const { db } = setup();
    expect(await drainDeliveryAlerts(db, { webhookUrl: undefined, service: 'banksync' })).toEqual({ posted: 0, failed: 0 });
  });
});
