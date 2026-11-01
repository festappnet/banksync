import {afterEach,describe,expect,it,vi} from 'vitest';
import {bankFailureDiagnostic} from './bankFailure';
import {fetchFioDelta,fetchFioStatement} from './fio';
import {operationsDb} from './operationsTestSupport';
import {markBankAccountApiFetchFailure,findBankAccountById} from './db';
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('safe bank failure metadata',()=>{
  it.each([null, [], {}, {accountStatement:[]}, {accountStatement:{info:null}}, {accountStatement:{info:[]}}])('diagnoses malformed statement shape without exposing its content: %j',async document=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(document))));
    const error=await fetchFioDelta('private-token').catch(error=>error);
    expect(bankFailureDiagnostic(error)).toMatchObject({code:'missing_statement_info',stage:'response_decode',operation:'transactions',transport:'direct',http_status:200});
    expect(JSON.stringify(bankFailureDiagnostic(error))).not.toContain('private-token');
  });
  it('identifies invalid JSON separately without copying its body or parser exception',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('<html>private-bank-data</html>')));
    const error=await fetchFioStatement('private-token','2026-10-31','2026-11-01',{url:'https://relay.invalid',secret:'private-secret'}).catch(error=>error);
    const diagnostic=bankFailureDiagnostic(error);
    expect(diagnostic).toMatchObject({code:'invalid_statement_json',operation:'periods',transport:'proxy'});
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|html|relay.invalid/);
  });
  it('does not misdiagnose an internal TypeError as a transport failure',()=>{
    expect(bankFailureDiagnostic(new TypeError('private internal value'))).toMatchObject({stage:'bank_sync',code:'bank_sync_internal_error'});
  });
  it.each(['TypeError','TimeoutError','AbortError'])('records actual request %s failures at the transport boundary',async name=>{
    const cause=new Error('private endpoint and token');cause.name=name;
    vi.stubGlobal('fetch',vi.fn(async()=>{throw cause;}));
    const error=await fetchFioDelta('private-token',{url:'https://relay.invalid',secret:'private-secret'}).catch(error=>error);
    const diagnostic=bankFailureDiagnostic(error);
    expect(diagnostic).toMatchObject({stage:'transport',code:name,operation:'transactions',transport:'proxy'});
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|relay.invalid/);
  });
  it('distinguishes an interrupted response body from invalid JSON',async()=>{
    const body=new ReadableStream({start(controller){controller.error(new DOMException('private body interruption','AbortError'));}});
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(body)));
    const error=await fetchFioDelta('private-token').catch(error=>error);
    expect(bankFailureDiagnostic(error)).toMatchObject({stage:'transport',code:'AbortError',operation:'transactions',transport:'direct',http_status:200});
  });
  it('reads health and historical failure together from one account snapshot',async()=>{
    const {db,sqlite}=operationsDb(15);
    sqlite.exec("INSERT INTO bank_accounts(id,account_number,pairing_code) VALUES(1,'1234/2010','fixture')");
    await markBankAccountApiFetchFailure(db,1,'bank_sync_internal_error',new Error('private'));
    const prepare=vi.spyOn(db,'prepare');
    const account=await findBankAccountById(db,1);
    const accountReads=prepare.mock.calls.filter(([sql])=>sql.includes('FROM bank_accounts'));
    expect(accountReads).toHaveLength(1);
    expect(accountReads[0]?.[0]).toContain('api_last_error');
    expect(accountReads[0]?.[0]).toContain('api_last_failure');
    expect(account?.api_last_failure?.code).toBe('bank_sync_internal_error');
  });
  it('redacts unknown exception text and keeps schema 14 consumers operational',async()=>{
    const {db,sqlite}=operationsDb(14);
    sqlite.exec("INSERT INTO bank_accounts(id,account_number,pairing_code) VALUES(1,'1234/2010','fixture')");
    const error=new Error('private-token-and-bank-payload');
    expect(bankFailureDiagnostic(error).code).toBe('bank_sync_internal_error');
    expect(JSON.stringify(bankFailureDiagnostic(error))).not.toContain('private');
    await markBankAccountApiFetchFailure(db,1,'bank_sync_internal_error',error);
    expect((await findBankAccountById(db,1))?.api_last_error).toBe('bank_sync_internal_error');
    expect((await findBankAccountById(db,1))?.api_last_failure).toBeUndefined();
  });
});
