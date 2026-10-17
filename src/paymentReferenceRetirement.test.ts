import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import type {ExecutionContext,Queue} from '@cloudflare/workers-types';
import worker,{type Env} from './cloudflare';
import {operationsDb} from './operationsTestSupport';
import {hashKey} from './auth';
import {recordIdempotency,sha256Hex} from './idempotency';
import {insertTransaction,assertSchemaVersion} from './db';
import {canonicalIban} from './bankAccountIdentity';
import {buildSqlDump} from './backup';
import type {Transaction} from './types';
const ctx={waitUntil(){},passThroughOnException(){}} as unknown as ExecutionContext;
function environment(db:Env['DB']):Env{return {DB:db,ADMIN_SECRET:'local-admin',WEBHOOK_KEK:btoa('a'.repeat(32)),SENDER_ALLOWLIST:'',WEBHOOK_QUEUE:{send:async()=>{}} as unknown as Queue};}
const payload:Omit<Transaction,'id'|'bank_account_id'>={amount_cents:10000,currency:'CZK',counter_account:null,bank_code:null,bank_name:null,vs:'000123',ks:null,ss:null,message:null,sender_name:null,user_identification:null,transaction_type:null,performed_by:null,comment:null,command_id:null,source:'fio_api',date:'2026-10-18',date_offset_min:null,transaction_id:'one',external_id:null};
describe('issuance-free bank service',()=>{
 it('normalizes receiving identity without an allocation registry',()=>{
  expect(canonicalIban('19-2000145399/0800')).toBe('CZ6508000000192000145399');
  expect(()=>canonicalIban('CZ0008000000192000145399')).toThrow('invalid_iban');
 });
 it('retires every allocator method even behind a cached success/in-flight response',async()=>{
  const {db,sqlite}=operationsDb(13),env=environment(db);
  for(const suffix of ['payment-references','payment-reference-admin'])for(const oldStatus of [0,201,409]){
   const path=`/bank-accounts/1/${suffix}`,key=`cache-${suffix}-${oldStatus}`,body='{}';
   await recordIdempotency({db,keyHash:await sha256Hex(`admin\nPOST\n${path}\n${key}`),authPrincipal:'admin',requestPath:path,requestMethod:'POST',requestBodyHash:await sha256Hex(body),responseStatus:oldStatus,responseBody:'{"reservation_id":"old"}'});
   const response=await worker.fetch(new Request('https://local'+path,{method:'POST',headers:{'X-Admin-Secret':env.ADMIN_SECRET,'Idempotency-Key':key,'Content-Type':'application/json'},body}),env,ctx);
   expect(response.status).toBe(410);expect(await response.json()).toEqual({error:'endpoint_retired'});
  }
  for(const method of ['GET','PUT','DELETE'])expect((await worker.fetch(new Request('https://local/bank-accounts/1/payment-references',{method,headers:{'X-Admin-Secret':env.ADMIN_SECRET}}),env,ctx)).status).toBe(410);
  expect(sqlite.prepare('SELECT count(*) n FROM payment_references').get()).toEqual({n:0});
 });
 it('imports duplicate/unregistered/absent VS independently of locked registry state on 13 and 14',async()=>{
  for(const version of [13,14]){
   const {db,sqlite}=operationsDb(version);await assertSchemaVersion(db);
   sqlite.exec("INSERT INTO bank_accounts(id,account_number,pairing_code) VALUES(1,'1234/2010','local')");
   for(const [n,vs] of ['000123','000123',null].entries())expect((await insertTransaction(db,{bank_account_id:1,payload:{...payload,transaction_id:String(n),vs,raw_vs:vs}})).status).toBe('inserted');
   expect(sqlite.prepare('SELECT raw_vs FROM transactions ORDER BY id').all()).toEqual([{raw_vs:'000123'},{raw_vs:'000123'},{raw_vs:null}]);
   expect(sqlite.prepare('SELECT count(*) n FROM physical_accounts').get()).toEqual({n:0});
  }
 });
 it('keeps account-health authorized and independent of all retired registry tables',async()=>{
  const {db,sqlite}=operationsDb(14),env=environment(db),key='bksk_local_1234567890123456789012345678901234567890';
  sqlite.prepare("INSERT INTO webhook_consumers(app_id,callback_url,secret_cipher,secret_hash,secret_prefix,admin_key_prefix,admin_key_hash) VALUES('consumer','https://example.invalid','c','h','p',?,?)").run(key.slice(0,12),await hashKey(key));
  sqlite.exec("INSERT INTO bank_accounts(id,account_number,pairing_code,owner_app_id,api_fetch_enabled,ingest_enabled,api_last_success_at) VALUES(1,'1234/2010','local','consumer',1,1,datetime('now'))");
  const response=await worker.fetch(new Request('https://local/bank-accounts/1/account-health',{headers:{'X-Tenant-Secret':key}}),env,ctx);
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({bank_observation_status:'healthy'});
  expect((await worker.fetch(new Request('https://local/bank-accounts/1/account-health',{method:'POST',headers:{'X-Tenant-Secret':key}}),env,ctx)).status).toBe(404);
 });
 it('upgrades without destroying history, releases the registry edit trigger and backs up locked audit rows',async()=>{
  const {db,sqlite}=operationsDb(13),id=await hashKey('CZ6508000000192000145399');
  sqlite.prepare('INSERT INTO physical_accounts(id,iban,allocation_enabled) VALUES(?,?,1)').run(id,'CZ6508000000192000145399');
  sqlite.prepare('INSERT INTO payment_references(reservation_id,physical_account_id,app_id,source_ref,normalized_vs,payload_hash) VALUES(?,?,?,?,?,?)').run('history',id,'former-client','invoice:old','42','a'.repeat(64));
  sqlite.exec("INSERT INTO bank_accounts(id,account_number,pairing_code) VALUES(1,'1234/2010','local')");sqlite.prepare('INSERT INTO account_aliases VALUES(?,?)').run(1,id);
  sqlite.exec(readFileSync(new URL('../migrations/0014_retire_payment_reference_allocator.sql',import.meta.url),'utf8'));
  expect(sqlite.prepare('SELECT allocation_enabled FROM physical_accounts').get()).toEqual({allocation_enabled:0});
  expect(sqlite.prepare('SELECT normalized_vs FROM payment_references').get()).toEqual({normalized_vs:'42'});
  expect(()=>sqlite.exec("UPDATE bank_accounts SET account_number='9999/2010' WHERE id=1")).not.toThrow();
  const dump=await buildSqlDump(db);expect(dump.rowCounts.payment_references).toBe(1);
  const restored=operationsDb(14);restored.sqlite.exec(dump.sql);
  expect(restored.sqlite.prepare('SELECT normalized_vs FROM payment_references').get()).toEqual({normalized_vs:'42'});
  expect(restored.sqlite.prepare('SELECT allocation_enabled FROM physical_accounts').get()).toEqual({allocation_enabled:0});
 });
});
