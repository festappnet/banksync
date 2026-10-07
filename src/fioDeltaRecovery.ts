import {RECOVERY_WRITES_ALLOWED} from './recoveryMaintenance';
import type {D1Database} from '@cloudflare/workers-types';
import {decryptSecret,encryptSecret,type VersionedSecretEnv} from './crypto';
import {fetchFioDelta,setFioPointer,setFioPointerById,FioReceivingAccountMismatch,type FioProxyConfig,type FioStatement} from './fio';
import {verifyFioCursor,type FioCursorProof} from './fioCursor';
import {normalizedBankAccount,type BankPollLease} from './bankPollLease';

interface CursorRow {
  receiving_account:string; generation:string; last_committed_movement_id:string|null;
  last_reported_movement_id:string|null; last_batch_ids:string; bootstrap_from_date:string; initialized:number;
}
interface BatchRow {id:string; cipher:string|null; key_version:number|null; cursor_before:string|null; recovery_stage:string; credential_generation:string}
export interface FioRecoveryAlias {id:number; generation:number; tokenCipher:string;accountNumber:string}
export interface FioDeltaInput {
  credentialHash:string; generation:string; token:string; aliases:FioRecoveryAlias[];
  lease:BankPollLease; env:VersionedSecretEnv; proxy?:FioProxyConfig|undefined;
  /** Import every validated alias before returning. Idempotency lives in D1. */
  importStatement(statement:FioStatement):Promise<{inserted:number;skipped:number}>;
}

/** One bank request at most per invocation. Caller establishes the verified
 * bootstrap and credential-wide alias set first. The persisted operation owns
 * reset/fetch/spool/commit; a response is never fetched twice from /last blindly.
 */
export async function recoverFioDelta(db:D1Database,input:FioDeltaInput):Promise<{inserted:number;skipped:number;deferred:boolean}> {
  const cursor=await db.prepare('SELECT * FROM fio_poll_cursors WHERE credential_hash=?').bind(input.credentialHash).first<CursorRow>();
  if(!cursor || cursor.generation!==input.generation || input.aliases.length===0) throw new Error('fio_verified_bootstrap_required');
  const guard=`${input.lease.guard.sql} AND ${RECOVERY_WRITES_ALLOWED} AND EXISTS (SELECT 1 FROM fio_poll_cursors WHERE credential_hash=? AND generation=?) AND `+
    input.aliases.map(()=>`EXISTS (SELECT 1 FROM bank_accounts WHERE id=? AND api_credential_generation=? AND api_token_cipher=? AND account_number=? AND ingest_enabled=1 AND api_fetch_enabled=1 AND ingest_mode IN ('api','both'))`).join(' AND ');
  const guardValues=[...input.lease.guard.values,input.credentialHash,input.generation,
    ...input.aliases.flatMap(alias=>[alias.id,alias.generation,alias.tokenCipher,alias.accountNumber])];
  async function write(sql:string,args:unknown[]) {
    const result=await db.prepare(`${sql} AND ${guard}`).bind(...args,...guardValues).run();
    if(result.meta.changes!==1) throw new Error('bank_poll_lease_lost');
  }
  let batch=await db.prepare(`SELECT id,cipher,key_version,cursor_before,recovery_stage,credential_generation FROM bank_recovery_batches
    WHERE credential_hash=? AND state<>'completed' AND recovery_stage<>'quarantined' ORDER BY created_at,id LIMIT 1`)
    .bind(input.credentialHash).first<BatchRow>();
  if(batch && batch.credential_generation!==input.generation) throw new Error('fio_recovery_generation_changed');
  const existed=batch!==null;
  if(!batch) {
    batch={id:crypto.randomUUID(),cipher:null,key_version:null,cursor_before:cursor.last_committed_movement_id,
      recovery_stage:cursor.initialized===1?'ready':'reset_required',credential_generation:input.generation};
    await db.prepare(`INSERT INTO bank_recovery_batches(id,bank_account_id,from_date,to_date,state,poll_kind,credential_hash,credential_generation,cursor_before,recovery_stage)
      SELECT ?,?,?,date('now'),'fetching','last',?,?,?,? WHERE ${guard}`)
      .bind(batch.id,input.aliases[0]!.id,cursor.bootstrap_from_date,input.credentialHash,input.generation,batch.cursor_before,batch.recovery_stage,...guardValues).run();
  }
  if(batch.cipher===null && (batch.recovery_stage==='reset_required'||batch.recovery_stage==='resetting'||
    (existed && batch.recovery_stage.startsWith('fetching')))) {
    await write("UPDATE bank_recovery_batches SET recovery_stage='resetting' WHERE id=? AND state<>'completed'",[batch.id]);
    if(batch.cursor_before!==null) await setFioPointerById(input.token,batch.cursor_before,input.proxy);
    else {
      if(Date.parse(new Date().toISOString().slice(0,10))-Date.parse(cursor.bootstrap_from_date)>89*86400000) throw new Error('recovery_window_requires_bank_unlock');
      await setFioPointer(input.token,cursor.bootstrap_from_date,input.proxy);
    }
    await input.lease.renew();
    await write('UPDATE bank_recovery_batches SET recovery_stage=? WHERE id=? AND state<>\'completed\'',
      [batch.cursor_before===null?'ready_after_date_reset':'ready',batch.id]);
    return {inserted:0,skipped:0,deferred:true};
  }
  let statement:FioStatement;
  const afterDateReset=batch.recovery_stage.endsWith('_after_date_reset');
  if(batch.cipher!==null && batch.key_version!==null) statement=JSON.parse(await decryptSecret(batch.cipher,batch.key_version,input.env));
  else {
    await write('UPDATE bank_recovery_batches SET recovery_stage=? WHERE id=? AND state<>\'completed\'',
      [afterDateReset?'fetching_after_date_reset':'fetching',batch.id]);
    statement=await fetchFioDelta(input.token,input.proxy);
    await input.lease.renew();
    const encrypted=await encryptSecret(JSON.stringify(statement),input.env);
    await write("UPDATE bank_recovery_batches SET cipher=?,key_version=?,state='spooled',recovery_stage=? WHERE id=? AND state<>'completed'",
      [encrypted.cipher,encrypted.keyVersion,afterDateReset?'spooled_after_date_reset':'spooled',batch.id]);
  }
  const receiving=normalizedBankAccount(String(statement.info.iban??`${statement.info.accountId??''}/${statement.info.bankId??''}`));
  if(receiving!==normalizedBankAccount(cursor.receiving_account)) throw new FioReceivingAccountMismatch(cursor.receiving_account,receiving);
  const previous:FioCursorProof={committedId:cursor.last_committed_movement_id,reportedId:cursor.last_reported_movement_id,batchIds:JSON.parse(cursor.last_batch_ids)};
  let proof:FioCursorProof;
  try {proof=verifyFioCursor(statement,previous,afterDateReset);}
  catch(error) {
    if(error instanceof Error && error.message==='fio_cursor_drift') {
      // Retain the unexpected encrypted response as evidence. A separate intent
      // will reset to the locally proven prefix instead of trusting another writer.
      await db.batch([
        db.prepare(`UPDATE bank_recovery_batches SET recovery_stage='quarantined' WHERE id=? AND ${guard}`).bind(batch.id,...guardValues),
        db.prepare(`UPDATE fio_poll_cursors SET initialized=0 WHERE credential_hash=? AND ${guard}`).bind(input.credentialHash,...guardValues),
      ]);
    }
    throw error;
  }
  const imported=await input.importStatement(statement);
  await input.lease.renew();
  const completedGuard="EXISTS (SELECT 1 FROM bank_recovery_batches WHERE id=? AND state='completed' AND completion_token=?)";
  const completedValues=[batch.id,input.lease.token];
  const committed=await db.batch([
    db.prepare(`UPDATE bank_recovery_batches SET state='completed',recovery_stage='completed',completed_at=datetime('now'),completion_token=?,cipher=NULL,key_version=NULL
      WHERE id=? AND state='spooled' AND ${guard}`).bind(input.lease.token,batch.id,...guardValues),
    db.prepare(`UPDATE fio_poll_cursors SET last_committed_movement_id=?,last_reported_movement_id=?,last_batch_ids=?,initialized=1,last_success_at=datetime('now')
      WHERE credential_hash=? AND ${completedGuard}`)
      .bind(proof.committedId,proof.reportedId,JSON.stringify(proof.batchIds),input.credentialHash,...completedValues),
    ...input.aliases.map(alias=>db.prepare(`UPDATE bank_accounts SET api_last_success_at=datetime('now'),api_last_error=NULL
      WHERE id=? AND ${completedGuard}`).bind(alias.id,...completedValues)),
  ]);
  if(committed[0]?.meta.changes!==1) throw new Error('bank_poll_lease_lost');
  return {...imported,deferred:false};
}
