import type { D1Database, R2Bucket, R2UploadedPart } from '@cloudflare/workers-types';
import { Buffer } from 'node:buffer';
import { createCipheriv } from 'node:crypto';
import { sqlDumpChunks } from './backupSql';
import {acquireBackupWindow,drainRecoveryWriters} from './backupWindow';
import {recoveryMaintenanceEnabled} from './recoveryMaintenance';

export interface BackupConfig {
  /** Privileged operator has already established a manual maintenance window. */
  reuseMaintenanceWindow?: boolean;
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
 * BACKUP_EXCLUDED, so a new table can never be silently omitted from backups.
 * Parents precede dependants so restore works with foreign keys enforced. */
export const TABLES = [
  'webhook_consumers',
  'physical_accounts',
  'bank_accounts',
  'account_aliases', 'payment_reference_grants', 'payment_references', 'payment_reference_conflicts',
  'bank_recovery_batches', 'authenticated_email_spool', 'fio_poll_cursors',
  'transactions',
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
  bank_poll_leases: 'ephemeral poll locks; restored locks must be reacquired',
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
  // Byte-by-byte string concatenation exceeds the Worker memory budget on
  // real SQL dumps. Encode the existing buffer without copying its bytes.
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

function fromBase64(value: string): Uint8Array {
  // Preserve strict Base64 decoding and avoid a temporary array of numbers.
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes;
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

/** Collect a SQL dump for local tooling; production streams the same serializer. */
export async function buildSqlDump(db:D1Database):Promise<{sql:string;rowCounts:Record<string,number>}> {
  const rowCounts:Record<string,number>={},chunks:string[]=[];
  for await(const chunk of sqlDumpChunks(db,TABLES,rowCounts))chunks.push(chunk);
  return {sql:chunks.join(''),rowCounts};
}

/** Keep only one SQL page and one 5 MiB encrypted R2 part in memory. */
async function uploadEncryptedDump(db:D1Database,cfg:BackupConfig,key:string):Promise<{size:number;rowCounts:Record<string,number>}> {
  const keyBytes=fromBase64(cfg.encryptionKey!);
  if(keyBytes.byteLength!==32)throw new Error('backup_encryption_key_must_be_32_bytes');
  const metadata={format:'banksync-backup' as const,version:1 as const,key_version:cfg.keyVersion!,algorithm:'AES-256-GCM' as const,created_at:new Date().toISOString()};
  const iv=crypto.getRandomValues(new Uint8Array(12)),cipher=createCipheriv('aes-256-gcm',keyBytes,iv,{authTagLength:16});
  cipher.setAAD(backupAad(metadata));
  const schema=await db.prepare("SELECT value FROM schema_meta WHERE key='version'").first<{value:string}>();
  let expectedRows=0;
  for(const table of TABLES){
    if(Number(schema?.value??0)<11&&['bank_recovery_batches','authenticated_email_spool'].includes(table))continue;
    if(Number(schema?.value??0)<12&&['physical_accounts','account_aliases','payment_reference_grants','payment_references','payment_reference_conflicts'].includes(table))continue;
    if(Number(schema?.value??0)<13&&table==='fio_poll_cursors')continue;
    const filter=table==='schema_meta'?" WHERE key NOT IN ('backup_maintenance_owner','api_sync_lease_until')":'';
    const count=await db.prepare(`SELECT COUNT(*) AS n FROM ${table}${filter}`).first<{n:number}>();expectedRows+=count?.n??0;
  }
  const rowCounts:Record<string,number>={},parts:R2UploadedPart[]=[];
  const upload=await cfg.bucket!.createMultipartUpload(key,{httpMetadata:{contentType:'application/octet-stream'},customMetadata:{banksync_table_count:String(TABLES.length),banksync_backup_format:'aes-256-gcm-v1',banksync_backup_key_version:String(cfg.keyVersion),banksync_total_rows:String(expectedRows)}});
  const part=new Uint8Array(5*1024*1024);let used=0,total=0,carry=Buffer.alloc(0);
  async function write(bytes:Uint8Array) {
    total+=bytes.byteLength;
    for(let offset=0;offset<bytes.byteLength;) {
      const take=Math.min(part.byteLength-used,bytes.byteLength-offset);part.set(bytes.subarray(offset,offset+take),used);used+=take;offset+=take;
      if(used===part.byteLength){parts.push(await upload.uploadPart(parts.length+1,part));used=0;}
    }
  }
  async function writeCipher(bytes:Uint8Array,final=false) {
    const combined=carry.length?Buffer.concat([carry,bytes]):Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const end=final?combined.length:combined.length-combined.length%3;
    if(end)await write(Buffer.from(combined.subarray(0,end).toString('base64')));
    carry=Buffer.from(combined.subarray(end));
  }
  try {
    await write(Buffer.from(JSON.stringify({...metadata,iv:base64(iv)}).slice(0,-1)+',"ciphertext":"'));
    // Batch short statements before updating the cipher, without retaining a dump.
    let pending:string[]=[],chars=0;
    for await(const chunk of sqlDumpChunks(db,TABLES,rowCounts)) {
      pending.push(chunk);chars+=chunk.length;
      if(chars>=65536){await writeCipher(cipher.update(Buffer.from(pending.join(''))));pending=[];chars=0;}
    }
    if(chars)await writeCipher(cipher.update(Buffer.from(pending.join(''))));
    await writeCipher(cipher.final());await writeCipher(cipher.getAuthTag(),true);
    await write(Buffer.from('"}'));
    if(used)parts.push(await upload.uploadPart(parts.length+1,part.subarray(0,used)));
    if(Object.values(rowCounts).reduce((sum,n)=>sum+n,0)!==expectedRows)throw new Error('backup_snapshot_changed');
    await upload.complete(parts);
    return {size:total,rowCounts};
  } catch(error) {
    try{await upload.abort();}catch(abortError){throw new AggregateError([error,abortError],'backup_upload_abort_failed');}
    throw error;
  }
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

  if(!Number.isInteger(cfg.keyVersion)||cfg.keyVersion<1)throw new Error('invalid_backup_key_version');
  const release=await acquireBackupWindow(db);
  if(!release && !(cfg.reuseMaintenanceWindow&&await recoveryMaintenanceEnabled(db)))return {uploaded:false,skipped_reason:'recovery_maintenance_busy'};
  try {
    await drainRecoveryWriters(db);
  const key = `${cfg.prefix}-${dateKey()}.sql.enc`;
  const {size: sizeBytes,rowCounts}=await uploadEncryptedDump(db,cfg,key);

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
    size_bytes: sizeBytes,
    table_row_counts: rowCounts,
    pruned_keys: toPrune,
  };
  } finally {if(release)await release();}
}
