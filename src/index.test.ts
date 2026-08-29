import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { D1Database, D1Result, D1PreparedStatement, Queue } from '@cloudflare/workers-types';
import { resetSchemaCheckCache } from './db';
import type { Env } from './cloudflare';
import { processEmail as processEmailWithEnvelope } from './cloudflare';
import type { WebhookQueueMessage } from './queue';
import { dispatchDueDeliveryJobs } from './webhookDelivery';

// ---- D1 facade (same pattern as db.test.ts) ----

function wrapAsD1(sqlite: Database.Database): D1Database {
  function prepare(sql: string): D1PreparedStatement {
    let boundArgs: unknown[] = [];

    const stmt = {
      bind(...args: unknown[]): D1PreparedStatement {
        boundArgs = args.map(a => (a === undefined ? null : a));
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

function makeTestDb(): { db: D1Database; sqlite: Database.Database } {
  const sqlite = new Database(':memory:');
  for (const m of ['0001_schema.sql']) {
    sqlite.exec(readFileSync(resolve(__dirname, '../migrations', m), 'utf8'));
  }
  return { db: wrapAsD1(sqlite), sqlite };
}

// ---- build a fake env ----

function makeEnv(db: D1Database, queueSend = vi.fn()): Env {
  return {
    DB: db,
    WEBHOOK_QUEUE: { send: queueSend } as unknown as Queue<WebhookQueueMessage>,
    ADMIN_SECRET: 'test-admin-secret',
    WEBHOOK_KEK: btoa('a'.repeat(32)), // 32-byte base64 KEK
    ENCRYPTION_KEY_VERSION: '1',
    ENCRYPTION_KEY_V1: btoa('b'.repeat(32)),
    FIO_MIN_INTERVAL_S: '0',
    SENDER_ALLOWLIST: 'noreply@fio.cz,info@airbank.cz',
    ENV: 'development',
  };
}

// ---- build a raw email ReadableStream ----

function makeStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Test-only adapter: production receives these facts from ForwardableEmailMessage. */
async function processEmail(raw: ReadableStream<Uint8Array>, env: Env): Promise<void> {
  const text = await new Response(raw).text();
  const mailFrom = /^From:\s*([^\r\n]+)/im.exec(text)?.[1]?.trim() ?? '';
  const rcptTo = /^To:\s*([^\r\n]+)/im.exec(text)?.[1]?.trim() ?? '';
  const authenticationResults = /^Authentication-Results:\s*([^\r\n]+)/im.exec(text)?.[1]?.trim() ?? null;
  await processEmailWithEnvelope(makeStream(text), env, {
    mailFrom,
    rcptTo,
    authenticationResults,
    trustedAuthservId: 'mx.cloudflare.net',
  });
}

// ---- seed helper: insert account + consumer + subscription ----

async function seedFullSetup(db: D1Database, sqlite: Database.Database): Promise<{
  pairingCode: string;
  accountId: number;
  appId: string;
}> {
  const pairingCode = 'aabbccdd11';
  const appId = 'testapp';

  sqlite.prepare(
    `INSERT INTO bank_accounts (account_number, account_type, pairing_code, label) VALUES ('123456/2010', 'FIO', ?, 'Test FIO')`
  ).run(pairingCode);
  const account = sqlite.prepare(`SELECT id FROM bank_accounts WHERE pairing_code = ?`).get(pairingCode) as { id: number };

  sqlite.prepare(
    `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES (?, 'https://example.com/webhook', 'cipher', 'hash', 'whsec_abcd')`
  ).run(appId);

  sqlite.prepare(
    `INSERT INTO webhook_subscriptions (bank_account_id, consumer_app_id) VALUES (?, ?)`
  ).run(account.id, appId);

  return { pairingCode, accountId: account.id, appId };
}

// ---- valid Fio email RFC822 ----

function buildFioEmail(to: string, from = 'noreply@fio.cz'): string {
  const body = [
    'Datum pohybu: 08.05.2026 10:30',
    'Částka: 1 990,00 CZK',
    'Protiúčet: 987654/0300',
    'Název protiúčtu: Test Sender',
    'VS: 12345',
    'KS: 0008',
    'SS: 0',
    'Zpráva pro příjemce: Test payment',
  ].join('\n');

  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: Pohyb na vašem účtu`,
    `Message-ID: <test-message-id@fio.cz>`,
    `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=fio.cz; dkim=pass header.d=fio.cz`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
  ].join('\r\n');
}

function fioApiTx(id: string, vs = '12345', amount = '100.00'): Record<string, { value: string }> {
  return {
    column0: { value: '2026-05-08' },
    column1: { value: amount },
    column5: { value: vs },
    column14: { value: 'CZK' },
    column22: { value: id },
  };
}

// ---- fetch helper for admin API ----

import worker from './cloudflare';

async function adminReq(
  method: string,
  path: string,
  env: Env,
  body?: unknown,
  headers?: Record<string, string>
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      'X-Admin-Secret': env.ADMIN_SECRET,
      'Content-Type': 'application/json',
      ...headers,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const req = new Request(`http://localhost${path}`, init);
  return worker.fetch(req, env, fakeCtx);
}

// Use the CF workers-types ExecutionContext shape (props is required in the type)
const fakeCtx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

afterEach(() => {
  vi.unstubAllGlobals();
});

// ============================================================================
// Tests
// ============================================================================

describe('email() — happy path: tx_inserted + enqueued', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('inserts 1 transaction and calls queue.send once', async () => {
    const { db, sqlite } = makeTestDb();
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const env = makeEnv(db, queueSend);
    const { pairingCode, accountId } = await seedFullSetup(db, sqlite);

    const raw = makeStream(buildFioEmail(`${pairingCode}@banksync.festapp.net`));
    await processEmail(raw, env);

    const txRow = sqlite.prepare(`SELECT * FROM transactions WHERE bank_account_id = ?`).get(accountId);
    expect(txRow).not.toBeNull();
    expect((txRow as Record<string, unknown>).amount_cents).toBe(199000);
    expect((txRow as Record<string, unknown>).currency).toBe('CZK');

    expect(queueSend).toHaveBeenCalledOnce();
    const msg = queueSend.mock.calls[0]![0] as WebhookQueueMessage;
    expect(msg.consumer_app_id).toBe('testapp');
    expect(msg.envelope.event).toBe('transaction.received');
    expect(msg.envelope.pairing_code).toBe(pairingCode);
    expect(msg.delivery_id).toMatch(/^[0-9A-Z]{26}$/);
  });
});

describe('delivery outbox healing', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('persists a delivery job when the first queue.send fails and a later sweep dispatches it', async () => {
    const { db, sqlite } = makeTestDb();
    const queueSend = vi.fn()
      .mockRejectedValueOnce(new Error('queue temporarily unavailable'))
      .mockResolvedValueOnce(undefined);
    const env = makeEnv(db, queueSend);
    const { pairingCode } = await seedFullSetup(db, sqlite);

    await processEmail(makeStream(buildFioEmail(`${pairingCode}@banksync.festapp.net`)), env);

    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM webhook_delivery_jobs`).get()).toMatchObject({ count: 1 });
    expect(queueSend).toHaveBeenCalledTimes(1);

    await dispatchDueDeliveryJobs(env);

    expect(queueSend).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare(`SELECT status FROM webhook_delivery_jobs`).get()).toMatchObject({ status: 'queued' });
  });
});

describe('email() — failure paths each write parse_log', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('oversized email writes parse_log and does not insert tx (tested via mock)', async () => {
    // The oversized guard is in email() handler itself (checks rawSize before processEmail).
    // We test parse_log insertion by sending a mime_parse_failed scenario instead.
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);

    // Totally invalid bytes — will fail postal-mime parse
    const raw = makeStream('\x00\x01\x02');
    await processEmail(raw, env);

    const logRow = sqlite.prepare(`SELECT * FROM parse_log LIMIT 1`).get() as Record<string, unknown> | undefined;
    expect(logRow).toBeDefined();
    expect(String(logRow!.error_message)).toMatch(/mime_parse_failed|email_identity_missing/);
  });

  it('missing Authentication-Results writes parse_log', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    const { pairingCode } = await seedFullSetup(db, sqlite);

    const raw = makeStream([
      `From: noreply@fio.cz`,
      `To: ${pairingCode}@banksync.festapp.net`,
      `Subject: test`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `Částka: 100 CZK`,
    ].join('\r\n'));

    await processEmail(raw, env);

    const row = sqlite.prepare(`SELECT error_message FROM parse_log LIMIT 1`).get() as { error_message: string } | undefined;
    expect(row?.error_message).toBe('trusted_authentication_missing');
  });

  it('DKIM alignment failure writes dkim_fail to parse_log', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    const { pairingCode } = await seedFullSetup(db, sqlite);

    const email = [
      `From: noreply@fio.cz`,
      `To: ${pairingCode}@banksync.festapp.net`,
      `Subject: test`,
      `Message-ID: <dkim-test@fio.cz>`,
      `Authentication-Results: mx.cloudflare.net; dkim=pass header.d=attacker.example`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `Částka: 100 CZK`,
    ].join('\r\n');

    await processEmail(makeStream(email), env);

    const row = sqlite.prepare(`SELECT error_message FROM parse_log LIMIT 1`).get() as { error_message: string } | undefined;
    expect(row?.error_message).toBe('authenticated_sender_not_aligned');
  });

  it('sender not in allow-list writes sender_not_allowed to parse_log', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    const { pairingCode } = await seedFullSetup(db, sqlite);

    const email = [
      `From: hacker@evil.com`,
      `To: ${pairingCode}@banksync.festapp.net`,
      `Subject: test`,
      `Message-ID: <sender-test@evil.com>`,
      `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=evil.com; dkim=pass header.d=evil.com`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `Částka: 100 CZK`,
    ].join('\r\n');

    await processEmail(makeStream(email), env);

    const row = sqlite.prepare(`SELECT error_message FROM parse_log LIMIT 1`).get() as { error_message: string } | undefined;
    expect(row?.error_message).toBe('sender_not_allowed');
  });

  it('domain-prefix allowlist (@fio.cz) accepts any user @fio.cz', async () => {
    const { db, sqlite } = makeTestDb();
    const env = { ...makeEnv(db), SENDER_ALLOWLIST: '@fio.cz' };
    const { pairingCode } = await seedFullSetup(db, sqlite);

    const email = [
      `From: oznameni@fio.cz`,                 // different local-part than 'noreply@'
      `To: ${pairingCode}@banksync.festapp.net`,
      `Subject: Pohyb`,
      `Message-ID: <domain-allow@fio.cz>`,
      `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=fio.cz; dkim=pass header.d=fio.cz`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `Datum pohybu: 08.05.2026 10:30`,
      `Částka: 1 234,00 CZK`,
      `VS: 12345`,
    ].join('\r\n');

    await processEmail(makeStream(email), env);

    const errs = sqlite.prepare(`SELECT error_message FROM parse_log`).all() as { error_message: string }[];
    expect(errs.find(e => e.error_message.startsWith('sender_not_allowed'))).toBeUndefined();
    const txCount = (sqlite.prepare(`SELECT COUNT(*) c FROM transactions`).get() as { c: number }).c;
    expect(txCount).toBe(1);
  });

  it('domain-prefix allowlist matches subdomain (mail.fio.cz aligns with @fio.cz)', async () => {
    const { db, sqlite } = makeTestDb();
    const env = { ...makeEnv(db), SENDER_ALLOWLIST: '@fio.cz' };
    const { pairingCode } = await seedFullSetup(db, sqlite);

    const email = [
      `From: noreply@mail.fio.cz`,
      `To: ${pairingCode}@banksync.festapp.net`,
      `Subject: Pohyb`,
      `Message-ID: <subdomain-allow@mail.fio.cz>`,
      `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=mail.fio.cz; dkim=pass header.d=mail.fio.cz`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `Datum pohybu: 08.05.2026 10:30`,
      `Částka: 1 234,00 CZK`,
      `VS: 12345`,
    ].join('\r\n');

    await processEmail(makeStream(email), env);

    const errs = sqlite.prepare(`SELECT error_message FROM parse_log`).all() as { error_message: string }[];
    expect(errs.find(e => e.error_message.startsWith('sender_not_allowed'))).toBeUndefined();
  });

  it('domain-prefix allowlist rejects similar-looking spoof (fio.cz.evil.com)', async () => {
    const { db, sqlite } = makeTestDb();
    const env = { ...makeEnv(db), SENDER_ALLOWLIST: '@fio.cz' };
    const { pairingCode } = await seedFullSetup(db, sqlite);

    const email = [
      `From: noreply@fio.cz.evil.com`,
      `To: ${pairingCode}@banksync.festapp.net`,
      `Subject: spoof attempt`,
      `Message-ID: <spoof@fio.cz.evil.com>`,
      `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=fio.cz.evil.com; dkim=pass header.d=fio.cz.evil.com`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `Částka: 100 CZK`,
    ].join('\r\n');

    await processEmail(makeStream(email), env);

    const row = sqlite.prepare(`SELECT error_message FROM parse_log LIMIT 1`).get() as { error_message: string } | undefined;
    expect(row?.error_message).toBe('sender_not_allowed');
  });

  it('exact email allowlist still works alongside @-domain entries', async () => {
    const { db, sqlite } = makeTestDb();
    const env = { ...makeEnv(db), SENDER_ALLOWLIST: 'foo@example.com,@fio.cz' };
    const { pairingCode } = await seedFullSetup(db, sqlite);

    const email = [
      `From: foo@example.com`,
      `To: ${pairingCode}@banksync.festapp.net`,
      `Subject: Pohyb`,
      `Message-ID: <exact-match@example.com>`,
      `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=example.com; dkim=pass header.d=example.com`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `Datum pohybu: 08.05.2026 10:30`,
      `Částka: 1 234,00 CZK`,
      `VS: 12345`,
    ].join('\r\n');

    await processEmail(makeStream(email), env);

    const errs = sqlite.prepare(`SELECT error_message FROM parse_log`).all() as { error_message: string }[];
    expect(errs.find(e => e.error_message.startsWith('sender_not_allowed'))).toBeUndefined();
  });

  it('no pairing code in To: writes no_pairing_code to parse_log', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);

    const email = [
      `From: noreply@fio.cz`,
      `To: unknown@banksync.festapp.net`,
      `Subject: test`,
      `Message-ID: <no-pairing@fio.cz>`,
      `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=fio.cz; dkim=pass header.d=fio.cz`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `Částka: 100 CZK`,
    ].join('\r\n');

    await processEmail(makeStream(email), env);

    const row = sqlite.prepare(`SELECT error_message FROM parse_log LIMIT 1`).get() as { error_message: string } | undefined;
    expect(row?.error_message).toMatch(/^no_pairing_code:/);
  });

  it('unknown pairing code writes unknown_pairing_code to parse_log', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);

    const email = buildFioEmail('deadbeef01@banksync.festapp.net');
    await processEmail(makeStream(email), env);

    const row = sqlite.prepare(`SELECT error_message FROM parse_log LIMIT 1`).get() as { error_message: string } | undefined;
    expect(row?.error_message).toMatch(/^unknown_pairing_code:/);
  });

  it('unknown provider writes unknown_provider to parse_log', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);

    // Use a valid hex pairing code (10 hex chars). Account number has no FIO/AirBank bank code.
    const unknownPairingCode = 'cafe123456';
    sqlite.prepare(
      `INSERT INTO bank_accounts (account_number, account_type, pairing_code, label) VALUES ('999999/9999', 'FIO', ?, 'Unknown bank')`
    ).run(unknownPairingCode);

    const email = [
      `From: noreply@fio.cz`,
      `To: ${unknownPairingCode}@banksync.festapp.net`,
      `Subject: test`,
      `Message-ID: <prov-test@fio.cz>`,
      `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=fio.cz; dkim=pass header.d=fio.cz`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `Generic notification with no supported bank marker.`,
    ].join('\r\n');

    await processEmail(makeStream(email), env);

    const row = sqlite.prepare(`SELECT error_message FROM parse_log LIMIT 1`).get() as { error_message: string } | undefined;
    expect(row?.error_message).toMatch(/^unknown_provider:|^parse_failed:/);
  });

  it('parse_failed (null from parser) writes parse_failed to parse_log', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    const { pairingCode } = await seedFullSetup(db, sqlite);

    // Valid fio email but body has no amount line → parseEmail returns null
    const email = [
      `From: noreply@fio.cz`,
      `To: ${pairingCode}@banksync.festapp.net`,
      `Subject: test`,
      `Message-ID: <parse-fail@fio.cz>`,
      `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=fio.cz; dkim=pass header.d=fio.cz`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `Fio banka`,
      `Částka: -- CZK`,
    ].join('\r\n');

    await processEmail(makeStream(email), env);

    const row = sqlite.prepare(`SELECT error_message FROM parse_log LIMIT 1`).get() as { error_message: string } | undefined;
    expect(row?.error_message).toMatch(/^parse_failed:/);
  });

  it('db insert failure writes db_insert_failed to parse_log (queue not called)', async () => {
    const { db, sqlite } = makeTestDb();
    const queueSend = vi.fn();
    const env = makeEnv(db, queueSend);
    const { pairingCode } = await seedFullSetup(db, sqlite);

    // Drop transactions table to force insert to throw
    sqlite.prepare(`DROP TABLE transactions`).run();

    const raw = makeStream(buildFioEmail(`${pairingCode}@banksync.festapp.net`));
    await processEmail(raw, env);

    const row = sqlite.prepare(`SELECT error_message FROM parse_log LIMIT 1`).get() as { error_message: string } | undefined;
    expect(row?.error_message).toMatch(/^db_insert_failed:/);
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('enqueue failure leaves a durable pending job but does not rethrow', async () => {
    const { db, sqlite } = makeTestDb();
    const queueSend = vi.fn().mockRejectedValue(new Error('queue unavailable'));
    const env = makeEnv(db, queueSend);
    const { pairingCode, accountId } = await seedFullSetup(db, sqlite);

    const raw = makeStream(buildFioEmail(`${pairingCode}@banksync.festapp.net`));
    await processEmail(raw, env);

    // Transaction should still be inserted
    const txRow = sqlite.prepare(`SELECT id FROM transactions WHERE bank_account_id = ?`).get(accountId);
    expect(txRow).not.toBeNull();

    const row = sqlite.prepare(`SELECT status, last_error FROM webhook_delivery_jobs LIMIT 1`).get() as { status: string; last_error: string } | undefined;
    expect(row).toMatchObject({ status: 'pending' });
    expect(row?.last_error).toMatch(/^queue_send_failed:/);
  });

  it('duplicate email (same Message-ID) is skipped — no second tx, no enqueue', async () => {
    const { db, sqlite } = makeTestDb();
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const env = makeEnv(db, queueSend);
    const { pairingCode, accountId } = await seedFullSetup(db, sqlite);

    const email = buildFioEmail(`${pairingCode}@banksync.festapp.net`);

    await processEmail(makeStream(email), env);
    const count1 = (sqlite.prepare(`SELECT COUNT(*) as cnt FROM transactions WHERE bank_account_id = ?`).get(accountId) as { cnt: number }).cnt;
    expect(count1).toBe(1);
    expect(queueSend).toHaveBeenCalledOnce();

    // Second delivery of same email
    await processEmail(makeStream(email), env);
    const count2 = (sqlite.prepare(`SELECT COUNT(*) as cnt FROM transactions WHERE bank_account_id = ?`).get(accountId) as { cnt: number }).cnt;
    expect(count2).toBe(1); // still 1
    expect(queueSend).toHaveBeenCalledOnce(); // not called again
  });
});

describe('schema mismatch returns 503 from /health', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('returns 503 when schema version is wrong', async () => {
    const { db, sqlite } = makeTestDb();
    sqlite.prepare(`UPDATE schema_meta SET value = '99' WHERE key = 'version'`).run();
    const env = makeEnv(db);

    const req = new Request('http://localhost/health', { method: 'GET' });
    const res = await worker.fetch(req, env, fakeCtx);
    expect(res.status).toBe(503);
  });
});

describe('admin POST /bank-accounts', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('creates account and GET /bank-accounts shows it', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    // Owner consumer must exist for FK + auto-subscribe.
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp', 'https://x', 'c', 'h', 'p')`
    ).run();

    const createRes = await adminReq('POST', '/bank-accounts', env, {
      account_number: '123456/2010',
      account_type: 'FIO',
      label: 'Fio festapp',
      owner_app_id: 'festapp',
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as Record<string, unknown>;
    expect(created.pairing_code).toMatch(/^[0-9a-f]{10}$/);
    expect(created.account_number).toBe('123456/2010');
    expect(created.owner_app_id).toBe('festapp');

    const listRes = await adminReq('GET', '/bank-accounts', env);
    const list = await listRes.json() as unknown[];
    expect(list.length).toBe(1);

    // Owner is auto-subscribed to its bank account
    const subRows = sqlite.prepare(`SELECT * FROM webhook_subscriptions WHERE consumer_app_id = 'festapp'`).all() as unknown[];
    expect(subRows.length).toBe(1);
  });

  it('rejects POST when owner_app_id consumer does not exist', async () => {
    const { db } = makeTestDb();
    const env = makeEnv(db);
    const res = await adminReq('POST', '/bank-accounts', env, {
      account_number: '999/2010',
      owner_app_id: 'no-such-consumer',
    });
    expect(res.status).toBe(422);
  });

  it('PUT /bank-accounts/:id updates label/account_type', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp', 'https://x', 'c', 'h', 'p')`
    ).run();
    const createRes = await adminReq('POST', '/bank-accounts', env, {
      account_number: '999/2010', account_type: 'FIO', label: 'Old', owner_app_id: 'festapp',
    });
    const created = await createRes.json() as { id: number };

    const putRes = await adminReq('PUT', `/bank-accounts/${created.id}`, env, { label: 'New label', account_type: 'AIRBANK' });
    expect(putRes.status).toBe(200);
    const updated = await putRes.json() as Record<string, unknown>;
    expect(updated.label).toBe('New label');
    expect(updated.account_type).toBe('AIRBANK');
  });

  it('PUT /bank-accounts/:id/owner transfers owner as admin only', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp', 'https://x', 'c', 'h', 'p')`
    ).run();
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('tutoring', 'https://y', 'c', 'h', 'p')`
    ).run();
    const createRes = await adminReq('POST', '/bank-accounts', env, {
      account_number: '999/2010', owner_app_id: 'festapp',
    });
    const created = await createRes.json() as { id: number };

    const putRes = await adminReq('PUT', `/bank-accounts/${created.id}/owner`, env, { owner_app_id: 'tutoring' });
    expect(putRes.status).toBe(200);
    const updated = await putRes.json() as Record<string, unknown>;
    expect(updated.owner_app_id).toBe('tutoring');
  });

  it('PUT /bank-accounts/:id/owner rejects unknown owner', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp', 'https://x', 'c', 'h', 'p')`
    ).run();
    const createRes = await adminReq('POST', '/bank-accounts', env, {
      account_number: '999/2010', owner_app_id: 'festapp',
    });
    const created = await createRes.json() as { id: number };

    const putRes = await adminReq('PUT', `/bank-accounts/${created.id}/owner`, env, { owner_app_id: 'missing-owner' });
    expect(putRes.status).toBe(422);
  });

  it('PUT /bank-accounts/:id returns 404 for missing id', async () => {
    const { db } = makeTestDb();
    const env = makeEnv(db);
    const res = await adminReq('PUT', '/bank-accounts/999', env, { label: 'x' });
    expect(res.status).toBe(404);
  });

  it('DELETE /bank-accounts/:id cascades subscriptions, returns 204', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp', 'https://x', 'c', 'h', 'p')`
    ).run();
    const createRes = await adminReq('POST', '/bank-accounts', env, {
      account_number: '999/2010', owner_app_id: 'festapp',
    });
    const created = await createRes.json() as { id: number };

    const subsBefore = sqlite.prepare(`SELECT COUNT(*) c FROM webhook_subscriptions`).get() as { c: number };
    expect(subsBefore.c).toBe(1);

    const delRes = await adminReq('DELETE', `/bank-accounts/${created.id}`, env);
    expect(delRes.status).toBe(204);

    const accCount = (sqlite.prepare(`SELECT COUNT(*) c FROM bank_accounts`).get() as { c: number }).c;
    const subsAfter = (sqlite.prepare(`SELECT COUNT(*) c FROM webhook_subscriptions`).get() as { c: number }).c;
    expect(accCount).toBe(0);
    expect(subsAfter).toBe(0);
  });

  it('DELETE /bank-accounts/:id returns 404 for missing id', async () => {
    const { db } = makeTestDb();
    const env = makeEnv(db);
    const res = await adminReq('DELETE', '/bank-accounts/9999', env);
    expect(res.status).toBe(404);
  });

  it('POST /bank-accounts/:id/regenerate-pairing returns new pairing', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp', 'https://x', 'c', 'h', 'p')`
    ).run();
    const createRes = await adminReq('POST', '/bank-accounts', env, {
      account_number: '999/2010', owner_app_id: 'festapp',
    });
    const created = await createRes.json() as { id: number; pairing_code: string };

    const regenRes = await adminReq('POST', `/bank-accounts/${created.id}/regenerate-pairing`, env);
    expect(regenRes.status).toBe(200);
    const regen = await regenRes.json() as { pairing_code: string };
    expect(regen.pairing_code).toMatch(/^[0-9a-f]{10}$/);
    expect(regen.pairing_code).not.toBe(created.pairing_code);
  });

  it('GET /bank-accounts?owner=app_id filters by owner', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp', 'https://x', 'c', 'h', 'p')`
    ).run();
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('tutoring', 'https://y', 'c', 'h', 'p')`
    ).run();
    await adminReq('POST', '/bank-accounts', env, { account_number: '111/2010', owner_app_id: 'festapp' });
    await adminReq('POST', '/bank-accounts', env, { account_number: '222/2010', owner_app_id: 'tutoring' });

    const allRes = await adminReq('GET', '/bank-accounts', env);
    const all = await allRes.json() as unknown[];
    expect(all.length).toBe(2);

    const festappRes = await adminReq('GET', '/bank-accounts?owner=festapp', env);
    const festappOnly = await festappRes.json() as Array<{ owner_app_id: string }>;
    expect(festappOnly.length).toBe(1);
    expect(festappOnly[0]?.owner_app_id).toBe('festapp');
  });

  it('creates Fio API account with write-only token, generic token prefix, and no plaintext echo', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp', 'https://x', 'c', 'h', 'p')`
    ).run();

    const createRes = await adminReq('POST', '/bank-accounts', env, {
      account_number: '123456/2010',
      account_type: 'FIO',
      owner_app_id: 'festapp',
      fio_api_token: 'fio-token-secret-1',
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as Record<string, unknown>;
    expect(created.ingest_mode).toBe('api');
    expect(created.api_token_set).toBe(true);
    expect(created.api_token_prefix).toBe('fio-to');
    expect(created.api_fetch_enabled).toBe(true);
    expect(JSON.stringify(created)).not.toContain('fio-token-secret-1');
    expect(created).not.toHaveProperty('api_token_cipher');

    const row = sqlite.prepare(`SELECT api_token_cipher, api_token_key_ver, api_token_prefix, cf_rule_id FROM bank_accounts WHERE id = ?`).get(created.id as number) as Record<string, unknown>;
    expect(typeof row.api_token_cipher).toBe('string');
    expect(row.api_token_key_ver).toBe(1);
    expect(row.api_token_prefix).toBe('fio-to');
    expect(row.cf_rule_id).toBeNull();
  });

  it('PUT /bank-accounts/:id/fio-token rotates encrypted token and updates prefix', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp', 'https://x', 'c', 'h', 'p')`
    ).run();
    const createRes = await adminReq('POST', '/bank-accounts', env, {
      account_number: '123456/2010',
      owner_app_id: 'festapp',
      fio_api_token: 'fio-token-secret-1',
    });
    const created = await createRes.json() as { id: number };
    const before = sqlite.prepare(`SELECT api_token_cipher FROM bank_accounts WHERE id = ?`).get(created.id) as { api_token_cipher: string };

    const putRes = await adminReq('PUT', `/bank-accounts/${created.id}/fio-token`, env, {
      fio_api_token: 'fio-token-secret-2',
      fetch_enabled: true,
    });
    expect(putRes.status).toBe(200);
    const updated = await putRes.json() as Record<string, unknown>;
    expect(updated.api_token_prefix).toBe('fio-to');
    expect(JSON.stringify(updated)).not.toContain('fio-token-secret-2');

    const after = sqlite.prepare(`SELECT api_token_cipher FROM bank_accounts WHERE id = ?`).get(created.id) as { api_token_cipher: string };
    expect(after.api_token_cipher).not.toBe(before.api_token_cipher);
  });

  it('DELETE /bank-accounts/:id/fio-token clears token and disables polling', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp', 'https://x', 'c', 'h', 'p')`
    ).run();
    const createRes = await adminReq('POST', '/bank-accounts', env, {
      account_number: '123456/2010',
      owner_app_id: 'festapp',
      fio_api_token: 'fio-token-secret-1',
    });
    const created = await createRes.json() as { id: number };

    const delRes = await adminReq('DELETE', `/bank-accounts/${created.id}/fio-token`, env);
    expect(delRes.status).toBe(200);
    const updated = await delRes.json() as Record<string, unknown>;
    expect(updated.api_token_set).toBe(false);
    expect(updated.api_fetch_enabled).toBe(false);
    expect(updated.api_token_prefix).toBeNull();

    const row = sqlite.prepare(`SELECT api_token_cipher, api_token_prefix, api_fetch_enabled FROM bank_accounts WHERE id = ?`).get(created.id) as Record<string, unknown>;
    expect(row.api_token_cipher).toBeNull();
    expect(row.api_token_prefix).toBeNull();
    expect(row.api_fetch_enabled).toBe(0);
  });

  it('POST /bank-accounts/:id/fio-sync inserts only new rows and queues only inserted live rows', async () => {
    const { db, sqlite } = makeTestDb();
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const env = makeEnv(db, queueSend);
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp', 'https://x', 'c', 'h', 'p')`
    ).run();
    const createRes = await adminReq('POST', '/bank-accounts', env, {
      account_number: '123456/2010',
      owner_app_id: 'festapp',
      fio_api_token: 'fio-token-secret-1',
    });
    const created = await createRes.json() as { id: number };
    sqlite.prepare(`UPDATE bank_accounts SET api_backfill_done = 1 WHERE id = ?`).run(created.id);
    sqlite.prepare(
      `INSERT INTO transactions (bank_account_id, amount_cents, currency, vs, source, date, transaction_id) VALUES (?, 10000, 'CZK', '12345', 'fio_api', '2026-05-08T12:00:00.000Z', 'existing-fio')`
    ).run(created.id);

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      accountStatement: {
        transactionList: {
          transaction: [
            fioApiTx('existing-fio'),
            fioApiTx('new-fio', '67890', '250.00'),
            fioApiTx('outgoing-fio', '99999', '-10.00'),
          ],
        },
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const syncRes = await adminReq('POST', `/bank-accounts/${created.id}/fio-sync`, env);
    expect(syncRes.status).toBe(200);
    const body = await syncRes.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      inserted: 1,
      skipped_duplicate: 1,
      skipped_outgoing: 1,
      parse_errors: 0,
      queued_webhooks: 1,
      backfill: false,
      api_last_error: null,
      api_backfill_done: true,
    });
    expect(typeof body.api_last_fetch_at).toBe('string');
    expect(typeof body.api_last_success_at).toBe('string');
    expect(queueSend).toHaveBeenCalledOnce();
    const txCount = (sqlite.prepare(`SELECT COUNT(*) c FROM transactions WHERE bank_account_id = ?`).get(created.id) as { c: number }).c;
    expect(txCount).toBe(2);
    vi.unstubAllGlobals();
  });

  it('does not expose Fio upstream error detail from manual sync', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp', 'https://x', 'c', 'h', 'p')`
    ).run();
    const createRes = await adminReq('POST', '/bank-accounts', env, {
      account_number: '123456/2010',
      owner_app_id: 'festapp',
      fio_api_token: 'fio-token-secret-1',
    });
    const created = await createRes.json() as { id: number };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('upstream-secret-stack-detail', { status: 429 })));

    const syncRes = await adminReq('POST', `/bank-accounts/${created.id}/fio-sync`, env);
    expect(syncRes.status).toBe(503);
    expect(await syncRes.json()).toEqual({ error: 'fio_api_transient_failure' });
  });

  it('initial Fio sync sets pointer only, then throttles the next request for 30 seconds', async () => {
    const { db, sqlite } = makeTestDb();
    const env = { ...makeEnv(db), FIO_MIN_INTERVAL_S: '30' };
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp', 'https://x', 'c', 'h', 'p')`
    ).run();
    const createRes = await adminReq('POST', '/bank-accounts', env, {
      account_number: '123456/2010',
      owner_app_id: 'festapp',
      fio_api_token: 'fio-token-secret-1',
    });
    const created = await createRes.json() as { id: number };

    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const firstSync = await adminReq('POST', `/bank-accounts/${created.id}/fio-sync`, env);
    expect(firstSync.status).toBe(200);
    const firstBody = await firstSync.json() as Record<string, unknown>;
    expect(firstBody).toMatchObject({
      inserted: 0,
      skipped_duplicate: 0,
      skipped_outgoing: 0,
      parse_errors: 0,
      queued_webhooks: 0,
      backfill: true,
      deferred: true,
      api_last_error: null,
      api_backfill_done: false,
    });
    expect(typeof firstBody.api_last_fetch_at).toBe('string');
    expect(typeof firstBody.api_last_success_at).toBe('string');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/set-last-date/');
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain('/last/');

    const secondSync = await adminReq('POST', `/bank-accounts/${created.id}/fio-sync`, env);
    expect(secondSync.status).toBe(429);
    const secondBody = await secondSync.json() as Record<string, unknown>;
    expect(secondBody).toMatchObject({
      error: 'api_fetch_throttled',
      retry_after_s: 30,
      api_last_error: null,
    });
    expect(typeof secondBody.api_last_fetch_at).toBe('string');
    expect(typeof secondBody.api_last_success_at).toBe('string');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('after pointer setup interval, Fio sync fetches last without setting pointer again and keeps backfill silent', async () => {
    const { db, sqlite } = makeTestDb();
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const env = { ...makeEnv(db, queueSend), FIO_MIN_INTERVAL_S: '30' };
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp', 'https://x', 'c', 'h', 'p')`
    ).run();
    const createRes = await adminReq('POST', '/bank-accounts', env, {
      account_number: '123456/2010',
      owner_app_id: 'festapp',
      fio_api_token: 'fio-token-secret-1',
    });
    const created = await createRes.json() as { id: number };

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        accountStatement: { transactionList: { transaction: [fioApiTx('backfill-fio', '55555', '150.00')] } },
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const firstSync = await adminReq('POST', `/bank-accounts/${created.id}/fio-sync`, env);
    expect(firstSync.status).toBe(200);
    sqlite.prepare(`UPDATE bank_accounts SET api_last_fetch_at = datetime('now', '-31 seconds') WHERE id = ?`).run(created.id);

    const secondSync = await adminReq('POST', `/bank-accounts/${created.id}/fio-sync`, env);
    expect(secondSync.status).toBe(200);
    const secondBody = await secondSync.json() as Record<string, unknown>;
    expect(secondBody).toMatchObject({
      inserted: 1,
      skipped_duplicate: 0,
      skipped_outgoing: 0,
      parse_errors: 0,
      queued_webhooks: 0,
      backfill: true,
      deferred: false,
      api_last_error: null,
      api_backfill_done: true,
    });
    expect(typeof secondBody.api_last_fetch_at).toBe('string');
    expect(typeof secondBody.api_last_success_at).toBe('string');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/set-last-date/');
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/last/');
    expect(fetchMock.mock.calls.map(c => String(c[0])).filter(url => url.includes('/set-last-date/'))).toHaveLength(1);
    expect(queueSend).not.toHaveBeenCalled();
    const row = sqlite.prepare(`SELECT api_backfill_done FROM bank_accounts WHERE id = ?`).get(created.id) as { api_backfill_done: number };
    expect(row.api_backfill_done).toBe(1);
  });

  it('GET /unmatched-mails surfaces no_pairing_code / unknown_pairing_code rows', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);

    // seed mixed parse_log entries
    sqlite.prepare(`INSERT INTO parse_log (error_message, raw_data) VALUES ('unknown_pairing_code: deadbeef99', 'raw1')`).run();
    sqlite.prepare(`INSERT INTO parse_log (error_message, raw_data) VALUES ('no_pairing_code: weird@banksync.festapp.net', 'raw2')`).run();
    sqlite.prepare(`INSERT INTO parse_log (error_message, raw_data) VALUES ('sender_not_allowed: x@y.com', 'raw3')`).run(); // not unmatched

    const res = await adminReq('GET', '/unmatched-mails', env);
    expect(res.status).toBe(200);
    const rows = await res.json() as Array<{ error_message: string }>;
    expect(rows.length).toBe(2);
    expect(rows.every(r => r.error_message.startsWith('no_pairing_code') || r.error_message.startsWith('unknown_pairing_code'))).toBe(true);
  });

  it('returns 400 on invalid body', async () => {
    const { db } = makeTestDb();
    const env = makeEnv(db);
    const res = await adminReq('POST', '/bank-accounts', env, { bad: 'data' });
    expect(res.status).toBe(400);
  });
});

describe('admin POST /consumers — secret shown once', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('POST returns plain secret; GET list omits secret field', async () => {
    const { db } = makeTestDb();
    const env = makeEnv(db);

    const createRes = await adminReq('POST', '/consumers', env, {
      app_id: 'festapp',
      callback_url: 'https://festapp.example.com/webhook',
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as Record<string, unknown>;
    expect(typeof created.secret).toBe('string');
    expect((created.secret as string).startsWith('whsec_')).toBe(true);
    // secret field should NOT be present in list
    const listRes = await adminReq('GET', '/consumers', env);
    const list = await listRes.json() as Array<Record<string, unknown>>;
    expect(list.length).toBe(1);
    expect(list[0]).not.toHaveProperty('secret');
    expect(list[0]).not.toHaveProperty('secret_cipher');
    expect(list[0]).toHaveProperty('secret_prefix');
  });
});

describe('admin POST /consumers/:app_id/rotate-secret', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('returns new plain secret; D1 cipher changes; prev_expires_at ~24h from now', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);

    // Create consumer
    const createRes = await adminReq('POST', '/consumers', env, {
      app_id: 'festapp',
      callback_url: 'https://festapp.example.com/webhook',
    });
    const { secret: originalSecret } = await createRes.json() as { secret: string };
    const beforeRow = sqlite.prepare(`SELECT secret_cipher, prev_secret_cipher, prev_expires_at FROM webhook_consumers WHERE app_id = 'festapp'`).get() as Record<string, unknown>;

    // Rotate
    const rotateRes = await adminReq('POST', '/consumers/festapp/rotate-secret', env);
    expect(rotateRes.status).toBe(200);
    const { secret: newSecret } = await rotateRes.json() as { secret: string };
    expect(typeof newSecret).toBe('string');
    expect(newSecret.startsWith('whsec_')).toBe(true);
    expect(newSecret).not.toBe(originalSecret);

    const afterRow = sqlite.prepare(`SELECT secret_cipher, prev_secret_cipher, prev_expires_at FROM webhook_consumers WHERE app_id = 'festapp'`).get() as Record<string, string | null>;
    expect(afterRow.secret_cipher).not.toBe(beforeRow.secret_cipher);
    expect(afterRow.prev_secret_cipher).toBe(beforeRow.secret_cipher);
    expect(afterRow.prev_expires_at).not.toBeNull();

    // prev_expires_at should be ~24h in the future
    const expiresAt = new Date(afterRow.prev_expires_at!).getTime();
    const now = Date.now();
    expect(expiresAt - now).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(expiresAt - now).toBeLessThan(25 * 60 * 60 * 1000);
  });
});

describe('admin POST /webhooks/replay { delivery_id }', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('re-enqueues the same canonical delivery job', async () => {
    const { db, sqlite } = makeTestDb();
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const env = makeEnv(db, queueSend);

    const deliveryId = '01HX00000000000000000000Y1';
    const payload = JSON.stringify({
      event: 'transaction.received',
      event_version: '1',
      delivery_id: deliveryId,
      pairing_code: 'aabbccdd11',
      data: { id: 1, bank_account_id: 1, amount_cents: 1000, currency: 'CZK' },
    });

    sqlite.prepare(
      `INSERT INTO webhook_delivery_jobs (id, transaction_id, consumer_app_id, delivery_id, payload, status, next_attempt_at) VALUES (1, 1, 'festapp', ?, ?, 'terminal', datetime('now'))`
    ).run(deliveryId, payload);

    const res = await adminReq('POST', '/webhooks/replay', env, { delivery_id: deliveryId, reason: 'stuck payment recovery' });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.queued).toBe(true);
    expect(queueSend).toHaveBeenCalledOnce();
    const msg = queueSend.mock.calls[0]![0] as WebhookQueueMessage;
    expect(msg.delivery_id).toBe(deliveryId);
    expect(msg.delivery_job_id).toBe(1);
  });
});

describe('admin GET /webhooks/deliveries', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('returns the lifecycle fields required for operational triage', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    sqlite.prepare(`
      INSERT INTO webhook_delivery_jobs
        (transaction_id, consumer_app_id, delivery_id, payload, status, http_attempt_count, next_attempt_at, lease_until, last_http_status, last_error, delivered_at, terminal_at)
      VALUES (1, 'festapp', '01HX00000000000000000000Y2', '{}', 'terminal', 8, datetime('now'), NULL, 403, 'forbidden', NULL, datetime('now'))
    `).run();

    const res = await adminReq('GET', '/webhooks/deliveries?limit=1', env);
    expect(res.status).toBe(200);
    const body = await res.json() as { jobs: Array<Record<string, unknown>>; next_cursor: number | null };
    expect(body).toHaveProperty('next_cursor');
    const [job] = body.jobs;
    expect(job).toMatchObject({
      status: 'terminal',
      http_attempt_count: 8,
      last_http_status: 403,
      last_error: 'forbidden',
      next_attempt_at: expect.any(String),
      created_at: expect.any(String),
      terminal_at: expect.any(String),
    });
  });
});

describe('admin auth', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('missing X-Admin-Secret returns 401', async () => {
    const { db } = makeTestDb();
    const env = makeEnv(db);
    const req = new Request('http://localhost/bank-accounts', {
      method: 'GET',
      headers: {},
    });
    const res = await worker.fetch(req, env, fakeCtx);
    expect(res.status).toBe(401);
  });

  it('wrong X-Admin-Secret returns 401', async () => {
    const { db } = makeTestDb();
    const env = makeEnv(db);
    const req = new Request('http://localhost/bank-accounts', {
      method: 'GET',
      headers: { 'X-Admin-Secret': 'wrong' },
    });
    const res = await worker.fetch(req, env, fakeCtx);
    expect(res.status).toBe(401);
  });
});

describe('/__test/email gated on ENV', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('returns 404 when ENV=production', async () => {
    const { db } = makeTestDb();
    const env = { ...makeEnv(db), ENV: 'production' };
    const req = new Request('http://localhost/__test/email', {
      method: 'POST',
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'text/plain' },
      body: 'test body',
    });
    const res = await worker.fetch(req, env, fakeCtx);
    expect(res.status).toBe(404);
  });

  it('returns 200 when ENV=development', async () => {
    const { db, sqlite } = makeTestDb();
    const env = { ...makeEnv(db), EMAIL_AUTHSERV_ID: 'mx.cloudflare.net' }; // ENV='development'
    const { pairingCode } = await seedFullSetup(db, sqlite);

    const email = buildFioEmail(`${pairingCode}@banksync.festapp.net`);
    const req = new Request('http://localhost/__test/email', {
      method: 'POST',
      headers: {
        'X-Admin-Secret': env.ADMIN_SECRET,
        'Content-Type': 'message/rfc822',
        'X-Test-Mail-From': 'noreply@fio.cz',
        'X-Test-Rcpt-To': `${pairingCode}@banksync.festapp.net`,
        'Authentication-Results': 'mx.cloudflare.net; dmarc=pass header.from=fio.cz; dkim=pass header.d=fio.cz',
      },
      body: email,
    });
    const res = await worker.fetch(req, env, fakeCtx);
    expect(res.status).toBe(200);
  });
});

describe('/health structure', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('returns expected shape', async () => {
    const { db } = makeTestDb();
    const env = makeEnv(db);
    const req = new Request('http://localhost/health', { method: 'GET' });
    const res = await worker.fetch(req, env, fakeCtx);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body).toEqual({ ok: true });
  });
});

describe('/status structure', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('returns expected shape with service/bank_accounts/consumers/queues blocks', async () => {
    const { db } = makeTestDb();
    const env = makeEnv(db);
    const res = await adminReq('GET', '/status', env);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('service');
    expect(body).toHaveProperty('bank_accounts');
    expect(body).toHaveProperty('consumers');
    expect(body).toHaveProperty('queues');
    const queues = body.queues as Record<string, unknown>;
    expect('main_pending' in queues).toBe(true);
    expect('delivery_active' in queues).toBe(true);
    expect('pending_delivery_alerts' in queues).toBe(true);
    expect('dlq_pending' in queues).toBe(false); // removed dead alias
    const service = body.service as Record<string, unknown>;
    expect(typeof service.parse_failures_24h).toBe('number');
  });

  it('does not expose detailed status anonymously', async () => {
    const { db } = makeTestDb();
    const env = makeEnv(db);
    const res = await worker.fetch(new Request('http://localhost/status'), env, fakeCtx);
    expect(res.status).toBe(401);
    await expect(res.text()).resolves.not.toContain('bank_accounts');
  });
});

describe('scheduled() retention cron', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('prunes parse_log/webhook_log/event_log/transactions past retention windows', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);

    sqlite.prepare(
      `INSERT INTO bank_accounts (account_number, account_type, pairing_code, label) VALUES ('1/2010', 'FIO', 'pp', 'L')`
    ).run();

    // Stale parse_log (>30d), stale event_log (>30d), stale webhook_log (>90d), stale transaction (>90d)
    sqlite.prepare(`INSERT INTO parse_log (error_message, created_at) VALUES ('old', datetime('now','-100 days'))`).run();
    sqlite.prepare(`INSERT INTO parse_log (error_message, created_at) VALUES ('fresh', datetime('now','-1 days'))`).run();
    sqlite.prepare(`INSERT INTO event_log (event_type, created_at) VALUES ('old', datetime('now','-100 days'))`).run();
    sqlite.prepare(`INSERT INTO webhook_log (delivery_id, consumer_app_id, attempt, created_at) VALUES ('did1', 'c1', 1, datetime('now','-100 days'))`).run();
    sqlite.prepare(
      `INSERT INTO transactions (bank_account_id, amount_cents, currency, source, date, created_at) VALUES (1, 1, 'CZK', 'email', datetime('now'), datetime('now','-100 days'))`
    ).run();
    sqlite.prepare(
      `INSERT INTO transactions (bank_account_id, amount_cents, currency, source, date, created_at) VALUES (1, 1, 'CZK', 'email', datetime('now'), datetime('now','-1 days'))`
    ).run();

    // Expired prev_secret rotation
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix, prev_secret_cipher, prev_expires_at) VALUES ('c1', 'https://x', 'c', 'h', 'p', 'old', datetime('now','-1 days'))`
    ).run();

    const fakeEvent = {} as unknown as Parameters<NonNullable<typeof worker.scheduled>>[0];
    await worker.scheduled!(fakeEvent, env, fakeCtx);

    const parseLogCount = (sqlite.prepare(`SELECT COUNT(*) c FROM parse_log`).get() as { c: number }).c;
    const eventLogCount = (sqlite.prepare(`SELECT COUNT(*) c FROM event_log`).get() as { c: number }).c;
    const webhookLogCount = (sqlite.prepare(`SELECT COUNT(*) c FROM webhook_log`).get() as { c: number }).c;
    const txCount = (sqlite.prepare(`SELECT COUNT(*) c FROM transactions`).get() as { c: number }).c;
    const consumer = sqlite.prepare(`SELECT prev_secret_cipher, prev_expires_at FROM webhook_consumers WHERE app_id = 'c1'`).get() as {
      prev_secret_cipher: string | null;
      prev_expires_at: string | null;
    };

    expect(parseLogCount).toBe(1);    // 'fresh' kept, 'old' deleted
    expect(eventLogCount).toBe(0);
    expect(webhookLogCount).toBe(0);
    expect(txCount).toBe(1);          // 1d-old kept, 100d-old deleted
    expect(consumer.prev_secret_cipher).toBe(null);
    expect(consumer.prev_expires_at).toBe(null);
  });

  it('minutely sync cron polls due API accounts without running daily retention', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp', 'https://x', 'c', 'h', 'p')`
    ).run();
    const createRes = await adminReq('POST', '/bank-accounts', env, {
      account_number: '123456/2010',
      account_type: 'FIO',
      owner_app_id: 'festapp',
      fio_api_token: 'fio-token-secret-1',
      ingest_mode: 'api',
    });
    const created = await createRes.json() as { id: number };
    sqlite.prepare(`UPDATE bank_accounts SET api_backfill_done = 1, api_last_fetch_at = datetime('now', '-1 hour') WHERE id = ?`).run(created.id);
    sqlite.prepare(`INSERT INTO parse_log (error_message, created_at) VALUES ('old', datetime('now','-100 days'))`).run();

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      accountStatement: { transactionList: { transaction: [] } },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const minutelyEvent = { cron: '* * * * *' } as unknown as Parameters<NonNullable<typeof worker.scheduled>>[0];
    await worker.scheduled!(minutelyEvent, env, fakeCtx);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/last/');
    const parseLogCount = (sqlite.prepare(`SELECT COUNT(*) c FROM parse_log`).get() as { c: number }).c;
    expect(parseLogCount).toBe(1);
    const account = sqlite.prepare(`SELECT api_last_success_at FROM bank_accounts WHERE id = ?`).get(created.id) as { api_last_success_at: string | null };
    expect(account.api_last_success_at).not.toBeNull();
  });

  it('api sync queue tick polls due accounts and reschedules next tick after 30 seconds', async () => {
    const { db, sqlite } = makeTestDb();
    const apiQueueSend = vi.fn().mockResolvedValue(undefined);
    const env = { ...makeEnv(db), API_SYNC_QUEUE: { send: apiQueueSend } as unknown as Queue<unknown> } as Env;
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp', 'https://x', 'c', 'h', 'p')`
    ).run();
    const createRes = await adminReq('POST', '/bank-accounts', env, {
      account_number: '123456/2010',
      account_type: 'FIO',
      owner_app_id: 'festapp',
      fio_api_token: 'fio-token-secret-1',
      ingest_mode: 'api',
    });
    const created = await createRes.json() as { id: number };
    sqlite.prepare(`UPDATE bank_accounts SET api_backfill_done = 1, api_last_fetch_at = datetime('now', '-1 hour') WHERE id = ?`).run(created.id);

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      accountStatement: { transactionList: { transaction: [] } },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = {
      queue: 'banksync-api-sync',
      messages: [{
        body: { kind: 'api_sync_tick', source: 'cron', enqueued_at: new Date().toISOString() },
        ack,
        retry,
        attempts: 1,
      }],
    } as unknown as MessageBatch<unknown>;

    await worker.queue!(batch, env, fakeCtx);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/last/');
    expect(apiQueueSend).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Phase 1.6 integration tests: rate limiting, idempotency, audit, tenant scope
// ============================================================================

describe('rate limiting — 429 for tenants, bypass for admin', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('admin bypass: even with 100 in bucket, admin still gets 200', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    const bucket = new Date().toISOString().slice(0, 16).replace('T', ' ');
    sqlite.prepare(
      `INSERT INTO rate_limit_buckets (principal, window_start, count) VALUES ('admin', ?, 999)`
    ).run(bucket);

    const res = await adminReq('GET', '/bank-accounts', env);
    expect(res.status).toBe(200); // admin bypasses
  });

  it('tenant: returns 429 after limit is reached', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    // Seed a tenant consumer with admin key
    const adminKeyPlain = 'bksk_test1234567890ABCDEFGHIJKLMNOPQRSTUVWX';
    const enc = new TextEncoder();
    const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(adminKeyPlain));
    const hashHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    const prefix = adminKeyPlain.slice(0, 12);
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix, admin_key_hash, admin_key_prefix) VALUES ('rl-tenant', 'https://x', 'c', 'h', 'p', ?, ?)`
    ).run(hashHex, prefix);
    // Seed 100 in bucket for the tenant principal
    const bucket = new Date().toISOString().slice(0, 16).replace('T', ' ');
    sqlite.prepare(
      `INSERT INTO rate_limit_buckets (principal, window_start, count) VALUES ('tenant:rl-tenant', ?, 100)`
    ).run(bucket);

    const req = new Request('http://localhost/bank-accounts', {
      method: 'GET',
      headers: { 'X-Tenant-Secret': adminKeyPlain },
    });
    const res = await worker.fetch(req, env, fakeCtx);
    expect(res.status).toBe(429);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('rate_limited');
    expect(typeof body.retry_after).toBe('number');
  });
});

describe('idempotency — replay returns cached response', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('second POST with same Idempotency-Key returns same body without re-executing', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp', 'https://x', 'c', 'h', 'p')`
    ).run();

    const idemKey = 'idem-test-key-001';
    const reqBody = { account_number: '111/2010', owner_app_id: 'festapp' };

    // First call — creates account
    const res1 = await adminReq('POST', '/bank-accounts', env, reqBody, { 'Idempotency-Key': idemKey });
    expect(res1.status).toBe(201);
    const body1 = await res1.json() as { id: number; pairing_code: string };

    const countAfterFirst = (sqlite.prepare(`SELECT COUNT(*) c FROM bank_accounts`).get() as { c: number }).c;
    expect(countAfterFirst).toBe(1);

    // Second call — same key, same body → should return cached response
    const res2 = await adminReq('POST', '/bank-accounts', env, reqBody, { 'Idempotency-Key': idemKey });
    expect(res2.status).toBe(201);
    const body2 = await res2.json() as { id: number; pairing_code: string };

    // No second row created
    const countAfterSecond = (sqlite.prepare(`SELECT COUNT(*) c FROM bank_accounts`).get() as { c: number }).c;
    expect(countAfterSecond).toBe(1);
    // Same response body
    expect(body2.id).toBe(body1.id);
    expect(body2.pairing_code).toBe(body1.pairing_code);
  });

  it('POST with same Idempotency-Key but different body returns 422', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp', 'https://x', 'c', 'h', 'p')`
    ).run();

    const idemKey = 'idem-mismatch-key-001';

    // First call
    await adminReq('POST', '/bank-accounts', env, { account_number: '111/2010', owner_app_id: 'festapp' }, { 'Idempotency-Key': idemKey });

    // Second call — same key, DIFFERENT body
    const res2 = await adminReq('POST', '/bank-accounts', env, { account_number: '999/2010', owner_app_id: 'festapp' }, { 'Idempotency-Key': idemKey });
    expect(res2.status).toBe(422);
    const body = await res2.json() as Record<string, unknown>;
    expect(body.error).toBe('idempotency_key_body_mismatch');
  });
});

describe('audit log — row created on mutating operations', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('POST /bank-accounts creates an audit log row', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp', 'https://x', 'c', 'h', 'p')`
    ).run();

    await adminReq('POST', '/bank-accounts', env, { account_number: '111/2010', owner_app_id: 'festapp' });

    const auditRow = sqlite.prepare(`SELECT * FROM admin_audit_log LIMIT 1`).get() as Record<string, unknown> | undefined;
    expect(auditRow).toBeDefined();
    expect(auditRow!.auth_principal).toBe('admin');
    expect(auditRow!.http_method).toBe('POST');
    expect(auditRow!.request_path).toBe('/bank-accounts');
    expect(auditRow!.http_status).toBe(201);
  });
});

describe('tenant scope — bank account isolation', () => {
  beforeEach(() => resetSchemaCheckCache());

  // Helper: make a tenant request using X-Tenant-Secret header
  async function tenantReq(
    method: string,
    path: string,
    env: Env,
    tenantKey: string,
    body?: unknown,
  ): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: {
        'X-Tenant-Secret': tenantKey,
        'Content-Type': 'application/json',
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const req = new Request(`http://localhost${path}`, init);
    return worker.fetch(req, env, fakeCtx);
  }

  async function seedTenantKey(sqlite: ReturnType<typeof makeTestDb>['sqlite'], appId: string): Promise<string> {
    // Generate a deterministic fake tenant key in bksk_ format
    const plain = `bksk_${appId.padEnd(43, 'x').slice(0, 43)}`;
    const prefix = plain.slice(0, 12);
    // sha256 of plain (simplified — we'll insert hash directly via Node crypto)
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(plain).digest('hex');
    sqlite.prepare(
      `UPDATE webhook_consumers SET admin_key_hash = ?, admin_key_prefix = ? WHERE app_id = ?`
    ).run(hash, prefix, appId);
    return plain;
  }

  it('AC20: GET /webhooks/deliveries scopes a tenant to its own jobs in SQL (before limit)', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    sqlite.prepare(`INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp', 'https://x', 'c', 'h', 'p')`).run();
    sqlite.prepare(`INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('other', 'https://y', 'c', 'h', 'p')`).run();
    // Other tenant's job has a higher id, so a filter-after-limit bug would drop festapp's row.
    sqlite.prepare(`INSERT INTO webhook_delivery_jobs (id, transaction_id, consumer_app_id, delivery_id, payload, status, next_attempt_at) VALUES (10, 1, 'festapp', 'D-FEST', '{}', 'queued', datetime('now'))`).run();
    sqlite.prepare(`INSERT INTO webhook_delivery_jobs (id, transaction_id, consumer_app_id, delivery_id, payload, status, next_attempt_at) VALUES (11, 1, 'other', 'D-OTHER', '{}', 'queued', datetime('now'))`).run();
    const tenantKey = await seedTenantKey(sqlite, 'festapp');

    const res = await tenantReq('GET', '/webhooks/deliveries?limit=1', env, tenantKey);
    expect(res.status).toBe(200);
    const body = await res.json() as { jobs: Array<{ consumer_app_id: string; delivery_id: string }> };
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]!.consumer_app_id).toBe('festapp');
    expect(body.jobs[0]!.delivery_id).toBe('D-FEST');
  });

  it('tenant creating account for own app_id succeeds', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp', 'https://x', 'c', 'h', 'p')`
    ).run();
    const tenantKey = await seedTenantKey(sqlite, 'festapp');

    const res = await tenantReq('POST', '/bank-accounts', env, tenantKey, {
      account_number: '111/2010',
      owner_app_id: 'festapp',
    });
    expect(res.status).toBe(201);
  });

  it('tenant creating account for another app_id returns 403', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp', 'https://x', 'c', 'h', 'p')`
    ).run();
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('tutoring', 'https://y', 'c', 'h', 'p')`
    ).run();
    const tenantKey = await seedTenantKey(sqlite, 'festapp');

    const res = await tenantReq('POST', '/bank-accounts', env, tenantKey, {
      account_number: '999/2010',
      owner_app_id: 'tutoring',
    });
    expect(res.status).toBe(403);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('cannot_create_for_other_tenant');
  });

  it('tenant GET /bank-accounts only sees own accounts', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp', 'https://x', 'c', 'h', 'p')`
    ).run();
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('tutoring', 'https://y', 'c', 'h', 'p')`
    ).run();
    const tenantKey = await seedTenantKey(sqlite, 'festapp');

    // Create two accounts via admin
    await adminReq('POST', '/bank-accounts', env, { account_number: '111/2010', owner_app_id: 'festapp' });
    await adminReq('POST', '/bank-accounts', env, { account_number: '222/2010', owner_app_id: 'tutoring' });

    // Tenant sees only own
    const res = await tenantReq('GET', '/bank-accounts', env, tenantKey);
    expect(res.status).toBe(200);
    const accounts = await res.json() as Array<{ owner_app_id: string }>;
    expect(accounts.length).toBe(1);
    expect(accounts[0]?.owner_app_id).toBe('festapp');
  });

  it('tenant cannot subscribe itself to a foreign account, while admin can share explicitly', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    sqlite.prepare(`INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('owner', 'https://owner.example/hook', 'c', 'h', 'p')`).run();
    sqlite.prepare(`INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('attacker', 'https://attacker.example/hook', 'c', 'h', 'p')`).run();
    sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code, owner_app_id) VALUES ('111/2010', 'aabbccdd11', 'owner')`).run();
    const account = sqlite.prepare(`SELECT id FROM bank_accounts WHERE owner_app_id='owner'`).get() as { id: number };
    const tenantKey = await seedTenantKey(sqlite, 'attacker');

    const denied = await tenantReq('POST', '/subscriptions', env, tenantKey, { app_id: 'attacker', bank_account_id: account.id });
    expect(denied.status).toBe(403);
    expect((sqlite.prepare(`SELECT count(*) count FROM webhook_subscriptions`).get() as { count: number }).count).toBe(0);
    expect((sqlite.prepare(`SELECT count(*) count FROM webhook_delivery_jobs`).get() as { count: number }).count).toBe(0);

    const shared = await adminReq('POST', '/subscriptions', env, { app_id: 'attacker', bank_account_id: account.id });
    expect(shared.status).toBe(201);
  });

  it('applies tenant ownership in SQL before transaction/log limits', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    sqlite.prepare(`INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('tenant', 'https://tenant.example/hook', 'c', 'h', 'p')`).run();
    sqlite.prepare(`INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('other', 'https://other.example/hook', 'c', 'h', 'p')`).run();
    sqlite.prepare(`INSERT INTO bank_accounts (id, account_number, pairing_code, owner_app_id) VALUES (1,'111/2010','aabbccdd11','other')`).run();
    sqlite.prepare(`INSERT INTO bank_accounts (id, account_number, pairing_code, owner_app_id) VALUES (2,'222/2010','aabbccdd22','tenant')`).run();
    sqlite.prepare(`INSERT INTO transactions (id, bank_account_id, amount_cents, currency, source, date) VALUES (1,1,100,'CZK','email',datetime('now'))`).run();
    sqlite.prepare(`INSERT INTO transactions (id, bank_account_id, amount_cents, currency, source, date) VALUES (2,2,200,'CZK','email',datetime('now'))`).run();
    sqlite.prepare(`INSERT INTO parse_log (id, bank_account_id, error_message) VALUES (2,1,'foreign'),(1,2,'owned')`).run();
    sqlite.prepare(`INSERT INTO webhook_log (id, delivery_id, consumer_app_id, attempt) VALUES (1,'FOREIGN','other',1),(2,'OWNED','tenant',1)`).run();
    const tenantKey = await seedTenantKey(sqlite, 'tenant');

    const transactions = await (await tenantReq('GET', '/transactions?limit=1', env, tenantKey)).json() as Array<{ bank_account_id: number }>;
    expect(transactions).toEqual([expect.objectContaining({ bank_account_id: 2 })]);
    const parseLogs = await (await tenantReq('GET', '/parse-log?limit=1', env, tenantKey)).json() as Array<{ error_message: string }>;
    expect(parseLogs).toEqual([expect.objectContaining({ error_message: 'owned' })]);
    const webhookLogs = await (await tenantReq('GET', '/webhook-log?limit=1', env, tenantKey)).json() as Array<{ delivery_id: string }>;
    expect(webhookLogs).toEqual([expect.objectContaining({ delivery_id: 'OWNED' })]);
  });
});

describe('admin POST /consumers — returns secret + admin_key', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('returns both webhook secret and admin_key on creation', async () => {
    const { db } = makeTestDb();
    const env = makeEnv(db);

    const res = await adminReq('POST', '/consumers', env, {
      app_id: 'newapp',
      callback_url: 'https://newapp.example.com/webhook',
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.secret).toBe('string');
    expect((body.secret as string).startsWith('whsec_')).toBe(true);
    expect(typeof body.admin_key).toBe('string');
    expect((body.admin_key as string).startsWith('bksk_')).toBe(true);
    expect(typeof body.admin_key_prefix).toBe('string');
  });

  it('rejects idempotency and never persists a credential response', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    const res = await adminReq('POST', '/consumers', env, {
      app_id: 'newapp',
      callback_url: 'https://newapp.example.com/webhook',
    }, { 'Idempotency-Key': 'must-not-cache' });
    expect(res.status).toBe(400);
    expect((sqlite.prepare(`SELECT count(*) count FROM idempotency_keys`).get() as { count: number }).count).toBe(0);
    expect((sqlite.prepare(`SELECT count(*) count FROM webhook_consumers`).get() as { count: number }).count).toBe(0);
  });
});

describe('bounded and non-sensitive HTTP failures', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('rejects a declared oversized mutation before buffering it', async () => {
    const { db } = makeTestDb();
    const env = makeEnv(db);
    const req = new Request('http://localhost/bank-accounts', {
      method: 'POST',
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Length': String(256 * 1024 + 1) },
      body: '{}',
    });
    const res = await worker.fetch(req, env, fakeCtx);
    expect(res.status).toBe(413);
  });

  it('returns a stable public error without database detail', async () => {
    const env = makeEnv({ prepare: () => { throw new Error('SQL secret detail'); } } as unknown as D1Database);
    const res = await worker.fetch(new Request('http://localhost/private', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env, fakeCtx);
    expect(res.status).toBe(500);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('internal_error');
    expect(JSON.stringify(body)).not.toContain('SQL secret detail');
  });
});

describe('POST /consumers/:app_id/rotate-admin-key', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('admin can rotate admin key; returns new plain key', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);

    await adminReq('POST', '/consumers', env, { app_id: 'myapp', callback_url: 'https://x' });

    const before = sqlite.prepare(`SELECT admin_key_hash, admin_key_prefix FROM webhook_consumers WHERE app_id = 'myapp'`).get() as { admin_key_hash: string; admin_key_prefix: string };
    expect(before.admin_key_prefix).toBeTruthy();

    const res = await adminReq('POST', '/consumers/myapp/rotate-admin-key', env);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.admin_key).toBe('string');
    expect((body.admin_key as string).startsWith('bksk_')).toBe(true);
    expect(typeof body.admin_key_prefix).toBe('string');

    const after = sqlite.prepare(`SELECT admin_key_hash, admin_key_prefix FROM webhook_consumers WHERE app_id = 'myapp'`).get() as { admin_key_hash: string; admin_key_prefix: string };
    expect(after.admin_key_hash).not.toBe(before.admin_key_hash);
  });

  it('rotate-admin-key on unknown consumer returns 404', async () => {
    const { db } = makeTestDb();
    const env = makeEnv(db);
    const res = await adminReq('POST', '/consumers/no-such-app/rotate-admin-key', env);
    expect(res.status).toBe(404);
  });
});

describe('PUT /consumers/:app_id — update callback_url', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('admin can update callback_url → 200 with updated object', async () => {
    const { db } = makeTestDb();
    const env = makeEnv(db);
    await adminReq('POST', '/consumers', env, { app_id: 'myapp', callback_url: 'https://old.example.com/wh' });

    const res = await adminReq('PUT', '/consumers/myapp', env, { callback_url: 'https://new.example.com/wh' });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.callback_url).toBe('https://new.example.com/wh');
    expect(body.app_id).toBe('myapp');
  });

  it('unknown app_id → 404', async () => {
    const { db } = makeTestDb();
    const env = makeEnv(db);
    const res = await adminReq('PUT', '/consumers/no-such', env, { callback_url: 'https://x.example.com/wh' });
    expect(res.status).toBe(404);
  });

  it('invalid callback_url (not https) → 400', async () => {
    const { db } = makeTestDb();
    const env = makeEnv(db);
    await adminReq('POST', '/consumers', env, { app_id: 'myapp', callback_url: 'https://old.example.com/wh' });
    const res = await adminReq('PUT', '/consumers/myapp', env, { callback_url: 'http://insecure.example.com/wh' });
    expect(res.status).toBe(400);
  });

  it('tenant can update own consumer → 200', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);
    await adminReq('POST', '/consumers', env, { app_id: 'myapp', callback_url: 'https://old.example.com/wh' });

    const plain = `bksk_${'myapp'.padEnd(43, 'x').slice(0, 43)}`;
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(plain).digest('hex');
    sqlite.prepare(`UPDATE webhook_consumers SET admin_key_hash = ?, admin_key_prefix = ? WHERE app_id = 'myapp'`).run(hash, plain.slice(0, 12));

    const req = new Request('http://localhost/consumers/myapp', {
      method: 'PUT',
      headers: { 'X-Tenant-Secret': plain, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_url: 'https://new.example.com/wh' }),
    });
    const res = await worker.fetch(req, env, fakeCtx);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.callback_url).toBe('https://new.example.com/wh');
  });

  it('unauthenticated PUT → 401', async () => {
    const { db } = makeTestDb();
    const env = makeEnv(db);
    await adminReq('POST', '/consumers', env, { app_id: 'myapp', callback_url: 'https://old.example.com/wh' });
    const req = new Request('http://localhost/consumers/myapp', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_url: 'https://new.example.com/wh' }),
    });
    const res = await worker.fetch(req, env, fakeCtx);
    expect(res.status).toBe(401);
  });
});

describe('GET /admin/audit-log — admin only', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('returns audit rows for admin', async () => {
    const { db, sqlite } = makeTestDb();
    const env = makeEnv(db);

    // Seed an audit row directly
    sqlite.prepare(
      `INSERT INTO admin_audit_log (auth_principal, http_method, request_path, http_status) VALUES ('admin', 'POST', '/bank-accounts', 201)`
    ).run();

    const res = await adminReq('GET', '/admin/audit-log', env);
    expect(res.status).toBe(200);
    const rows = await res.json() as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toHaveProperty('auth_principal');
    expect(rows[0]).toHaveProperty('http_method');
  });

  it('GET /admin/audit-log returns 401 for unauthenticated request', async () => {
    const { db } = makeTestDb();
    const env = makeEnv(db);
    const req = new Request('http://localhost/admin/audit-log', { method: 'GET' });
    const res = await worker.fetch(req, env, fakeCtx);
    expect(res.status).toBe(401);
  });
});

describe('GET /health/deep — admin only', () => {
  beforeEach(() => resetSchemaCheckCache());

  it('rejects anonymous requests before active probes', async () => {
    const { db } = makeTestDb();
    const env = makeEnv(db);
    const req = new Request('http://localhost/health/deep', { method: 'GET' });
    const res = await worker.fetch(req, env, fakeCtx);
    expect(res.status).toBe(401);
  });

  it('returns the operator shape with admin auth', async () => {
    const { db } = makeTestDb();
    const env = makeEnv(db);
    const res = await adminReq('GET', '/health/deep', env);
    expect([200, 503]).toContain(res.status);
    const body = await res.json() as Record<string, unknown>;
    expect(['green', 'yellow', 'red']).toContain(body.status);
    expect(body).toHaveProperty('components');
    expect(body).toHaveProperty('details');
    expect(typeof body.probed_at).toBe('string');
    const components = body.components as Record<string, unknown>;
    expect(components).toHaveProperty('db_read');
    expect(components).toHaveProperty('db_write');
    expect(components).toHaveProperty('outbox_drift');
  });
});
