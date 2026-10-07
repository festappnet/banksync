import type {D1Database} from '@cloudflare/workers-types';
export interface OperationsStatus {
  recovery_maintenance:boolean;
  recovery_open:number; recovery_oldest_at:string|null; recovery_oldest_age_s:number;
  recovery_quarantined:number; recovery_quarantine_oldest_at:string|null;
  email_pending:number; email_due:number; email_quarantined:number; email_quarantine_oldest_at:string|null;
  last_maintenance_at:string|null; maintenance_age_s:number|null;
  last_backup_at:string|null; backup_age_s:number|null;
  db_size_bytes:number; db_growth_bytes_per_day:number|null;
  api_accounts:Array<{id:number;last_success_at:string|null;freshness_age_s:number|null}>;
}
function age(value:string|null,now:number):number|null {
  if(!value) return null;
  const ms=Date.parse(value.includes('T')?value:`${value.replace(' ','T')}Z`);
  return Number.isFinite(ms)?Math.max(0,Math.floor((now-ms)/1000)):null;
}
export async function getOperationsStatus(db:D1Database):Promise<OperationsStatus|undefined> {
  const schema=await db.prepare("SELECT value FROM schema_meta WHERE key='version'").all<{value:string}>();
  if(schema.results[0]?.value!=='13') return undefined;
  const [recovery,email,metadata,accounts]=await Promise.all([
    db.prepare(`SELECT SUM(CASE WHEN recovery_stage<>'quarantined' THEN 1 ELSE 0 END) AS open,
      MIN(CASE WHEN recovery_stage<>'quarantined' THEN created_at END) AS oldest,
      SUM(CASE WHEN recovery_stage='quarantined' THEN 1 ELSE 0 END) AS quarantined,
      MIN(CASE WHEN recovery_stage='quarantined' THEN created_at END) AS quarantine_oldest
      FROM bank_recovery_batches WHERE state<>'completed'`).first<{open:number|null;oldest:string|null;quarantined:number|null;quarantine_oldest:string|null}>(),
    db.prepare(`SELECT SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN state='pending' AND datetime(next_attempt_at)<=datetime('now') AND (claim_until IS NULL OR datetime(claim_until)<=datetime('now')) THEN 1 ELSE 0 END) AS due,
      SUM(CASE WHEN state='quarantined' THEN 1 ELSE 0 END) AS quarantined,
      MIN(CASE WHEN state='quarantined' THEN created_at END) AS oldest FROM authenticated_email_spool WHERE state<>'completed'`)
      .first<{pending:number|null;due:number|null;quarantined:number|null;oldest:string|null}>(),
    db.prepare("SELECT key,value FROM schema_meta WHERE key IN ('last_maintenance_at','last_backup_at','db_size_sample','db_size_previous_sample','recovery_maintenance')").all<{key:string;value:string}>(),
    db.prepare(`SELECT id,api_last_success_at FROM bank_accounts WHERE account_type='FIO' AND api_fetch_enabled=1 AND ingest_enabled=1 AND ingest_mode IN ('api','both') ORDER BY id`)
      .all<{id:number;api_last_success_at:string|null}>(),
  ]);
  const meta=new Map(metadata.results.map(row=>[row.key,row.value])),now=Date.now();
  const maintenance=meta.get('last_maintenance_at')??null,backup=meta.get('last_backup_at')??null;
  let growth:number|null=null;
  if(meta.has('db_size_sample')&&meta.has('db_size_previous_sample')) {
    const current=JSON.parse(meta.get('db_size_sample')!) as {bytes:number;at:string},prior=JSON.parse(meta.get('db_size_previous_sample')!) as {bytes:number;at:string};
    const interval=Date.parse(current.at)-Date.parse(prior.at);
    if(interval>=3600000) growth=Math.round((current.bytes-prior.bytes)*86400000/interval);
  }
  return {recovery_maintenance:meta.get('recovery_maintenance')==='on',recovery_open:recovery?.open??0,recovery_oldest_at:recovery?.oldest??null,recovery_oldest_age_s:age(recovery?.oldest??null,now)??0,
    recovery_quarantined:recovery?.quarantined??0,recovery_quarantine_oldest_at:recovery?.quarantine_oldest??null,
    email_pending:email?.pending??0,email_due:email?.due??0,email_quarantined:email?.quarantined??0,email_quarantine_oldest_at:email?.oldest??null,
    last_maintenance_at:maintenance,maintenance_age_s:age(maintenance,now),last_backup_at:backup,backup_age_s:age(backup,now),
    db_size_bytes:schema.meta.size_after,db_growth_bytes_per_day:growth,
    api_accounts:accounts.results.map(row=>({id:row.id,last_success_at:row.api_last_success_at,freshness_age_s:age(row.api_last_success_at,now)}))};
}

/** Sample physical D1 allocation using supported result metadata. Do not sum
 * payload lengths or infer reclaimed bytes immediately after SQLite DELETE. */
export async function recordStorageSample(db:D1Database):Promise<void> {
  const schema=await db.prepare("SELECT value FROM schema_meta WHERE key='version'").all<{value:string}>();
  if(schema.results[0]?.value!=='13') return;
  const prior=await db.prepare("SELECT value FROM schema_meta WHERE key='db_size_sample'").first<{value:string}>();
  const writes=[];
  if(prior) writes.push(db.prepare("INSERT INTO schema_meta(key,value) VALUES('db_size_previous_sample',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(prior.value));
  writes.push(db.prepare("INSERT INTO schema_meta(key,value) VALUES('db_size_sample',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(JSON.stringify({bytes:schema.meta.size_after,at:new Date().toISOString()})));
  await db.batch(writes);
}

export const OPERATIONS_THRESHOLDS={recovery_oldest_age_s:3600,email_quarantined:1,recovery_quarantined:1,
  api_freshness_age_s:1800,api_never_succeeded:1,maintenance_missing:1,backup_missing:1,maintenance_age_s:172800,backup_age_s:9*86400,db_size_bytes:8_000_000_000,db_growth_bytes_per_day:50_000_000};
export function operationalBreaches(status:OperationsStatus):Array<{metric:string;value:number;threshold:number}> {
  const values:Record<string,number>={recovery_oldest_age_s:status.recovery_oldest_age_s,email_quarantined:status.email_quarantined,
    recovery_quarantined:status.recovery_quarantined,api_freshness_age_s:Math.max(0,...status.api_accounts.map(account=>account.freshness_age_s??0)),
    api_never_succeeded:status.api_accounts.filter(account=>account.last_success_at===null).length,
    maintenance_missing:status.last_maintenance_at===null?1:0,backup_missing:status.last_backup_at===null?1:0,
    maintenance_age_s:status.maintenance_age_s??0,backup_age_s:status.backup_age_s??0,
    db_size_bytes:status.db_size_bytes,db_growth_bytes_per_day:status.db_growth_bytes_per_day??0};
  return Object.entries(OPERATIONS_THRESHOLDS).filter(([metric,threshold])=>values[metric]!>=threshold)
    .map(([metric,threshold])=>({metric,value:values[metric]!,threshold}));
}
