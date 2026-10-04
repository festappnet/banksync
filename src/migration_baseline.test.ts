import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('canonical D1 baseline', () => {
  it('creates the complete version 10 schema from an empty database', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(resolve(__dirname, '../migrations/0001_schema.sql'), 'utf8'));

    expect((sqlite.prepare(`SELECT value FROM schema_meta WHERE key='version'`).get() as { value: string }).value).toBe('10');
    const tables = sqlite.prepare(`SELECT name FROM sqlite_schema WHERE type='table'`).all() as Array<{ name: string }>;
    const names = new Set(tables.map(({ name }) => name));
    expect(names.has('webhook_delivery_jobs')).toBe(true);
    expect(names.has('webhook_delivery_alerts')).toBe(true);
    expect(names.has('webhook_dlq')).toBe(false);
    expect(names.has('webhook_dlq_archive')).toBe(false);
    expect(sqlite.prepare(`SELECT name FROM pragma_table_info('webhook_subscriptions') WHERE name='deleted_at'`).get()).toBeTruthy();
  });

  it('upgrades a version 9 database, clears response cache, and converges structurally', () => {
    const baseline = readFileSync(resolve(__dirname, '../migrations/0001_schema.sql'), 'utf8');
    const upgrade = readFileSync(resolve(__dirname, '../migrations/0010_security_hardening.sql'), 'utf8');
    const fresh = new Database(':memory:');
    fresh.exec(baseline);

    const upgraded = new Database(':memory:');
    for (let version = 1; version <= 9; version += 1) {
      const prefix = String(version).padStart(4, '0');
      const file = [
        'schema', 'multitenant', 'cf_rule_sync', 'phase16_hardening',
        'fio_api_sync', 'webhook_delivery_jobs', 'webhook_delivery_fencing',
        'alert_outbox_and_subscription_history', 'contract_drop_dlq_archive',
      ][version - 1]!;
      upgraded.exec(readFileSync(resolve(__dirname, `../test-fixtures/migrations-v9/${prefix}_${file}.sql`), 'utf8'));
    }
    upgraded.prepare(`INSERT INTO idempotency_keys (key_hash, auth_principal, request_path, request_method, response_status, response_body) VALUES ('canary','admin','/consumers','POST',201,'plaintext-secret')`).run();
    upgraded.exec(upgrade);

    expect((upgraded.prepare(`SELECT value FROM schema_meta WHERE key='version'`).get() as { value: string }).value).toBe('10');
    expect((upgraded.prepare(`SELECT count(*) count FROM idempotency_keys`).get() as { count: number }).count).toBe(0);
    const schema = (db: Database.Database) => {
      const objects = db.prepare(`SELECT type, name, tbl_name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all() as Array<{ type: string; name: string; tbl_name: string }>;
      return objects.map(object => ({
        ...object,
        columns: object.type === 'table' ? db.prepare(`SELECT cid, name, type, \"notnull\", dflt_value, pk FROM pragma_table_xinfo(?) ORDER BY cid`).all(object.name) : [],
        foreignKeys: object.type === 'table' ? db.prepare(`SELECT id, seq, \"table\", \"from\", \"to\", on_update, on_delete, match FROM pragma_foreign_key_list(?) ORDER BY id, seq`).all(object.name) : [],
        indexColumns: object.type === 'index' ? db.prepare(`SELECT seqno, cid, name, desc, coll, key FROM pragma_index_xinfo(?) ORDER BY seqno`).all(object.name) : [],
      }));
    };
    expect(schema(upgraded)).toEqual(schema(fresh));
  });
});


it('schema 11 preserves archived payload bytes and the high ID watermark after retention', () => {
  const db=new Database(':memory:');db.exec(readFileSync(resolve(__dirname,'../migrations/0001_schema.sql'),'utf8'));
  db.exec("INSERT INTO bank_accounts(id,account_number,pairing_code) VALUES(1,'1234/2010','0123456789')");
  db.exec("INSERT INTO transactions(id,bank_account_id,amount_cents,currency,source,date,transaction_id) VALUES(5000,1,1000,'CZK','email','2026-01-01','777')");
  db.exec("INSERT INTO webhook_delivery_jobs(transaction_id,consumer_app_id,event_kind,delivery_id,payload,status,next_attempt_at) VALUES(5000,'dating','transaction.received','01K00000000000000000000001','archived exact bytes','delivered',datetime('now'))");
  db.exec('DELETE FROM transactions');
  const before=db.prepare('SELECT payload FROM webhook_delivery_jobs').get();
  db.exec(readFileSync(resolve(__dirname,'../migrations/0011_complete_bank_facts.sql'),'utf8'));
  db.exec("INSERT INTO transactions(bank_account_id,amount_cents,currency,source,date) VALUES(1,-1000,'EUR','fio_api','2026-10-04')");
  expect(db.prepare('SELECT id FROM transactions').get()).toEqual({id:5001});
  expect(db.prepare('SELECT payload FROM webhook_delivery_jobs').get()).toEqual(before);
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='idx_tx_fuzzy_same_day'").get()).toBeUndefined();
});
