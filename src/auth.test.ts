import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { D1Database, D1Result, D1PreparedStatement } from '@cloudflare/workers-types';
import { resolveAuth, generateTenantAdminKey, hashKey, timingSafeEqual } from './auth';
import { createConsumer, setConsumerAdminKey, resetSchemaCheckCache } from './db';

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

function makeTestDb(): D1Database {
  const sqlite = new Database(':memory:');
  for (const m of MIGRATIONS) {
    const p = resolve(__dirname, '../migrations', m);
    sqlite.exec(readFileSync(p, 'utf8'));
  }
  return wrapAsD1(sqlite);
}

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/', { headers });
}

// ---- tests ----

describe('timingSafeEqual', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
  });

  it('returns false for different lengths', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });

  it('returns false for different content of same length', () => {
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
  });
});

describe('hashKey', () => {
  it('is deterministic — same input produces same hash', async () => {
    const h1 = await hashKey('test-key-value');
    const h2 = await hashKey('test-key-value');
    expect(h1).toBe(h2);
  });

  it('produces a 64-char hex string (SHA-256)', async () => {
    const h = await hashKey('anything');
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('generateTenantAdminKey', () => {
  it('plain starts with bksk_, prefix is 12 chars, hash is 64 hex chars', async () => {
    const { plain, prefix, hash } = await generateTenantAdminKey();
    expect(plain.startsWith('bksk_')).toBe(true);
    expect(prefix).toHaveLength(12);
    expect(prefix).toBe(plain.slice(0, 12));
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates unique keys on each call', async () => {
    const a = await generateTenantAdminKey();
    const b = await generateTenantAdminKey();
    expect(a.plain).not.toBe(b.plain);
  });
});

describe('resolveAuth', () => {
  let db: D1Database;
  const ADMIN_SECRET = 'super-secret-token';

  beforeEach(() => {
    resetSchemaCheckCache();
    db = makeTestDb();
  });

  it('no headers → unauth', async () => {
    const ctx = await resolveAuth(makeRequest(), { DB: db, ADMIN_SECRET });
    expect(ctx).toEqual({ type: 'unauth' });
  });

  it('wrong admin secret → unauth', async () => {
    const ctx = await resolveAuth(
      makeRequest({ 'X-Admin-Secret': 'wrong-value' }),
      { DB: db, ADMIN_SECRET },
    );
    expect(ctx).toEqual({ type: 'unauth' });
  });

  it('correct admin secret → { type: admin }', async () => {
    const ctx = await resolveAuth(
      makeRequest({ 'X-Admin-Secret': ADMIN_SECRET }),
      { DB: db, ADMIN_SECRET },
    );
    expect(ctx).toEqual({ type: 'admin' });
  });

  it('tenant key with no consumer (prefix not in DB) → unauth', async () => {
    const { plain } = await generateTenantAdminKey();
    const ctx = await resolveAuth(
      makeRequest({ 'X-Tenant-Secret': plain }),
      { DB: db, ADMIN_SECRET },
    );
    expect(ctx).toEqual({ type: 'unauth' });
  });

  it('tenant key with matching prefix but wrong key (hash mismatch) → unauth', async () => {
    // Register a consumer with a known admin key
    await createConsumer(db, {
      app_id: 'app-hash-mismatch',
      callback_url: 'https://example.com/cb',
      secret_cipher: 'cipher',
      secret_hash: 'shash',
      secret_prefix: 'spfx',
    });
    const { plain, prefix, hash } = await generateTenantAdminKey();
    await setConsumerAdminKey(db, 'app-hash-mismatch', hash, prefix);

    // Build a key that shares the same 12-char prefix but differs thereafter
    const wrongKey = plain.slice(0, 12) + 'X'.repeat(plain.length - 12);
    const ctx = await resolveAuth(
      makeRequest({ 'X-Tenant-Secret': wrongKey }),
      { DB: db, ADMIN_SECRET },
    );
    expect(ctx).toEqual({ type: 'unauth' });
  });

  it('tenant key with matching prefix + correct hash → { type: tenant, app_id }', async () => {
    await createConsumer(db, {
      app_id: 'app-valid-tenant',
      callback_url: 'https://example.com/cb',
      secret_cipher: 'cipher',
      secret_hash: 'shash',
      secret_prefix: 'spfx',
    });
    const { plain, prefix, hash } = await generateTenantAdminKey();
    await setConsumerAdminKey(db, 'app-valid-tenant', hash, prefix);

    const ctx = await resolveAuth(
      makeRequest({ 'X-Tenant-Secret': plain }),
      { DB: db, ADMIN_SECRET },
    );
    expect(ctx).toEqual({ type: 'tenant', app_id: 'app-valid-tenant' });
  });

  it('both headers, admin valid → admin wins (cheaper path first)', async () => {
    await createConsumer(db, {
      app_id: 'app-both-admin-wins',
      callback_url: 'https://example.com/cb',
      secret_cipher: 'cipher',
      secret_hash: 'shash',
      secret_prefix: 'spfx',
    });
    const { plain, prefix, hash } = await generateTenantAdminKey();
    await setConsumerAdminKey(db, 'app-both-admin-wins', hash, prefix);

    const ctx = await resolveAuth(
      makeRequest({ 'X-Admin-Secret': ADMIN_SECRET, 'X-Tenant-Secret': plain }),
      { DB: db, ADMIN_SECRET },
    );
    expect(ctx).toEqual({ type: 'admin' });
  });

  it('both headers, admin invalid + tenant valid → tenant resolves', async () => {
    await createConsumer(db, {
      app_id: 'app-both-tenant-wins',
      callback_url: 'https://example.com/cb',
      secret_cipher: 'cipher',
      secret_hash: 'shash',
      secret_prefix: 'spfx',
    });
    const { plain, prefix, hash } = await generateTenantAdminKey();
    await setConsumerAdminKey(db, 'app-both-tenant-wins', hash, prefix);

    const ctx = await resolveAuth(
      makeRequest({ 'X-Admin-Secret': 'wrong-admin', 'X-Tenant-Secret': plain }),
      { DB: db, ADMIN_SECRET },
    );
    expect(ctx).toEqual({ type: 'tenant', app_id: 'app-both-tenant-wins' });
  });
});
