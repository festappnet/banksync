import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { D1Database, D1Result, D1PreparedStatement } from '@cloudflare/workers-types';
import { encodeRf } from './iso11649';
import {
  assertSchemaVersion,
  resetSchemaCheckCache,
  createBankAccount,
  findBankAccountByPairingCode,
  listBankAccounts,
  createConsumer,
  findConsumerByAppId,
  rotateConsumerSecret,
  createSubscription,
  deleteSubscription,
  findActiveSubscriptions,
  insertTransaction,
  insertParseLog,
  getConsumerSecretMaterials,
  insertWebhookLogEntry,
  writeEvent,
  pruneRetention,
} from './db';
import type { Transaction } from './types';
import * as loggerModule from './logger';

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

// ---- sample transaction payload ----

function txPayload(overrides: Partial<Omit<Transaction, 'id' | 'bank_account_id'>> = {}): Omit<Transaction, 'id' | 'bank_account_id'> {
  return {
    amount_cents: 1990,
    currency: 'CZK',
    counter_account: null,
    bank_code: null,
    bank_name: null,
    vs: null,
    ks: null,
    ss: null,
    message: null,
    sender_name: null,
    user_identification: null,
    transaction_type: null,
    performed_by: null,
    comment: null,
    command_id: null,
    source: 'email',
    date: '2026-05-08T00:00:00Z',
    date_offset_min: null,
    transaction_id: null,
    external_id: null,
    ...overrides,
  };
}

// ---- tests ----

describe('assertSchemaVersion', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('happy path — version=5 resolves', async () => {
    const db = makeTestDb();
    await expect(assertSchemaVersion(db)).resolves.toBeUndefined();
  });

  it('second call uses cache (no extra query needed — just resolves again)', async () => {
    const db = makeTestDb();
    await assertSchemaVersion(db);
    await expect(assertSchemaVersion(db)).resolves.toBeUndefined();
  });

  it('mismatch throws schema_version_mismatch', async () => {
    const { db, sqlite } = makeTestDbWithSqlite();
    sqlite.prepare(`UPDATE schema_meta SET value = '99' WHERE key = 'version'`).run();
    await expect(assertSchemaVersion(db)).rejects.toThrow('schema_version_mismatch');
  });

  it('mismatch error message contains got+expected', async () => {
    const { db, sqlite } = makeTestDbWithSqlite();
    sqlite.prepare(`UPDATE schema_meta SET value = '99' WHERE key = 'version'`).run();
    await expect(assertSchemaVersion(db)).rejects.toThrow('got 99, expected one of 10');
  });
});

describe('bank accounts', () => {
  it('createBankAccount + findBankAccountByPairingCode round-trip', async () => {
    const db = makeTestDb();
    const created = await createBankAccount(db, {
      account_number: '1234/2010',
      pairing_code: 'a3f92c1e44',
      label: 'Test',
    });
    expect(created.id).toBeGreaterThan(0);
    expect(created.pairing_code).toBe('a3f92c1e44');

    const found = await findBankAccountByPairingCode(db, 'a3f92c1e44');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.account_number).toBe('1234/2010');
  });

  it('findBankAccountByPairingCode returns null for unknown code', async () => {
    const db = makeTestDb();
    const found = await findBankAccountByPairingCode(db, 'doesnotexist');
    expect(found).toBeNull();
  });

  it('createBankAccount UNIQUE conflict on pairing_code throws', async () => {
    const db = makeTestDb();
    await createBankAccount(db, { account_number: '1234/2010', pairing_code: 'a3f92c1e44' });
    await expect(
      createBankAccount(db, { account_number: '9999/2010', pairing_code: 'a3f92c1e44' }),
    ).rejects.toThrow();
  });

  it('listBankAccounts returns all accounts', async () => {
    const db = makeTestDb();
    await createBankAccount(db, { account_number: '1234/2010', pairing_code: 'code0001' });
    await createBankAccount(db, { account_number: '5678/2010', pairing_code: 'code0002' });
    const list = await listBankAccounts(db);
    expect(list).toHaveLength(2);
  });
});

describe('insertTransaction', () => {
  it('first insert returns inserted status with transaction', async () => {
    const db = makeTestDb();
    const acct = await createBankAccount(db, { account_number: '1234/2010', pairing_code: 'code0001' });
    const result = await insertTransaction(db, {
      bank_account_id: acct.id,
      payload: txPayload({ external_id: 'msg-1' }),
    });
    expect(result.status).toBe('inserted');
    if (result.status === 'inserted') {
      expect(result.transaction.id).toBeGreaterThan(0);
      expect(result.transaction.external_id).toBe('msg-1');
    }
  });

  it('persists the VS decoded from a checksum-valid RF before webhook delivery', async () => {
    const db = makeTestDb();
    const acct = await createBankAccount(db, { account_number: '1234/2010', pairing_code: 'code0001' });
    const result = await insertTransaction(db, {
      bank_account_id: acct.id,
      payload: txPayload({
        currency: 'EUR',
        message: `SEPA reference ${encodeRf('0000000001')}`,
        external_id: 'eur-rf-1',
      }),
    });

    expect(result.status).toBe('inserted');
    if (result.status === 'inserted') {
      expect(result.transaction.vs).toBe('0000000001');
    }
  });

  it('does not persist a VS from an RF reference with broken check digits', async () => {
    const db = makeTestDb();
    const acct = await createBankAccount(db, { account_number: '1234/2010', pairing_code: 'code0001' });
    const valid = encodeRf('123456');
    const broken = `${valid.slice(0, 2)}${valid.slice(2, 4) === '99' ? '98' : '99'}${valid.slice(4)}`;
    const result = await insertTransaction(db, {
      bank_account_id: acct.id,
      payload: txPayload({ currency: 'EUR', message: broken, external_id: 'eur-rf-broken' }),
    });

    expect(result.status).toBe('inserted');
    if (result.status === 'inserted') {
      expect(result.transaction.vs).toBeNull();
    }
  });

  it('layer 2 dedup: same external_id → duplicate_external_id', async () => {
    const db = makeTestDb();
    const acct = await createBankAccount(db, { account_number: '1234/2010', pairing_code: 'code0001' });
    await insertTransaction(db, {
      bank_account_id: acct.id,
      payload: txPayload({ external_id: 'msg-1' }),
    });
    const result = await insertTransaction(db, {
      bank_account_id: acct.id,
      payload: txPayload({ external_id: 'msg-1' }),
    });
    expect(result.status).toBe('skipped');
    expect((result as { status: 'skipped'; reason: string }).reason).toBe('duplicate_external_id');
  });

  it('layer 1 dedup: same transaction_id same bank_account → duplicate_transaction_id', async () => {
    const db = makeTestDb();
    const acct = await createBankAccount(db, { account_number: '1234/2010', pairing_code: 'code0001' });
    await insertTransaction(db, {
      bank_account_id: acct.id,
      payload: txPayload({ transaction_id: 'fio-tx-001', external_id: 'msg-a' }),
    });
    const result = await insertTransaction(db, {
      bank_account_id: acct.id,
      payload: txPayload({ transaction_id: 'fio-tx-001', external_id: 'msg-b' }),
    });
    expect(result.status).toBe('skipped');
    expect((result as { status: 'skipped'; reason: string }).reason).toBe('duplicate_transaction_id');
  });

  it('layer 3 dedup: email/API fuzzy duplicate on same day', async () => {
    const db = makeTestDb();
    const acct = await createBankAccount(db, { account_number: '1234/2010', pairing_code: 'code0001' });
    await insertTransaction(db, {
      bank_account_id: acct.id,
      payload: txPayload({ source: 'email', external_id: 'msg-1', vs: '12345', amount_cents: 1990, currency: 'CZK', date: '2026-05-08T08:00:00.000Z' }),
    });
    const result = await insertTransaction(db, {
      bank_account_id: acct.id,
      payload: txPayload({ source: 'fio_api', transaction_id: 'fio-1', external_id: null, vs: '12345', amount_cents: 1990, currency: 'CZK', date: '2026-05-08T12:00:00.000Z' }),
    });
    expect(result.status).toBe('skipped');
    expect((result as { status: 'skipped'; reason: string }).reason).toBe('fuzzy_duplicate');
  });

  it('layer 3 dedup: email/API fuzzy duplicate with date shift', async () => {
    const db = makeTestDb();
    const acct = await createBankAccount(db, { account_number: '1234/2010', pairing_code: 'code0001' });
    await insertTransaction(db, {
      bank_account_id: acct.id,
      payload: txPayload({ source: 'email', external_id: 'msg-1', vs: '12345', amount_cents: 1990, currency: 'CZK', date: '2026-05-08T08:00:00.000Z' }),
    });
    const result = await insertTransaction(db, {
      bank_account_id: acct.id,
      payload: txPayload({ source: 'fio_api', transaction_id: 'fio-1', external_id: null, vs: '12345', amount_cents: 1990, currency: 'CZK', date: '2026-05-10T12:00:00.000Z' }),
    });
    expect(result.status).toBe('skipped');
    expect((result as { status: 'skipped'; reason: string }).reason).toBe('fuzzy_duplicate');
  });

  it('same transaction_id on different bank_account is NOT a duplicate', async () => {
    const db = makeTestDb();
    const acct1 = await createBankAccount(db, { account_number: '1111/2010', pairing_code: 'code0001' });
    const acct2 = await createBankAccount(db, { account_number: '2222/2010', pairing_code: 'code0002' });
    await insertTransaction(db, {
      bank_account_id: acct1.id,
      payload: txPayload({ transaction_id: 'fio-tx-001', external_id: null }),
    });
    const result = await insertTransaction(db, {
      bank_account_id: acct2.id,
      payload: txPayload({ transaction_id: 'fio-tx-001', external_id: null }),
    });
    expect(result.status).toBe('inserted');
  });

  it('both external_id and transaction_id null: each insert succeeds', async () => {
    const db = makeTestDb();
    const acct = await createBankAccount(db, { account_number: '1234/2010', pairing_code: 'code0001' });
    const r1 = await insertTransaction(db, {
      bank_account_id: acct.id,
      payload: txPayload({ transaction_id: null, external_id: null }),
    });
    const r2 = await insertTransaction(db, {
      bank_account_id: acct.id,
      payload: txPayload({ transaction_id: null, external_id: null }),
    });
    expect(r1.status).toBe('inserted');
    expect(r2.status).toBe('inserted');
  });
});

describe('consumers', () => {
  it('createConsumer + findConsumerByAppId round-trip', async () => {
    const db = makeTestDb();
    const consumer = await createConsumer(db, {
      app_id: 'festapp',
      callback_url: 'https://festapp.net/banksync',
      secret_cipher: 'cipher1',
      secret_hash: 'hash1',
      secret_prefix: 'abc123',
    });
    expect(consumer.app_id).toBe('festapp');
    const found = await findConsumerByAppId(db, 'festapp');
    expect(found).not.toBeNull();
    expect(found!.callback_url).toBe('https://festapp.net/banksync');
  });

  it('findConsumerByAppId returns null for unknown', async () => {
    const db = makeTestDb();
    expect(await findConsumerByAppId(db, 'nobody')).toBeNull();
  });
});

describe('rotateConsumerSecret', () => {
  it('rotation moves current cipher to prev and sets new cipher', async () => {
    const { db, sqlite } = makeTestDbWithSqlite();
    await createConsumer(db, {
      app_id: 'app1',
      callback_url: 'https://example.com',
      secret_cipher: 'c1',
      secret_hash: 'h1',
      secret_prefix: 'prefix',
    });
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await rotateConsumerSecret(db, 'app1', {
      newCipher: 'c2',
      newHash: 'h2',
      newPrefix: 'prefi2',
      prevExpiresAt: expiresAt,
    });
    const row = sqlite.prepare(`SELECT secret_cipher, prev_secret_cipher, prev_expires_at FROM webhook_consumers WHERE app_id = 'app1'`).get() as {
      secret_cipher: string; prev_secret_cipher: string | null; prev_expires_at: string | null;
    };
    expect(row.secret_cipher).toBe('c2');
    expect(row.prev_secret_cipher).toBe('c1');
    expect(row.prev_expires_at).toBe(expiresAt);
  });

  it('rotate on unknown app_id throws', async () => {
    const db = makeTestDb();
    await expect(
      rotateConsumerSecret(db, 'nobody', { newCipher: 'c', newHash: 'h', newPrefix: 'p', prevExpiresAt: '2099-01-01T00:00:00Z' }),
    ).rejects.toThrow('app_id not found');
  });
});

describe('getConsumerSecretMaterials', () => {
  it('returns null for unknown app', async () => {
    const db = makeTestDb();
    expect(await getConsumerSecretMaterials(db, 'nobody')).toBeNull();
  });

  it('prev_cipher_in_grace when prev_expires_at is in the future', async () => {
    const { db, sqlite } = makeTestDbWithSqlite();
    await createConsumer(db, {
      app_id: 'app1',
      callback_url: 'https://example.com',
      secret_cipher: 'c1',
      secret_hash: 'h1',
      secret_prefix: 'p',
    });
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    sqlite.prepare(`UPDATE webhook_consumers SET prev_secret_cipher = 'c0', prev_expires_at = ? WHERE app_id = 'app1'`).run(future);
    const result = await getConsumerSecretMaterials(db, 'app1');
    expect(result).not.toBeNull();
    expect(result!.primary_cipher).toBe('c1');
    expect(result!.prev_cipher_in_grace).toBe('c0');
  });

  it('prev_cipher_in_grace is null when prev_expires_at is in the past', async () => {
    const { db, sqlite } = makeTestDbWithSqlite();
    await createConsumer(db, {
      app_id: 'app1',
      callback_url: 'https://example.com',
      secret_cipher: 'c1',
      secret_hash: 'h1',
      secret_prefix: 'p',
    });
    const past = '2020-01-01T00:00:00.000Z';
    sqlite.prepare(`UPDATE webhook_consumers SET prev_secret_cipher = 'c0', prev_expires_at = ? WHERE app_id = 'app1'`).run(past);
    const result = await getConsumerSecretMaterials(db, 'app1');
    expect(result!.prev_cipher_in_grace).toBeNull();
  });
});

describe('subscriptions', () => {
  it('createSubscription cap: 21st throws subscription_cap_reached:20', async () => {
    const { db, sqlite } = makeTestDbWithSqlite();
    const acct = await createBankAccount(db, { account_number: '1234/2010', pairing_code: 'code0001' });
    for (let i = 0; i < 20; i++) {
      const appId = `app${i}`;
      sqlite.prepare(`INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES (?, 'https://x.com', 'c', 'h', 'p')`).run(appId);
      sqlite.prepare(`INSERT INTO webhook_subscriptions (bank_account_id, consumer_app_id) VALUES (?, ?)`).run(acct.id, appId);
    }
    // 21st consumer
    sqlite.prepare(`INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('app20', 'https://x.com', 'c', 'h', 'p')`).run();
    await expect(
      createSubscription(db, { app_id: 'app20', bank_account_id: acct.id }),
    ).rejects.toThrow('subscription_cap_reached:20');
  });

  it('createSubscription duplicate (same app+account) throws', async () => {
    const db = makeTestDb();
    const acct = await createBankAccount(db, { account_number: '1234/2010', pairing_code: 'code0001' });
    await createConsumer(db, { app_id: 'app1', callback_url: 'https://x.com', secret_cipher: 'c', secret_hash: 'h', secret_prefix: 'p' });
    await createSubscription(db, { app_id: 'app1', bank_account_id: acct.id });
    await expect(
      createSubscription(db, { app_id: 'app1', bank_account_id: acct.id }),
    ).rejects.toThrow();
  });

  it('findActiveSubscriptions returns up to 20 and warns on 21', async () => {
    const { db, sqlite } = makeTestDbWithSqlite();
    const acct = await createBankAccount(db, { account_number: '1234/2010', pairing_code: 'code0001' });
    // Pre-seed 21 rows bypassing the cap guard
    for (let i = 0; i < 21; i++) {
      const appId = `appX${i}`;
      sqlite.prepare(`INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES (?, 'https://x.com', 'c', 'h', 'p')`).run(appId);
      sqlite.prepare(`INSERT INTO webhook_subscriptions (bank_account_id, consumer_app_id) VALUES (?, ?)`).run(acct.id, appId);
    }
    const logSpy = vi.spyOn(loggerModule, 'log');
    const subs = await findActiveSubscriptions(db, acct.id);
    expect(subs).toHaveLength(20);
    expect(logSpy).toHaveBeenCalledWith('subscription_cap_warning', expect.objectContaining({ bank_account_id: acct.id }));
    logSpy.mockRestore();
  });

  it('findActiveSubscriptions under 20 does not warn', async () => {
    const db = makeTestDb();
    const acct = await createBankAccount(db, { account_number: '1234/2010', pairing_code: 'code0001' });
    await createConsumer(db, { app_id: 'app1', callback_url: 'https://x.com', secret_cipher: 'c', secret_hash: 'h', secret_prefix: 'p' });
    await createSubscription(db, { app_id: 'app1', bank_account_id: acct.id });
    const logSpy = vi.spyOn(loggerModule, 'log');
    const subs = await findActiveSubscriptions(db, acct.id);
    expect(subs).toHaveLength(1);
    expect(logSpy).not.toHaveBeenCalledWith('subscription_cap_warning', expect.anything());
    logSpy.mockRestore();
  });
});

describe('insertParseLog', () => {
  it('inserts a row with error_message', async () => {
    const { db, sqlite } = makeTestDbWithSqlite();
    await insertParseLog(db, { error_message: 'mime_parse_failed: bad content' });
    const row = sqlite.prepare(`SELECT error_message FROM parse_log`).get() as { error_message: string } | undefined;
    expect(row?.error_message).toBe('mime_parse_failed: bad content');
  });

  it('insertParseLog swallows D1 errors', async () => {
    // Create a broken D1 that always throws on run()
    const brokenDb = {
      prepare: () => ({
        bind: () => ({
          run: async () => { throw new Error('D1 transient error'); },
        }),
      }),
    } as unknown as D1Database;
    await expect(insertParseLog(brokenDb, { error_message: 'test' })).resolves.toBeUndefined();
  });
});

describe('writeEvent + pruneRetention', () => {
  it('pruneRetention deletes backdated rows and returns counts', async () => {
    const { db, sqlite } = makeTestDbWithSqlite();

    // Insert and backdate parse_log (31 days old)
    sqlite.prepare(`INSERT INTO parse_log (error_message, created_at) VALUES ('old', datetime('now', '-31 days'))`).run();
    sqlite.prepare(`INSERT INTO parse_log (error_message, created_at) VALUES ('new', datetime('now', '-1 days'))`).run();

    // Insert and backdate event_log (31 days old)
    sqlite.prepare(`INSERT INTO event_log (event_type, created_at) VALUES ('old_event', datetime('now', '-31 days'))`).run();
    sqlite.prepare(`INSERT INTO event_log (event_type, created_at) VALUES ('new_event', datetime('now', '-1 days'))`).run();

    // Insert and backdate webhook_log (91 days old)
    sqlite.prepare(`INSERT INTO webhook_log (delivery_id, consumer_app_id, attempt, created_at) VALUES ('dlv-1', 'app1', 1, datetime('now', '-91 days'))`).run();
    sqlite.prepare(`INSERT INTO webhook_log (delivery_id, consumer_app_id, attempt, created_at) VALUES ('dlv-2', 'app1', 1, datetime('now', '-1 days'))`).run();

    // Bank account + transaction for retention
    sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code) VALUES ('1234/2010', 'code0001')`).run();
    const acctId = (sqlite.prepare(`SELECT id FROM bank_accounts WHERE pairing_code = 'code0001'`).get() as { id: number }).id;
    sqlite.prepare(`INSERT INTO transactions (bank_account_id, amount_cents, currency, source, date, created_at) VALUES (?, 100, 'CZK', 'email', '2026-05-08T00:00:00Z', datetime('now', '-91 days'))`).run(acctId);
    sqlite.prepare(`INSERT INTO transactions (bank_account_id, amount_cents, currency, source, date, created_at) VALUES (?, 200, 'CZK', 'email', '2026-05-08T00:00:00Z', datetime('now', '-1 days'))`).run(acctId);

    sqlite.prepare(`INSERT INTO idempotency_keys (key_hash, auth_principal, request_path, request_method, response_status, response_body, created_at) VALUES ('old', 'admin', '/x', 'POST', 200, '{}', datetime('now', '-25 hours'))`).run();
    sqlite.prepare(`INSERT INTO admin_audit_log (auth_principal, http_method, request_path, http_status, created_at) VALUES ('admin', 'POST', '/x', 200, datetime('now', '-91 days'))`).run();

    // Expired prev_secret
    sqlite.prepare(`INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix, prev_secret_cipher, prev_expires_at) VALUES ('app1', 'https://x.com', 'c', 'h', 'p', 'old_c', datetime('now', '-1 hours'))`).run();

    const counts = await pruneRetention(db);
    expect(counts.parse_log_deleted).toBe(1);
    expect(counts.event_log_deleted).toBe(1);
    expect(counts.webhook_log_deleted).toBe(1);
    expect(counts.transactions_deleted).toBe(1);
    expect(counts.idempotency_keys_deleted).toBe(1);
    expect(counts.admin_audit_log_deleted).toBe(1);
    expect(counts.expired_prev_secrets_cleared).toBe(1);

    // Verify non-expired rows survived
    const parseSurvived = (sqlite.prepare(`SELECT COUNT(*) as n FROM parse_log`).get() as { n: number }).n;
    expect(parseSurvived).toBe(1);
  });
});

describe('writeEvent', () => {
  it('inserts event with JSON detail', async () => {
    const { db, sqlite } = makeTestDbWithSqlite();
    await writeEvent(db, { event_type: 'tx_inserted', detail: { tx_id: 42 } });
    const row = sqlite.prepare(`SELECT event_type, detail FROM event_log`).get() as { event_type: string; detail: string };
    expect(row.event_type).toBe('tx_inserted');
    expect(JSON.parse(row.detail)).toEqual({ tx_id: 42 });
  });
});

describe('insertWebhookLogEntry', () => {
  it('inserts a delivery log row', async () => {
    const { db, sqlite } = makeTestDbWithSqlite();
    await insertWebhookLogEntry(db, {
      delivery_id: 'dlv-001',
      consumer_app_id: 'app1',
      attempt: 1,
      http_status: 200,
    });
    const row = sqlite.prepare(`SELECT delivery_id, http_status FROM webhook_log`).get() as { delivery_id: string; http_status: number };
    expect(row.delivery_id).toBe('dlv-001');
    expect(row.http_status).toBe(200);
  });
});
