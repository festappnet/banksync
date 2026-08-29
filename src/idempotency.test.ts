import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { D1Database, D1Result, D1PreparedStatement } from '@cloudflare/workers-types';
import { checkIdempotency, recordIdempotency, sha256Hex } from './idempotency.js';

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

function makeReq(opts: { key?: string; body?: string; method?: string; url?: string } = {}): { req: Request; bodyText: string } {
  const headers: Record<string, string> = {};
  if (opts.key !== undefined) headers['Idempotency-Key'] = opts.key;
  const bodyText = opts.body ?? '';
  const init: RequestInit = {
    method: opts.method ?? 'POST',
    headers,
  };
  if (bodyText) init.body = bodyText;
  const req = new Request(opts.url ?? 'https://example.com/consumers', init);
  return { req, bodyText };
}

// ---- tests ----

describe('sha256Hex', () => {
  it('is deterministic for same input', async () => {
    const a = await sha256Hex('hello world');
    const b = await sha256Hex('hello world');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different output for different input', async () => {
    const a = await sha256Hex('foo');
    const b = await sha256Hex('bar');
    expect(a).not.toBe(b);
  });
});

describe('checkIdempotency — no header', () => {
  it('no Idempotency-Key header → miss with empty keyHash, no DB write on record', async () => {
    const { db, sqlite } = makeTestDb();
    const { req, bodyText } = makeReq();
    const result = await checkIdempotency({ db, request: req, authPrincipal: 'admin', requestBodyText: bodyText });
    expect(result.kind).toBe('miss');
    expect((result as { kind: 'miss'; keyHash: string }).keyHash).toBe('');

    // Calling recordIdempotency with empty keyHash is a no-op
    await recordIdempotency({
      db,
      keyHash: '',
      authPrincipal: 'admin',
      requestPath: '/consumers',
      requestMethod: 'POST',
      requestBodyHash: null,
      responseStatus: 200,
      responseBody: '{}',
    });
    const count = (sqlite.prepare(`SELECT COUNT(*) as n FROM idempotency_keys`).get() as { n: number }).n;
    expect(count).toBe(0);
  });
});

describe('checkIdempotency — first request', () => {
  it('first request with key → miss with non-empty keyHash; recordIdempotency stores row', async () => {
    const { db, sqlite } = makeTestDb();
    const { req, bodyText } = makeReq({ key: 'test-key-001', body: '{"amount":100}' });
    const result = await checkIdempotency({ db, request: req, authPrincipal: 'admin', requestBodyText: bodyText });
    expect(result.kind).toBe('miss');
    const keyHash = (result as { kind: 'miss'; keyHash: string }).keyHash;
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);

    const bodyHash = await sha256Hex(bodyText);
    await recordIdempotency({
      db,
      keyHash,
      authPrincipal: 'admin',
      requestPath: '/consumers',
      requestMethod: 'POST',
      requestBodyHash: bodyHash,
      responseStatus: 201,
      responseBody: '{"id":"abc"}',
    });

    const row = sqlite.prepare(`SELECT key_hash, response_status, response_body FROM idempotency_keys WHERE key_hash = ?`).get(keyHash) as
      | { key_hash: string; response_status: number; response_body: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.response_status).toBe(201);
    expect(row!.response_body).toBe('{"id":"abc"}');
  });
});

describe('checkIdempotency — replay (hit)', () => {
  it('second request, same key + same body + same auth → hit, returns cached status+body', async () => {
    const { db } = makeTestDb();
    const bodyText = '{"amount":100}';
    const { req: req1, bodyText: bt1 } = makeReq({ key: 'replay-key', body: bodyText });

    const first = await checkIdempotency({ db, request: req1, authPrincipal: 'admin', requestBodyText: bt1 });
    expect(first.kind).toBe('miss');
    const keyHash = (first as { kind: 'miss'; keyHash: string }).keyHash;
    const bodyHash = await sha256Hex(bodyText);

    await recordIdempotency({
      db,
      keyHash,
      authPrincipal: 'admin',
      requestPath: '/consumers',
      requestMethod: 'POST',
      requestBodyHash: bodyHash,
      responseStatus: 201,
      responseBody: '{"id":"xyz"}',
    });

    const { req: req2, bodyText: bt2 } = makeReq({ key: 'replay-key', body: bodyText });
    const second = await checkIdempotency({ db, request: req2, authPrincipal: 'admin', requestBodyText: bt2 });
    expect(second.kind).toBe('hit');
    expect((second as { kind: 'hit'; status: number; body: string }).status).toBe(201);
    expect((second as { kind: 'hit'; status: number; body: string }).body).toBe('{"id":"xyz"}');
  });
});

describe('checkIdempotency — body mismatch', () => {
  it('same key + same auth + DIFFERENT body → mismatch', async () => {
    const { db } = makeTestDb();
    const { req: req1, bodyText: bt1 } = makeReq({ key: 'mismatch-key', body: '{"amount":100}' });

    const first = await checkIdempotency({ db, request: req1, authPrincipal: 'admin', requestBodyText: bt1 });
    const keyHash = (first as { kind: 'miss'; keyHash: string }).keyHash;
    const bodyHash = await sha256Hex(bt1);

    await recordIdempotency({
      db,
      keyHash,
      authPrincipal: 'admin',
      requestPath: '/consumers',
      requestMethod: 'POST',
      requestBodyHash: bodyHash,
      responseStatus: 200,
      responseBody: '{"ok":true}',
    });

    const { req: req2, bodyText: bt2 } = makeReq({ key: 'mismatch-key', body: '{"amount":999}' });
    const second = await checkIdempotency({ db, request: req2, authPrincipal: 'admin', requestBodyText: bt2 });
    expect(second.kind).toBe('mismatch');
  });
});

describe('checkIdempotency — principal namespacing', () => {
  it('same key but DIFFERENT auth_principal → miss (separate cache entry)', async () => {
    const { db } = makeTestDb();
    const bodyText = '{"x":1}';
    const { req: req1, bodyText: bt1 } = makeReq({ key: 'shared-key', body: bodyText });

    const first = await checkIdempotency({ db, request: req1, authPrincipal: 'admin', requestBodyText: bt1 });
    const keyHash = (first as { kind: 'miss'; keyHash: string }).keyHash;
    const bodyHash = await sha256Hex(bodyText);

    await recordIdempotency({
      db,
      keyHash,
      authPrincipal: 'admin',
      requestPath: '/consumers',
      requestMethod: 'POST',
      requestBodyHash: bodyHash,
      responseStatus: 200,
      responseBody: '{"ok":true}',
    });

    // Same Idempotency-Key but different principal → different hash → miss
    const { req: req2, bodyText: bt2 } = makeReq({ key: 'shared-key', body: bodyText });
    const second = await checkIdempotency({ db, request: req2, authPrincipal: 'tenant:app1', requestBodyText: bt2 });
    expect(second.kind).toBe('miss');
    expect((second as { kind: 'miss'; keyHash: string }).keyHash).not.toBe(keyHash);
  });
});

describe('checkIdempotency — route and method namespacing', () => {
  it('same caller key and body cannot replay across a different route or method', async () => {
    const { db } = makeTestDb();
    const bodyText = '{"x":1}';
    const { req } = makeReq({ key: 'scoped-key', body: bodyText, method: 'POST', url: 'https://example.com/first' });
    const first = await checkIdempotency({ db, request: req, authPrincipal: 'admin', requestBodyText: bodyText });
    expect(first.kind).toBe('miss');
    await recordIdempotency({
      db,
      keyHash: (first as { kind: 'miss'; keyHash: string }).keyHash,
      authPrincipal: 'admin',
      requestPath: '/first',
      requestMethod: 'POST',
      requestBodyHash: await sha256Hex(bodyText),
      responseStatus: 200,
      responseBody: '{"ok":true}',
    });

    const differentPath = makeReq({ key: 'scoped-key', body: bodyText, method: 'POST', url: 'https://example.com/second' });
    await expect(checkIdempotency({ db, request: differentPath.req, authPrincipal: 'admin', requestBodyText: bodyText })).resolves.toMatchObject({ kind: 'miss' });
    const differentMethod = makeReq({ key: 'scoped-key', body: bodyText, method: 'PUT', url: 'https://example.com/first' });
    await expect(checkIdempotency({ db, request: differentMethod.req, authPrincipal: 'admin', requestBodyText: bodyText })).resolves.toMatchObject({ kind: 'miss' });
  });
});

describe('recordIdempotency — 5xx NOT cached', () => {
  it('5xx response is not cached; next request sees miss', async () => {
    const { db, sqlite } = makeTestDb();
    const { req, bodyText } = makeReq({ key: '5xx-key', body: '{}' });

    const first = await checkIdempotency({ db, request: req, authPrincipal: 'admin', requestBodyText: bodyText });
    const keyHash = (first as { kind: 'miss'; keyHash: string }).keyHash;

    await recordIdempotency({
      db,
      keyHash,
      authPrincipal: 'admin',
      requestPath: '/consumers',
      requestMethod: 'POST',
      requestBodyHash: null,
      responseStatus: 503,
      responseBody: '{"error":"unavailable"}',
    });

    const count = (sqlite.prepare(`SELECT COUNT(*) as n FROM idempotency_keys`).get() as { n: number }).n;
    expect(count).toBe(0);

    const { req: req2, bodyText: bt2 } = makeReq({ key: '5xx-key', body: '{}' });
    const second = await checkIdempotency({ db, request: req2, authPrincipal: 'admin', requestBodyText: bt2 });
    expect(second.kind).toBe('miss');
  });
});

describe('recordIdempotency — 2xx IS cached', () => {
  it('2xx response is cached and replayed', async () => {
    const { db } = makeTestDb();
    const { req, bodyText } = makeReq({ key: '2xx-key', body: '{}' });

    const first = await checkIdempotency({ db, request: req, authPrincipal: 'admin', requestBodyText: bodyText });
    const keyHash = (first as { kind: 'miss'; keyHash: string }).keyHash;
    const bodyHash = await sha256Hex(bodyText);

    await recordIdempotency({
      db,
      keyHash,
      authPrincipal: 'admin',
      requestPath: '/consumers',
      requestMethod: 'POST',
      requestBodyHash: bodyHash,
      responseStatus: 200,
      responseBody: '{"ok":true}',
    });

    const { req: req2, bodyText: bt2 } = makeReq({ key: '2xx-key', body: '{}' });
    const second = await checkIdempotency({ db, request: req2, authPrincipal: 'admin', requestBodyText: bt2 });
    expect(second.kind).toBe('hit');
    expect((second as { kind: 'hit'; status: number; body: string }).status).toBe(200);
  });
});

describe('recordIdempotency — 4xx IS cached', () => {
  it('4xx response is cached and replayed (Stripe pattern: stable error replay)', async () => {
    const { db } = makeTestDb();
    const { req, bodyText } = makeReq({ key: '4xx-key', body: '{"bad":"data"}' });

    const first = await checkIdempotency({ db, request: req, authPrincipal: 'admin', requestBodyText: bodyText });
    const keyHash = (first as { kind: 'miss'; keyHash: string }).keyHash;
    const bodyHash = await sha256Hex(bodyText);

    await recordIdempotency({
      db,
      keyHash,
      authPrincipal: 'admin',
      requestPath: '/consumers',
      requestMethod: 'POST',
      requestBodyHash: bodyHash,
      responseStatus: 422,
      responseBody: '{"error":"validation_failed"}',
    });

    const { req: req2, bodyText: bt2 } = makeReq({ key: '4xx-key', body: '{"bad":"data"}' });
    const second = await checkIdempotency({ db, request: req2, authPrincipal: 'admin', requestBodyText: bt2 });
    expect(second.kind).toBe('hit');
    expect((second as { kind: 'hit'; status: number; body: string }).status).toBe(422);
    expect((second as { kind: 'hit'; status: number; body: string }).body).toBe('{"error":"validation_failed"}');
  });
});

describe('checkIdempotency — empty body', () => {
  it('empty body stores NULL hash; replay with empty body → hit', async () => {
    const { db } = makeTestDb();
    const { req, bodyText } = makeReq({ key: 'empty-body-key' }); // no body

    const first = await checkIdempotency({ db, request: req, authPrincipal: 'admin', requestBodyText: bodyText });
    const keyHash = (first as { kind: 'miss'; keyHash: string }).keyHash;
    expect(bodyText).toBe('');

    await recordIdempotency({
      db,
      keyHash,
      authPrincipal: 'admin',
      requestPath: '/consumers',
      requestMethod: 'POST',
      requestBodyHash: null,
      responseStatus: 204,
      responseBody: '',
    });

    const { req: req2, bodyText: bt2 } = makeReq({ key: 'empty-body-key' });
    const second = await checkIdempotency({ db, request: req2, authPrincipal: 'admin', requestBodyText: bt2 });
    expect(second.kind).toBe('hit');
  });

  it('empty body cached; replay with non-empty body → mismatch', async () => {
    const { db } = makeTestDb();
    const { req, bodyText } = makeReq({ key: 'empty-to-full-key' });

    const first = await checkIdempotency({ db, request: req, authPrincipal: 'admin', requestBodyText: bodyText });
    const keyHash = (first as { kind: 'miss'; keyHash: string }).keyHash;

    await recordIdempotency({
      db,
      keyHash,
      authPrincipal: 'admin',
      requestPath: '/consumers',
      requestMethod: 'POST',
      requestBodyHash: null,
      responseStatus: 200,
      responseBody: '{}',
    });

    const { req: req2, bodyText: bt2 } = makeReq({ key: 'empty-to-full-key', body: '{"surprise":"data"}' });
    const second = await checkIdempotency({ db, request: req2, authPrincipal: 'admin', requestBodyText: bt2 });
    expect(second.kind).toBe('mismatch');
  });
});

describe('recordIdempotency — concurrent insert race', () => {
  it('atomically reserves a key so only one concurrent request can mutate', async () => {
    const { db, sqlite } = makeTestDb();
    const a = makeReq({ key: 'race-key' });
    const b = makeReq({ key: 'race-key' });
    const results = await Promise.all([
      checkIdempotency({ db, request: a.req, authPrincipal: 'admin', requestBodyText: a.bodyText }),
      checkIdempotency({ db, request: b.req, authPrincipal: 'admin', requestBodyText: b.bodyText }),
    ]);

    expect(results.map(result => result.kind).sort()).toEqual(['in_flight', 'miss']);
    const rows = sqlite.prepare(`SELECT response_body FROM idempotency_keys`).all() as { response_body: string }[];
    expect(rows).toHaveLength(1);
  });
});

describe('Idempotency-Key length validation', () => {
  it('empty string (length 0) → miss with empty keyHash', async () => {
    const { db } = makeTestDb();
    const { req, bodyText } = makeReq({ key: '' });
    const result = await checkIdempotency({ db, request: req, authPrincipal: 'admin', requestBodyText: bodyText });
    expect(result.kind).toBe('miss');
    expect((result as { kind: 'miss'; keyHash: string }).keyHash).toBe('');
  });

  it('256-char key → miss with empty keyHash', async () => {
    const { db } = makeTestDb();
    const longKey = 'x'.repeat(256);
    const { req, bodyText } = makeReq({ key: longKey });
    const result = await checkIdempotency({ db, request: req, authPrincipal: 'admin', requestBodyText: bodyText });
    expect(result.kind).toBe('miss');
    expect((result as { kind: 'miss'; keyHash: string }).keyHash).toBe('');
  });

  it('1-char key → processed (miss with non-empty keyHash)', async () => {
    const { db } = makeTestDb();
    const { req, bodyText } = makeReq({ key: 'x' });
    const result = await checkIdempotency({ db, request: req, authPrincipal: 'admin', requestBodyText: bodyText });
    expect(result.kind).toBe('miss');
    expect((result as { kind: 'miss'; keyHash: string }).keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('255-char key → processed (miss with non-empty keyHash)', async () => {
    const { db } = makeTestDb();
    const maxKey = 'a'.repeat(255);
    const { req, bodyText } = makeReq({ key: maxKey });
    const result = await checkIdempotency({ db, request: req, authPrincipal: 'admin', requestBodyText: bodyText });
    expect(result.kind).toBe('miss');
    expect((result as { kind: 'miss'; keyHash: string }).keyHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
