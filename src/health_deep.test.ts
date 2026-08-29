import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { D1Database, D1Result, D1PreparedStatement, Queue } from '@cloudflare/workers-types';
import { deepHealth, auditCfRoutingDrift } from './health_deep';
import type { CfRoutingConfig } from './cf_routing';

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

function fakeQueue(): Queue<unknown> {
  return { send: vi.fn(), sendBatch: vi.fn() } as unknown as Queue<unknown>;
}

function cfRulesResponse(rules: Array<{ id: string; matchers?: Array<{ type: string; field?: string; value?: string }> }>): Response {
  return new Response(
    JSON.stringify({ success: true, result: rules, result_info: {} }),
    { status: 200 },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────
// deepHealth tests
// ─────────────────────────────────────────────

describe('deepHealth', () => {
  it('1. all green: D1 fast, CF 200, no outbox pending, queue binding present', async () => {
    const { db } = makeTestDb();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    const result = await deepHealth({ db, queue: fakeQueue(), cf: cfgEnabled });

    expect(result.status).toBe('green');
    expect(result.components.db_read).toBe('green');
    expect(result.components.db_write).toBe('green');
    expect(result.components.queue_producer).toBe('green');
    expect(result.components.cf_api).toBe('green');
    expect(result.components.outbox_drift).toBe('green');
    expect(result.details.queue_send_skipped).toBe(false);
    expect(result.details.outbox_pending_count).toBe(0);
    expect(result.details.outbox_failed_count).toBe(0);
    expect(result.probed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('required secrets missing in production → red (release blocker), present → green', async () => {
    const { db } = makeTestDb();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));

    const missingProd = await deepHealth({
      db, queue: fakeQueue(), cf: cfgEnabled,
      secrets: { alertWebhookPresent: false, backupsPresent: true, emailAuthPresent: true, callbackPolicyPresent: true, isProduction: true },
    });
    expect(missingProd.components.required_secrets).toBe('red');
    expect(missingProd.status).toBe('red');

    const missingDev = await deepHealth({
      db, queue: fakeQueue(), cf: cfgEnabled,
      secrets: { alertWebhookPresent: false, backupsPresent: false, emailAuthPresent: false, callbackPolicyPresent: false, isProduction: false },
    });
    expect(missingDev.components.required_secrets).toBe('yellow');

    const present = await deepHealth({
      db, queue: fakeQueue(), cf: cfgEnabled,
      secrets: { alertWebhookPresent: true, backupsPresent: true, emailAuthPresent: true, callbackPolicyPresent: true, isProduction: true },
    });
    expect(present.components.required_secrets).toBe('green');
  });

  it('2. D1 read slow → yellow on db_read, overall yellow', async () => {
    const { db } = makeTestDb();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    // Intercept prepare to introduce latency on SELECT 1
    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      const stmt = originalPrepare(sql);
      if (sql === 'SELECT 1 as ok') {
        const originalFirst = stmt.first.bind(stmt);
        vi.spyOn(stmt, 'first').mockImplementation(async () => {
          await new Promise(r => setTimeout(r, 300)); // 300ms > 200ms threshold
          return originalFirst();
        });
      }
      return stmt;
    });

    const result = await deepHealth({ db, queue: fakeQueue(), cf: cfgEnabled });

    expect(result.components.db_read).toBe('yellow');
    expect(result.status).toBe('yellow');
  });

  it('3. D1 write throws → red on db_write, overall red', async () => {
    const { db } = makeTestDb();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      const stmt = originalPrepare(sql);
      if (sql.includes('health_probe')) {
        vi.spyOn(stmt, 'first').mockRejectedValue(new Error('D1 write error'));
      }
      return stmt;
    });

    const result = await deepHealth({ db, queue: fakeQueue(), cf: cfgEnabled });

    expect(result.components.db_write).toBe('red');
    expect(result.status).toBe('red');
  });

  it('4. CF API 500 → red on cf_api, overall red', async () => {
    const { db } = makeTestDb();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false }), { status: 500 }),
    );

    const result = await deepHealth({ db, queue: fakeQueue(), cf: cfgEnabled });

    expect(result.components.cf_api).toBe('red');
    expect(result.details.cf_api_status).toBe(500);
    expect(result.status).toBe('red');
  });

  it('5. CF API disabled (token undefined) → cf_api=green, no fetch call', async () => {
    const { db } = makeTestDb();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await deepHealth({ db, queue: fakeQueue(), cf: cfgDisabled });

    expect(result.components.cf_api).toBe('green');
    expect(result.details.cf_api_latency_ms).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('6. queue=null → queue_producer=yellow, queue_send_skipped=true', async () => {
    const { db } = makeTestDb();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    const result = await deepHealth({ db, queue: null, cf: cfgEnabled });

    expect(result.components.queue_producer).toBe('yellow');
    expect(result.details.queue_send_skipped).toBe(true);
  });

  it('7. outbox pending > 0 → outbox_drift=yellow, overall yellow', async () => {
    const { db, sqlite } = makeTestDb();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    // Insert a bank account first (FK for outbox)
    sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code) VALUES ('1234/5678', 'pend001')`).run();
    const acct = sqlite.prepare(`SELECT id FROM bank_accounts WHERE pairing_code = 'pend001'`).get() as { id: number };
    sqlite.prepare(`INSERT INTO cf_routing_outbox (op, pairing_code, bank_account_id, status) VALUES ('create', 'pend001', ?, 'pending')`).run(acct.id);

    const result = await deepHealth({ db, queue: fakeQueue(), cf: cfgEnabled });

    expect(result.components.outbox_drift).toBe('yellow');
    expect(result.details.outbox_pending_count).toBe(1);
    expect(result.details.outbox_failed_count).toBe(0);
    expect(result.status).toBe('yellow');
  });

  it('8. outbox failed > 0 → outbox_drift=red, overall red', async () => {
    const { db, sqlite } = makeTestDb();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code) VALUES ('9999/5678', 'fail001')`).run();
    const acct = sqlite.prepare(`SELECT id FROM bank_accounts WHERE pairing_code = 'fail001'`).get() as { id: number };
    sqlite.prepare(`INSERT INTO cf_routing_outbox (op, pairing_code, bank_account_id, status, attempts) VALUES ('create', 'fail001', ?, 'failed', 10)`).run(acct.id);

    const result = await deepHealth({ db, queue: fakeQueue(), cf: cfgEnabled });

    expect(result.components.outbox_drift).toBe('red');
    expect(result.details.outbox_failed_count).toBe(1);
    expect(result.status).toBe('red');
  });
});

// ─────────────────────────────────────────────
// auditCfRoutingDrift tests
// ─────────────────────────────────────────────

describe('auditCfRoutingDrift', () => {
  it('9. CF disabled: returns cf_api_disabled=true, only outbox info', async () => {
    const { db, sqlite } = makeTestDb();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code) VALUES ('1/2010', 'dis001')`).run();
    const acct = sqlite.prepare(`SELECT id FROM bank_accounts WHERE pairing_code = 'dis001'`).get() as { id: number };
    sqlite.prepare(`INSERT INTO cf_routing_outbox (op, pairing_code, bank_account_id, status) VALUES ('create', 'dis001', ?, 'pending')`).run(acct.id);

    const result = await auditCfRoutingDrift({ db, cf: cfgDisabled });

    expect(result.cf_api_disabled).toBe(true);
    expect(result.outbox_pending).toHaveLength(1);
    expect(result.outbox_pending[0]!.pairing_code).toBe('dis001');
    expect(result.db_rows_missing_cf_rule).toHaveLength(0);
    expect(result.cf_rules_orphaned).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('10. happy path: 2 accounts with matching CF rules → no orphans', async () => {
    const { db, sqlite } = makeTestDb();

    sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code, cf_rule_id) VALUES ('1/2010', 'aa001', 'rule-aa001')`).run();
    sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code, cf_rule_id) VALUES ('2/2010', 'bb002', 'rule-bb002')`).run();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      cfRulesResponse([
        { id: 'rule-aa001', matchers: [{ type: 'literal', field: 'to', value: 'aa001@banksync.festapp.net' }] },
        { id: 'rule-bb002', matchers: [{ type: 'literal', field: 'to', value: 'bb002@banksync.festapp.net' }] },
      ]),
    );

    const result = await auditCfRoutingDrift({ db, cf: cfgEnabled });

    expect(result.cf_api_disabled).toBe(false);
    expect(result.db_rows_missing_cf_rule).toHaveLength(0);
    expect(result.cf_rules_orphaned).toHaveLength(0);
    expect(result.outbox_pending).toHaveLength(0);
  });

  it('11. DB row with NULL cf_rule_id → returned in db_rows_missing_cf_rule', async () => {
    const { db, sqlite } = makeTestDb();

    sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code, cf_rule_id) VALUES ('1/2010', 'nullcode', NULL)`).run();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(cfRulesResponse([]));

    const result = await auditCfRoutingDrift({ db, cf: cfgEnabled });

    expect(result.db_rows_missing_cf_rule).toHaveLength(1);
    expect(result.db_rows_missing_cf_rule[0]!.pairing_code).toBe('nullcode');
    expect(result.db_rows_missing_cf_rule[0]!.cf_rule_id).toBeNull();
  });

  it('11b. API-only bank account with NULL cf_rule_id is not email routing drift', async () => {
    const { db, sqlite } = makeTestDb();

    sqlite
      .prepare(`INSERT INTO bank_accounts (account_number, account_type, ingest_mode, pairing_code, cf_rule_id) VALUES ('api-only/2010', 'FIO', 'api', 'api001', NULL)`)
      .run();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(cfRulesResponse([]));

    const result = await auditCfRoutingDrift({ db, cf: cfgEnabled });

    expect(result.db_rows_missing_cf_rule).toHaveLength(0);
    expect(result.cf_rules_orphaned).toHaveLength(0);
  });

  it('12. CF rule for banksync matcher with no DB ref → cf_rules_orphaned', async () => {
    const { db } = makeTestDb();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      cfRulesResponse([
        { id: 'rule-orphan1', matchers: [{ type: 'literal', field: 'to', value: 'abc1234567@banksync.festapp.net' }] },
      ]),
    );

    const result = await auditCfRoutingDrift({ db, cf: cfgEnabled });

    expect(result.cf_rules_orphaned).toHaveLength(1);
    expect(result.cf_rules_orphaned[0]!.rule_id).toBe('rule-orphan1');
    expect(result.cf_rules_orphaned[0]!.matcher_value).toBe('abc1234567@banksync.festapp.net');
    expect(result.db_rows_missing_cf_rule).toHaveLength(0);
  });

  it('13. CF catch-all rule (type=all) → ignored', async () => {
    const { db } = makeTestDb();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      cfRulesResponse([
        { id: 'rule-catchall', matchers: [{ type: 'all' }] },
      ]),
    );

    const result = await auditCfRoutingDrift({ db, cf: cfgEnabled });

    expect(result.cf_rules_orphaned).toHaveLength(0);
  });

  it('14. CF non-banksync literal rule (manual@festapp.net) → ignored', async () => {
    const { db } = makeTestDb();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      cfRulesResponse([
        { id: 'rule-manual', matchers: [{ type: 'literal', field: 'to', value: 'manual@festapp.net' }] },
      ]),
    );

    const result = await auditCfRoutingDrift({ db, cf: cfgEnabled });

    expect(result.cf_rules_orphaned).toHaveLength(0);
  });

  it('15. outbox pending+failed entries returned alongside CF/DB drift', async () => {
    const { db, sqlite } = makeTestDb();

    // pairing codes must be hex to match banksync pattern: [0-9a-f]{4,32}
    sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code, cf_rule_id) VALUES ('1/2010', 'ab01cd02', 'rule-ab01cd02')`).run();
    const acct = sqlite.prepare(`SELECT id FROM bank_accounts WHERE pairing_code = 'ab01cd02'`).get() as { id: number };
    sqlite.prepare(`INSERT INTO cf_routing_outbox (op, pairing_code, bank_account_id, status) VALUES ('create', 'ab01cd02', ?, 'pending')`).run(acct.id);
    sqlite.prepare(`INSERT INTO cf_routing_outbox (op, cf_rule_id, status, attempts) VALUES ('delete', 'rule-stale', 'failed', 10)`).run();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      cfRulesResponse([
        { id: 'rule-ab01cd02', matchers: [{ type: 'literal', field: 'to', value: 'ab01cd02@banksync.festapp.net' }] },
        { id: 'rule-deadbeef', matchers: [{ type: 'literal', field: 'to', value: 'deadbeef@banksync.festapp.net' }] },
      ]),
    );

    const result = await auditCfRoutingDrift({ db, cf: cfgEnabled });

    expect(result.outbox_pending).toHaveLength(2);
    expect(result.outbox_pending.map(r => r.status)).toEqual(expect.arrayContaining(['pending', 'failed']));
    expect(result.cf_rules_orphaned).toHaveLength(1);
    expect(result.cf_rules_orphaned[0]!.rule_id).toBe('rule-deadbeef');
    expect(result.db_rows_missing_cf_rule).toHaveLength(0);
  });
});
