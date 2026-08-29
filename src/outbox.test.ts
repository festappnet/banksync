import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { D1Database, D1Result, D1PreparedStatement } from '@cloudflare/workers-types';
import {
  enqueueCreate,
  enqueueDelete,
  markCompleted,
  markFailureAttempt,
  fetchDuePending,
  processOutbox,
  nextAttemptAt,
} from './outbox';
import type { CfRoutingConfig } from './cf_routing';

// ---- D1 facade over better-sqlite3 (with batch support) ----

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

      // expose for batch
      _sql: sql,
      _getBoundArgs(): unknown[] { return boundArgs; },
    } as unknown as D1PreparedStatement;

    return stmt;
  }

  async function batch(statements: D1PreparedStatement[]): Promise<D1Result<Record<string, unknown>>[]> {
    return sqlite.transaction(() => {
      return statements.map((stmt) => {
        const s = stmt as unknown as { _sql: string; _getBoundArgs(): unknown[] };
        const prepared = sqlite.prepare(s._sql);
        const args = s._getBoundArgs();
        const info = prepared.run(...(args as Parameters<typeof prepared.run>));
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
        } as D1Result<Record<string, unknown>>;
      });
    })();
  }

  return { prepare, batch } as unknown as D1Database;
}

const MIGRATIONS = ['0001_schema.sql'];

function applyMigrations(sqlite: Database.Database): void {
  for (const m of MIGRATIONS) {
    const p = resolve(__dirname, '../migrations', m);
    sqlite.exec(readFileSync(p, 'utf8'));
  }
}

function makeTestDb(): { db: D1Database; sqlite: Database.Database } {
  const sqlite = new Database(':memory:');
  applyMigrations(sqlite);
  return { db: wrapAsD1(sqlite), sqlite };
}

const cfgEnabled: CfRoutingConfig = {
  apiToken: 'test-token',
  zoneId: 'zone-abc',
  domain: 'banksync.festapp.net',
};
const cfgDisabled: CfRoutingConfig = {
  apiToken: undefined,
  zoneId: 'zone-abc',
  domain: 'banksync.festapp.net',
};

function seedBankAccount(sqlite: Database.Database, pairingCode = 'code0001'): number {
  sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code) VALUES ('1234/2010', ?)`).run(pairingCode);
  return (sqlite.prepare(`SELECT id FROM bank_accounts WHERE pairing_code = ?`).get(pairingCode) as { id: number }).id;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- 1. enqueueCreate ----

describe('enqueueCreate', () => {
  it('writes outbox row with op=create, pending, attempts=0', async () => {
    const { db, sqlite } = makeTestDb();
    const bankAccountId = seedBankAccount(sqlite);
    const id = await enqueueCreate(db, { pairing_code: 'abc123', bank_account_id: bankAccountId });
    expect(id).toBeGreaterThan(0);
    const row = sqlite.prepare(`SELECT * FROM cf_routing_outbox WHERE id = ?`).get(id) as {
      op: string; pairing_code: string; bank_account_id: number; status: string; attempts: number;
    };
    expect(row.op).toBe('create');
    expect(row.pairing_code).toBe('abc123');
    expect(row.bank_account_id).toBe(bankAccountId);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
  });
});

// ---- 2. enqueueDelete ----

describe('enqueueDelete', () => {
  it('writes outbox row with op=delete, cf_rule_id, pending', async () => {
    const { db, sqlite } = makeTestDb();
    const id = await enqueueDelete(db, { cf_rule_id: 'rule-abc' });
    expect(id).toBeGreaterThan(0);
    const row = sqlite.prepare(`SELECT * FROM cf_routing_outbox WHERE id = ?`).get(id) as {
      op: string; cf_rule_id: string; status: string; attempts: number;
    };
    expect(row.op).toBe('delete');
    expect(row.cf_rule_id).toBe('rule-abc');
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
  });
});

// ---- 3. markCompleted for create ----

describe('markCompleted for create', () => {
  it('updates outbox.status=completed AND bank_accounts.cf_rule_id', async () => {
    const { db, sqlite } = makeTestDb();
    const bankAccountId = seedBankAccount(sqlite);
    const outboxId = await enqueueCreate(db, { pairing_code: 'abc123', bank_account_id: bankAccountId });
    await markCompleted(db, outboxId, 'rule-xyz');
    const outboxRow = sqlite.prepare(`SELECT status, cf_rule_id, completed_at FROM cf_routing_outbox WHERE id = ?`).get(outboxId) as {
      status: string; cf_rule_id: string; completed_at: string | null;
    };
    expect(outboxRow.status).toBe('completed');
    expect(outboxRow.cf_rule_id).toBe('rule-xyz');
    expect(outboxRow.completed_at).not.toBeNull();
    const acct = sqlite.prepare(`SELECT cf_rule_id FROM bank_accounts WHERE id = ?`).get(bankAccountId) as { cf_rule_id: string | null };
    expect(acct.cf_rule_id).toBe('rule-xyz');
  });
});

// ---- 4. markCompleted for delete ----

describe('markCompleted for delete', () => {
  it('updates only outbox.status=completed (no bank_account update)', async () => {
    const { db, sqlite } = makeTestDb();
    const outboxId = await enqueueDelete(db, { cf_rule_id: 'rule-del' });
    await markCompleted(db, outboxId);
    const outboxRow = sqlite.prepare(`SELECT status, completed_at FROM cf_routing_outbox WHERE id = ?`).get(outboxId) as {
      status: string; completed_at: string | null;
    };
    expect(outboxRow.status).toBe('completed');
    expect(outboxRow.completed_at).not.toBeNull();
  });
});

// ---- 5. markFailureAttempt ----

describe('markFailureAttempt', () => {
  it('increments attempts, sets next_attempt_at in future, stores last_error', async () => {
    const { db, sqlite } = makeTestDb();
    const bankAccountId = seedBankAccount(sqlite);
    const outboxId = await enqueueCreate(db, { pairing_code: 'abc', bank_account_id: bankAccountId });
    const before = Date.now();
    await markFailureAttempt(db, outboxId, 'CF 500: service unavailable');
    const row = sqlite.prepare(`SELECT attempts, last_error, next_attempt_at, status FROM cf_routing_outbox WHERE id = ?`).get(outboxId) as {
      attempts: number; last_error: string; next_attempt_at: string; status: string;
    };
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe('CF 500: service unavailable');
    expect(row.status).toBe('pending');
    // next_attempt_at should be approximately now+60s (attempts=1 → 60s backoff)
    const nextAt = new Date(row.next_attempt_at.replace(' ', 'T') + 'Z').getTime();
    expect(nextAt).toBeGreaterThan(before + 55_000);
  });
});

// ---- 6. markFailureAttempt at MAX_ATTEMPTS boundary ----

describe('markFailureAttempt MAX_ATTEMPTS boundary', () => {
  it('remains pending when attempts+1 < MAX_ATTEMPTS', async () => {
    const { db, sqlite } = makeTestDb();
    const bankAccountId = seedBankAccount(sqlite);
    const outboxId = await enqueueCreate(db, { pairing_code: 'abc', bank_account_id: bankAccountId });
    // Set attempts to 8 directly (MAX=10, so 8+1=9 < 10 → still pending)
    sqlite.prepare(`UPDATE cf_routing_outbox SET attempts = 8 WHERE id = ?`).run(outboxId);
    await markFailureAttempt(db, outboxId, 'err');
    const row = sqlite.prepare(`SELECT status, attempts FROM cf_routing_outbox WHERE id = ?`).get(outboxId) as {
      status: string; attempts: number;
    };
    expect(row.attempts).toBe(9);
    expect(row.status).toBe('pending');
  });

  it('transitions to failed when attempts+1 >= MAX_ATTEMPTS', async () => {
    const { db, sqlite } = makeTestDb();
    const bankAccountId = seedBankAccount(sqlite);
    const outboxId = await enqueueCreate(db, { pairing_code: 'abc', bank_account_id: bankAccountId });
    // Set attempts to 9 directly (9+1=10 = MAX → failed)
    sqlite.prepare(`UPDATE cf_routing_outbox SET attempts = 9 WHERE id = ?`).run(outboxId);
    await markFailureAttempt(db, outboxId, 'final error');
    const row = sqlite.prepare(`SELECT status, attempts FROM cf_routing_outbox WHERE id = ?`).get(outboxId) as {
      status: string; attempts: number;
    };
    expect(row.attempts).toBe(10);
    expect(row.status).toBe('failed');
  });
});

// ---- 7. fetchDuePending filters by next_attempt_at ----

describe('fetchDuePending', () => {
  it('only returns pending rows where next_attempt_at <= now', async () => {
    const { db, sqlite } = makeTestDb();
    const bankAccountId = seedBankAccount(sqlite);
    // row 1: due (next_attempt_at in the past)
    const id1 = await enqueueCreate(db, { pairing_code: 'code1', bank_account_id: bankAccountId });
    sqlite.prepare(`UPDATE cf_routing_outbox SET next_attempt_at = datetime('now', '-1 hour') WHERE id = ?`).run(id1);
    // row 2: not due (next_attempt_at in the future)
    const id2 = await enqueueDelete(db, { cf_rule_id: 'rule-future' });
    sqlite.prepare(`UPDATE cf_routing_outbox SET next_attempt_at = datetime('now', '+1 hour') WHERE id = ?`).run(id2);

    const rows = await fetchDuePending(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id1);
  });

  it('skips completed and failed rows', async () => {
    const { db, sqlite } = makeTestDb();
    const id = await enqueueDelete(db, { cf_rule_id: 'rule-done' });
    sqlite.prepare(`UPDATE cf_routing_outbox SET status = 'completed', next_attempt_at = datetime('now', '-1 hour') WHERE id = ?`).run(id);
    const rows = await fetchDuePending(db);
    expect(rows).toHaveLength(0);
  });
});

// ---- 8. fetchDuePending ORDER BY id ----

describe('fetchDuePending ordering', () => {
  it('returns oldest rows first (ORDER BY id)', async () => {
    const { db, sqlite } = makeTestDb();
    const bankAccountId = seedBankAccount(sqlite);
    const id1 = await enqueueCreate(db, { pairing_code: 'first', bank_account_id: bankAccountId });
    const id2 = await enqueueDelete(db, { cf_rule_id: 'rule-second' });
    sqlite.prepare(`UPDATE cf_routing_outbox SET next_attempt_at = datetime('now', '-1 hour')`).run();
    const rows = await fetchDuePending(db);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]!.id).toBe(id1);
    expect(rows[1]!.id).toBe(id2);
  });
});

// ---- 9. processOutbox happy path create ----

describe('processOutbox create happy path', () => {
  it('calls createRule, marks completed, populates bank_accounts.cf_rule_id', async () => {
    const { db, sqlite } = makeTestDb();
    const bankAccountId = seedBankAccount(sqlite, 'mycode');
    const outboxId = await enqueueCreate(db, { pairing_code: 'mycode', bank_account_id: bankAccountId });
    sqlite.prepare(`UPDATE cf_routing_outbox SET next_attempt_at = datetime('now', '-1 minute') WHERE id = ?`).run(outboxId);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, result: { id: 'rule-123' }, errors: [] }), { status: 200 }),
    );

    const counts = await processOutbox(db, cfgEnabled);
    expect(counts.attempted).toBe(1);
    expect(counts.succeeded).toBe(1);
    expect(counts.failed_attempt).toBe(0);
    expect(counts.exhausted).toBe(0);

    const outboxRow = sqlite.prepare(`SELECT status, cf_rule_id FROM cf_routing_outbox WHERE id = ?`).get(outboxId) as {
      status: string; cf_rule_id: string | null;
    };
    expect(outboxRow.status).toBe('completed');
    expect(outboxRow.cf_rule_id).toBe('rule-123');

    const acct = sqlite.prepare(`SELECT cf_rule_id FROM bank_accounts WHERE id = ?`).get(bankAccountId) as { cf_rule_id: string | null };
    expect(acct.cf_rule_id).toBe('rule-123');
  });
});

describe('processOutbox stale create compensation', () => {
  it('completes without calling Cloudflare when the owning account was deleted', async () => {
    const { db, sqlite } = makeTestDb();
    const bankAccountId = seedBankAccount(sqlite);
    const outboxId = await enqueueCreate(db, { pairing_code: 'deleted', bank_account_id: bankAccountId });
    sqlite.prepare(`DELETE FROM bank_accounts WHERE id = ?`).run(bankAccountId);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const counts = await processOutbox(db, cfgEnabled);

    expect(counts).toMatchObject({ attempted: 1, succeeded: 1, failed_attempt: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT status FROM cf_routing_outbox WHERE id = ?`).get(outboxId)).toEqual({ status: 'completed' });
  });

  it('deletes a newly created rule when the account disappears during the CF request', async () => {
    const { db, sqlite } = makeTestDb();
    const bankAccountId = seedBankAccount(sqlite, 'raced');
    const outboxId = await enqueueCreate(db, { pairing_code: 'raced', bank_account_id: bankAccountId });
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => {
        sqlite.prepare(`DELETE FROM bank_accounts WHERE id = ?`).run(bankAccountId);
        return new Response(JSON.stringify({ success: true, result: { id: 'rule-raced' }, errors: [] }), { status: 200 });
      })
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, result: null, errors: [] }), { status: 200 }));

    const counts = await processOutbox(db, cfgEnabled);

    expect(counts).toMatchObject({ attempted: 1, succeeded: 1, failed_attempt: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
    expect(fetchSpy.mock.calls[1]![1]).toMatchObject({ method: 'DELETE' });
    expect(sqlite.prepare(`SELECT status, cf_rule_id FROM cf_routing_outbox WHERE id = ?`).get(outboxId)).toEqual({
      status: 'completed',
      cf_rule_id: null,
    });
  });
});

// ---- 10. processOutbox happy path delete ----

describe('processOutbox delete happy path', () => {
  it('calls deleteRule, marks completed', async () => {
    const { db, sqlite } = makeTestDb();
    const outboxId = await enqueueDelete(db, { cf_rule_id: 'rule-del' });
    sqlite.prepare(`UPDATE cf_routing_outbox SET next_attempt_at = datetime('now', '-1 minute') WHERE id = ?`).run(outboxId);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, result: null, errors: [] }), { status: 200 }),
    );

    const counts = await processOutbox(db, cfgEnabled);
    expect(counts.succeeded).toBe(1);
    const row = sqlite.prepare(`SELECT status FROM cf_routing_outbox WHERE id = ?`).get(outboxId) as { status: string };
    expect(row.status).toBe('completed');
  });
});

// ---- 11. processOutbox delete idempotent on CF 404 ----

describe('processOutbox delete 404 idempotent', () => {
  it('treats CF 404 on delete as success → markCompleted', async () => {
    const { db, sqlite } = makeTestDb();
    const outboxId = await enqueueDelete(db, { cf_rule_id: 'gone-rule' });
    sqlite.prepare(`UPDATE cf_routing_outbox SET next_attempt_at = datetime('now', '-1 minute') WHERE id = ?`).run(outboxId);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('', { status: 404 }),
    );

    const counts = await processOutbox(db, cfgEnabled);
    expect(counts.succeeded).toBe(1);
    expect(counts.failed_attempt).toBe(0);
    const row = sqlite.prepare(`SELECT status FROM cf_routing_outbox WHERE id = ?`).get(outboxId) as { status: string };
    expect(row.status).toBe('completed');
  });
});

// ---- 12. processOutbox failure path (CF 500) ----

describe('processOutbox failure path', () => {
  it('CF 500 → markFailureAttempt, status stays pending, attempts incremented', async () => {
    const { db, sqlite } = makeTestDb();
    const bankAccountId = seedBankAccount(sqlite, 'code');
    const outboxId = await enqueueCreate(db, { pairing_code: 'code', bank_account_id: bankAccountId });
    sqlite.prepare(`UPDATE cf_routing_outbox SET next_attempt_at = datetime('now', '-1 minute') WHERE id = ?`).run(outboxId);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: 'CF internal error' }] }), { status: 500 }),
    );

    const counts = await processOutbox(db, cfgEnabled);
    expect(counts.attempted).toBe(1);
    expect(counts.succeeded).toBe(0);
    expect(counts.failed_attempt).toBe(1);
    expect(counts.exhausted).toBe(0);

    const row = sqlite.prepare(`SELECT status, attempts FROM cf_routing_outbox WHERE id = ?`).get(outboxId) as {
      status: string; attempts: number;
    };
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
  });
});

// ---- 13. processOutbox exhausted at MAX_ATTEMPTS ----

describe('processOutbox MAX_ATTEMPTS exhaustion', () => {
  it('previous attempts=9, this fail → status=failed, exhausted counter +1', async () => {
    const { db, sqlite } = makeTestDb();
    const bankAccountId = seedBankAccount(sqlite, 'code');
    const outboxId = await enqueueCreate(db, { pairing_code: 'code', bank_account_id: bankAccountId });
    sqlite.prepare(`UPDATE cf_routing_outbox SET attempts = 9, next_attempt_at = datetime('now', '-1 minute') WHERE id = ?`).run(outboxId);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: 'CF down' }] }), { status: 503 }),
    );

    const counts = await processOutbox(db, cfgEnabled);
    expect(counts.exhausted).toBe(1);
    expect(counts.failed_attempt).toBe(1);

    const row = sqlite.prepare(`SELECT status, attempts FROM cf_routing_outbox WHERE id = ?`).get(outboxId) as {
      status: string; attempts: number;
    };
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(10);
  });
});

// ---- 14. processOutbox returns proper counts ----

describe('processOutbox counts', () => {
  it('returns correct attempted/succeeded/failed_attempt/exhausted across mixed rows', async () => {
    const { db, sqlite } = makeTestDb();
    const bankAccountId = seedBankAccount(sqlite, 'code1');

    // row 1: create → will succeed
    const id1 = await enqueueCreate(db, { pairing_code: 'code1', bank_account_id: bankAccountId });
    sqlite.prepare(`UPDATE cf_routing_outbox SET next_attempt_at = datetime('now', '-1 minute') WHERE id = ?`).run(id1);

    // row 2: delete → will fail (500)
    const id2 = await enqueueDelete(db, { cf_rule_id: 'rule-del' });
    sqlite.prepare(`UPDATE cf_routing_outbox SET next_attempt_at = datetime('now', '-1 minute') WHERE id = ?`).run(id2);

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, result: { id: 'rule-ok' }, errors: [] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: 'fail' }] }), { status: 500 }),
      );

    const counts = await processOutbox(db, cfgEnabled);
    expect(counts.attempted).toBe(2);
    expect(counts.succeeded).toBe(1);
    expect(counts.failed_attempt).toBe(1);
    expect(counts.exhausted).toBe(0);
  });
});

// ---- 15. processOutbox skips when CF disabled ----

describe('processOutbox CF disabled', () => {
  it('returns all-zero counts and does not call fetch', async () => {
    const { db, sqlite } = makeTestDb();
    const bankAccountId = seedBankAccount(sqlite);
    const outboxId = await enqueueCreate(db, { pairing_code: 'code', bank_account_id: bankAccountId });
    sqlite.prepare(`UPDATE cf_routing_outbox SET next_attempt_at = datetime('now', '-1 minute') WHERE id = ?`).run(outboxId);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const counts = await processOutbox(db, cfgDisabled);
    expect(counts.attempted).toBe(0);
    expect(counts.succeeded).toBe(0);
    expect(counts.failed_attempt).toBe(0);
    expect(counts.exhausted).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---- 16. nextAttemptAt backoff schedule ----

describe('nextAttemptAt backoff', () => {
  const cases: Array<[number, number]> = [
    [1, 60],
    [2, 120],
    [3, 240],
    [4, 480],
    [5, 960],
    [6, 1920],
    [7, 3600], // cap
    [8, 3600],
    [9, 3600],
    [10, 3600],
  ];

  it.each(cases)('attempts=%i → +%is (± 2s)', (attempts, expectedSeconds) => {
    const before = Date.now();
    const result = nextAttemptAt(attempts);
    const after = Date.now();
    const resultMs = new Date(result.replace(' ', 'T') + 'Z').getTime();
    expect(resultMs).toBeGreaterThanOrEqual(before + (expectedSeconds - 2) * 1000);
    expect(resultMs).toBeLessThanOrEqual(after + (expectedSeconds + 2) * 1000);
  });
});
