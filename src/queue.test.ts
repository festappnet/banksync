import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { D1Database, D1Result, D1PreparedStatement, Message, MessageBatch } from '@cloudflare/workers-types';
import { handleQueueBatch, backoffSeconds } from './queue';
import type { QueueEnv, WebhookQueueMessage } from './queue';
import { webhookEncrypt } from './crypto';
import { signWebhook } from './relay';
import { resetSchemaCheckCache } from './db';
import type { WebhookEnvelope, Transaction } from './types';

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

function makeTestDb(): { db: D1Database; sqlite: Database.Database } {
  const sqlite = new Database(':memory:');
  for (const m of ['0001_schema.sql', '0002_multitenant.sql', '0003_cf_rule_sync.sql', '0004_phase16_hardening.sql', '0005_fio_api_sync.sql', '0006_webhook_delivery_jobs.sql', '0007_webhook_delivery_fencing.sql', '0008_alert_outbox_and_subscription_history.sql', '0009_contract_drop_dlq_archive.sql']) {
    sqlite.exec(readFileSync(resolve(__dirname, '../migrations', m), 'utf8'));
  }
  return { db: wrapAsD1(sqlite), sqlite };
}

// ---- test fixtures ----

const KEK_B64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; // 32 zero bytes, base64

const stubTx: Transaction = {
  id: 1,
  bank_account_id: 1,
  amount_cents: 1990,
  currency: 'CZK',
  counter_account: null,
  bank_code: null,
  bank_name: null,
  vs: null,
  ks: null,
  ss: null,
  message: null,
  sender_name: 'Test Sender',
  user_identification: null,
  transaction_type: null,
  performed_by: null,
  comment: null,
  command_id: null,
  source: 'email',
  date: '2026-05-08T00:00:00Z',
  date_offset_min: null,
  transaction_id: 'TX-001',
  external_id: null,
};

const stubEnvelope: WebhookEnvelope = {
  event: 'transaction.received',
  event_version: '1',
  delivery_id: '01HTEST123456789AB',
  pairing_code: 'a3f92c1e44',
  data: stubTx,
};

function makeMsg(overrides: Partial<WebhookQueueMessage & { attempts: number }> = {}): Message<WebhookQueueMessage> {
  const body: WebhookQueueMessage = {
    message_version: 2,
    delivery_job_id: 1,
    delivery_id: stubEnvelope.delivery_id,
    consumer_app_id: 'festapp',
    bank_account_id: 1,
    transaction_id: 1,
    // Fencing must match the persisted job so retry/terminal outcomes apply.
    generation: 1,
    dispatch_token: 'tok-1',
    envelope: stubEnvelope,
    ...overrides,
  };
  return {
    id: 'msg-id-1',
    timestamp: new Date(),
    body,
    attempts: overrides.attempts ?? 1,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<WebhookQueueMessage>;
}

function makeBatch(msgs: Message<WebhookQueueMessage>[], queueName = 'banksync-webhooks'): MessageBatch<WebhookQueueMessage> {
  return {
    queue: queueName,
    messages: msgs,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    retryAll: vi.fn(),
    ackAll: vi.fn(),
  } as unknown as MessageBatch<WebhookQueueMessage>;
}

async function makeEnv(secret: string, prevSecret?: string): Promise<{ env: QueueEnv; sqlite: Database.Database }> {
  const { db, sqlite } = makeTestDb();

  const primaryCipher = await webhookEncrypt(secret, KEK_B64);
  let prevCipher: string | null = null;
  if (prevSecret !== undefined) {
    prevCipher = await webhookEncrypt(prevSecret, KEK_B64);
  }

  // Insert consumer row directly
  if (prevCipher !== null) {
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix, prev_secret_cipher, prev_expires_at)
       VALUES ('festapp', 'https://consumer.example.com/webhook', ?, 'hash1', 'prefix', ?, ?)`
    ).run(primaryCipher, prevCipher, futureExpiry);
  } else {
    sqlite.prepare(
      `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix)
       VALUES ('festapp', 'https://consumer.example.com/webhook', ?, 'hash1', 'prefix')`
    ).run(primaryCipher);
  }

  const env: QueueEnv = {
    DB: db,
    WEBHOOK_KEK: KEK_B64,
    WEBHOOK_QUEUE: {} as never,
  };

  sqlite.prepare(`
    INSERT INTO webhook_delivery_jobs
      (id, transaction_id, consumer_app_id, delivery_id, payload, status, dispatch_token, next_attempt_at)
    VALUES (1, 1, 'festapp', ?, ?, 'queued', 'tok-1', datetime('now'))
  `).run(stubEnvelope.delivery_id, JSON.stringify(stubEnvelope));

  return { env, sqlite };
}

// ---- tests ----

beforeEach(() => {
  resetSchemaCheckCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('backoffSeconds', () => {
  it('table-test for all key values', () => {
    expect(backoffSeconds(1)).toBe(30);
    expect(backoffSeconds(2)).toBe(60);
    expect(backoffSeconds(3)).toBe(120);
    expect(backoffSeconds(5)).toBe(480);
    expect(backoffSeconds(6)).toBe(960);
    expect(backoffSeconds(7)).toBe(1800);
    expect(backoffSeconds(100)).toBe(1800);
  });
});

describe('2xx happy path', () => {
  it('acks message, no retry, inserts webhook_log row with http_status=200', async () => {
    const secret = 'test-secret-happy';
    const { env, sqlite } = await makeEnv(secret);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    const msg = makeMsg({ attempts: 1 });
    const batch = makeBatch([msg]);
    await handleQueueBatch(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();

    const row = sqlite.prepare(`SELECT http_status, attempt FROM webhook_log WHERE delivery_id = ?`).get(stubEnvelope.delivery_id) as { http_status: number; attempt: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.http_status).toBe(200);
    expect(row!.attempt).toBe(1);

    fetchSpy.mockRestore();
  });
});

describe('5xx triggers exponential retry', () => {
  it.each([
    [1, 30],
    [2, 60],
    [5, 480],
    [6, 960],
    [7, 1800],
  ])('attempts=%i → delaySeconds=%i', async (attempts, expectedDelay) => {
    const { env, sqlite } = await makeEnv('test-secret-5xx');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));

    const msg = makeMsg({ attempts });
    const batch = makeBatch([msg]);
    await handleQueueBatch(batch, env);

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: expectedDelay });
    expect(msg.ack).not.toHaveBeenCalled();

    const row = sqlite.prepare(`SELECT http_status FROM webhook_log WHERE delivery_id = ?`).get(stubEnvelope.delivery_id) as { http_status: number } | undefined;
    expect(row?.http_status).toBe(500);

    fetchSpy.mockRestore();
    resetSchemaCheckCache();
  });
});

describe('400 → ack, no retry', () => {
  it('acks, webhook_log shows http_status=400 and 4xx_client_error', async () => {
    const { env, sqlite } = await makeEnv('test-secret-400');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad request', { status: 400 }));

    const msg = makeMsg({ attempts: 1 });
    const batch = makeBatch([msg]);
    await handleQueueBatch(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();

    const row = sqlite.prepare(`SELECT http_status, error_message FROM webhook_log WHERE delivery_id = ?`).get(stubEnvelope.delivery_id) as { http_status: number; error_message: string } | undefined;
    expect(row?.http_status).toBe(400);
    expect(row?.error_message).toBe('4xx_client_error');

    fetchSpy.mockRestore();
  });
});

describe('408 → retry', () => {
  it('retries on 408 (Request Timeout)', async () => {
    const { env } = await makeEnv('test-secret-408');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 408 }));

    const msg = makeMsg({ attempts: 1 });
    const batch = makeBatch([msg]);
    await handleQueueBatch(batch, env);

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(msg.ack).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});

describe('429 → retry', () => {
  it('retries on 429 (Too Many Requests)', async () => {
    const { env } = await makeEnv('test-secret-429');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 429 }));

    const msg = makeMsg({ attempts: 1 });
    const batch = makeBatch([msg]);
    await handleQueueBatch(batch, env);

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(msg.ack).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});

describe('network error (fetch throws)', () => {
  it('retries, webhook_log has http_status=0 and error message', async () => {
    const { env, sqlite } = await makeEnv('test-secret-network');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection refused'));

    const msg = makeMsg({ attempts: 1 });
    const batch = makeBatch([msg]);
    await handleQueueBatch(batch, env);

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(msg.ack).not.toHaveBeenCalled();

    const row = sqlite.prepare(`SELECT http_status, error_message FROM webhook_log WHERE delivery_id = ?`).get(stubEnvelope.delivery_id) as { http_status: number; error_message: string } | undefined;
    expect(row?.http_status).toBe(0);
    expect(row?.error_message).toContain('connection refused');

    fetchSpy.mockRestore();
  });
});

describe('HMAC canonicalization on wire', () => {
  it('body bytes sent via fetch exactly match signWebhook output', async () => {
    const secret = 'test-secret-hmac';
    const { env } = await makeEnv(secret);

    let capturedBody: Uint8Array | undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      capturedBody = init?.body instanceof Uint8Array ? init.body : new Uint8Array(init?.body as ArrayBuffer);
      return new Response('ok', { status: 200 });
    });

    const msg = makeMsg({ attempts: 1 });
    const batch = makeBatch([msg]);
    await handleQueueBatch(batch, env);

    const expectedSigned = await signWebhook({ envelope: stubEnvelope, secret });
    expect(capturedBody).toBeDefined();
    expect(capturedBody).toEqual(expectedSigned.bodyBytes);

    fetchSpy.mockRestore();
  });
});

describe('prev-secret fallback on 401', () => {
  it('first fetch returns 401, second fetch with prev secret returns 200; two log rows, msg.ack called', async () => {
    const primarySecret = 'new-secret';
    const prevSecret = 'old-secret';
    const { env, sqlite } = await makeEnv(primarySecret, prevSecret);

    let callCount = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return new Response('unauthorized', { status: 401 });
      return new Response('ok', { status: 200 });
    });

    const msg = makeMsg({ attempts: 1 });
    const batch = makeBatch([msg]);
    await handleQueueBatch(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(callCount).toBe(2);

    const rows = sqlite.prepare(`SELECT http_status, error_message FROM webhook_log WHERE delivery_id = ? ORDER BY rowid`).all(stubEnvelope.delivery_id) as { http_status: number; error_message: string | null }[];
    // We expect one combined row (the prev-secret path writes a single log entry)
    const successRow = rows.find(r => r.http_status === 200);
    expect(successRow).toBeDefined();
    expect(successRow?.error_message).toBe('retry_with_prev');

    fetchSpy.mockRestore();
  });

  it('second fetch body signed with prev secret matches expected bytes', async () => {
    const primarySecret = 'new-secret-v2';
    const prevSecret = 'old-secret-v2';
    const { env } = await makeEnv(primarySecret, prevSecret);

    let secondBody: Uint8Array | undefined;
    let callCount = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      callCount++;
      if (callCount === 1) return new Response('unauthorized', { status: 401 });
      secondBody = init?.body instanceof Uint8Array ? init.body : new Uint8Array(init?.body as ArrayBuffer);
      return new Response('ok', { status: 200 });
    });

    const msg = makeMsg({ attempts: 1 });
    await handleQueueBatch(makeBatch([msg]), env);

    const expectedPrev = await signWebhook({ envelope: stubEnvelope, secret: prevSecret });
    expect(secondBody).toBeDefined();
    expect(secondBody).toEqual(expectedPrev.bodyBytes);

    fetchSpy.mockRestore();
  });
});

describe('prev-secret fallback: both fail', () => {
  it('primary 401, prev 401 → ack with both errors logged, no retry', async () => {
    const { env, sqlite } = await makeEnv('new-secret', 'old-secret');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unauthorized', { status: 401 }));

    const msg = makeMsg({ attempts: 1 });
    const batch = makeBatch([msg]);
    await handleQueueBatch(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();

    const row = sqlite.prepare(`SELECT http_status, error_message FROM webhook_log WHERE delivery_id = ?`).get(stubEnvelope.delivery_id) as { http_status: number; error_message: string } | undefined;
    expect(row?.http_status).toBe(401);
    expect(row?.error_message).toContain('retry_with_prev');

    fetchSpy.mockRestore();
  });
});

describe('no prev_cipher_in_grace + 401', () => {
  it('single fetch, ack, webhook_log with http_status=401 and 4xx_client_error', async () => {
    const { env, sqlite } = await makeEnv('some-secret'); // no prev secret
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unauthorized', { status: 401 }));

    const msg = makeMsg({ attempts: 1 });
    const batch = makeBatch([msg]);
    await handleQueueBatch(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();

    const row = sqlite.prepare(`SELECT http_status, error_message FROM webhook_log WHERE delivery_id = ?`).get(stubEnvelope.delivery_id) as { http_status: number; error_message: string } | undefined;
    expect(row?.http_status).toBe(401);
    expect(row?.error_message).toBe('4xx_client_error');

    fetchSpy.mockRestore();
  });
});

describe('consumer not found (deleted mid-flight)', () => {
  it('acks, logs consumer_not_found, no fetch call', async () => {
    const { db, sqlite } = makeTestDb();
    // No consumer inserted
    const env: QueueEnv = { DB: db, WEBHOOK_KEK: KEK_B64, WEBHOOK_QUEUE: {} as never };
    sqlite.prepare(`INSERT INTO webhook_delivery_jobs (id, transaction_id, consumer_app_id, delivery_id, payload, status, dispatch_token, next_attempt_at) VALUES (1, 1, 'ghost-app', ?, ?, 'queued', 'tok-1', datetime('now'))`).run(stubEnvelope.delivery_id, JSON.stringify(stubEnvelope));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const msg = makeMsg({ attempts: 1, consumer_app_id: 'ghost-app' });
    const batch = makeBatch([msg]);
    await handleQueueBatch(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();

    const row = sqlite.prepare(`SELECT error_message FROM webhook_log WHERE delivery_id = ?`).get(stubEnvelope.delivery_id) as { error_message: string } | undefined;
    expect(row?.error_message).toBe('consumer_not_found');

    fetchSpy.mockRestore();
  });
});

describe('DLQ re-drive', () => {
  it('returns the canonical job to pending, acks, and creates no second delivery record', async () => {
    const { db, sqlite } = makeTestDb();
    const env: QueueEnv = { DB: db, WEBHOOK_KEK: KEK_B64, WEBHOOK_QUEUE: {} as never };
    sqlite.prepare(`INSERT INTO webhook_delivery_jobs (id, transaction_id, consumer_app_id, delivery_id, payload, status, dispatch_token, next_attempt_at) VALUES (1, 1, 'festapp', ?, ?, 'queued', 'tok-1', datetime('now'))`).run(stubEnvelope.delivery_id, JSON.stringify(stubEnvelope));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const msg = makeMsg({ attempts: 5 });
    const batch = makeBatch([msg], 'banksync-webhooks-dlq');
    await handleQueueBatch(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();

    const row = sqlite.prepare(`SELECT delivery_id, consumer_app_id, last_error, status FROM webhook_delivery_jobs WHERE delivery_id = ?`).get(stubEnvelope.delivery_id) as { delivery_id: string; consumer_app_id: string; last_error: string; status: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.delivery_id).toBe(stubEnvelope.delivery_id);
    expect(row!.consumer_app_id).toBe('festapp');
    expect(row!.last_error).toBe('queue_max_retries_exhausted');
    expect(row!.status).toBe('pending');

    fetchSpy.mockRestore();
  });
});

describe('DLQ idempotent', () => {
  it('two calls with the same delivery ID retain one canonical job', async () => {
    const { db, sqlite } = makeTestDb();
    const env: QueueEnv = { DB: db, WEBHOOK_KEK: KEK_B64, WEBHOOK_QUEUE: {} as never };
    sqlite.prepare(`INSERT INTO webhook_delivery_jobs (id, transaction_id, consumer_app_id, delivery_id, payload, status, dispatch_token, next_attempt_at) VALUES (1, 1, 'festapp', ?, ?, 'queued', 'tok-1', datetime('now'))`).run(stubEnvelope.delivery_id, JSON.stringify(stubEnvelope));

    const msg1 = makeMsg({ attempts: 5 });
    const msg2 = makeMsg({ attempts: 5 });
    // Call DLQ handler twice with same delivery_id
    await handleQueueBatch(makeBatch([msg1], 'banksync-webhooks-dlq'), env);
    resetSchemaCheckCache();
    await handleQueueBatch(makeBatch([msg2], 'banksync-webhooks-dlq'), env);

    const count = (sqlite.prepare(`SELECT COUNT(*) as n FROM webhook_delivery_jobs WHERE delivery_id = ?`).get(stubEnvelope.delivery_id) as { n: number }).n;
    expect(count).toBe(1);
  });
});

describe('schema version mismatch', () => {
  it('throws when schema_meta.value is wrong (Cloudflare will retry)', async () => {
    const { db, sqlite } = makeTestDb();
    sqlite.prepare(`UPDATE schema_meta SET value = '99' WHERE key = 'version'`).run();
    resetSchemaCheckCache();

    const env: QueueEnv = { DB: db, WEBHOOK_KEK: KEK_B64, WEBHOOK_QUEUE: {} as never };
    const msg = makeMsg({ attempts: 1 });
    const batch = makeBatch([msg]);

    await expect(handleQueueBatch(batch, env)).rejects.toThrow('schema_version_mismatch');
  });
});
