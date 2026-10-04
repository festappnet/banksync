import {describe,it,expect,vi,afterEach} from 'vitest';
import Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {D1Database,D1Result,D1PreparedStatement} from '@cloudflare/workers-types';
import {createBankAccount,createConsumer,createSubscription,findBankAccountApiMaterials,insertTransaction,pruneRetention} from './db';
import {mapFioTransaction} from './fio';
import {encryptSecret} from './crypto';
import {recoverBankAccount} from './bankRecovery';
import {ensureDeliveryJobs} from './webhookDelivery';
import {buildWebhookEnvelope,signWebhook,verifyWebhook} from './relay';
import {decimalToCents} from './normalize';
const env={ENCRYPTION_KEY_VERSION:'1',ENCRYPTION_KEY_V1:btoa('a'.repeat(32))};
afterEach(()=>vi.unstubAllGlobals());
function wrapAsD1(sqlite: Database.Database): D1Database {
  function prepare(sql: string): D1PreparedStatement {
    let boundArgs: unknown[] = [];

    const stmt = {
      bind(...args: unknown[]): D1PreparedStatement {
        boundArgs = args.map(a => a === undefined ? null : a);
        return stmt;
      },

      async first<T = Record<string, unknown>>(): Promise<T | null> {
        const s = sqlite.prepare(sql);
        const row = s.get(...(boundArgs as Parameters<typeof s.get>)) as T | undefined;
        return row ?? null;
      },

      async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const s = sqlite.prepare(sql);
        const results = s.all(...(boundArgs as Parameters<typeof s.all>)) as T[];
        return {
          results,
          success: true,
          meta: { changes: 0, last_row_id: 0, duration: 0, size_after: 0, rows_read: results.length, rows_written: 0, changed_db: false },
        };
      },

      async run(): Promise<D1Result<Record<string, unknown>>> {
        const s = sqlite.prepare(sql);
        const info = s.run(...(boundArgs as Parameters<typeof s.run>));
        return {
          results: [],
          success: true,
          meta: {
            changes: info.changes,
            last_row_id: Number(info.lastInsertRowid),
            duration: 0,
            size_after: 0,
            rows_read: 0,
            rows_written: info.changes,
            changed_db: info.changes > 0,
          },
        };
      },
    } as unknown as D1PreparedStatement;

    return stmt;
  }

  return { prepare, async batch(statements: D1PreparedStatement[]) { return Promise.all(sqlite.transaction(() => statements.map(statement=>statement.run()))()); } } as unknown as D1Database;
}

const MIGRATIONS = ['0001_schema.sql','0011_complete_bank_facts.sql'];

function applyMigrations(sqlite: Database.Database): void {
  for (const m of MIGRATIONS) {
    const p = resolve(__dirname, '../migrations', m);
    sqlite.exec(readFileSync(p, 'utf8'));
  }
}

function makeTestDb(): D1Database {
  const sqlite = new Database(':memory:');
  applyMigrations(sqlite);
  return wrapAsD1(sqlite);
}

function makeTestDbWithSqlite(): { db: D1Database; sqlite: Database.Database } {
  const sqlite = new Database(':memory:');
  applyMigrations(sqlite);
  return { db: wrapAsD1(sqlite), sqlite };
}


const raw=(id='101',amount='10.07')=>({column0:{value:'2026-10-04'},column1:{value:amount},column14:{value:'EUR'},column5:{value:null},column17:{value:'777'},column22:{value:id},column27:{value:'RF471234567890'}});
async function setup() {
  const {db,sqlite}=makeTestDbWithSqlite();
  const token=await encryptSecret('synthetic-fixture-token',env);
  const account=await createBankAccount(db,{account_number:'1234/2010',pairing_code:'0123456789',account_type:'FIO',ingest_mode:'api',api_token_cipher:token.cipher,api_token_key_ver:token.keyVersion,api_fetch_enabled:true});
  return {db,sqlite,account:(await findBankAccountApiMaterials(db,account.id))!};
}
function statement(rows=[raw()]) {return new Response(JSON.stringify({accountStatement:{info:{accountId:'1234',bankId:'2010',currency:'EUR'},transactionList:{transaction:rows}}}));}
function unlock(sqlite:Database.Database) {sqlite.exec("UPDATE bank_poll_leases SET next_allowed_at=datetime('now','-31 seconds'),lease_until=datetime('now','-31 seconds')");}
describe('complete BankSync facts and recovery',()=>{
  it('keeps distinct movements, signed totals, RF, command and raw VS',async()=>{
    const {db,sqlite,account}=await setup();
    for(const row of [raw('101'),raw('102'),raw('103','-10.07'),raw('104','0')]) await insertTransaction(db,{bank_account_id:account.id,payload:mapFioTransaction(row)!});
    expect(sqlite.prepare('SELECT count(*) AS n,sum(amount_cents) AS total FROM transactions').get()).toEqual({n:4,total:1007});
    expect(sqlite.prepare('SELECT transaction_id,command_id,payer_reference,raw_vs FROM transactions WHERE id=1').get()).toEqual({transaction_id:'101',command_id:'777',payer_reference:'RF471234567890',raw_vs:null});
  });
  it('does not silently acknowledge changed facts for the same movement',async()=>{
    const {db,account}=await setup();
    await insertTransaction(db,{bank_account_id:account.id,payload:mapFioTransaction(raw())!});
    await expect(insertTransaction(db,{bank_account_id:account.id,payload:mapFioTransaction(raw('101','10.08'))!})).rejects.toThrow('bank_movement_fact_conflict');
  });
  it('recovers old encrypted spool after partial insertion without another bank fetch',async()=>{
    const {db,sqlite,account}=await setup();
    const fetch=vi.fn().mockResolvedValue(statement([raw(),raw('102')]));vi.stubGlobal('fetch',fetch);
    const prepare=db.prepare.bind(db);let inserts=0;
    db.prepare=((sql:string)=>{if(sql.includes('INSERT OR IGNORE INTO transactions') && ++inserts===2) throw new Error('disk_failure'); return prepare(sql);}) as typeof db.prepare;
    await expect(recoverBankAccount(db,account,env)).rejects.toThrow('disk_failure');
    expect(sqlite.prepare("SELECT state FROM bank_recovery_batches").get()).toEqual({state:'spooled'});
    sqlite.exec("UPDATE bank_accounts SET api_reconciled_through=date('now','-120 days')");
    unlock(sqlite);db.prepare=prepare;
    expect(await recoverBankAccount(db,account,env)).toEqual({inserted:1,skipped:1});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare('SELECT count(*) AS n FROM transactions').get()).toEqual({n:2});
  });
  it('recovers a lost bank response using the same durable window without /last',async()=>{
    const {db,sqlite,account}=await setup();
    const fetch=vi.fn().mockRejectedValueOnce(new Error('crash_after_bank_response')).mockResolvedValueOnce(statement());vi.stubGlobal('fetch',fetch);
    await expect(recoverBankAccount(db,account,env)).rejects.toThrow();unlock(sqlite);
    await recoverBankAccount(db,account,env);
    expect(fetch.mock.calls[0]![0]).toEqual(fetch.mock.calls[1]![0]);
    expect(fetch.mock.calls[0]![0]).toContain('/periods/');
  });
  it('shares an atomic polling lock between manual and scheduled callers',async()=>{
    const {db,sqlite,account}=await setup();let release!:(value:Response)=>void;
    vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>release=resolve)));
    const first=recoverBankAccount(db,account,env);
    await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    await expect(recoverBankAccount(db,account,env)).rejects.toThrow('bank_poll_busy');
    release(statement());await first;
    expect(sqlite.prepare('SELECT count(*) AS n FROM transactions').get()).toEqual({n:1});
  });
  it('rejects a wrong-account snapshot and recovers after the token/account is corrected',async()=>{
    const {db,sqlite,account}=await setup();
    const fetch=vi.fn().mockImplementation(()=>statement());vi.stubGlobal('fetch',fetch);
    await expect(recoverBankAccount(db,{...account,account_number:'9999/2010'},env))
      .rejects.toMatchObject({code:'fio_receiving_account_mismatch',expectedAccount:'9999/2010',receivedAccount:'1234/2010'});
    expect(sqlite.prepare('SELECT count(*) AS n FROM transactions').get()).toEqual({n:0});
    expect(sqlite.prepare('SELECT state,cipher,key_version FROM bank_recovery_batches').get()).toEqual({state:'fetching',cipher:null,key_version:null});
    unlock(sqlite);
    expect(await recoverBankAccount(db,account,env)).toEqual({inserted:1,skipped:0});
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('delivers all directions to v2 and only unchanged incoming shape to v1',async()=>{
    const {db,sqlite,account}=await setup();
    for(const [app,version] of [['dating','1'],['festapp','2']] as const) {
      await createConsumer(db,{app_id:app,event_version:version,callback_url:'https://example.com',secret_cipher:'x',secret_hash:'x',secret_prefix:'x'});
      await createSubscription(db,{app_id:app,bank_account_id:account.id});
    }
    for(const row of [raw(),raw('102','-1'),raw('103','0')]) await insertTransaction(db,{bank_account_id:account.id,payload:mapFioTransaction(row)!});
    expect(await ensureDeliveryJobs(db)).toBe(4);
    const jobs=sqlite.prepare('SELECT consumer_app_id,payload FROM webhook_delivery_jobs').all() as {consumer_app_id:string;payload:string}[];
    const v1=JSON.parse(jobs.find(job=>job.consumer_app_id==='dating')!.payload);
    expect(v1.event_version).toBe('1');expect(v1.data).not.toHaveProperty('direction');expect(v1.data).not.toHaveProperty('created_at');
    for(const job of jobs.filter(job=>job.consumer_app_id==='festapp')) {
      const event=JSON.parse(job.payload);const signed=await signWebhook({envelope:event,secret:'synthetic'});
      expect(await verifyWebhook({secret:'synthetic',timestamp:signed.headers['X-BankSync-Timestamp'],deliveryId:event.delivery_id,signature:signed.headers['X-BankSync-Signature'],bodyBytes:signed.bodyBytes,eventVersion:'2'})).toEqual(event);
      await expect(verifyWebhook({secret:'synthetic',timestamp:signed.headers['X-BankSync-Timestamp'],deliveryId:event.delivery_id,signature:signed.headers['X-BankSync-Signature'],bodyBytes:signed.bodyBytes})).rejects.toThrow('event_version_unsupported');
    }
  });
  it('keeps unresolved terminal facts beyond retention',async()=>{
    const {db,sqlite,account}=await setup();
    await createConsumer(db,{app_id:'festapp',event_version:'2',callback_url:'https://example.com',secret_cipher:'x',secret_hash:'x',secret_prefix:'x'});
    await createSubscription(db,{app_id:'festapp',bank_account_id:account.id});
    await insertTransaction(db,{bank_account_id:account.id,payload:mapFioTransaction(raw())!});await ensureDeliveryJobs(db);
    sqlite.exec("UPDATE transactions SET created_at=datetime('now','-100 days'); UPDATE webhook_delivery_jobs SET status='terminal'");
    await pruneRetention(db);expect(sqlite.prepare('SELECT count(*) AS n FROM transactions').get()).toEqual({n:1});
  });
  it('rejects rounded identity, missing date, excessive precision and unsafe amounts',()=>{
    expect(()=>mapFioTransaction({...raw(),column22:{value:9007199254740992}})).toThrow('unsafe_fio_identity');
    expect(()=>mapFioTransaction({...raw(),column0:undefined})).toThrow('missing_fio_date');
    expect(()=>decimalToCents('1.001','EUR')).toThrow();expect(()=>decimalToCents('90071992547409.92','EUR')).toThrow();
    expect(decimalToCents('1.01','EUR')).toBe(101);expect(decimalToCents('-0.01','CZK')).toBe(-1);
  });
});
