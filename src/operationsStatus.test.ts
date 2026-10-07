import {describe,it,expect} from 'vitest';
import {operationsDb} from './operationsTestSupport';
import {getOperationsStatus,recordStorageSample,operationalBreaches} from './operationsStatus';
import {getStatusData} from './db';
import {evaluateThresholds,DEFAULT_THRESHOLDS} from './alerter';
describe('protected operations status',()=>{
  it('keeps older schemas compatible and reports empty observations without invented freshness',async()=>{
    expect(await getOperationsStatus(operationsDb(12).db)).toBeUndefined();
    const {db}=operationsDb();const status=(await getOperationsStatus(db))!;
    expect(status.recovery_open).toBe(0);expect(status.api_accounts).toEqual([]);expect(status.last_backup_at).toBeNull();expect(status.db_size_bytes).toBeGreaterThan(0);
    expect(operationalBreaches(status).map(metric=>metric.metric)).toEqual(['maintenance_missing','backup_missing']);
  });
  it('separates pending retries, quarantines, current API freshness and successful maintenance',async()=>{
    const {db,sqlite}=operationsDb();sqlite.exec(`INSERT INTO bank_accounts(id,account_number,pairing_code,api_fetch_enabled,ingest_mode,api_last_success_at) VALUES(1,'1234/2010','fixture',1,'api',datetime('now','-2 hours'));
      INSERT INTO bank_recovery_batches(id,bank_account_id,from_date,to_date,state,recovery_stage,created_at) VALUES('open',1,'2026-10-01','2026-10-02','fetching','fetching',datetime('now','-2 hours')),('evidence',1,'2026-10-01','2026-10-02','spooled','quarantined',datetime('now','-1 hour'));
      INSERT INTO authenticated_email_spool(id,bank_account_id,message_key,body_sha256,cipher,key_version,state,next_attempt_at) VALUES('q',1,'q','digest','evidence',1,'quarantined',datetime('now')),('later',1,'later','digest','bytes',1,'pending',datetime('now','+1 day')),('due',1,'due','digest','bytes',1,'pending',datetime('now','-1 hour'));
      INSERT INTO schema_meta(key,value) VALUES('last_maintenance_at',datetime('now')),('last_backup_at',datetime('now'));`);
    const status=(await getStatusData(db)).operations!;
    expect(status.recovery_open).toBe(1);expect(status.recovery_quarantined).toBe(1);expect(status.recovery_oldest_age_s).toBeGreaterThanOrEqual(7200);
    expect(status.email_pending).toBe(2);expect(status.email_due).toBe(1);expect(status.email_quarantined).toBe(1);
    expect(status.api_accounts[0]?.freshness_age_s).toBeGreaterThanOrEqual(7200);
    const alert=await evaluateThresholds(db,{webhookUrl:'https://example.test',service:'fixture',thresholds:DEFAULT_THRESHOLDS});
    expect(alert?.triggered_thresholds.map(row=>row.metric)).toEqual(['recovery_oldest_age_s','email_quarantined','recovery_quarantined','api_freshness_age_s']);
  });
  it('measures physical allocation and daily growth from successful samples',async()=>{
    const {db,sqlite}=operationsDb();
    sqlite.prepare("INSERT INTO schema_meta(key,value) VALUES('db_size_sample',?)").run(JSON.stringify({bytes:1000,at:new Date(Date.now()-86400000).toISOString()}));
    await recordStorageSample(db);const status=(await getOperationsStatus(db))!;
    expect(status.db_growth_bytes_per_day).toBeGreaterThan(0);
    expect(status.db_growth_bytes_per_day).toBeLessThanOrEqual(status.db_size_bytes);
  });
});
