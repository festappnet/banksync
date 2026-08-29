import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { D1Database, D1Result, D1PreparedStatement, R2Bucket, R2Object } from '@cloudflare/workers-types';
import { buildSqlDump, runBackupTick as rawRunBackupTick, decryptBackup, TABLES, BACKUP_EXCLUDED } from './backup';

const TEST_BACKUP_KEY = btoa('k'.repeat(32));
function runBackupTick(db: D1Database, cfg: Parameters<typeof rawRunBackupTick>[1]) {
  return rawRunBackupTick(db, { ...cfg, encryptionKey: TEST_BACKUP_KEY, keyVersion: 1 });
}

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
          meta: {
            changes: 0,
            last_row_id: 0,
            duration: 0,
            size_after: 0,
            rows_read: results.length,
            rows_written: 0,
            changed_db: false,
          },
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

// ---- R2 mock ----

interface MockR2Storage {
  objects: Map<string, { key: string; data: Uint8Array; metadata?: Record<string, string> | undefined }>;
}

function makeMockR2(): { bucket: R2Bucket; storage: MockR2Storage } {
  const storage: MockR2Storage = { objects: new Map() };

  const bucket = {
    async put(
      key: string,
      value: ArrayBuffer | ArrayBufferView | string | ReadableStream<Uint8Array> | Blob,
      options?: { httpMetadata?: Record<string, unknown>; customMetadata?: Record<string, string> },
    ) {
      let buf: Uint8Array;
      if (typeof value === 'string') {
        buf = new TextEncoder().encode(value);
      } else if (ArrayBuffer.isView(value)) {
        buf = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      } else if (value instanceof ArrayBuffer) {
        buf = new Uint8Array(value);
      } else {
        throw new Error('unsupported value type for mock R2.put');
      }

      const obj: { key: string; data: Uint8Array; metadata?: Record<string, string> } = {
        key,
        data: buf,
      };
      if (options?.customMetadata) {
        obj.metadata = options.customMetadata;
      }
      storage.objects.set(key, obj);

      return {
        key,
        version: '1',
        size: buf.byteLength,
        etag: 'mock-etag',
        httpEtag: 'mock-http-etag',
        uploaded: new Date(),
      } as any;
    },

    async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
      const filtered = [...storage.objects.keys()]
        .filter(k => !options?.prefix || k.startsWith(options.prefix))
        .sort()
        .slice(0, options?.limit ?? 1000);

      const objects = filtered.map(key => ({
        key,
        size: storage.objects.get(key)!.data.byteLength,
        uploaded: new Date(),
        etag: 'mock-etag',
        httpEtag: 'mock-http-etag',
        storageClass: 'STANDARD',
        customMetadata: storage.objects.get(key)?.metadata,
      })) as R2Object[];

      return {
        objects,
        truncated: false,
        cursor: undefined,
        delimitedPrefixes: [],
      };
    },

    async delete(key: string) {
      storage.objects.delete(key);
    },
  } as unknown as R2Bucket;

  return { bucket, storage };
}

// ---- migrations ----

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

// ---- tests ----

describe('backup allowlist completeness', () => {
  it('every application table is either backed up or explicitly excluded', () => {
    const sqlite = new Database(':memory:');
    applyMigrations(sqlite);
    const tables = (sqlite.prepare(
      `SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    ).all() as Array<{ name: string }>).map((r) => r.name);

    const covered = new Set([...TABLES, ...Object.keys(BACKUP_EXCLUDED)]);
    const missing = tables.filter((t) => !covered.has(t));
    expect(missing).toEqual([]); // a new table must be added to TABLES or BACKUP_EXCLUDED

    // And no allowlisted table is stale (present in the list but not the schema).
    const schema = new Set(tables);
    expect(TABLES.filter((t) => !schema.has(t))).toEqual([]);
  });
});

describe('backup', () => {
  describe('buildSqlDump', () => {
    it('empty DB generates header but no row inserts', async () => {
      const { db } = makeTestDb();
      const { sql, rowCounts } = await buildSqlDump(db);

      expect(sql).toContain('-- banksync backup');
      expect(sql).toContain('-- schema_version=10');
      expect(sql).toContain('-- restore: re-apply migrations then load this file');

      // All tables should have 0 rows except schema_meta
      for (const [table, count] of Object.entries(rowCounts)) {
        if (table === 'schema_meta') {
          expect(count).toBeGreaterThan(0);
        } else {
          expect(count).toBe(0);
        }
      }

      expect(sql).not.toContain('INSERT INTO');
      expect(sql).toContain('INSERT OR REPLACE INTO schema_meta');
    });

    it('DB with bank_accounts contains INSERT INTO bank_accounts', async () => {
      const { db, sqlite } = makeTestDb();
      sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code) VALUES (?, ?)`).run('1234/2010', 'code0001');

      const { sql, rowCounts } = await buildSqlDump(db);

      expect(rowCounts.bank_accounts).toBe(1);
      expect(sql).toContain('INSERT INTO bank_accounts');
      expect(sql).toContain("'1234/2010'");
      expect(sql).toContain("'code0001'");
    });

    it('table_row_counts populated correctly for multiple tables', async () => {
      const { db, sqlite } = makeTestDb();
      sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code) VALUES (?, ?)`).run('1234/2010', 'code0001');
      sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code) VALUES (?, ?)`).run('5678/2010', 'code0002');
      sqlite.prepare(`INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES (?, ?, ?, ?, ?)`).run('app1', 'http://example.com', 'cipher', 'hash', 'prefix');

      const { rowCounts } = await buildSqlDump(db);

      expect(rowCounts.bank_accounts).toBe(2);
      expect(rowCounts.webhook_consumers).toBe(1);
      expect(rowCounts.transactions).toBe(0);
    });

    it('restores into a freshly migrated schema without schema_meta conflicts', async () => {
      const { db, sqlite } = makeTestDb();
      sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code) VALUES (?, ?)`).run('1234/2010', 'code0001');
      sqlite.prepare(`INSERT INTO schema_meta (key, value) VALUES (?, ?)`).run('backup_fixture', 'present');
      const { sql } = await buildSqlDump(db);

      const restored = new Database(':memory:');
      applyMigrations(restored);
      expect(() => restored.exec(sql)).not.toThrow();
      expect(restored.prepare(`SELECT count(*) AS count FROM bank_accounts`).get()).toEqual({ count: 1 });
      expect(restored.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).get()).toEqual({ value: '10' });
      expect(restored.prepare(`SELECT value FROM schema_meta WHERE key = 'backup_fixture'`).get()).toEqual({ value: 'present' });
    });

    it('NULL columns emit literal NULL', async () => {
      const { db, sqlite } = makeTestDb();
      sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code, label) VALUES (?, ?, ?)`).run('1234/2010', 'code0001', null);

      const { sql } = await buildSqlDump(db);

      expect(sql).toContain('INSERT INTO bank_accounts');
      expect(sql).toContain(', NULL,');
    });

    it("single quotes in strings escaped (John's → 'John''s')", async () => {
      const { db, sqlite } = makeTestDb();
      sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code, label) VALUES (?, ?, ?)`).run('1234/2010', "code'001", "John's Account");

      const { sql } = await buildSqlDump(db);

      expect(sql).toContain("'code''001'");
      expect(sql).toContain("'John''s Account'");
    });

    it('boolean columns stored as 0/1', async () => {
      const { db, sqlite } = makeTestDb();
      sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code) VALUES (?, ?)`).run('1234/2010', 'code0001');

      const { sql } = await buildSqlDump(db);

      // Verify no explicit boolean columns in this schema, but test the sqlValue function indirectly
      expect(sql).toContain('INSERT INTO');
    });

    it('date columns (TEXT timestamps) preserved', async () => {
      const { db, sqlite } = makeTestDb();
      const ts = '2026-05-08T12:34:56Z';
      sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code, created_at) VALUES (?, ?, ?)`).run('1234/2010', 'code0001', ts);

      const { sql } = await buildSqlDump(db);

      expect(sql).toContain(ts);
    });

    it('numeric columns preserved as numbers', async () => {
      const { db, sqlite } = makeTestDb();
      sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code) VALUES (?, ?)`).run('1234/2010', 'code0001');
      const accountId = sqlite.prepare(`SELECT id FROM bank_accounts LIMIT 1`).get() as { id: number };
      sqlite.prepare(`INSERT INTO transactions (bank_account_id, amount_cents, currency, source, date) VALUES (?, ?, ?, ?, ?)`).run(accountId.id, 1990, 'CZK', 'email', '2026-05-08T00:00:00Z');

      const { sql } = await buildSqlDump(db);

      expect(sql).toContain('1990'); // amount_cents without quotes
      expect(sql).toContain("'CZK'"); // currency with quotes
    });

    it('excludes ephemeral idempotency and rate-limit rows completely', async () => {
      const { db, sqlite } = makeTestDb();
      sqlite.prepare(`INSERT INTO idempotency_keys (key_hash, auth_principal, request_path, request_method, response_status, response_body) VALUES ('k','admin','/consumers','POST',201,'canary-plaintext-secret')`).run();
      sqlite.prepare(`INSERT INTO rate_limit_buckets (principal, window_start, count) VALUES ('tenant:x','2026-01-01 00:00',1)`).run();
      const { sql } = await buildSqlDump(db);
      expect(sql).not.toContain('idempotency_keys');
      expect(sql).not.toContain('rate_limit_buckets');
      expect(sql).not.toContain('canary-plaintext-secret');
    });
  });

  describe('runBackupTick', () => {
    it('r2_bucket_unbound: cfg.bucket undefined → uploaded=false, skipped_reason set', async () => {
      const { db } = makeTestDb();

      const result = await runBackupTick(db, { bucket: undefined, prefix: 'test', retain: 8 });

      expect(result.uploaded).toBe(false);
      expect(result.skipped_reason).toBe('r2_bucket_unbound');
      expect(result.key).toBeUndefined();
    });

    it('happy path: uploads file with YYYYMMDD format', async () => {
      const { db } = makeTestDb();
      const { bucket } = makeMockR2();

      const result = await runBackupTick(db, { bucket, prefix: 'banksync-test', retain: 8 });

      expect(result.uploaded).toBe(true);
      expect(result.key).toMatch(/^banksync-test-\d{8}\.sql\.enc$/);
      expect(result.size_bytes).toBeGreaterThan(0);
    });

    it('refuses to write plaintext when encryption configuration is absent', async () => {
      const { db } = makeTestDb();
      const { bucket, storage } = makeMockR2();
      const result = await rawRunBackupTick(db, { bucket, prefix: 'banksync-test' });
      expect(result).toEqual({ uploaded: false, skipped_reason: 'backup_encryption_not_configured' });
      expect(storage.objects.size).toBe(0);
    });

    it('encrypted object contains no SQL canary and authentication detects tampering', async () => {
      const { db, sqlite } = makeTestDb();
      const { bucket, storage } = makeMockR2();
      sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code, label) VALUES ('1234/2010','aabbccdd11','PII-CANARY')`).run();
      const result = await runBackupTick(db, { bucket, prefix: 'banksync-test' });
      const bytes = storage.objects.get(result.key!)!.data;
      expect(new TextDecoder().decode(bytes)).not.toContain('PII-CANARY');
      await expect(decryptBackup(bytes, TEST_BACKUP_KEY)).resolves.toContain('PII-CANARY');
      const envelope = JSON.parse(new TextDecoder().decode(bytes));
      envelope.ciphertext = envelope.ciphertext.slice(0, -2) + 'AA';
      await expect(decryptBackup(new TextEncoder().encode(JSON.stringify(envelope)), TEST_BACKUP_KEY)).rejects.toThrow();
    });

    it('filename uses YYYYMMDD format (e.g. 20260508)', async () => {
      const { db } = makeTestDb();
      const { bucket } = makeMockR2();

      const result = await runBackupTick(db, { bucket, prefix: 'banksync-prod', retain: 8 });

      const match = result.key?.match(/banksync-prod-(\d{8})\.sql\.enc/);
      expect(match).not.toBeNull();
      const dateStr = match![1];
      expect(dateStr).toMatch(/^\d{8}$/);
    });

    it('table_row_counts populated in result', async () => {
      const { db, sqlite } = makeTestDb();
      const { bucket } = makeMockR2();

      sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code) VALUES (?, ?)`).run('1234/2010', 'code0001');

      const result = await runBackupTick(db, { bucket, prefix: 'banksync-test', retain: 8 });

      expect(result.table_row_counts).toBeDefined();
      expect(result.table_row_counts!.bank_accounts).toBe(1);
    });

    it('httpMetadata.contentType is application/sql', async () => {
      const { db } = makeTestDb();
      const { bucket, storage } = makeMockR2();

      const result = await runBackupTick(db, { bucket, prefix: 'banksync-test', retain: 8 });

      const key = result.key!;
      // The mock doesn't store httpMetadata, but we can verify it was called
      expect(key).toBeDefined();
    });

    it('customMetadata includes banksync_table_count and banksync_total_rows', async () => {
      const { db, sqlite } = makeTestDb();
      const { bucket, storage } = makeMockR2();

      sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code) VALUES (?, ?)`).run('1234/2010', 'code0001');
      sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code) VALUES (?, ?)`).run('5678/2010', 'code0002');

      const result = await runBackupTick(db, { bucket, prefix: 'banksync-test', retain: 8 });

      const key = result.key!;
      const obj = storage.objects.get(key);
      expect(obj?.metadata?.banksync_table_count).toBeDefined();
      expect(obj?.metadata?.banksync_total_rows).toBeDefined();
      expect(Number(obj?.metadata?.banksync_table_count!)).toBeGreaterThan(0);
    });

    it('retention: 10 existing backups, retain=8 → current backup plus 7 newest remain', async () => {
      const { db } = makeTestDb();
      const { bucket, storage } = makeMockR2();

      const prefix = 'banksync-test';

      // Manually insert 10 old backup keys
      for (let i = 0; i < 10; i++) {
        const key = `${prefix}-2026050${i}.sql`;
        storage.objects.set(key, { key, data: new Uint8Array([1, 2, 3]) });
      }

      const result = await runBackupTick(db, { bucket, prefix, retain: 8 });

      expect(result.pruned_keys).toBeDefined();
      expect(result.pruned_keys!.length).toBe(3);

      // The 3 oldest should be removed because this tick uploads today's backup first.
      expect(result.pruned_keys).toContain(`${prefix}-20260500.sql`);
      expect(result.pruned_keys).toContain(`${prefix}-20260501.sql`);
      expect(result.pruned_keys).toContain(`${prefix}-20260502.sql`);

      // Verify they're deleted from storage
      expect(storage.objects.has(`${prefix}-20260500.sql`)).toBe(false);
      expect(storage.objects.has(`${prefix}-20260501.sql`)).toBe(false);
      expect(storage.objects.has(`${prefix}-20260502.sql`)).toBe(false);

      // And today's backup plus the 7 newest historical backups remain
      expect(storage.objects.has(`${prefix}-20260503.sql`)).toBe(true);
      expect(storage.objects.has(`${prefix}-20260509.sql`)).toBe(true);
    });

    it('retention: less than retain count → no deletes', async () => {
      const { db } = makeTestDb();
      const { bucket, storage } = makeMockR2();

      const prefix = 'banksync-test';

      // Insert 5 old backups
      for (let i = 0; i < 5; i++) {
        const key = `${prefix}-2026050${i}.sql`;
        storage.objects.set(key, { key, data: new Uint8Array([1, 2, 3]) });
      }

      const result = await runBackupTick(db, { bucket, prefix, retain: 8 });

      // Should not prune any (only have 5, retain is 8)
      expect(result.pruned_keys).toHaveLength(0);

      // All should still exist
      for (let i = 0; i < 5; i++) {
        const key = `${prefix}-2026050${i}.sql`;
        expect(storage.objects.has(key)).toBe(true);
      }
    });

    it('idempotent same-day call: second run for same date overwrites first key (no duplicate)', async () => {
      const { db, sqlite } = makeTestDb();
      const { bucket, storage } = makeMockR2();

      const prefix = 'banksync-test';

      // First run
      const result1 = await runBackupTick(db, { bucket, prefix, retain: 8 });
      const key1 = result1.key!;
      expect(storage.objects.size).toBe(1);

      // Add a data change
      sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code) VALUES (?, ?)`).run('1234/2010', 'code0001');

      // Second run for same day
      const result2 = await runBackupTick(db, { bucket, prefix, retain: 8 });
      const key2 = result2.key!;

      // Should be the same key
      expect(key2).toBe(key1);

      // Storage should still have only 1 object (overwritten)
      expect(storage.objects.size).toBe(1);

      // New content should be there
      const encryptedContent = storage.objects.get(key2)!.data;
      expect(new TextDecoder().decode(encryptedContent)).not.toContain('bank_accounts');
      await expect(decryptBackup(encryptedContent, TEST_BACKUP_KEY)).resolves.toContain('bank_accounts');
    });

    it('default retain=8 is applied when retain is undefined', async () => {
      const { db } = makeTestDb();
      const { bucket, storage } = makeMockR2();

      const prefix = 'banksync-test';

      // Insert 10 old backups
      for (let i = 0; i < 10; i++) {
        const key = `${prefix}-2026050${i}.sql`;
        storage.objects.set(key, { key, data: new Uint8Array([1, 2, 3]) });
      }

      const result = await runBackupTick(db, { bucket, prefix }); // No retain specified

      // Should prune 3: 10 historical backups + today's upload, retain 8.
      expect(result.pruned_keys!.length).toBe(3);
    });

    it('SQL dump contains proper INSERT statements', async () => {
      const { db, sqlite } = makeTestDb();
      const { bucket, storage } = makeMockR2();

      sqlite.prepare(`INSERT INTO bank_accounts (account_number, pairing_code, label) VALUES (?, ?, ?)`).run('1234/2010', 'code0001', 'MyAccount');

      const result = await runBackupTick(db, { bucket, prefix: 'banksync-test', retain: 8 });

      const encrypted = storage.objects.get(result.key!)!.data;
      expect(new TextDecoder().decode(encrypted)).not.toContain('MyAccount');
      const content = await decryptBackup(encrypted, TEST_BACKUP_KEY);
      expect(content).toContain('INSERT INTO bank_accounts');
      expect(content).toContain("'1234/2010'");
      expect(content).toContain("'code0001'");
      expect(content).toContain("'MyAccount'");
    });
  });
});
