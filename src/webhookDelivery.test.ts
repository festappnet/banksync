import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { D1Database, D1PreparedStatement, D1Result, Queue } from '@cloudflare/workers-types';
import {
  dispatchDeliveryJob,
  dispatchDueDeliveryJobs,
  ensureDeliveryJobs,
  recordDeliveryOutcome,
  replayDelivery,
} from './webhookDelivery';
import type { WebhookQueueMessage } from './queue';

const MIGRATIONS = ['0001_schema.sql'];

/** In-memory D1 shim over better-sqlite3. `failOn` injects a deterministic
 * post-send / storage failure for crash-boundary tests. */
function wrapAsD1(sqlite: Database.Database, failOn?: (sql: string) => boolean): D1Database {
  return {
    prepare(sql: string): D1PreparedStatement {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]): D1PreparedStatement {
          args = values;
          return statement;
        },
        async first<T>(): Promise<T | null> {
          return sqlite.prepare(sql).get(...args) as T ?? null;
        },
        async all<T>(): Promise<D1Result<T>> {
          const results = sqlite.prepare(sql).all(...args) as T[];
          return { results, success: true, meta: { changes: 0, last_row_id: 0, duration: 0, size_after: 0, rows_read: results.length, rows_written: 0, changed_db: false } };
        },
        async run(): Promise<D1Result<Record<string, unknown>>> {
          if (failOn && failOn(sql)) throw new Error('injected_d1_failure');
          const result = sqlite.prepare(sql).run(...args);
          return { results: [], success: true, meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid), duration: 0, size_after: 0, rows_read: 0, rows_written: result.changes, changed_db: result.changes > 0 } };
        },
      } as unknown as D1PreparedStatement;
      return statement;
    },
  } as D1Database;
}

function setup(failOn?: (sql: string) => boolean): {
  db: D1Database; sqlite: Database.Database; send: ReturnType<typeof vi.fn>;
} {
  const sqlite = new Database(':memory:');
  for (const migration of MIGRATIONS) {
    sqlite.exec(readFileSync(resolve(__dirname, '../migrations', migration), 'utf8'));
  }
  sqlite.prepare(`INSERT INTO bank_accounts (id, account_number, account_type, pairing_code) VALUES (1, '1/2010', 'FIO', 'abc123def4')`).run();
  sqlite.prepare(`INSERT INTO transactions (id, bank_account_id, amount_cents, currency, source, date) VALUES (1, 1, 1000, 'CZK', 'email', datetime('now'))`).run();
  sqlite.prepare(`INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('consumer', 'https://example.test/hook', 'x', 'x', 'x')`).run();
  sqlite.prepare(`INSERT INTO webhook_subscriptions (bank_account_id, consumer_app_id) VALUES (1, 'consumer')`).run();
  return { db: wrapAsD1(sqlite, failOn), sqlite, send: vi.fn().mockResolvedValue(undefined) };
}

function queue(send: ReturnType<typeof vi.fn>): Queue<WebhookQueueMessage> {
  return { send } as unknown as Queue<WebhookQueueMessage>;
}

function jobRow(sqlite: Database.Database): {
  id: number; status: string; generation: number; dispatch_token: string | null;
  http_attempt_count: number; delivery_id: string; delivered_at: string | null; terminal_at: string | null;
} {
  return sqlite.prepare(`SELECT id, status, generation, dispatch_token, http_attempt_count, delivery_id, delivered_at, terminal_at FROM webhook_delivery_jobs`).get() as never;
}

describe('webhook delivery lifecycle', () => {
  it('creates one durable job per transaction/consumer and heals a failed producer send', async () => {
    const { db, sqlite, send } = setup();
    expect(await ensureDeliveryJobs(db, 1)).toBe(1);
    expect(await ensureDeliveryJobs(db, 1)).toBe(0);
    expect(jobRow(sqlite).status).toBe('pending');

    // Provable send failure returns the job to pending, not a lost message.
    send.mockRejectedValueOnce(new Error('queue outage'));
    await dispatchDueDeliveryJobs({ DB: db, WEBHOOK_QUEUE: queue(send) });
    expect(jobRow(sqlite).status).toBe('pending');

    await dispatchDueDeliveryJobs({ DB: db, WEBHOOK_QUEUE: queue(send) });
    expect(send).toHaveBeenCalledTimes(2);
    expect(jobRow(sqlite).status).toBe('queued');
    expect(send.mock.calls[1]![0]).toMatchObject({ message_version: 2, generation: 1 });
  });

  it('AC1: a successful send whose post-send D1 update fails stays owned, not immediately re-dispatched', async () => {
    // Fail only the dispatching -> queued update. The send succeeds first.
    const { db, sqlite, send } = setup(sql => /SET status = 'queued'/.test(sql) && /status = 'dispatching'/.test(sql));
    await ensureDeliveryJobs(db, 1);

    await dispatchDueDeliveryJobs({ DB: db, WEBHOOK_QUEUE: queue(send) });
    expect(send).toHaveBeenCalledTimes(1);
    // Left dispatching with a long ownership lease — NOT pending.
    const row = jobRow(sqlite);
    expect(row.status).toBe('dispatching');

    // Immediate re-sweep must not produce a second message.
    await dispatchDueDeliveryJobs({ DB: db, WEBHOOK_QUEUE: queue(send) });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('AC2: delivered is absorbing — a late terminal outcome cannot overwrite it', async () => {
    const { db, sqlite, send } = setup();
    await ensureDeliveryJobs(db, 1);
    await dispatchDeliveryJob({ DB: db, WEBHOOK_QUEUE: queue(send) }, 1);
    const { generation, dispatch_token } = jobRow(sqlite);

    const delivered = await recordDeliveryOutcome(db, { deliveryJobId: 1, generation, dispatchToken: dispatch_token, kind: 'delivered', httpStatus: 200 });
    expect(delivered).toMatchObject({ applied: true, status: 'delivered' });

    const lateTerminal = await recordDeliveryOutcome(db, { deliveryJobId: 1, generation, dispatchToken: dispatch_token, kind: 'terminal', httpStatus: 500 });
    expect(lateTerminal.status).toBe('delivered');
    expect(jobRow(sqlite).status).toBe('delivered');
  });

  it('AC3: two sweeps over one job produce exactly one active dispatch', async () => {
    const { db, sqlite, send } = setup();
    await ensureDeliveryJobs(db, 1);

    // First claim wins; the second cannot re-claim a job it already owns.
    const first = await dispatchDeliveryJob({ DB: db, WEBHOOK_QUEUE: queue(send) }, 1);
    const second = await dispatchDeliveryJob({ DB: db, WEBHOOK_QUEUE: queue(send) }, 1);
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);

    // A job already dispatching with a live lease is not due.
    sqlite.prepare(`UPDATE webhook_delivery_jobs SET status='dispatching', lease_until=datetime('now','+1 hour'), next_attempt_at=datetime('now')`).run();
    await dispatchDueDeliveryJobs({ DB: db, WEBHOOK_QUEUE: queue(send) });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('AC14: a stale generation/token outcome cannot mutate a newer job', async () => {
    const { db, sqlite, send } = setup();
    await ensureDeliveryJobs(db, 1);
    await dispatchDeliveryJob({ DB: db, WEBHOOK_QUEUE: queue(send) }, 1);
    const stale = jobRow(sqlite); // generation 1, token1

    // A terminal job (replay is a no-op for active jobs). Replay bumps
    // generation and re-dispatches under a new token.
    sqlite.prepare(`UPDATE webhook_delivery_jobs SET status='terminal', terminal_at=datetime('now')`).run();
    await replayDelivery(db, queue(send), 1);
    const fresh = jobRow(sqlite);
    expect(fresh.generation).toBe(2);
    expect(fresh.dispatch_token).not.toBe(stale.dispatch_token);

    // The old in-flight message (generation 1) is fenced out as stale.
    const staleDelivered = await recordDeliveryOutcome(db, { deliveryJobId: 1, generation: stale.generation, dispatchToken: stale.dispatch_token, kind: 'delivered', httpStatus: 200 });
    expect(staleDelivered.status).toBe('stale');
    const staleTerminal = await recordDeliveryOutcome(db, { deliveryJobId: 1, generation: stale.generation, dispatchToken: stale.dispatch_token, kind: 'terminal', httpStatus: 500 });
    expect(staleTerminal.status).toBe('stale');
    expect(jobRow(sqlite).status).not.toBe('delivered');
    expect(jobRow(sqlite).status).not.toBe('terminal');
  });

  it('reopens a dispatching job whose ownership lease has expired', async () => {
    const { db, sqlite, send } = setup();
    await ensureDeliveryJobs(db, 1);
    // Simulate a message lost with no outcome: dispatching, lease long past.
    sqlite.prepare(`UPDATE webhook_delivery_jobs SET status='dispatching', dispatch_token='old', lease_until=datetime('now','-1 hour'), next_attempt_at=datetime('now','-1 hour')`).run();

    await dispatchDueDeliveryJobs({ DB: db, WEBHOOK_QUEUE: queue(send) });
    expect(send).toHaveBeenCalledTimes(1);
    expect(jobRow(sqlite).status).toBe('queued');
    // A fresh token, not the abandoned one.
    expect(jobRow(sqlite).dispatch_token).not.toBe('old');
  });

  it('does not dispatch a leased job, records terminals, and manual replay preserves the delivery id', async () => {
    const { db, sqlite, send } = setup();
    await ensureDeliveryJobs(db, 1);
    sqlite.prepare(`UPDATE webhook_delivery_jobs SET lease_until = datetime('now', '+1 hour')`).run();
    await dispatchDueDeliveryJobs({ DB: db, WEBHOOK_QUEUE: queue(send) });
    expect(send).not.toHaveBeenCalled();

    sqlite.prepare(`UPDATE webhook_delivery_jobs SET lease_until = NULL, status='queued', generation=1, dispatch_token='tok'`).run();
    const before = jobRow(sqlite);
    await recordDeliveryOutcome(db, { deliveryJobId: before.id, generation: 1, dispatchToken: 'tok', kind: 'terminal', httpStatus: 403, error: 'forbidden' });
    expect(jobRow(sqlite).status).toBe('terminal');

    const replay = await replayDelivery(db, queue(send), before.id);
    expect(replay).toMatchObject({ found: true, queued: true, delivery_id: before.delivery_id });
    expect(send.mock.calls[0]![0]).toMatchObject({ delivery_id: before.delivery_id, delivery_job_id: before.id, generation: 2 });
    const after = jobRow(sqlite);
    expect(after.http_attempt_count).toBe(0);
    expect(after.generation).toBe(2);
    expect(after.delivered_at).toBeNull();
    expect(after.terminal_at).toBeNull();
  });

  it('AC10: replay is a no-op for an active job and for a delivered job without force', async () => {
    const { db, sqlite, send } = setup();
    await ensureDeliveryJobs(db, 1);
    await dispatchDeliveryJob({ DB: db, WEBHOOK_QUEUE: queue(send) }, 1); // now queued (active)
    send.mockClear();

    const active = await replayDelivery(db, queue(send), 1);
    expect(active).toMatchObject({ found: true, queued: false, noop: 'active' });
    expect(send).not.toHaveBeenCalled();

    // Deliver it, then a normal replay is a no-op; force re-drives + bumps incident_version.
    sqlite.prepare(`UPDATE webhook_delivery_jobs SET status='delivered', delivered_at=datetime('now'), incident_version=0`).run();
    const noForce = await replayDelivery(db, queue(send), 1);
    expect(noForce).toMatchObject({ found: true, queued: false, noop: 'already_delivered' });
    expect(send).not.toHaveBeenCalled();

    const forced = await replayDelivery(db, queue(send), 1, { force: true });
    expect(forced.queued).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(jobRow(sqlite).status).toBe('queued');
    expect((sqlite.prepare(`SELECT incident_version FROM webhook_delivery_jobs`).get() as { incident_version: number }).incident_version).toBe(1);
  });

  it('AC17: a soft-deleted subscription keeps intent for transactions ingested during its active window', async () => {
    const { db, sqlite } = setup();
    // Subscription active over [-2h, -30min); tx1 ingested at -1h (inside), tx2 now (after unsubscribe).
    sqlite.prepare(`UPDATE webhook_subscriptions SET created_at = datetime('now','-2 hours'), deleted_at = datetime('now','-30 minutes')`).run();
    sqlite.prepare(`UPDATE transactions SET created_at = datetime('now','-1 hour') WHERE id = 1`).run();
    sqlite.prepare(`INSERT INTO transactions (id, bank_account_id, amount_cents, currency, source, date, created_at) VALUES (2, 1, 500, 'CZK', 'email', datetime('now'), datetime('now'))`).run();

    expect(await ensureDeliveryJobs(db, 1)).toBe(1); // inside the window → intent survives the unsubscribe
    expect(await ensureDeliveryJobs(db, 2)).toBe(0); // ingested after the unsubscribe → no job
  });

  it('does not fan out retained history to a subscription created later', async () => {
    const { db, sqlite } = setup();
    sqlite.prepare(`UPDATE transactions SET created_at = datetime('now', '-1 day')`).run();
    sqlite.prepare(`UPDATE webhook_subscriptions SET created_at = datetime('now', '-1 day')`).run();
    expect(await ensureDeliveryJobs(db, 1)).toBe(1);

    sqlite.prepare(`INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('late', 'https://example.test/late', 'x', 'x', 'x')`).run();
    sqlite.prepare(`INSERT INTO webhook_subscriptions (bank_account_id, consumer_app_id) VALUES (1, 'late')`).run();

    expect(await ensureDeliveryJobs(db, 1)).toBe(0);
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM webhook_delivery_jobs`).get()).toMatchObject({ count: 1 });
  });
});
