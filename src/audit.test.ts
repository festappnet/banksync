import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { D1Database, D1Result, D1PreparedStatement } from '@cloudflare/workers-types';
import { recordAudit, shouldAuditMethod, redactBodyForAudit, listAuditLog } from './audit.js';

// ---- D1 facade over better-sqlite3 ----

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

const MIGRATIONS = ['0001_schema.sql'];

function makeTestDb(): { db: D1Database; sqlite: Database.Database } {
  const sqlite = new Database(':memory:');
  for (const m of MIGRATIONS) {
    const p = resolve(__dirname, '../migrations', m);
    sqlite.exec(readFileSync(p, 'utf8'));
  }
  return { db: wrapAsD1(sqlite), sqlite };
}

// ---- tests ----

describe('shouldAuditMethod', () => {
  it('returns false for GET, HEAD, OPTIONS', () => {
    expect(shouldAuditMethod('GET')).toBe(false);
    expect(shouldAuditMethod('HEAD')).toBe(false);
    expect(shouldAuditMethod('OPTIONS')).toBe(false);
  });

  it('returns true for POST, PUT, DELETE, PATCH', () => {
    expect(shouldAuditMethod('POST')).toBe(true);
    expect(shouldAuditMethod('PUT')).toBe(true);
    expect(shouldAuditMethod('DELETE')).toBe(true);
    expect(shouldAuditMethod('PATCH')).toBe(true);
  });

  it('returns false for lowercase post (requires canonical uppercase)', () => {
    expect(shouldAuditMethod('post')).toBe(false);
    expect(shouldAuditMethod('put')).toBe(false);
    expect(shouldAuditMethod('delete')).toBe(false);
    expect(shouldAuditMethod('patch')).toBe(false);
  });
});

describe('recordAudit — writes row with all fields', () => {
  it('inserts a row with every field populated', async () => {
    const { db, sqlite } = makeTestDb();

    await recordAudit({
      db,
      authPrincipal: 'admin',
      httpMethod: 'POST',
      requestPath: '/admin/consumers',
      httpStatus: 201,
      requestBodySummary: '{"app_id":"test"}',
      sourceIp: '1.2.3.4',
      userAgent: 'TestAgent/1.0',
      durationMs: 42,
    });

    const row = sqlite.prepare(`SELECT * FROM admin_audit_log`).get() as {
      id: number; auth_principal: string; http_method: string; request_path: string;
      http_status: number; request_body_summary: string | null; source_ip: string | null;
      user_agent: string | null; duration_ms: number | null; created_at: string;
    };
    expect(row.auth_principal).toBe('admin');
    expect(row.http_method).toBe('POST');
    expect(row.request_path).toBe('/admin/consumers');
    expect(row.http_status).toBe(201);
    expect(row.request_body_summary).toBe('{"app_id":"test"}');
    expect(row.source_ip).toBe('1.2.3.4');
    expect(row.user_agent).toBe('TestAgent/1.0');
    expect(row.duration_ms).toBe(42);
    expect(typeof row.created_at).toBe('string');
  });
});

describe('recordAudit — defaults missing optional fields to NULL', () => {
  it('omitted optional fields become NULL in DB', async () => {
    const { db, sqlite } = makeTestDb();

    await recordAudit({
      db,
      authPrincipal: 'tenant:app1',
      httpMethod: 'DELETE',
      requestPath: '/admin/bank-accounts/5',
      httpStatus: 204,
    });

    const row = sqlite.prepare(`SELECT * FROM admin_audit_log`).get() as {
      request_body_summary: string | null; source_ip: string | null;
      user_agent: string | null; duration_ms: number | null;
    };
    expect(row.request_body_summary).toBeNull();
    expect(row.source_ip).toBeNull();
    expect(row.user_agent).toBeNull();
    expect(row.duration_ms).toBeNull();
  });
});

describe('recordAudit — swallows D1 errors', () => {
  it('does NOT throw when D1 rejects; logs to console.error', async () => {
    const brokenDb = {
      prepare: () => ({
        bind: () => ({
          run: async () => { throw new Error('D1 transient error'); },
        }),
      }),
    } as unknown as D1Database;

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(recordAudit({
      db: brokenDb,
      authPrincipal: 'admin',
      httpMethod: 'POST',
      requestPath: '/admin/consumers',
      httpStatus: 500,
    })).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalledOnce();
    errSpy.mockRestore();
  });
});

describe('recordAudit — truncates request_body_summary to 4KB', () => {
  it('5KB summary is stored truncated to ≤ 4096 bytes', async () => {
    const { db, sqlite } = makeTestDb();
    const big = 'x'.repeat(5120);

    await recordAudit({
      db,
      authPrincipal: 'admin',
      httpMethod: 'PUT',
      requestPath: '/admin/bank-accounts/1',
      httpStatus: 200,
      requestBodySummary: big,
    });

    const row = sqlite.prepare(`SELECT request_body_summary FROM admin_audit_log`).get() as { request_body_summary: string };
    expect(new TextEncoder().encode(row.request_body_summary).length).toBeLessThanOrEqual(4096);
  });
});

describe('redactBodyForAudit — strips sensitive keys', () => {
  it('redacts secret, admin_key, password, token; preserves other keys', () => {
    const input = JSON.stringify({ secret: 'xxx', label: 'OK', admin_key: 'yyy' });
    const output = JSON.parse(redactBodyForAudit(input)) as Record<string, string>;
    expect(output['secret']).toBe('[REDACTED]');
    expect(output['admin_key']).toBe('[REDACTED]');
    expect(output['label']).toBe('OK');
  });

  it('preserves allowlisted keys: secret_prefix, admin_key_prefix, key_hash', () => {
    const input = JSON.stringify({ secret_prefix: 'whsec_abc', admin_key_prefix: 'ak_', key_hash: 'deadbeef' });
    const output = JSON.parse(redactBodyForAudit(input)) as Record<string, string>;
    expect(output['secret_prefix']).toBe('whsec_abc');
    expect(output['admin_key_prefix']).toBe('ak_');
    expect(output['key_hash']).toBe('deadbeef');
  });

  it('recurses into nested objects', () => {
    const input = JSON.stringify({ nested: { password: 'p4ss', safe: 'yes' } });
    const output = JSON.parse(redactBodyForAudit(input)) as { nested: Record<string, string> };
    expect(output.nested['password']).toBe('[REDACTED]');
    expect(output.nested['safe']).toBe('yes');
  });

  it('recurses into arrays of objects', () => {
    const input = JSON.stringify({ items: [{ token: 'tok1', name: 'a' }, { token: 'tok2', name: 'b' }] });
    const output = JSON.parse(redactBodyForAudit(input)) as { items: Array<Record<string, string>> };
    expect(output.items[0]!['token']).toBe('[REDACTED]');
    expect(output.items[0]!['name']).toBe('a');
    expect(output.items[1]!['token']).toBe('[REDACTED]');
  });

  it('on invalid JSON: stores no caller-controlled bytes', () => {
    const invalid = 'not-json-{{{ plaintext-secret';
    const result = redactBodyForAudit(invalid);
    expect(result).toBe('[UNPARSEABLE BODY REDACTED]');
    expect(result).not.toContain('plaintext-secret');
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(4096);
  });

  it('truncates output to ≤ 4KB', () => {
    const big = JSON.stringify({ data: 'a'.repeat(5120) });
    const result = redactBodyForAudit(big);
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(4096);
  });

  it('matches keys case-insensitively: Secret, SECRET_TOKEN, myAuth-key patterns', () => {
    const input = JSON.stringify({ Secret: 'v1', SECRET_TOKEN: 'v2', 'myAuth-key': 'v3', normalField: 'ok' });
    const output = JSON.parse(redactBodyForAudit(input)) as Record<string, string>;
    expect(output['Secret']).toBe('[REDACTED]');
    expect(output['SECRET_TOKEN']).toBe('[REDACTED]');
    expect(output['myAuth-key']).toBe('[REDACTED]');
    expect(output['normalField']).toBe('ok');
  });
});

describe('listAuditLog', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('filters by since, authPrincipal, limit; returns DESC order', async () => {
    const { db, sqlite } = makeTestDb();

    sqlite.prepare(`
      INSERT INTO admin_audit_log (auth_principal, http_method, request_path, http_status, created_at)
      VALUES
        ('admin', 'POST', '/a', 201, datetime('now', '-5 minutes')),
        ('admin', 'DELETE', '/b', 204, datetime('now', '-3 minutes')),
        ('tenant:app1', 'POST', '/c', 201, datetime('now', '-1 minutes'))
    `).run();

    // Use SQLite datetime format to match how created_at is stored (no T/Z, space-separated)
    const since = (sqlite.prepare(`SELECT datetime('now', '-10 minutes') as t`).get() as { t: string }).t;

    const all = await listAuditLog(db, { since, limit: 10 });
    expect(all).toHaveLength(3);
    // DESC order: last inserted id first
    expect(all[0]!.request_path).toBe('/c');
    expect(all[2]!.request_path).toBe('/a');

    const adminOnly = await listAuditLog(db, { since, authPrincipal: 'admin', limit: 10 });
    expect(adminOnly).toHaveLength(2);
    expect(adminOnly.every(r => r.auth_principal === 'admin')).toBe(true);

    const limited = await listAuditLog(db, { since, limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('defaults: no args → 30-day window, limit 50, no principal filter', async () => {
    const { db, sqlite } = makeTestDb();

    sqlite.prepare(`
      INSERT INTO admin_audit_log (auth_principal, http_method, request_path, http_status, created_at)
      VALUES
        ('admin', 'POST', '/recent', 200, datetime('now', '-1 day')),
        ('admin', 'POST', '/old', 200, datetime('now', '-31 days'))
    `).run();

    const rows = await listAuditLog(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.request_path).toBe('/recent');
  });

  it('caps limit at 500', async () => {
    const { db, sqlite } = makeTestDb();

    for (let i = 0; i < 10; i++) {
      sqlite.prepare(`
        INSERT INTO admin_audit_log (auth_principal, http_method, request_path, http_status)
        VALUES ('admin', 'POST', '/x', 200)
      `).run();
    }

    const since = new Date(0).toISOString();
    const rows = await listAuditLog(db, { since, limit: 9999 });
    expect(rows).toHaveLength(10); // only 10 rows exist
  });
});
