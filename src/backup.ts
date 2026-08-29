import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

export interface BackupConfig {
  /** R2 bucket binding. Undefined → backup disabled (dev mode). */
  bucket: R2Bucket | undefined;
  /** Identifier prefix in R2 keys: e.g. 'banksync-prod' → keys like banksync-prod-YYYYMMDD.sql */
  prefix: string;
  /** Number of latest backups to retain in R2. Older ones deleted on each tick. */
  retain?: number;
}

export interface BackupResult {
  uploaded: boolean;
  key?: string;
  size_bytes?: number;
  table_row_counts?: Record<string, number>;
  /** Older keys deleted on this tick. */
  pruned_keys?: string[];
  /** Skipped reason when uploaded=false. */
  skipped_reason?: string;
}

/** Tables the backup exports. Kept in lockstep with the schema: the backup
 * completeness test fails if any application table is neither here nor in
 * BACKUP_EXCLUDED, so a new table can never be silently omitted from backups. */
export const TABLES = [
  'bank_accounts',
  'transactions',
  'webhook_consumers',
  'webhook_subscriptions',
  'parse_log',
  'webhook_log',
  'webhook_delivery_jobs',
  'webhook_delivery_alerts',
  'alert_state',
  'event_log',
  'schema_meta',
  'cf_routing_outbox',
  'idempotency_keys',
  'admin_audit_log',
  'rate_limit_buckets',
];

/** Application tables deliberately NOT backed up, each with a stated reason.
 * A table must be in TABLES or here — the completeness test enforces it. */
export const BACKUP_EXCLUDED: Record<string, string> = {
  // (none currently — every application table is backed up)
};

function dateKey(d: Date = new Date()): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''");
}

function sqlValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    return Number.isFinite(v) ? String(v) : 'NULL';
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${escapeSqlString(String(v))}'`;
}

/**
 * Export all banksync tables to a SQL dump string.
 * Each row becomes `INSERT INTO <table> (...) VALUES (...);`.
 * Headers include schema_meta version + timestamp.
 *
 * NULL values: emit literal `NULL`. String values: SQL-escape (' → '').
 */
export async function buildSqlDump(db: D1Database): Promise<{
  sql: string;
  rowCounts: Record<string, number>;
}> {
  const lines: string[] = [];
  lines.push(`-- banksync backup ${new Date().toISOString()}`);

  const versionRow = await db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).first<{ value: string }>();
  lines.push(`-- schema_version=${versionRow?.value ?? 'unknown'}`);
  lines.push(`-- restore: re-apply migrations then load this file`);
  lines.push('');

  const rowCounts: Record<string, number> = {};
  for (const table of TABLES) {
    const r = await db.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>();
    rowCounts[table] = r.results.length;
    if (r.results.length === 0) continue;

    const cols = Object.keys(r.results[0]!);
    lines.push(`-- ${table} (${r.results.length} rows)`);
    for (const row of r.results) {
      const values = cols.map(c => sqlValue(row[c])).join(', ');
      lines.push(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${values});`);
    }
    lines.push('');
  }

  return { sql: lines.join('\n'), rowCounts };
}

/**
 * Run a backup tick. Idempotent per-day (same key = R2 overwrite). Prunes old keys keeping `retain` newest.
 */
export async function runBackupTick(db: D1Database, cfg: BackupConfig): Promise<BackupResult> {
  if (!cfg.bucket) {
    return { uploaded: false, skipped_reason: 'r2_bucket_unbound' };
  }

  const { sql, rowCounts } = await buildSqlDump(db);
  const key = `${cfg.prefix}-${dateKey()}.sql`;
  const buf = new TextEncoder().encode(sql);

  await cfg.bucket.put(key, buf, {
    httpMetadata: { contentType: 'application/sql' },
    customMetadata: {
      banksync_table_count: String(TABLES.length),
      banksync_total_rows: String(Object.values(rowCounts).reduce((a, b) => a + b, 0)),
    },
  });

  // Prune older keys, keep `retain` newest
  const retain = cfg.retain ?? 8;
  const list = await cfg.bucket.list({ prefix: cfg.prefix, limit: 1000 });
  const sortedKeys = list.objects.map(o => o.key).sort().reverse();
  const toPrune = sortedKeys.slice(retain);
  for (const k of toPrune) {
    await cfg.bucket.delete(k);
  }

  return {
    uploaded: true,
    key,
    size_bytes: buf.byteLength,
    table_row_counts: rowCounts,
    pruned_keys: toPrune,
  };
}
