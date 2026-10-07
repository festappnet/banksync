import {describe,it,expect,vi,afterEach} from 'vitest';
import {operationsDb} from './operationsTestSupport';
import {recoverFioAccount} from './fioRecovery';
import {encryptSecret} from './crypto';
import {findBankAccountApiMaterials,setBankAccountApiToken} from './db';
const env={ENCRYPTION_KEY_VERSION:'1',ENCRYPTION_KEY_V1:btoa('a'.repeat(32))};
afterEach(()=>vi.unstubAllGlobals());
function response(ids=['101'],marker:string|null=null,end:string|null='101') {
  return new Response(JSON.stringify({accountStatement:{info:{accountId:'1234',bankId:'2010',currency:'CZK',idLastDownload:marker,idTo:end},
    transactionList:{transaction:ids.map(id=>({column22:{value:id},column0:{value:'2026-10-08'},column1:{value:'10'},column14:{value:'CZK'}}))}}}));
}
async function fixture() {
  const {db,sqlite}=operationsDb();const token=await encryptSecret('synthetic-token',env);
  for(const id of [1,2]) sqlite.prepare(`INSERT INTO bank_accounts(id,account_number,pairing_code,api_token_cipher,api_token_key_ver,api_fetch_enabled,ingest_mode)
    VALUES(?,'1234/2010',?,?,1,1,'api')`).run(id,`fixture-${id}`,token.cipher);
  const run=async(id=1)=>recoverFioAccount(db,(await findBankAccountApiMaterials(db,id))!,env);
  const unlock=()=>sqlite.exec("UPDATE bank_poll_leases SET lease_until=datetime('now','-1 second'),next_allowed_at=datetime('now','-1 second')");
  return {db,sqlite,run,unlock};
}
describe('canonical credential-wide Fio polling',()=>{
  it('bootstraps once, resets once, then uses only /last and fans out to both legacy NULL-hash aliases',async()=>{
    const {sqlite,run,unlock}=await fixture();const fetch=vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(new Response(''))
      .mockResolvedValueOnce(response()).mockResolvedValueOnce(response(['102'],'101','102'));vi.stubGlobal('fetch',fetch);
    expect(await run()).toEqual({inserted:1,skipped:0,deferred:true});unlock();expect((await run(2)).deferred).toBe(true);
    unlock();expect(await run()).toEqual({inserted:0,skipped:1,deferred:false});unlock();expect(await run(2)).toEqual({inserted:1,skipped:0,deferred:false});
    expect(fetch.mock.calls.map(call=>String(call[0]).split('/rest/')[1]?.split('/')[0])).toEqual(['periods','set-last-date','last','last']);
    expect(sqlite.prepare('SELECT COUNT(DISTINCT api_token_hash) AS n FROM bank_accounts').get()).toEqual({n:1});
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toEqual({n:4});
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM fio_poll_cursors').get()).toEqual({n:1});
  });
  it('uses the existing verified checkpoint for cutover instead of replaying 90 days again',async()=>{
    const {sqlite,run}=await fixture();sqlite.exec("UPDATE bank_accounts SET api_backfill_done=1,api_reconciled_through=date('now')");
    const fetch=vi.fn().mockResolvedValue(response());vi.stubGlobal('fetch',fetch);await run();
    const expected=new Date(Date.parse(new Date().toISOString().slice(0,10))-3*86400000).toISOString().slice(0,10);
    expect(fetch.mock.calls[0]![0]).toContain(`/periods/synthetic-token/${expected}/`);
    expect(sqlite.prepare('SELECT bootstrap_from_date FROM fio_poll_cursors').get()).toEqual({bootstrap_from_date:expected});
  });
  it('performs the daily periods check independently of the confirmed delta cursor',async()=>{
    const {sqlite,run,unlock}=await fixture();const fetch=vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(new Response('')).mockResolvedValueOnce(response()).mockResolvedValueOnce(response(['101','102'],null,'102'));vi.stubGlobal('fetch',fetch);
    await run();unlock();await run();unlock();await run();
    sqlite.exec("UPDATE bank_accounts SET api_reconciled_through=date('now','-1 day')");unlock();await run();
    expect(fetch.mock.calls[3]![0]).toContain('/periods/');
    expect(sqlite.prepare('SELECT last_committed_movement_id FROM fio_poll_cursors').get()).toEqual({last_committed_movement_id:'101'});
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toEqual({n:4});
  });
  it('rejects a wrong physical alias before any bank cursor request',async()=>{
    const {sqlite,run,unlock}=await fixture();const fetch=vi.fn().mockResolvedValue(response());vi.stubGlobal('fetch',fetch);await run();
    sqlite.exec("UPDATE bank_accounts SET account_number='9999/2010' WHERE id=2");unlock();
    await expect(run(2)).rejects.toMatchObject({code:'fio_receiving_account_mismatch'});expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps wrong-bootstrap evidence but allows the correct alias to establish ownership',async()=>{
    const {sqlite,run,unlock}=await fixture();sqlite.exec("UPDATE bank_accounts SET account_number='9999/2010' WHERE id=2");
    const fetch=vi.fn().mockImplementation(()=>Promise.resolve(response()));vi.stubGlobal('fetch',fetch);
    await expect(run(2)).rejects.toMatchObject({code:'fio_receiving_account_mismatch'});unlock();await run(1);
    expect(sqlite.prepare('SELECT recovery_stage,cipher IS NOT NULL AS evidence FROM bank_recovery_batches ORDER BY created_at,id').all()).toEqual(expect.arrayContaining([{recovery_stage:'quarantined',evidence:1},{recovery_stage:'completed',evidence:0}]));
    expect(sqlite.prepare('SELECT DISTINCT bank_account_id FROM transactions').all()).toEqual([{bank_account_id:1}]);
  });
  it('backfills a newly activated alias before it joins an advanced shared cursor',async()=>{
    const {sqlite,run,unlock}=await fixture();sqlite.exec('UPDATE bank_accounts SET ingest_enabled=0 WHERE id=2');
    const fetch=vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(new Response('')).mockResolvedValueOnce(response()).mockResolvedValueOnce(response(['101','102']));vi.stubGlobal('fetch',fetch);
    await run();unlock();await run();unlock();await run();
    sqlite.exec('UPDATE bank_accounts SET ingest_enabled=1,api_credential_generation=1 WHERE id=2');unlock();await run(2);
    expect(fetch.mock.calls[3]![0]).toContain('/periods/');
    expect(sqlite.prepare('SELECT transaction_id FROM transactions WHERE bank_account_id=2 ORDER BY transaction_id').all()).toEqual([{transaction_id:'101'},{transaction_id:'102'}]);
    expect(sqlite.prepare('SELECT last_committed_movement_id FROM fio_poll_cursors').get()).toEqual({last_committed_movement_id:'101'});
  });
  it('recovers a same-token rotation from the proven checkpoint and retains lost old-generation intent',async()=>{
    const {db,sqlite,run,unlock}=await fixture();const fetch=vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(new Response('')).mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error('lost delta')).mockResolvedValueOnce(new Response(''));vi.stubGlobal('fetch',fetch);
    await run();unlock();await run();unlock();await run();unlock();await expect(run()).rejects.toThrow('lost delta');
    const encrypted=await encryptSecret('synthetic-token',env);const hash=sqlite.prepare('SELECT api_token_hash FROM bank_accounts WHERE id=1').get() as {api_token_hash:string};
    await setBankAccountApiToken(db,1,{token_cipher:encrypted.cipher,token_key_ver:1,token_prefix:'fixture',token_hash:hash.api_token_hash,fetch_enabled:true});
    unlock();expect((await run()).deferred).toBe(true);expect(fetch.mock.calls[4]![0]).toContain('/set-last-id/synthetic-token/101/');
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM bank_recovery_batches WHERE recovery_stage='quarantined'").get()).toEqual({n:1});
  });
  it('atomically fences the actual ledger insertion when identity changes after the preflight check',async()=>{
    const {db,sqlite,run}=await fixture();const prepare=db.prepare.bind(db);
    db.prepare=((sql:string)=>{if(sql.includes('INSERT OR IGNORE INTO transactions')) sqlite.exec("UPDATE bank_accounts SET account_number='9999/2010' WHERE id=1");return prepare(sql);}) as typeof db.prepare;
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response()));
    await expect(run()).rejects.toThrow('bank_poll_lease_lost');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toEqual({n:0});
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM fio_poll_cursors').get()).toEqual({n:0});
    expect(sqlite.prepare('SELECT state,cipher IS NOT NULL AS evidence FROM bank_recovery_batches').get()).toEqual({state:'spooled',evidence:1});
  });
  it('refuses to silently truncate a long unresolved reconciliation gap',async()=>{
    const {sqlite,run}=await fixture();sqlite.exec("UPDATE bank_accounts SET api_backfill_done=1,api_reconciled_through=date('now','-100 days')");
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await expect(run()).rejects.toThrow('recovery_window_requires_bank_unlock');expect(fetch).not.toHaveBeenCalled();
  });
});
