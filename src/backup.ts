import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

export interface BackupConfig {
  /** R2 bucket binding. Undefined → backup disabled (dev mode). */
  bucket: R2Bucket | undefined;
  /** Identifier prefix in R2 keys: e.g. 'banksync-prod' → keys like banksync-prod-YYYYMMDD.sql */
  prefix: string;
  /** Number of latest backups to retain in R2. Older ones deleted on each tick. */
  retain?: number;
  /** Independent 32-byte base64 AES-GCM key. Required when bucket is bound. */
  encryptionKey?: string | undefined;
  /** Positive integer identifying BACKUP_ENCRYPTION_KEY_Vn. */
  keyVersion?: number | undefined;
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
  'admin_audit_log',
];

/** Application tables deliberately NOT backed up, each with a stated reason.
 * A table must be in TABLES or here — the completeness test enforces it. */
export const BACKUP_EXCLUDED: Record<string, string> = {
  idempotency_keys: 'ephemeral response cache; may contain sensitive historic responses',
  rate_limit_buckets: 'ephemeral abuse-control counters',
};

export interface EncryptedBackupEnvelope {
  format: 'banksync-backup';
  version: 1;
  key_version: number;
  algorithm: 'AES-256-GCM';
  created_at: string;
  iv: string;
  ciphertext: string;
}

function base64(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function fromBase64(value: string): Uint8Array {
  const decoded = atob(value);
  return Uint8Array.from(decoded, char => char.charCodeAt(0));
}

async function importBackupKey(encoded: string): Promise<CryptoKey> {
  const bytes = fromBase64(encoded);
  if (bytes.byteLength !== 32) throw new Error('backup_encryption_key_must_be_32_bytes');
  return crypto.subtle.importKey('raw', bytes.buffer as ArrayBuffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function backupAad(envelope: Pick<EncryptedBackupEnvelope, 'format' | 'version' | 'key_version' | 'algorithm' | 'created_at'>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(envelope));
}

export async function encryptBackup(sql: string, encodedKey: string, keyVersion: number): Promise<Uint8Array> {
  if (!Number.isInteger(keyVersion) || keyVersion < 1) throw new Error('invalid_backup_key_version');
  const metadata = {
    format: 'banksync-backup' as const,
    version: 1 as const,
    key_version: keyVersion,
    algorithm: 'AES-256-GCM' as const,
    created_at: new Date().toISOString(),
  };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer, additionalData: backupAad(metadata).buffer as ArrayBuffer, tagLength: 128 },
    await importBackupKey(encodedKey),
    new TextEncoder().encode(sql),
  );
  const envelope: EncryptedBackupEnvelope = {
    ...metadata,
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(ciphertext)),
  };
  return new TextEncoder().encode(JSON.stringify(envelope));
}

export async function decryptBackup(bytes: Uint8Array, encodedKey: string): Promise<string> {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as EncryptedBackupEnvelope;
  if (parsed.format !== 'banksync-backup' || parsed.version !== 1 || parsed.algorithm !== 'AES-256-GCM') {
    throw new Error('unsupported_backup_format');
  }
  const metadata = {
    format: parsed.format,
    version: parsed.version,
    key_version: parsed.key_version,
    algorithm: parsed.algorithm,
    created_at: parsed.created_at,
  };
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(parsed.iv).buffer as ArrayBuffer, additionalData: backupAad(metadata).buffer as ArrayBuffer, tagLength: 128 },
    await importBackupKey(encodedKey),
    fromBase64(parsed.ciphertext).buffer as ArrayBuffer,
  );
  return new TextDecoder().decode(plaintext);
}

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
  if (!cfg.encryptionKey || !cfg.keyVersion) {
    return { uploaded: false, skipped_reason: 'backup_encryption_not_configured' };
  }

  const { sql, rowCounts } = await buildSqlDump(db);
  const key = `${cfg.prefix}-${dateKey()}.sql.enc`;
  const buf = await encryptBackup(sql, cfg.encryptionKey, cfg.keyVersion);

  await cfg.bucket.put(key, buf, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: {
      banksync_table_count: String(TABLES.length),
      banksync_backup_format: 'aes-256-gcm-v1',
      banksync_backup_key_version: String(cfg.keyVersion),
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
