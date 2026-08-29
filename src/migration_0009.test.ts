import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Matrix #9: the contract cleanup must canonically represent EVERY historical
// DLQ row before dropping webhook_dlq_archive — no blanket delete, no long-term
// archive. Null-transaction orphans become terminal legacy jobs; the table is
// then dropped and the schema is a single unified forward-only shape.

const THROUGH_0008 = [
  '0001_schema.sql', '0002_multitenant.sql', '0003_cf_rule_sync.sql',
  '0004_phase16_hardening.sql', '0005_fio_api_sync.sql',
  '0006_webhook_delivery_jobs.sql', '0007_webhook_delivery_fencing.sql',
  '0008_alert_outbox_and_subscription_history.sql',
];
function readMig(n: string): string { return readFileSync(resolve(__dirname, '../migrations', n), 'utf8'); }

describe('0009 contract cleanup', () => {
  it('imports null-transaction orphans as terminal legacy jobs, then drops the archive', () => {
    const sqlite = new Database(':memory:');
    for (const m of THROUGH_0008) sqlite.exec(readMig(m));

    // Seed the legacy archive: 2 null-transaction orphans + (a with-transaction
    // row is irrelevant here — 0006 already imported those). Note 0006 renamed
    // webhook_dlq -> webhook_dlq_archive, so it exists now.
    sqlite.prepare(`INSERT INTO bank_accounts (id, account_number, account_type, pairing_code) VALUES (1,'1/2010','FIO','abc123def4')`).run();
    sqlite.prepare(`INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES ('festapp','https://x','x','x','x')`).run();
    sqlite.prepare(`INSERT INTO webhook_dlq_archive (id, delivery_id, consumer_app_id, bank_account_id, transaction_id, payload, last_error, attempts, created_at) VALUES (101,'ORPHAN-1','festapp',1,NULL,'{}','old_error',4,datetime('now'))`).run();
    sqlite.prepare(`INSERT INTO webhook_dlq_archive (id, delivery_id, consumer_app_id, bank_account_id, transaction_id, payload, last_error, attempts, created_at) VALUES (102,'ORPHAN-2','festapp',1,NULL,'{}','old_error',2,datetime('now'))`).run();

    const before = (sqlite.prepare(`SELECT COUNT(*) AS n FROM webhook_dlq_archive WHERE transaction_id IS NULL`).get() as { n: number }).n;
    expect(before).toBe(2);

    sqlite.exec(readMig('0009_contract_drop_dlq_archive.sql'));

    // Version unified to 9.
    expect((sqlite.prepare(`SELECT value FROM schema_meta WHERE key='version'`).get() as { value: string }).value).toBe('9');
    // Archive table gone.
    expect(sqlite.prepare(`SELECT name FROM sqlite_schema WHERE type='table' AND name='webhook_dlq_archive'`).get()).toBeUndefined();
    // Both orphans preserved as terminal legacy jobs — none lost.
    const imported = sqlite.prepare(`SELECT delivery_id, status, import_source, legacy_dlq_id, http_attempt_count, last_error, transaction_id FROM webhook_delivery_jobs WHERE import_source='legacy_dlq' ORDER BY legacy_dlq_id`).all() as Array<Record<string, unknown>>;
    expect(imported).toHaveLength(2);
    expect(imported[0]).toMatchObject({ delivery_id: 'ORPHAN-1', status: 'terminal', import_source: 'legacy_dlq', legacy_dlq_id: 101, http_attempt_count: 4, last_error: 'legacy_missing_transaction', transaction_id: null });
    expect(imported[1]).toMatchObject({ delivery_id: 'ORPHAN-2', legacy_dlq_id: 102, http_attempt_count: 2 });
  });
});
