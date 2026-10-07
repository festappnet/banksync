// Explicit operator check: creates only its own disposable D1 database, uses
// synthetic evidence, and removes it after checking the real D1 SQL platform.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const account=process.argv[2],evidenceFile=process.argv[3];
if(!/^[a-f0-9]{32}$/.test(account??'') || !evidenceFile) throw new Error('Usage: node scripts/verify-recovery-platform.mjs <account-id> <private-evidence-file>');
const auth=JSON.parse(execFileSync('pnpm',['exec','wrangler','auth','token','--json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
const prefix=`https://api.cloudflare.com/client/v4/accounts/${account}`;
const name=`banksync-recovery-proof-${randomUUID()}`;
const evidence={name,started_at:new Date().toISOString(),checks:{},cleanup_verified:false};
let database;
async function api(path,method='GET',body) {
  const response=await fetch(prefix+path,{method,headers:{Authorization:`Bearer ${auth.token}`,'content-type':'application/json'},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(40000)});
  const result=await response.json();
  if(!response.ok||!result.success) throw new Error(`Cloudflare operator check failed (${response.status})`);
  return result.result;
}
function save() {writeFileSync(evidenceFile,JSON.stringify(evidence,null,2)+'\n',{mode:0o600});}
async function sql(query) {
  if(!database) throw new Error('No owned disposable database');
  const result=await api(`/d1/database/${database}/query`,'POST',{sql:query});
  if(result.some(item=>!item.success)) throw new Error('Disposable SQL statement failed');
  return result;
}
function assert(condition,message) {if(!condition) throw new Error(message);}
try {
  const created=await api('/d1/database','POST',{name});database=created.uuid;evidence.database=database;save();
  const identity=await api(`/d1/database/${database}`);
  assert(identity.name===name,'Unexpected disposable database identity');
  for(const file of ['0001_schema.sql','0010_security_hardening.sql','0011_complete_bank_facts.sql','0012_payment_references.sql'])
    await sql(readFileSync(fileURLToPath(new URL(`../migrations/${file}`,import.meta.url)),'utf8'));
  await sql("INSERT INTO bank_accounts(id,account_number,pairing_code) VALUES(1,'1234/2010','fixture');INSERT INTO authenticated_email_spool(id,bank_account_id,body_sha256,cipher,key_version,attempts) VALUES('old',1,'digest','encrypted-fixture',1,901)");
  const migration=readFileSync(fileURLToPath(new URL('../migrations/0013_recovery_operations.sql',import.meta.url)),'utf8');
  evidence.migration_sha256=createHash('sha256').update(migration).digest('hex');await sql(migration);
  const schema=(await sql("SELECT value FROM schema_meta WHERE key='version'"))[0].results;
  assert(schema[0]?.value==='13','Schema did not advance to 13');
  const pending=(await sql("SELECT id,message_key,cipher,attempts FROM authenticated_email_spool WHERE id='old'"))[0].results[0];
  assert(pending?.cipher==='encrypted-fixture'&&pending.attempts===901&&pending.message_key==='old','Pending evidence changed');
  await sql("INSERT INTO authenticated_email_spool(id,message_key,body_sha256,cipher,key_version,state) VALUES('orphan','orphan','digest','encrypted-orphan',1,'quarantined')");
  evidence.checks.migration_preserved_pending=true;evidence.checks.orphan_quarantine=true;
  await sql("WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<30000) INSERT INTO bank_recovery_batches(id,bank_account_id,from_date,to_date,state,cipher,key_version,completed_at) SELECT 'done-'||x,1,'2026-10-01','2026-10-02','completed','completed-fixture',1,datetime('now','-8 days') FROM seq;INSERT INTO bank_recovery_batches(id,bank_account_id,from_date,to_date,state) VALUES('pending',1,'2026-10-01','2026-10-02','fetching')");
  const query="SELECT id FROM bank_recovery_batches WHERE bank_account_id=1 AND state<>'completed' ORDER BY created_at,id LIMIT 1";
  const plan=(await sql('EXPLAIN QUERY PLAN '+query))[0].results;
  const lookup=(await sql(query))[0];
  assert(plan.some(row=>row.detail.includes('idx_bank_recovery_open')),'Open query did not use the partial index');
  assert(lookup.results[0]?.id==='pending'&&lookup.meta.rows_read<=2,'Open query read completed history');
  evidence.checks.open_query={rows_read:lookup.meta.rows_read,plan};
  const clear=(await sql("UPDATE bank_recovery_batches SET cipher=NULL,key_version=NULL WHERE id IN (SELECT id FROM bank_recovery_batches WHERE state='completed' AND cipher IS NOT NULL ORDER BY completed_at,id LIMIT 500)"))[0];
  const prune=(await sql("DELETE FROM bank_recovery_batches WHERE id IN (SELECT id FROM bank_recovery_batches WHERE state='completed' AND datetime(completed_at)<datetime('now','-7 days') ORDER BY completed_at,id LIMIT 500)"))[0];
  assert(clear.meta.changes===500&&prune.meta.changes===500,'Cleanup exceeded or missed its bound');
  assert((await sql("SELECT COUNT(*) AS n FROM bank_recovery_batches WHERE id='pending' AND state='fetching'"))[0].results[0].n===1,'Pending recovery was deleted');
  evidence.checks.bounded_cleanup={cleared:clear.meta.changes,deleted:prune.meta.changes};
  await sql("INSERT INTO schema_meta(key,value) VALUES('recovery_maintenance','on')");
  const fenced=(await sql("INSERT INTO transactions(bank_account_id,amount_cents,currency,source,date) SELECT 1,100,'CZK','fio_api','2026-10-08' WHERE NOT EXISTS(SELECT 1 FROM schema_meta WHERE key='recovery_maintenance' AND value='on')"))[0];
  assert(fenced.meta.changes===0,'Maintenance failed to fence the actual insertion');
  evidence.checks.maintenance_fence=true;evidence.completed_at=new Date().toISOString();save();
} finally {
  if(database) {
    const identity=await api(`/d1/database/${database}`);
    assert(identity.name===name,'Refusing to delete an unowned database');
    await api(`/d1/database/${database}`,'DELETE');
    const response=await fetch(prefix+`/d1/database/${database}`,{headers:{Authorization:`Bearer ${auth.token}`},signal:AbortSignal.timeout(40000)});
    evidence.cleanup_verified=response.status===404;save();
    assert(evidence.cleanup_verified,'Disposable cleanup could not be verified');
  }
}
console.log(JSON.stringify({checks:Object.keys(evidence.checks),cleanup_verified:evidence.cleanup_verified}));
