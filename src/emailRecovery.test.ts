import {describe,it,expect} from 'vitest';
import {operationsDb} from './operationsTestSupport';
import {beginEmailRecovery,completeEmailRecovery,failEmailRecovery,emailR2Disposition} from './emailRecovery';

function fixture() {
  const context=operationsDb();
  context.sqlite.exec("INSERT INTO bank_accounts(id,account_number,pairing_code) VALUES(1,'1234/2010','fixture')");
  const input={messageKey:'message',accountId:1,digest:'digest-a',cipher:'encrypted-a',keyVersion:1,r2Key:'r2-a'};
  return {...context,input};
}

describe('authenticated email recovery',()=>{
  it('claims once, clears only completed payloads and cleans up R2 idempotently',async()=>{
    const {db,sqlite,input}=fixture();
    const started=await beginEmailRecovery(db,input);expect(started.kind).toBe('claimed');
    expect(await beginEmailRecovery(db,input)).toEqual({kind:'deferred'});
    if(started.kind!=='claimed') throw new Error('expected claim');
    await completeEmailRecovery(db,started.claim);
    expect(sqlite.prepare('SELECT state,cipher,key_version,attempts FROM authenticated_email_spool').get()).toEqual({state:'completed',cipher:null,key_version:null,attempts:1});
    expect(await emailR2Disposition(db,'r2-a')).toBe('delete');
    expect(await beginEmailRecovery(db,input)).toEqual({kind:'completed'});
    await expect(completeEmailRecovery(db,started.claim)).rejects.toThrow('email_recovery_claim_lost');
  });
  it('preserves both conflicting variants and prevents an in-flight completion',async()=>{
    const {db,sqlite,input}=fixture();const original=await beginEmailRecovery(db,input);
    expect(await beginEmailRecovery(db,{...input,digest:'digest-b',cipher:'encrypted-b',r2Key:'r2-b'})).toEqual({kind:'quarantined'});
    expect(sqlite.prepare('SELECT body_sha256,cipher,state FROM authenticated_email_spool ORDER BY body_sha256').all()).toEqual([
      {body_sha256:'digest-a',cipher:'encrypted-a',state:'quarantined'},
      {body_sha256:'digest-b',cipher:'encrypted-b',state:'quarantined'},
    ]);
    if(original.kind!=='claimed') throw new Error('expected claim');
    await expect(completeEmailRecovery(db,original.claim)).rejects.toThrow('email_recovery_claim_lost');
    expect(await emailR2Disposition(db,'r2-a')).toBe('retain');
    expect(await emailR2Disposition(db,'r2-b')).toBe('retain');
    expect(await beginEmailRecovery(db,input)).toEqual({kind:'quarantined'});
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM authenticated_email_spool').get()).toEqual({n:2});
  });
  it('retains the completed original digest and new evidence without recreating cleared bytes',async()=>{
    const {db,sqlite,input}=fixture();const original=await beginEmailRecovery(db,input);
    if(original.kind!=='claimed') throw new Error('expected claim');await completeEmailRecovery(db,original.claim);
    await beginEmailRecovery(db,{...input,digest:'digest-b',cipher:'encrypted-b',r2Key:'r2-b'});
    expect(sqlite.prepare('SELECT state,cipher,last_error FROM authenticated_email_spool WHERE id=?').get('message')).toEqual({state:'completed',cipher:null,last_error:'email_transport_body_conflict'});
    expect(await emailR2Disposition(db,'r2-b')).toBe('retain');
  });
  it('uses bounded retry delays without retrying on both scheduler paths',async()=>{
    const {db,sqlite,input}=fixture();
    for(const seconds of [300,900,3600,21600,86400,86400]) {
      const started=await beginEmailRecovery(db,input);if(started.kind!=='claimed') throw new Error('expected claim');
      expect(await failEmailRecovery(db,started.claim,new Error('private transient details'))).toBe(true);
      expect(sqlite.prepare("SELECT CAST(strftime('%s',next_attempt_at)-strftime('%s','now') AS INTEGER) AS delay,last_error FROM authenticated_email_spool").get()).toEqual({delay:seconds,last_error:'email_processing_failed'});
      expect(await beginEmailRecovery(db,input)).toEqual({kind:'deferred'});
      expect(await emailR2Disposition(db,'r2-a')).toBe('retain');
      sqlite.exec("UPDATE authenticated_email_spool SET next_attempt_at=datetime('now','-1 second')");
    }
  });
  it('quarantines permanent parser failures after one attempt and leaves unknown R2 objects recoverable',async()=>{
    const {db,sqlite,input}=fixture();const started=await beginEmailRecovery(db,input);
    if(started.kind!=='claimed') throw new Error('expected claim');
    await failEmailRecovery(db,started.claim,new Error('email_missing_bank_date'));
    expect(await beginEmailRecovery(db,input)).toEqual({kind:'quarantined'});
    expect(sqlite.prepare('SELECT attempts,cipher FROM authenticated_email_spool').get()).toEqual({attempts:1,cipher:'encrypted-a'});
    expect(await emailR2Disposition(db,'orphan-before-d1-outage')).toBe('process');
  });
  it('fences stale handlers when their expired claim is acquired by another worker',async()=>{
    const {db,sqlite,input}=fixture();const old=await beginEmailRecovery(db,input);
    sqlite.exec("UPDATE authenticated_email_spool SET claim_until=datetime('now','-1 second')");
    const current=await beginEmailRecovery(db,input);
    if(old.kind!=='claimed'||current.kind!=='claimed') throw new Error('expected claims');
    await expect(completeEmailRecovery(db,old.claim)).rejects.toThrow('email_recovery_claim_lost');
    expect(await failEmailRecovery(db,old.claim,new Error('failure'))).toBe(false);
    await completeEmailRecovery(db,current.claim);
  });
});
