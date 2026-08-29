import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { D1Database, D1PreparedStatement, D1Result, Queue } from '@cloudflare/workers-types';
import { createWebhookDeliveryCoordinator } from './webhookDeliveryCoordinator';
import type { WebhookQueueMessage } from './queue';
import type { SenderResult, WebhookSender } from './webhookSender';
import type { WebhookEnvelope } from './types';

const MIGRATIONS = ['0001_schema.sql'];

function wrapAsD1(sqlite: Database.Database): D1Database {
  return {
    prepare(sql: string): D1PreparedStatement {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]): D1PreparedStatement { args = values; return statement; },
        async first<T>(): Promise<T | null> { return sqlite.prepare(sql).get(...args) as T ?? null; },
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

function setup() {
  const sqlite = new Database(':memory:');
  for (const m of MIGRATIONS) sqlite.exec(readFileSync(resolve(__dirname, '../migrations', m), 'utf8'));
  sqlite.prepare(`INSERT INTO bank_accounts (id, account_number, account_type, pairing_code) VALUES (1, '1/2010', 'FIO', 'abc123def4')`).run();
  sqlite.prepare(`INSERT INTO transactions (id, bank_account_id, amount_cents, currency, source, date) VALUES (1, 1, 1000, 'CZK', 'email', datetime('now'))`).run();
  sqlite.prepare(`INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('consumer', 'https://example.test/hook', 'x', 'x', 'x')`).run();
  sqlite.prepare(`INSERT INTO webhook_subscriptions (bank_account_id, consumer_app_id) VALUES (1, 'consumer')`).run();
  const send = vi.fn().mockResolvedValue(undefined);
  return { sqlite, db: wrapAsD1(sqlite), send };
}

function fakeSender(result: SenderResult): WebhookSender {
  return { send: vi.fn().mockResolvedValue(result) };
}

const envelope = { event: 'transaction.received', event_version: '1', delivery_id: 'D', pairing_code: 'abc123def4', data: { bank_account_id: 1 } } as unknown as WebhookEnvelope;

function messageFor(sqlite: Database.Database): WebhookQueueMessage {
  const job = sqlite.prepare(`SELECT id, delivery_id, generation, dispatch_token FROM webhook_delivery_jobs`).get() as { id: number; delivery_id: string; generation: number; dispatch_token: string };
  return {
    message_version: 2, delivery_job_id: job.id, delivery_id: job.delivery_id,
    consumer_app_id: 'consumer', bank_account_id: 1, transaction_id: 1,
    generation: job.generation, dispatch_token: job.dispatch_token, envelope,
  };
}

function jobStatus(sqlite: Database.Database): string {
  return (sqlite.prepare(`SELECT status FROM webhook_delivery_jobs`).get() as { status: string }).status;
}

describe('WebhookDeliveryCoordinator (interface)', () => {
  it('observeTransaction creates and dispatches one job', async () => {
    const { db, sqlite, send } = setup();
    const c = createWebhookDeliveryCoordinator({ DB: db, WEBHOOK_KEK: 'k', WEBHOOK_QUEUE: { send } as unknown as Queue<WebhookQueueMessage> });
    const r = await c.observeTransaction(1);
    expect(r).toEqual({ created: 1, dispatched: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(jobStatus(sqlite)).toBe('queued');
  });

  it('handleAttempt: 2xx acks and marks delivered', async () => {
    const { db, sqlite, send } = setup();
    const c = createWebhookDeliveryCoordinator({ DB: db, WEBHOOK_KEK: 'k', WEBHOOK_QUEUE: { send } as unknown as Queue<WebhookQueueMessage> }, { sender: fakeSender({ kind: 'http', httpStatus: 200, usedPrevSecret: false, primaryStatus: null }) });
    await c.observeTransaction(1);
    const disp = await c.handleAttempt(messageFor(sqlite), { attempts: 1, source: 'primary' });
    expect(disp).toEqual({ action: 'ack' });
    expect(jobStatus(sqlite)).toBe('delivered');
  });

  it('handleAttempt: 500 returns a retry disposition', async () => {
    const { db, sqlite, send } = setup();
    const c = createWebhookDeliveryCoordinator({ DB: db, WEBHOOK_KEK: 'k', WEBHOOK_QUEUE: { send } as unknown as Queue<WebhookQueueMessage> }, { sender: fakeSender({ kind: 'http', httpStatus: 500, usedPrevSecret: false, primaryStatus: null }) });
    await c.observeTransaction(1);
    const disp = await c.handleAttempt(messageFor(sqlite), { attempts: 1, source: 'primary' });
    expect(disp).toMatchObject({ action: 'retry' });
    expect(jobStatus(sqlite)).toBe('queued');
  });

  it('handleAttempt: 400 acks and marks terminal', async () => {
    const { db, sqlite, send } = setup();
    const c = createWebhookDeliveryCoordinator({ DB: db, WEBHOOK_KEK: 'k', WEBHOOK_QUEUE: { send } as unknown as Queue<WebhookQueueMessage> }, { sender: fakeSender({ kind: 'http', httpStatus: 400, usedPrevSecret: false, primaryStatus: null }) });
    await c.observeTransaction(1);
    const disp = await c.handleAttempt(messageFor(sqlite), { attempts: 1, source: 'primary' });
    expect(disp).toEqual({ action: 'ack' });
    expect(jobStatus(sqlite)).toBe('terminal');
  });

  it('handleAttempt: missing consumer acks as terminal', async () => {
    const { db, sqlite, send } = setup();
    const c = createWebhookDeliveryCoordinator({ DB: db, WEBHOOK_KEK: 'k', WEBHOOK_QUEUE: { send } as unknown as Queue<WebhookQueueMessage> }, { sender: fakeSender({ kind: 'no_consumer' }) });
    await c.observeTransaction(1);
    const disp = await c.handleAttempt(messageFor(sqlite), { attempts: 1, source: 'primary' });
    expect(disp).toEqual({ action: 'ack' });
    expect(jobStatus(sqlite)).toBe('terminal');
  });

  it('handleAttempt: consumer secret configuration errors fail fast as terminal', async () => {
    const { db, sqlite, send } = setup();
    const c = createWebhookDeliveryCoordinator({ DB: db, WEBHOOK_KEK: 'k', WEBHOOK_QUEUE: { send } as unknown as Queue<WebhookQueueMessage> }, { sender: fakeSender({ kind: 'configuration_error', error: 'consumer_secret_decrypt_failed' }) });
    await c.observeTransaction(1);
    const disp = await c.handleAttempt(messageFor(sqlite), { attempts: 1, source: 'primary' });
    expect(disp).toEqual({ action: 'ack' });
    expect(jobStatus(sqlite)).toBe('terminal');
    expect(sqlite.prepare(`SELECT last_error FROM webhook_delivery_jobs WHERE id = 1`).get())
      .toMatchObject({ last_error: 'consumer_secret_decrypt_failed' });
  });

  it('handleAttempt: a stale-generation message is ack\'d without mutating the job', async () => {
    const { db, sqlite, send } = setup();
    const c = createWebhookDeliveryCoordinator({ DB: db, WEBHOOK_KEK: 'k', WEBHOOK_QUEUE: { send } as unknown as Queue<WebhookQueueMessage> }, { sender: fakeSender({ kind: 'http', httpStatus: 500, usedPrevSecret: false, primaryStatus: null }) });
    await c.observeTransaction(1);
    const msg = { ...messageFor(sqlite), generation: 999 };
    const disp = await c.handleAttempt(msg, { attempts: 1, source: 'primary' });
    expect(disp).toEqual({ action: 'ack' }); // stale -> settled -> ack, not retry
    expect(jobStatus(sqlite)).toBe('queued'); // unchanged
  });

  it('handleAttempt: a non-V2 (legacy) message is ack\'d unprocessed and never mutates the job', async () => {
    const { db, sqlite, send } = setup();
    const c = createWebhookDeliveryCoordinator({ DB: db, WEBHOOK_KEK: 'k', WEBHOOK_QUEUE: { send } as unknown as Queue<WebhookQueueMessage> }, { sender: fakeSender({ kind: 'http', httpStatus: 200, usedPrevSecret: false, primaryStatus: null }) });
    await c.observeTransaction(1);
    const before = jobStatus(sqlite);

    // Legacy V1 shape: no message_version / generation / dispatch_token.
    const v1 = { ...messageFor(sqlite), message_version: undefined, generation: undefined, dispatch_token: undefined } as unknown as WebhookQueueMessage;
    const disp = await c.handleAttempt(v1, { attempts: 1, source: 'primary' });
    expect(disp).toEqual({ action: 'ack' });
    expect(jobStatus(sqlite)).toBe(before); // unchanged — never processed
  });

  it('handleAttempt dead_letter re-drives the canonical job to pending', async () => {
    const { db, sqlite, send } = setup();
    const c = createWebhookDeliveryCoordinator({ DB: db, WEBHOOK_KEK: 'k', WEBHOOK_QUEUE: { send } as unknown as Queue<WebhookQueueMessage> });
    await c.observeTransaction(1);
    const disp = await c.handleAttempt(messageFor(sqlite), { attempts: 5, source: 'dead_letter' });
    expect(disp).toEqual({ action: 'ack' });
    const row = sqlite.prepare(`SELECT status, last_error FROM webhook_delivery_jobs`).get() as { status: string; last_error: string };
    expect(row.status).toBe('pending');
    expect(row.last_error).toBe('queue_max_retries_exhausted');
  });
});
