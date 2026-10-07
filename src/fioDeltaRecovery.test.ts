import {describe,it,expect,vi,afterEach} from 'vitest';
import {operationsDb} from './operationsTestSupport';
import {withBankPollLease,normalizedBankAccount} from './bankPollLease';
import {recoverFioDelta,type FioDeltaInput} from './fioDeltaRecovery';
import {encryptSecret} from './crypto';
import {mapFioTransaction} from './fio';
import {insertTransaction} from './db';
const env={ENCRYPTION_KEY_VERSION:'1',ENCRYPTION_KEY_V1:btoa('a'.repeat(32))};
afterEach(()=>vi.unstubAllGlobals());
function response(ids=['101'],marker='100',end:string|null='101') {
  return new Response(JSON.stringify({accountStatement:{info:{accountId:'1234',bankId:'2010',currency:'CZK',idLastDownload:marker,idTo:end},
    transactionList:{transaction:ids.map(id=>({column22:{value:id},column0:{value:'2026-10-08'},column1:{value:'10'},column14:{value:'CZK'}}))}}}));
}
async function fixture(initialized=1) {
  const {db,sqlite}=operationsDb();const encrypted=await encryptSecret('synthetic-token',env);
  for(const id of [1,2]) sqlite.prepare(`INSERT INTO bank_accounts(id,account_number,pairing_code,api_token_cipher,api_token_key_ver,api_fetch_enabled,ingest_mode,api_token_hash,api_backfill_done) VALUES(?,'1234/2010',?,?,1,1,'api','hash',1)`).run(id,`fixture-${id}`,encrypted.cipher);
  sqlite.prepare(`INSERT INTO fio_poll_cursors(credential_hash,receiving_account,generation,last_committed_movement_id,last_reported_movement_id,last_batch_ids,bootstrap_from_date,initialized)
    VALUES('hash',?,'generation',?,?,?,date('now','-3 days'),?)`).run(normalizedBankAccount('1234/2010'),initialized?'100':null,initialized?'90':null,initialized?'["100"]':'[]',initialized);
  const aliases=[1,2].map(id=>({id,generation:0,tokenCipher:encrypted.cipher,accountNumber:'1234/2010'}));
  const imports=async(statement:Parameters<FioDeltaInput['importStatement']>[0])=>{
    let inserted=0,skipped=0;
    const mapped=statement.transactions.map(raw=>mapFioTransaction(raw)!);
    for(const alias of aliases) for(const payload of mapped) {
      const result=await insertTransaction(db,{bank_account_id:alias.id,payload});
      if(alias.id===1) {if(result.status==='inserted') inserted++;else skipped++;}
    }
    return {inserted,skipped};
  };
  const run=(importStatement=imports)=>withBankPollLease(db,'1234/2010','synthetic-token',lease=>
    recoverFioDelta(db,{credentialHash:'hash',generation:'generation',token:'synthetic-token',aliases,lease,env,importStatement}));
  const unlock=()=>sqlite.exec("UPDATE bank_poll_leases SET lease_until=datetime('now','-1 second'),next_allowed_at=datetime('now','-1 second')");
  return {db,sqlite,run,imports,unlock};
}
describe('durable Fio delta recovery protocol',()=>{
  it('imports all aliases and commits their freshness with the proven cursor and payload cleanup',async()=>{
    const {sqlite,run}=await fixture();vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response()));
    expect(await run()).toEqual({inserted:1,skipped:0,deferred:false});
    expect(sqlite.prepare('SELECT last_committed_movement_id FROM fio_poll_cursors').get()).toEqual({last_committed_movement_id:'101'});
    expect(sqlite.prepare('SELECT bank_account_id,transaction_id FROM transactions ORDER BY bank_account_id').all()).toEqual([{bank_account_id:1,transaction_id:'101'},{bank_account_id:2,transaction_id:'101'}]);
    expect(sqlite.prepare('SELECT state,cipher,key_version FROM bank_recovery_batches').get()).toEqual({state:'completed',cipher:null,key_version:null});
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM bank_accounts WHERE api_last_success_at IS NOT NULL').get()).toEqual({n:2});
  });
  it('resets a lost response to the last committed ID, then fetches on a separate invocation',async()=>{
    const {sqlite,run,unlock}=await fixture();const fetch=vi.fn().mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce(new Response('')).mockResolvedValueOnce(response());vi.stubGlobal('fetch',fetch);
    await expect(run()).rejects.toThrow('lost response');
    expect(sqlite.prepare('SELECT recovery_stage FROM bank_recovery_batches').get()).toEqual({recovery_stage:'fetching'});
    unlock();expect((await run()).deferred).toBe(true);
    expect(fetch.mock.calls[1]![0]).toContain('/set-last-id/synthetic-token/100/');
    unlock();await run();expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2]![0]).toContain('/last/');
  });
  it('repeats a lost reset without running /last or advancing freshness',async()=>{
    const {sqlite,run,unlock}=await fixture(0);const fetch=vi.fn().mockRejectedValueOnce(new Error('reset timeout')).mockResolvedValueOnce(new Response(''));vi.stubGlobal('fetch',fetch);
    await expect(run()).rejects.toThrow('reset timeout');unlock();expect((await run()).deferred).toBe(true);
    expect(fetch.mock.calls[0]![0]).toContain('/set-last-date/');expect(fetch.mock.calls[0]![0]).toBe(fetch.mock.calls[1]![0]);
    expect(sqlite.prepare('SELECT last_success_at FROM fio_poll_cursors').get()).toEqual({last_success_at:null});
  });
  it('finishes a partially imported spool without another bank request',async()=>{
    const {db,sqlite,run,imports,unlock}=await fixture();const fetch=vi.fn().mockResolvedValue(response());vi.stubGlobal('fetch',fetch);
    await expect(run(async statement=>{
      await insertTransaction(db,{bank_account_id:1,payload:mapFioTransaction(statement.transactions[0]!)!});throw new Error('D1 outage');
    })).rejects.toThrow('D1 outage');
    unlock();expect(await run(imports)).toEqual({inserted:0,skipped:1,deferred:false});expect(fetch).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toEqual({n:2});
  });
  it('fences the whole completion transaction when one alias rotates during import',async()=>{
    const {sqlite,run,imports}=await fixture();vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response()));
    await expect(run(async statement=>{const imported=await imports(statement);sqlite.exec('UPDATE bank_accounts SET api_credential_generation=1 WHERE id=2');return imported;})).rejects.toThrow('bank_poll_lease_lost');
    expect(sqlite.prepare('SELECT last_committed_movement_id FROM fio_poll_cursors').get()).toEqual({last_committed_movement_id:'100'});
    expect(sqlite.prepare('SELECT state,cipher IS NOT NULL AS has_payload FROM bank_recovery_batches').get()).toEqual({state:'spooled',has_payload:1});
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM bank_accounts WHERE api_last_success_at IS NOT NULL').get()).toEqual({n:0});
  });
  it('preserves a drift response and starts recovery from the locally proven prefix',async()=>{
    const {sqlite,run,unlock}=await fixture();const fetch=vi.fn().mockResolvedValueOnce(response(['201'],'200','201')).mockResolvedValueOnce(new Response(''));vi.stubGlobal('fetch',fetch);
    await expect(run()).rejects.toThrow('fio_cursor_drift');
    expect(sqlite.prepare('SELECT recovery_stage,cipher IS NOT NULL AS has_payload FROM bank_recovery_batches').get()).toEqual({recovery_stage:'quarantined',has_payload:1});
    unlock();expect((await run()).deferred).toBe(true);expect(fetch.mock.calls[1]![0]).toContain('/set-last-id/synthetic-token/100/');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toEqual({n:0});
  });
});
