import type { D1Database } from '@cloudflare/workers-types';
import { log } from './logger';

export interface RateLimitConfig {
  /** Window size in seconds (default 60). */
  windowSeconds: number;
  /** Max requests per window per principal (default 100). */
  limit: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = { windowSeconds: 60, limit: 100 };

export interface RateLimitResult {
  allowed: boolean;
  /** Current count in window. */
  count: number;
  /** Limit for this principal. */
  limit: number;
  /** Seconds until window slides past first req in window — RFC 6585 Retry-After hint. */
  retryAfter: number;
}

// 'YYYY-MM-DD HH:MM' — minute resolution, lexicographically sortable
export function bucketKey(date: Date): string {
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

export async function checkAndIncrement(
  db: D1Database,
  principal: string,
  cfg: RateLimitConfig = DEFAULT_RATE_LIMIT,
): Promise<RateLimitResult> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - cfg.windowSeconds * 1000);
  const currentBucket = bucketKey(now);
  const windowStartBucket = bucketKey(windowStart);

  // Increment first with one atomic SQLite statement. Concurrent requests can
  // no longer all observe the same pre-increment count and pass together.
  await db
    .prepare(`
      INSERT INTO rate_limit_buckets (principal, window_start, count)
      VALUES (?, ?, 1)
      ON CONFLICT(principal, window_start) DO UPDATE SET count = count + 1
    `)
    .bind(principal, currentBucket)
    .run();

  const sumRow = await db
    .prepare(`SELECT COALESCE(SUM(count), 0) as total FROM rate_limit_buckets WHERE principal = ? AND window_start >= ?`)
    .bind(principal, windowStartBucket)
    .first<{ total: number }>();

  const currentCount = sumRow?.total ?? 0;

  if (currentCount > cfg.limit) {
    log('rate_limit_denied', { principal, count: currentCount, limit: cfg.limit });
    return {
      allowed: false,
      count: cfg.limit,
      limit: cfg.limit,
      retryAfter: cfg.windowSeconds,
    };
  }

  return {
    allowed: true,
    count: currentCount,
    limit: cfg.limit,
    retryAfter: 0,
  };
}

export async function readCount(
  db: D1Database,
  principal: string,
  windowSeconds: number = DEFAULT_RATE_LIMIT.windowSeconds,
): Promise<number> {
  const windowStart = new Date(Date.now() - windowSeconds * 1000);
  const windowStartBucket = bucketKey(windowStart);

  const row = await db
    .prepare(`SELECT COALESCE(SUM(count), 0) as total FROM rate_limit_buckets WHERE principal = ? AND window_start >= ?`)
    .bind(principal, windowStartBucket)
    .first<{ total: number }>();

  return row?.total ?? 0;
}

export async function pruneOldBuckets(db: D1Database): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000);
  const cutoffBucket = bucketKey(cutoff);

  const result = await db
    .prepare(`DELETE FROM rate_limit_buckets WHERE window_start < ?`)
    .bind(cutoffBucket)
    .run();

  return { deleted: result.meta.changes };
}
