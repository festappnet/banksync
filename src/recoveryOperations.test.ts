import {describe,it,expect,vi,afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {operationsDb} from './operationsTestSupport';
import {assertSchemaVersion,pruneCompletedRecovery} from './db';
import {fetchFioDelta,fioMovementId,setFioPointerById} from './fio';
import {buildSqlDump,TABLES,BACKUP_EXCLUDED} from './backup';

afterEach(()=>vi.unstubAllGlobals());

describe('recovery operations schema and retention',()=>{
  it('upgrades existing pending evidence without changing facts or delivery payloads',async()=>{
    const {db,sqlite}=operationsDb(12);
    sqlite.exec("INSERT INTO bank_accounts(id,account_number,pairing_code) VALUES(1,'1234/2010','fixture'); INSERT INTO authenticated_email_spool(id,bank_account_id,body_sha256,cipher,key_version,attempts) VALUES('old',1,'digest','encrypted',1,901)");
    sqlite.exec(readFileSync(resolve(__dirname,'../migrations/0013_recovery_operations.sql'),'utf8'));
    await expect(assertSchemaVersion(db)).resolves.toBeUndefined();
    expect(sqlite.prepare('SELECT id,message_key,cipher,state,attempts FROM authenticated_email_spool').get()).toEqual({id:'old',message_key:'old',cipher:'encrypted',state:'pending',attempts:901});
    expect(()=>sqlite.exec("UPDATE authenticated_email_spool SET cipher=NULL WHERE id='old'")).toThrow();
  });

  it('uses the partial index with 30000 completed batches and orders only open batches',()=>{
    const {sqlite}=operationsDb();
    sqlite.exec("INSERT INTO bank_accounts(id,account_number,pairing_code) VALUES(1,'1234/2010','fixture')");
    const insert=sqlite.prepare("INSERT INTO bank_recovery_batches(id,bank_account_id,from_date,to_date,state,created_at) VALUES(?,1,'2026-10-01','2026-10-02',?,?)");
    sqlite.transaction(()=>{for(let i=0;i<30000;i++)insert.run(`done-${i}`,'completed','2026-10-01');insert.run('later','fetching','2026-10-03');insert.run('earlier','spooled','2026-10-02');})();
    const sql="SELECT id FROM bank_recovery_batches WHERE bank_account_id=? AND state<>'completed' ORDER BY created_at,id LIMIT 1";
    const plan=JSON.stringify(sqlite.prepare('EXPLAIN QUERY PLAN '+sql).all(1));
    expect(plan).toContain('idx_bank_recovery_open');expect(plan).not.toMatch(/SCAN bank_recovery_batches|TEMP B-TREE/);
    expect(sqlite.prepare(sql).get(1)).toEqual({id:'earlier'});
  });

  it('clears completed payloads, retains recent metadata and preserves pending and quarantine',async()=>{
    const {db,sqlite}=operationsDb();
    sqlite.exec(`INSERT INTO bank_accounts(id,account_number,pairing_code) VALUES(1,'1234/2010','fixture');
      INSERT INTO bank_recovery_batches(id,bank_account_id,from_date,to_date,state,cipher,key_version,completed_at) VALUES
      ('pending',1,'2026-10-01','2026-10-02','spooled','pending-bytes',1,NULL),
      ('recent',1,'2026-10-01','2026-10-02','completed','recent-bytes',1,datetime('now')),
      ('old',1,'2026-10-01','2026-10-02','completed','old-bytes',1,datetime('now','-8 days'));
      INSERT INTO authenticated_email_spool(id,bank_account_id,message_key,body_sha256,cipher,key_version,state,completed_at) VALUES
      ('pending',1,'pending','a','pending-bytes',1,'pending',NULL),
      ('quarantine',1,'original','b','conflicting-bytes',1,'quarantined',NULL),
      ('original',1,'original','c','original-bytes',1,'completed',datetime('now','-8 days')),
      ('old',1,'old','d','old-bytes',1,'completed',datetime('now','-8 days'));`);
    await pruneCompletedRecovery(db);
    expect(sqlite.prepare('SELECT id,cipher FROM bank_recovery_batches ORDER BY id').all()).toEqual([{id:'pending',cipher:'pending-bytes'},{id:'recent',cipher:null}]);
    expect(sqlite.prepare('SELECT id,cipher FROM authenticated_email_spool ORDER BY id').all()).toEqual([{id:'original',cipher:null},{id:'pending',cipher:'pending-bytes'},{id:'quarantine',cipher:'conflicting-bytes'}]);
    expect(await pruneCompletedRecovery(db)).toEqual({recovery_payloads_cleared:0,recovery_batches_deleted:0,email_payloads_cleared:0,email_spool_deleted:0});
  });

  it('caps historical cleanup at 500 rows per invocation',async()=>{
    const {db,sqlite}=operationsDb();
    sqlite.exec("INSERT INTO bank_accounts(id,account_number,pairing_code) VALUES(1,'1234/2010','fixture')");
    const insert=sqlite.prepare("INSERT INTO bank_recovery_batches(id,bank_account_id,from_date,to_date,state,cipher,key_version,completed_at) VALUES(?,1,'2026-10-01','2026-10-02','completed','cipher',1,datetime('now'))");
    sqlite.transaction(()=>{for(let i=0;i<510;i++)insert.run(String(i));})();
    expect((await pruneCompletedRecovery(db)).recovery_payloads_cleared).toBe(500);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM bank_recovery_batches WHERE cipher IS NOT NULL').get()).toEqual({n:10});
  });

  it('backs up and restores the complete schema including bank cursors',async()=>{
    const {db,sqlite}=operationsDb();
    sqlite.exec("INSERT INTO fio_poll_cursors(credential_hash,receiving_account,generation,bootstrap_from_date,last_committed_movement_id) VALUES('credential','CZ-fixture','generation','2026-10-01','9007199254740993')");
    const tables=sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[];
    expect(tables.filter(t=>!TABLES.includes(t.name)&&!BACKUP_EXCLUDED[t.name])).toEqual([]);
    const dump=await buildSqlDump(db),restored=operationsDb();restored.sqlite.exec(dump.sql);
    expect(restored.sqlite.prepare('SELECT last_committed_movement_id FROM fio_poll_cursors').get()).toEqual({last_committed_movement_id:'9007199254740993'});
  });
});

describe('Fio cursor client',()=>{
  it('retains the cursor/account header and handles singleton and empty deltas',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({accountStatement:{info:{accountId:'1234',idLastDownload:101},transactionList:{transaction:{column22:{value:102}}}}}))).mockResolvedValueOnce(new Response(JSON.stringify({accountStatement:{info:{accountId:'1234',idLastDownload:102},transactionList:null}}))));
    expect(await fetchFioDelta('synthetic')).toEqual({info:{accountId:'1234',idLastDownload:101},transactions:[{column22:{value:102}}]});
    expect((await fetchFioDelta('synthetic')).transactions).toEqual([]);
  });
  it('rejects a delta without a receiving-account header',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({accountStatement:{transactionList:null}}))));
    await expect(fetchFioDelta('synthetic')).rejects.toThrow('missing_statement_info');
  });
  it('uses movement ID text in the proxy and rejects rounded or malformed identities',async()=>{
    const fetch=vi.fn().mockResolvedValue(new Response(''));vi.stubGlobal('fetch',fetch);
    await setFioPointerById('synthetic','9007199254740993',{url:'https://proxy.example',secret:'synthetic'});
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({op:'set-last-id',token:'synthetic',id:'9007199254740993'});
    expect(()=>fioMovementId(9007199254740992)).toThrow('unsafe_fio_identity');
    await expect(setFioPointerById('synthetic','1/other')).rejects.toThrow('invalid_fio_movement_id');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
