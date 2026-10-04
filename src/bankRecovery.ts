import type { D1Database } from '@cloudflare/workers-types';
import type { ApiFetchAccount } from './types';
import { decryptSecret, encryptSecret, type VersionedSecretEnv } from './crypto';
import { fetchFioStatement, mapFioTransaction, type FioProxyConfig } from './fio';
import { insertTransaction } from './db';
import { sha256Hex } from './idempotency';

/** Interval pulls never advance Fio's /last pointer. Every request has a durable
 * window before touching the bank; a lost response is recovered by that window.
 * All manual/cron/queue callers use the same physical-account + credential lease.
 */
export async function recoverBankAccount(db: D1Database, account: ApiFetchAccount,
  env: VersionedSecretEnv, proxy?: FioProxyConfig): Promise<{inserted:number; skipped:number}> {
  const enabled=await db.prepare('SELECT ingest_enabled FROM bank_accounts WHERE id=?').bind(account.id).first<{ingest_enabled:number}>();
  if(enabled?.ingest_enabled===0) throw new Error('bank_connection_paused');
  const credential = await decryptSecret(account.api_token_cipher, account.api_token_key_ver, env);
  const keys = [await sha256Hex(`fio-account:${account.account_number.replace(/\s/g, '').toUpperCase()}`), await sha256Hex(`fio-token:${credential}`)].sort();
  const fence = crypto.randomUUID();
  const held: string[] = [];
  try {
    for (const key of keys) {
      const claim = await db.prepare(`INSERT INTO bank_poll_leases (credential_hash,token,lease_until,next_allowed_at)
        VALUES (?,?,datetime('now','+120 seconds'),datetime('now','+30 seconds'))
        ON CONFLICT(credential_hash) DO UPDATE SET token=excluded.token, lease_until=excluded.lease_until,
        next_allowed_at=excluded.next_allowed_at
        WHERE datetime(bank_poll_leases.lease_until)<=datetime('now') AND datetime(bank_poll_leases.next_allowed_at)<=datetime('now')`)
        .bind(key,fence).run();
      if (claim.meta.changes !== 1) throw new Error('bank_poll_busy');
      held.push(key);
    }
    async function renew() {
      for (const key of held) {
        const result = await db.prepare(`UPDATE bank_poll_leases SET lease_until=datetime('now','+120 seconds')
          WHERE credential_hash=? AND token=? AND datetime(lease_until)>datetime('now')`).bind(key,fence).run();
        if (result.meta.changes !== 1) throw new Error('bank_poll_lease_lost');
      }
    }
    const open = await db.prepare(`SELECT id,from_date,to_date,cipher,key_version FROM bank_recovery_batches
      WHERE bank_account_id=? AND state<>'completed' ORDER BY created_at,id LIMIT 1`).bind(account.id)
      .first<{id:string;from_date:string;to_date:string;cipher:string|null;key_version:number|null}>();
    const checkpoint = await db.prepare('SELECT api_reconciled_through FROM bank_accounts WHERE id=?').bind(account.id).first<{api_reconciled_through:string|null}>();
    const end = new Date().toISOString().slice(0,10);
    const start = new Date(checkpoint?.api_reconciled_through ?? Date.parse(end) - 86*86400000);
    start.setUTCDate(start.getUTCDate()-3);
    if (!open && Date.parse(end) - start.getTime() > 89*86400000) throw new Error('recovery_window_requires_bank_unlock');
    const batch = open ?? {id:crypto.randomUUID(),from_date:start.toISOString().slice(0,10),to_date:end,cipher:null,key_version:null};
    if (!open) await db.prepare(`INSERT INTO bank_recovery_batches(id,bank_account_id,from_date,to_date,state) VALUES(?,?,?,?,'fetching')`)
      .bind(batch.id,account.id,batch.from_date,batch.to_date).run();
    await db.prepare(`UPDATE bank_accounts SET api_last_fetch_at=datetime('now') WHERE id=?`).bind(account.id).run();
    let statement;
    if (batch.cipher !== null && batch.key_version !== null) statement = JSON.parse(await decryptSecret(batch.cipher,batch.key_version,env));
    else {
      statement = await fetchFioStatement(credential,batch.from_date,batch.to_date,proxy);
      await renew();
      const encrypted = await encryptSecret(JSON.stringify(statement),env);
      await db.prepare(`UPDATE bank_recovery_batches SET cipher=?,key_version=?,state='spooled' WHERE id=?`)
        .bind(encrypted.cipher,encrypted.keyVersion,batch.id).run();
    }
    // Compare the receiving account before importing any row. Account identity
    // format must be the same validated representation returned by Fio.
    const identity = String(statement.info?.iban ?? '').replace(/\s/g,'').toUpperCase();
    const domestic = `${statement.info?.accountId ?? ''}/${statement.info?.bankId ?? ''}`;
    const expected = account.account_number.replace(/\s/g,'').toUpperCase();
    if (expected !== identity && expected !== domestic) throw new Error('fio_receiving_account_mismatch');
    let inserted=0, skipped=0;
    for (const raw of statement.transactions) {
      await renew();
      const mapped = mapFioTransaction(raw);
      if (!mapped || mapped.identity_kind !== 'movement') throw new Error('fio_unverified_movement');
      if (mapped.currency !== String(statement.info?.currency ?? '').toUpperCase()) throw new Error('fio_statement_currency_mismatch');
      const result=await insertTransaction(db,{bank_account_id:account.id,payload:mapped});
      if(result.status==='inserted') inserted++; else skipped++;
    }
    await renew();
    await db.batch([
      db.prepare(`UPDATE bank_recovery_batches SET state='completed',completed_at=datetime('now') WHERE id=?`).bind(batch.id),
      db.prepare(`UPDATE bank_accounts SET api_last_success_at=datetime('now'),api_last_error=NULL,api_backfill_done=1,
        api_reconciled_through=?,api_pointer_initialized=1 WHERE id=?`).bind(batch.to_date,account.id),
    ]);
    return {inserted,skipped};
  } finally {
    for(const key of held) await db.prepare(`UPDATE bank_poll_leases SET lease_until=datetime('now'),next_allowed_at=datetime('now','+30 seconds') WHERE credential_hash=? AND token=?`).bind(key,fence).run();
  }
}
