import type { D1Database } from '@cloudflare/workers-types';
import { hashKey } from './auth';
export interface PaymentReference {reservation_id:string;physical_account_id:string;app_id:string;source_ref:string;normalized_vs:string;payload_hash:string}
export function normalizeVs(value:string):string {
 if(!/^\d{1,10}$/.test(value))throw Error('invalid_vs');return value.replace(/^0+(?=\d)/,'');
}
export function canonicalIban(value:string):string {
 let iban=value.replace(/\s/g,'').toUpperCase();
 const local=iban.match(/^(?:(\d{1,6})-)?(\d{1,10})\/(\d{4})$/);
 if(local){const bban=local[3]!+(local[1]??'').padStart(6,'0')+local[2]!.padStart(10,'0');const checksum=98-Number(BigInt(bban+'123500')%97n);iban='CZ'+String(checksum).padStart(2,'0')+bban;}
 if(!/^CZ\d{22}$/.test(iban)||BigInt((iban.slice(4)+iban.slice(0,4)).replace(/[A-Z]/g,c=>String(c.charCodeAt(0)-55)))%97n!==1n)throw Error('invalid_iban');return iban;
}
export async function mapPhysicalAccount(db:D1Database,accountId:number){
 const account=await db.prepare('SELECT account_number FROM bank_accounts WHERE id=?').bind(accountId).first<{account_number:string}>();if(!account)throw Error('not_found');
 const iban=canonicalIban(account.account_number),id=await hashKey(iban);
 await db.batch([db.prepare('INSERT INTO physical_accounts(id,iban) VALUES(?,?) ON CONFLICT DO NOTHING').bind(id,iban),db.prepare('INSERT INTO account_aliases VALUES(?,?) ON CONFLICT DO NOTHING').bind(accountId,id)]);
 const row=await db.prepare('SELECT physical_account_id FROM account_aliases WHERE bank_account_id=?').bind(accountId).first<{physical_account_id:string}>();if(row?.physical_account_id!==id)throw Error('account_identity_conflict');return id;
}
export async function referenceScope(db:D1Database,accountId:number,appId:string):Promise<string>{
 const row=await db.prepare('SELECT a.physical_account_id FROM account_aliases a JOIN payment_reference_grants g ON g.physical_account_id=a.physical_account_id WHERE a.bank_account_id=? AND g.app_id=?').bind(accountId,appId).first<{physical_account_id:string}>();if(!row)throw Error('reference_forbidden');return row.physical_account_id;
}
export async function lookupPaymentReference(db:D1Database,physical:string,app:string,source:string){return db.prepare('SELECT * FROM payment_references WHERE physical_account_id=? AND app_id=? AND source_ref=?').bind(physical,app,source).first<PaymentReference>();}
// Unbiased cryptographic sampling in the complete 1-10 digit VS namespace.
function randomVariableSymbol(){const range=9999999999,space=2**48,limit=Math.floor(space/range)*range;for(;;){const words=crypto.getRandomValues(new Uint32Array(2)),value=(words[0]!&0xffff)*2**32+words[1]!;if(value<limit)return String(value%range+1);}}
export async function reservePaymentReference(db:D1Database,physical:string,app:string,source:string,payloadHash:string,legacyVs?:string,importHistorical=false):Promise<PaymentReference>{
 if(!source||source.length>255||!/^[a-f0-9]{64}$/.test(payloadHash))throw Error('reference_invalid');
 const old=await lookupPaymentReference(db,physical,app,source);if(old){if(old.payload_hash!==payloadHash||(legacyVs!==undefined&&old.normalized_vs!==normalizeVs(legacyVs)))throw Error('reference_conflict');return old;}
 if(legacyVs!==undefined&&!importHistorical){const state=await db.prepare('SELECT allocation_enabled FROM physical_accounts WHERE id=?').bind(physical).first<{allocation_enabled:number}>();if(!state?.allocation_enabled)throw Error('reference_registry_locked');}
 const vs=legacyVs===undefined?undefined:normalizeVs(legacyVs);
 for(let attempt=0;attempt<32;attempt++){
  // The INSERT reads the counter inside the same atomic D1 batch as its advance.
  const insert=vs===undefined?db.prepare(`INSERT INTO payment_references SELECT ?,id,?,?,?,? ,datetime('now') FROM physical_accounts WHERE id=? AND allocation_enabled=1 AND next_vs<=9999999999 ON CONFLICT DO NOTHING`).bind(crypto.randomUUID(),app,source,randomVariableSymbol(),payloadHash,physical):db.prepare('INSERT INTO payment_references(reservation_id,physical_account_id,app_id,source_ref,normalized_vs,payload_hash) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(crypto.randomUUID(),physical,app,source,vs,payloadHash);
  await db.batch(vs===undefined?[insert,db.prepare('UPDATE physical_accounts SET next_vs=next_vs+1 WHERE id=? AND allocation_enabled=1 AND next_vs<=9999999999').bind(physical)]:[insert]);
  const result=await lookupPaymentReference(db,physical,app,source);if(result){if(result.payload_hash!==payloadHash||(vs!==undefined&&result.normalized_vs!==vs))throw Error('reference_conflict');return result;}
  if(vs!==undefined){if(!importHistorical)throw Error('reference_conflict');await db.batch([db.prepare('INSERT INTO payment_reference_conflicts VALUES(?,?,?,?,?,datetime(\'now\'))').bind(crypto.randomUUID(),physical,vs,app,source),db.prepare('UPDATE physical_accounts SET allocation_enabled=0 WHERE id=?').bind(physical)]);throw Error('reference_conflict');}
  const state=await db.prepare('SELECT allocation_enabled,next_vs FROM physical_accounts WHERE id=?').bind(physical).first<{allocation_enabled:number;next_vs:number}>();if(!state?.allocation_enabled)throw Error('reference_registry_locked');if(state.next_vs>9999999999)throw Error('reference_exhausted');
 }
 throw Error('reference_retry_required');
}
