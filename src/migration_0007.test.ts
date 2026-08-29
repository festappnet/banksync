import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Matrix #11: the 0007 expand migration must preserve every 0006 row (the table
// is rebuilt to widen the status CHECK and add fencing columns) and backfill the
// new columns, then still run the runtime queries. Seeds the OLD schema first,
// then applies 0007 — never the whole set at once.

const PRE = ['0001_schema.sql', '0002_multitenant.sql', '0003_cf_rule_sync.sql', '0004_phase16_hardening.sql', '0005_fio_api_sync.sql', '0006_webhook_delivery_jobs.sql'];

function readMig(name: string): string {
  return readFileSync(resolve(__dirname, '../migrations', name), 'utf8');
}

describe('0007 expand migration preservation', () => {
  it('preserves 0006 delivery jobs, backfills fencing columns, and adds the alert outbox', () => {
    const sqlite = new Database(':memory:');
    for (const m of PRE) sqlite.exec(readMig(m));

    // Seed pre-expand rows across every 0006 status.
    sqlite.prepare(`INSERT INTO bank_accounts (id, account_number, account_type, pairing_code) VALUES (1, '1/2010', 'FIO', 'abc123def4')`).run();
    sqlite.prepare(`INSERT INTO transactions (id, bank_account_id, amount_cents, currency, source, date) VALUES (1, 1, 1000, 'CZK', 'email', datetime('now'))`).run();
    sqlite.prepare(`INSERT INTO webhook_delivery_jobs (id, transaction_id, consumer_app_id, delivery_id, payload, status, attempt_count, next_attempt_at, last_http_status, last_error, delivered_at) VALUES (1, 1, 'festapp', 'D-DELIVERED', '{}', 'delivered', 3, datetime('now'), 200, NULL, datetime('now'))`).run();
    sqlite.prepare(`INSERT INTO webhook_delivery_jobs (id, transaction_id, consumer_app_id, delivery_id, payload, status, attempt_count, next_attempt_at) VALUES (2, 1, 'other', 'D-QUEUED', '{}', 'queued', 1, datetime('now'))`).run();

    expect((sqlite.prepare(`SELECT value FROM schema_meta WHERE key='version'`).get() as { value: string }).value).toBe('6');

    // Apply the expand migration.
    sqlite.exec(readMig('0007_webhook_delivery_fencing.sql'));

    expect((sqlite.prepare(`SELECT value FROM schema_meta WHERE key='version'`).get() as { value: string }).value).toBe('7');

    const jobs = sqlite.prepare(`SELECT id, status, generation, dispatch_token, http_attempt_count, event_kind, last_http_status FROM webhook_delivery_jobs ORDER BY id`).all() as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(2);
    // Every row preserved, status intact, counters backfilled from attempt_count.
    expect(jobs[0]).toMatchObject({ id: 1, status: 'delivered', generation: 1, dispatch_token: null, http_attempt_count: 3, event_kind: 'transaction.received', last_http_status: 200 });
    expect(jobs[1]).toMatchObject({ id: 2, status: 'queued', generation: 1, http_attempt_count: 1 });

    // The widened status CHECK now permits the new `dispatching` value.
    sqlite.prepare(`UPDATE webhook_delivery_jobs SET status='dispatching' WHERE id=2`).run();
    expect((sqlite.prepare(`SELECT status FROM webhook_delivery_jobs WHERE id=2`).get() as { status: string }).status).toBe('dispatching');

    // 0008 (applied on top) adds the alert outbox + subscription tombstone column.
    sqlite.exec(readMig('0008_alert_outbox_and_subscription_history.sql'));
    expect((sqlite.prepare(`SELECT value FROM schema_meta WHERE key='version'`).get() as { value: string }).value).toBe('8');
    expect(() => sqlite.prepare(`SELECT COUNT(*) FROM webhook_delivery_alerts`).get()).not.toThrow();
    expect(sqlite.prepare(`SELECT name FROM pragma_table_info('webhook_subscriptions') WHERE name='deleted_at'`).get()).toBeTruthy();

    // Runtime due-scan query works against the expanded schema.
    const due = sqlite.prepare(`SELECT id FROM webhook_delivery_jobs WHERE status IN ('pending','dispatching','queued') AND datetime(next_attempt_at) <= datetime('now')`).all();
    expect(due.length).toBeGreaterThanOrEqual(1);
  });
});
