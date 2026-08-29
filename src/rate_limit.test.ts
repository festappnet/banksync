import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { D1Database, D1Result, D1PreparedStatement } from '@cloudflare/workers-types';
import {
  checkAndIncrement,
  readCount,
  pruneOldBuckets,
  bucketKey,
  DEFAULT_RATE_LIMIT,
} from './rate_limit';

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

const MIGRATIONS = ['0001_schema.sql', '0002_multitenant.sql', '0003_cf_rule_sync.sql', '0004_phase16_hardening.sql', '0005_fio_api_sync.sql', '0006_webhook_delivery_jobs.sql', '0007_webhook_delivery_fencing.sql', '0008_alert_outbox_and_subscription_history.sql', '0009_contract_drop_dlq_archive.sql'];

function makeTestDb(): { db: D1Database; sqlite: Database.Database } {
  const sqlite = new Database(':memory:');
  for (const m of MIGRATIONS) {
    const p = resolve(__dirname, '../migrations', m);
    sqlite.exec(readFileSync(p, 'utf8'));
  }
  return { db: wrapAsD1(sqlite), sqlite };
}

// ---- tests ----

describe('DEFAULT_RATE_LIMIT', () => {
  it('exports the documented defaults', () => {
    expect(DEFAULT_RATE_LIMIT.windowSeconds).toBe(60);
    expect(DEFAULT_RATE_LIMIT.limit).toBe(100);
  });
});

describe('bucketKey', () => {
  it('generates correct minute-resolution key', () => {
    const d = new Date('2026-05-08T14:32:47.123Z');
    expect(bucketKey(d)).toBe('2026-05-08 14:32');
  });

  it('different seconds in same minute → same key', () => {
    const a = new Date('2026-05-08T14:32:00.000Z');
    const b = new Date('2026-05-08T14:32:59.999Z');
    expect(bucketKey(a)).toBe(bucketKey(b));
  });

  it('adjacent minutes → different keys', () => {
    const a = new Date('2026-05-08T14:32:59.999Z');
    const b = new Date('2026-05-08T14:33:00.000Z');
    expect(bucketKey(a)).not.toBe(bucketKey(b));
  });

  it('keys are lexicographically sortable', () => {
    const earlier = bucketKey(new Date('2026-05-08T14:31:00Z'));
    const later = bucketKey(new Date('2026-05-08T14:32:00Z'));
    expect(earlier < later).toBe(true);
  });
});

describe('checkAndIncrement', () => {
  it('first request → allowed=true, count=1', async () => {
    const { db } = makeTestDb();
    const result = await checkAndIncrement(db, 'tenant:A');
    expect(result.allowed).toBe(true);
    expect(result.count).toBe(1);
    expect(result.limit).toBe(100);
    expect(result.retryAfter).toBe(0);
  });

  it('100 sequential requests all allowed; 101st denied', async () => {
    const { db } = makeTestDb();
    const cfg = { windowSeconds: 60, limit: 100 };
    for (let i = 0; i < 100; i++) {
      const r = await checkAndIncrement(db, 'tenant:B', cfg);
      expect(r.allowed).toBe(true);
    }
    const denied = await checkAndIncrement(db, 'tenant:B', cfg);
    expect(denied.allowed).toBe(false);
    expect(denied.count).toBe(100);
    expect(denied.retryAfter).toBe(60);
  });

  it('different principals are isolated', async () => {
    const { db } = makeTestDb();
    const cfg = { windowSeconds: 60, limit: 100 };
    for (let i = 0; i < 100; i++) {
      await checkAndIncrement(db, 'tenant:A', cfg);
    }
    // tenant:A is at limit; tenant:B should still be allowed
    const r = await checkAndIncrement(db, 'tenant:B', cfg);
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(1);
  });

  it('custom config: limit=5, 5 OK then 6th denied', async () => {
    const { db } = makeTestDb();
    const cfg = { windowSeconds: 60, limit: 5 };
    for (let i = 0; i < 5; i++) {
      const r = await checkAndIncrement(db, 'tenant:custom', cfg);
      expect(r.allowed).toBe(true);
    }
    const denied = await checkAndIncrement(db, 'tenant:custom', cfg);
    expect(denied.allowed).toBe(false);
    expect(denied.count).toBe(5);
    expect(denied.retryAfter).toBeGreaterThan(0);
  });

  it('retryAfter is 0 when allowed, >0 when denied', async () => {
    const { db } = makeTestDb();
    const cfg = { windowSeconds: 30, limit: 2 };
    const r1 = await checkAndIncrement(db, 'tenant:retry', cfg);
    expect(r1.retryAfter).toBe(0);
    await checkAndIncrement(db, 'tenant:retry', cfg);
    const denied = await checkAndIncrement(db, 'tenant:retry', cfg);
    expect(denied.retryAfter).toBe(30);
  });

  it('window slides: bucket 2 minutes ago is not counted', async () => {
    const { db, sqlite } = makeTestDb();
    const oldBucket = bucketKey(new Date(Date.now() - 2 * 60 * 1000));
    // Insert old bucket with count=50 for the same principal
    sqlite
      .prepare(`INSERT INTO rate_limit_buckets (principal, window_start, count) VALUES (?, ?, ?)`)
      .run('tenant:slide', oldBucket, 50);

    // With limit=60 and a 1-minute window, the 50 old requests are outside the window
    const r = await checkAndIncrement(db, 'tenant:slide', { windowSeconds: 60, limit: 60 });
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(1);
  });
});

describe('readCount', () => {
  it('returns 0 for unknown principal', async () => {
    const { db } = makeTestDb();
    const count = await readCount(db, 'tenant:nobody');
    expect(count).toBe(0);
  });

  it('returns current window sum without incrementing', async () => {
    const { db } = makeTestDb();
    await checkAndIncrement(db, 'tenant:rc');
    await checkAndIncrement(db, 'tenant:rc');
    const count = await readCount(db, 'tenant:rc');
    expect(count).toBe(2);
    // Confirm readCount did not increment
    const countAgain = await readCount(db, 'tenant:rc');
    expect(countAgain).toBe(2);
  });

  it('does not count buckets outside the window', async () => {
    const { db, sqlite } = makeTestDb();
    const oldBucket = bucketKey(new Date(Date.now() - 5 * 60 * 1000));
    sqlite
      .prepare(`INSERT INTO rate_limit_buckets (principal, window_start, count) VALUES (?, ?, ?)`)
      .run('tenant:rc2', oldBucket, 99);
    const count = await readCount(db, 'tenant:rc2', 60);
    expect(count).toBe(0);
  });
});

describe('pruneOldBuckets', () => {
  it('deletes buckets older than 1 hour and returns count', async () => {
    const { db, sqlite } = makeTestDb();
    const oldBucket = bucketKey(new Date(Date.now() - 70 * 60 * 1000));
    const recentBucket = bucketKey(new Date(Date.now() - 30 * 60 * 1000));

    sqlite
      .prepare(`INSERT INTO rate_limit_buckets (principal, window_start, count) VALUES (?, ?, ?)`)
      .run('tenant:prune', oldBucket, 10);
    sqlite
      .prepare(`INSERT INTO rate_limit_buckets (principal, window_start, count) VALUES (?, ?, ?)`)
      .run('tenant:prune', recentBucket, 5);

    const result = await pruneOldBuckets(db);
    expect(result.deleted).toBe(1);

    const remaining = (
      sqlite
        .prepare(`SELECT COUNT(*) as n FROM rate_limit_buckets WHERE principal = 'tenant:prune'`)
        .get() as { n: number }
    ).n;
    expect(remaining).toBe(1);
  });

  it('returns 0 when nothing to prune', async () => {
    const { db } = makeTestDb();
    const result = await pruneOldBuckets(db);
    expect(result.deleted).toBe(0);
  });
});
