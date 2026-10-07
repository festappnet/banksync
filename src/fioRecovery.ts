import {RECOVERY_WRITES_ALLOWED} from './recoveryMaintenance';
import type {D1Database} from '@cloudflare/workers-types';
import type {ApiFetchAccount} from './types';
import {decryptSecret,encryptSecret,type VersionedSecretEnv} from './crypto';
import {sha256Hex} from './idempotency';
import {fetchFioStatement,FioReceivingAccountMismatch,mapFioTransaction,type FioProxyConfig,type FioStatement} from './fio';
import {withBankPollLease,normalizedBankAccount,type BankPollLease} from './bankPollLease';
import {recoverFioDelta,type FioRecoveryAlias} from './fioDeltaRecovery';
import {recoverBankAccount} from './bankRecovery';
import {findBankAccountApiMaterials,insertTransaction} from './db';
interface AliasRow {
  id:number; account_number:string; api_token_cipher:string; api_token_key_ver:number; api_token_hash:string|null;
  api_credential_generation:number; api_backfill_done:number; api_reconciled_through:string|null;
}
interface CursorRow {receiving_account:string;generation:string;initialized:number}
interface PeriodBatch {id:string;from_date:string;to_date:string;cipher:string|null;key_version:number|null;credential_generation:string}
const DAY=86400000;

/** Discover the real credential group, including legacy NULL digests. Digests
 * are backfilled only while the encrypted credential still matches the read.
 */
async function discoverAliases(db:D1Database,accountId:number,env:VersionedSecretEnv) {
  const current=await db.prepare(`SELECT id,account_number,api_token_cipher,api_token_key_ver,api_token_hash,api_credential_generation,api_backfill_done,api_reconciled_through
    FROM bank_accounts WHERE id=? AND account_type='FIO' AND ingest_enabled=1 AND api_fetch_enabled=1 AND ingest_mode IN ('api','both')`)
    .bind(accountId).first<AliasRow>();
  if(!current?.api_token_cipher || current.api_token_key_ver===null) throw new Error('bank_connection_paused');
  const token=await decryptSecret(current.api_token_cipher,current.api_token_key_ver,env),hash=await sha256Hex(token);
  const rows=await db.prepare(`SELECT id,account_number,api_token_cipher,api_token_key_ver,api_token_hash,api_credential_generation,api_backfill_done,api_reconciled_through
    FROM bank_accounts WHERE account_type='FIO' AND ingest_enabled=1 AND api_fetch_enabled=1 AND ingest_mode IN ('api','both')
    AND api_token_cipher IS NOT NULL AND api_token_key_ver IS NOT NULL AND (api_token_hash=? OR api_token_hash IS NULL OR id=?) ORDER BY id LIMIT 501`)
    .bind(hash,accountId).all<AliasRow>();
  if(rows.results.length>500) throw new Error('fio_credential_inventory_limit');
  const physical=normalizedBankAccount(current.account_number),aliases:AliasRow[]=[];
  for(const row of rows.results) {
    const actual=await sha256Hex(await decryptSecret(row.api_token_cipher,row.api_token_key_ver,env));
    if(actual!==row.api_token_hash) await db.prepare(`UPDATE bank_accounts SET api_token_hash=? WHERE id=? AND api_token_cipher=? AND api_credential_generation=?`)
      .bind(actual,row.id,row.api_token_cipher,row.api_credential_generation).run();
    if(actual===hash && normalizedBankAccount(row.account_number)===physical) aliases.push(row);
  }
  if(!aliases.some(alias=>alias.id===accountId)) throw new Error('bank_poll_lease_lost');
  // D1 has a bounded parameter count; never silently omit an alias from fan-out.
  if(aliases.length>12) throw new Error('fio_alias_limit_exceeded');
  const generation=await sha256Hex(JSON.stringify(aliases.map(alias=>[alias.id,alias.api_credential_generation,alias.api_token_cipher,alias.account_number])));
  return {aliases,token,hash,physical,generation};
}

export async function recoverFioAccount(db:D1Database,requested:ApiFetchAccount,env:VersionedSecretEnv,proxy?:FioProxyConfig) {
  const group=await discoverAliases(db,requested.id,env);
  const cursor=await db.prepare('SELECT receiving_account,generation,initialized FROM fio_poll_cursors WHERE credential_hash=?')
    .bind(group.hash).first<CursorRow>();
  // A wrong account configured with this token never touches its /last cursor.
  if(cursor && normalizedBankAccount(cursor.receiving_account)!==group.physical) throw new FioReceivingAccountMismatch(group.physical,cursor.receiving_account);
  const ids=group.aliases.map(alias=>alias.id),marks=ids.map(()=>'?').join(',');
  const legacy=await db.prepare(`SELECT bank_account_id FROM bank_recovery_batches WHERE bank_account_id IN (${marks})
    AND credential_hash IS NULL AND state<>'completed' ORDER BY created_at,id LIMIT 1`).bind(...ids).first<{bank_account_id:number}>();
  if(legacy) {
    const material=await findBankAccountApiMaterials(db,legacy.bank_account_id);
    if(!material) throw new Error('fio_legacy_recovery_credential_missing');
    const result=await recoverBankAccount(db,material,env,proxy);
    return {...(legacy.bank_account_id===requested.id?result:{inserted:0,skipped:0}),deferred:true};
  }
  return withBankPollLease(db,group.physical,group.token,async lease=>{
    const cursor=await db.prepare('SELECT receiving_account,generation,initialized FROM fio_poll_cursors WHERE credential_hash=?').bind(group.hash).first<CursorRow>();
    if(cursor && normalizedBankAccount(cursor.receiving_account)!==group.physical) throw new FioReceivingAccountMismatch(group.physical,cursor.receiving_account);
    const aliases:FioRecoveryAlias[]=group.aliases.map(alias=>({id:alias.id,generation:alias.api_credential_generation,tokenCipher:alias.api_token_cipher,accountNumber:alias.account_number}));
    const guard=`${lease.guard.sql} AND ${RECOVERY_WRITES_ALLOWED} AND `+aliases.map(()=>`EXISTS (SELECT 1 FROM bank_accounts WHERE id=? AND api_credential_generation=? AND api_token_cipher=? AND account_number=? AND ingest_enabled=1 AND api_fetch_enabled=1 AND ingest_mode IN ('api','both'))`).join(' AND ');
    const values=[...lease.guard.values,...aliases.flatMap(alias=>[alias.id,alias.generation,alias.tokenCipher,alias.accountNumber])];
    async function importStatement(statement:FioStatement) {
      const receiving=normalizedBankAccount(String(statement.info.iban??`${statement.info.accountId??''}/${statement.info.bankId??''}`));
      if(receiving!==group.physical) throw new FioReceivingAccountMismatch(group.physical,receiving);
      // Validate the whole statement before importing its first row.
      const payloads=statement.transactions.map(raw=>{
        const mapped=mapFioTransaction(raw);
        if(!mapped || mapped.identity_kind!=='movement') throw new Error('fio_unverified_movement');
        if(mapped.currency!==String(statement.info.currency??'').toUpperCase()) throw new Error('fio_statement_currency_mismatch');
        return mapped;
      });
      let inserted=0,skipped=0;
      for(const alias of group.aliases) for(const payload of payloads) {
        await lease.renew();
        const allowed=await db.prepare(`SELECT id FROM bank_accounts WHERE id=? AND ${guard}`).bind(alias.id,...values).first();
        if(!allowed) throw new Error('bank_poll_lease_lost');
        const result=await insertTransaction(db,{bank_account_id:alias.id,payload,writeFence:{sql:guard,values}});
        if(alias.id===requested.id) {if(result.status==='inserted') inserted++;else skipped++;}
      }
      return {inserted,skipped};
    }
    // Every alias shares the attempt watermark, avoiding multiple bank pulls in
    // the same queue tick. This is not an import-success or completeness marker.
    const attempts=await db.batch(group.aliases.map(alias=>db.prepare(`UPDATE bank_accounts SET api_last_fetch_at=datetime('now') WHERE id=? AND ${guard}`).bind(alias.id,...values)));
    if(attempts.some(result=>result.meta.changes!==1)) throw new Error('bank_poll_lease_lost');
    // Preserve stale-generation evidence even before the first cursor exists.
    // A mistyped alias that fetched a non-mutating periods response must not
    // permanently poison the token's correctly configured physical account.
    await db.prepare(`UPDATE bank_recovery_batches SET recovery_stage='quarantined' WHERE credential_hash=? AND state<>'completed' AND credential_generation<>? AND ${guard}`)
      .bind(group.hash,group.generation,...values).run();
    if(cursor && cursor.generation!==group.generation) {
      const updated=await db.prepare(`UPDATE fio_poll_cursors SET generation=?,initialized=0 WHERE credential_hash=? AND ${guard}`).bind(group.generation,group.hash,...values).run();
      if(updated.meta.changes!==1) throw new Error('bank_poll_lease_lost');
    }
    const today=new Date().toISOString().slice(0,10);
    const period=await db.prepare(`SELECT id,from_date,to_date,cipher,key_version,credential_generation FROM bank_recovery_batches
      WHERE credential_hash=? AND poll_kind='periods' AND state<>'completed' AND recovery_stage<>'quarantined' ORDER BY created_at,id LIMIT 1`)
      .bind(group.hash).first<PeriodBatch>();
    // Finish a saved delta before a daily periods pull. It may be the only copy
    // of a bank response that already advanced the remote checkpoint.
    const delta=await db.prepare(`SELECT id FROM bank_recovery_batches WHERE credential_hash=? AND poll_kind='last' AND state<>'completed' AND recovery_stage<>'quarantined' LIMIT 1`)
      .bind(group.hash).first();
    const needsHistory=group.aliases.some(alias=>!alias.api_backfill_done||!alias.api_reconciled_through);
    const needsBootstrap=!cursor||needsHistory;
    const needsDaily=group.aliases.some(alias=>(alias.api_reconciled_through??'')<today);
    if(period || (!delta && (needsBootstrap||needsDaily))) {
      if(!period && group.aliases.some(alias=>alias.api_reconciled_through!==null && Date.parse(today)-Date.parse(alias.api_reconciled_through)>86*DAY)) throw new Error('recovery_window_requires_bank_unlock');
      const start=needsHistory ? new Date(Date.parse(today)-89*DAY).toISOString().slice(0,10)
        : new Date(Math.min(...group.aliases.map(alias=>Date.parse(alias.api_reconciled_through!)))-3*DAY).toISOString().slice(0,10);
      if(!period && Date.parse(today)-Date.parse(start)>89*DAY) throw new Error('recovery_window_requires_bank_unlock');
      return recoverPeriods(db,{group,lease,guard,values,existing:period,start,today,env,proxy,importStatement});
    }
    return recoverFioDelta(db,{credentialHash:group.hash,generation:group.generation,token:group.token,aliases,lease,env,proxy,importStatement});
  });
}

async function recoverPeriods(db:D1Database,input:{group:Awaited<ReturnType<typeof discoverAliases>>;lease:BankPollLease;guard:string;values:(string|number)[];
  existing:PeriodBatch|null;start:string;today:string;env:VersionedSecretEnv;proxy:FioProxyConfig|undefined;
  importStatement(statement:FioStatement):Promise<{inserted:number;skipped:number}>}) {
  const {group,guard,values,lease}=input;
  const batch=input.existing??{id:crypto.randomUUID(),from_date:input.start,to_date:input.today,cipher:null,key_version:null,credential_generation:group.generation};
  if(batch.credential_generation!==group.generation) throw new Error('fio_recovery_generation_changed');
  if(!input.existing) {
    const created=await db.prepare(`INSERT INTO bank_recovery_batches(id,bank_account_id,from_date,to_date,state,poll_kind,credential_hash,credential_generation,recovery_stage)
      SELECT ?,?,?,?,'fetching','periods',?,?,'fetching' WHERE ${guard}`)
      .bind(batch.id,group.aliases[0]!.id,batch.from_date,batch.to_date,group.hash,group.generation,...values).run();
    if(created.meta.changes!==1) throw new Error('bank_poll_lease_lost');
  }
  let statement:FioStatement;
  if(batch.cipher!==null && batch.key_version!==null) statement=JSON.parse(await decryptSecret(batch.cipher,batch.key_version,input.env));
  else {
    statement=await fetchFioStatement(group.token,batch.from_date,batch.to_date,input.proxy);
    await lease.renew();
    const encrypted=await encryptSecret(JSON.stringify(statement),input.env);
    const stored=await db.prepare(`UPDATE bank_recovery_batches SET cipher=?,key_version=?,state='spooled',recovery_stage='spooled' WHERE id=? AND ${guard}`)
      .bind(encrypted.cipher,encrypted.keyVersion,batch.id,...values).run();
    if(stored.meta.changes!==1) throw new Error('bank_poll_lease_lost');
  }
  const imported=await input.importStatement(statement);
  await lease.renew();
  const completed="EXISTS (SELECT 1 FROM bank_recovery_batches WHERE id=? AND state='completed' AND completion_token=?)",proof=[batch.id,lease.token];
  const results=await db.batch([
    db.prepare(`UPDATE bank_recovery_batches SET state='completed',recovery_stage='completed',completed_at=datetime('now'),completion_token=?,cipher=NULL,key_version=NULL WHERE id=? AND state='spooled' AND ${guard}`)
      .bind(lease.token,batch.id,...values),
    db.prepare(`INSERT INTO fio_poll_cursors(credential_hash,receiving_account,generation,bootstrap_from_date)
      SELECT ?,?,?,? WHERE ${completed} ON CONFLICT(credential_hash) DO NOTHING`)
      .bind(group.hash,group.physical,group.generation,batch.from_date,...proof),
    ...group.aliases.map(alias=>db.prepare(`UPDATE bank_accounts SET api_last_success_at=datetime('now'),api_last_error=NULL,api_backfill_done=1,api_reconciled_through=? WHERE id=? AND ${completed}`)
      .bind(batch.to_date,alias.id,...proof)),
  ]);
  if(results[0]?.meta.changes!==1) throw new Error('bank_poll_lease_lost');
  return {...imported,deferred:true};
}
