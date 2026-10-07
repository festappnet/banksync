import type {D1Database} from '@cloudflare/workers-types';

export interface EmailRecoveryClaim {id:string; token:string}
export type EmailRecoveryStart =
  | {kind:'claimed'; claim:EmailRecoveryClaim}
  | {kind:'completed'|'deferred'|'quarantined'};

/** Every authenticated variant is persisted before deciding whether to retry it.
 * A Message-ID conflict preserves both digests and all still-available bodies.
 */
export async function beginEmailRecovery(db:D1Database, input:{
  messageKey:string; accountId:number|null; digest:string; cipher:string; keyVersion:number; r2Key?:string|undefined;
}):Promise<EmailRecoveryStart> {
  // Keep old primary IDs addressable after migrating the legacy spool.
  const primary = await db.prepare('SELECT id,body_sha256 FROM authenticated_email_spool WHERE message_key=? ORDER BY created_at,id LIMIT 1')
    .bind(input.messageKey).first<{id:string;body_sha256:string}>();
  const id = primary?.body_sha256===input.digest ? primary.id : primary ? `${input.messageKey}:${input.digest}` : input.messageKey;
  await db.prepare(`INSERT INTO authenticated_email_spool(id,bank_account_id,message_key,body_sha256,cipher,key_version,r2_key)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET r2_key=COALESCE(authenticated_email_spool.r2_key,excluded.r2_key) WHERE authenticated_email_spool.body_sha256=excluded.body_sha256`)
    .bind(id,input.accountId,input.messageKey,input.digest,input.cipher,input.keyVersion,input.r2Key??null).run();
  // Re-read after INSERT: two simultaneous first deliveries may have different
  // bodies, so the pre-insert lookup alone cannot establish agreement.
  const conflicts = await db.prepare('SELECT id FROM authenticated_email_spool WHERE message_key=? AND body_sha256<>? LIMIT 1')
    .bind(input.messageKey,input.digest).first<{id:string}>();
  const own = await db.prepare('SELECT body_sha256 FROM authenticated_email_spool WHERE id=?').bind(id).first<{body_sha256:string}>();
  if (conflicts || own?.body_sha256!==input.digest) {
    // A concurrent first INSERT may have won the primary ID with other bytes.
    // Persist this variant separately before changing states.
    await db.batch([
      db.prepare(`INSERT INTO authenticated_email_spool(id,bank_account_id,message_key,body_sha256,cipher,key_version,r2_key,state,last_error)
        SELECT ?,?,?,?,?,?,?,'quarantined','email_transport_body_conflict'
        WHERE NOT EXISTS (SELECT 1 FROM authenticated_email_spool WHERE message_key=? AND body_sha256=?) ON CONFLICT(id) DO NOTHING`)
        .bind(`${input.messageKey}:${input.digest}`,input.accountId,input.messageKey,input.digest,input.cipher,input.keyVersion,input.r2Key??null,input.messageKey,input.digest),
      db.prepare(`UPDATE authenticated_email_spool SET state=CASE WHEN state='completed' THEN state ELSE 'quarantined' END,
        last_error='email_transport_body_conflict',claim_token=NULL,claim_until=NULL WHERE message_key=?`).bind(input.messageKey),
    ]);
    return {kind:'quarantined'};
  }
  const token=crypto.randomUUID();
  const acquired=await db.prepare(`UPDATE authenticated_email_spool SET claim_token=?,claim_until=datetime('now','+120 seconds'),
    last_attempt_at=datetime('now'),attempts=attempts+1 WHERE id=? AND state='pending'
    AND datetime(next_attempt_at)<=datetime('now') AND (claim_until IS NULL OR datetime(claim_until)<=datetime('now'))`)
    .bind(token,id).run();
  if(acquired.meta.changes===1) return {kind:'claimed',claim:{id,token}};
  const row=await db.prepare('SELECT state FROM authenticated_email_spool WHERE id=?').bind(id).first<{state:string}>();
  return {kind:row?.state==='completed'?'completed':row?.state==='quarantined'?'quarantined':'deferred'};
}

export async function completeEmailRecovery(db:D1Database,claim:EmailRecoveryClaim):Promise<void> {
  const result=await db.prepare(`UPDATE authenticated_email_spool SET state='completed',completed_at=datetime('now'),cipher=NULL,key_version=NULL,
    last_error=NULL,claim_token=NULL,claim_until=NULL WHERE id=? AND state='pending' AND claim_token=? AND datetime(claim_until)>datetime('now')`)
    .bind(claim.id,claim.token).run();
  if(result.meta.changes!==1) throw new Error('email_recovery_claim_lost');
}

/** Store stable categories only, never exception text containing private data. */
export function emailFailureCategory(error:unknown):{code:string; permanent:boolean} {
  const code=error instanceof Error ? error.message : '';
  if(['email_missing_bank_date','email_transport_body_conflict','authenticated_email_quarantined'].includes(code)) return {code,permanent:true};
  if(code==='email_connection_paused') return {code,permanent:false};
  return {code:'email_processing_failed',permanent:false};
}

export async function failEmailRecovery(db:D1Database,claim:EmailRecoveryClaim,error:unknown):Promise<boolean> {
  const failure=emailFailureCategory(error);
  const result=await db.prepare(`UPDATE authenticated_email_spool SET state=?,last_error=?,
    next_attempt_at=datetime('now',CASE WHEN ?='email_connection_paused' THEN '+1 day'
      WHEN attempts<=1 THEN '+5 minutes' WHEN attempts=2 THEN '+15 minutes'
      WHEN attempts=3 THEN '+1 hour' WHEN attempts=4 THEN '+6 hours' ELSE '+1 day' END),
    claim_token=NULL,claim_until=NULL WHERE id=? AND state='pending' AND claim_token=?`)
    .bind(failure.permanent?'quarantined':'pending',failure.code,failure.code,claim.id,claim.token).run();
  return result.meta.changes===1;
}

export async function emailR2Disposition(db:D1Database,key:string):Promise<'process'|'retain'|'delete'> {
  const row=await db.prepare(`SELECT state,next_attempt_at,claim_until FROM authenticated_email_spool WHERE r2_key=? LIMIT 1`)
    .bind(key).first<{state:string;next_attempt_at:string;claim_until:string|null}>();
  if(!row) return 'process'; // R2-first persistence may precede a D1 outage.
  if(row.state==='completed') return 'delete';
  if(row.state==='quarantined') return 'retain';
  const due=await db.prepare(`SELECT id FROM authenticated_email_spool WHERE r2_key=? AND state='pending'
    AND datetime(next_attempt_at)<=datetime('now') AND (claim_until IS NULL OR datetime(claim_until)<=datetime('now')) LIMIT 1`)
    .bind(key).first<{id:string}>();
  return due?'process':'retain';
}
