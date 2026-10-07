import type {D1Database} from '@cloudflare/workers-types';
import {sha256Hex} from './idempotency';
import {canonicalIban} from './paymentReferences';

export function normalizedBankAccount(value:string):string {
  const clean=value.replace(/\s/g,'').toUpperCase();
  try {return canonicalIban(clean);} catch {return clean;}
}

export interface BankPollLease {
  token:string;
  /** SQL fragment and bind values to fence a write within its own transaction. */
  guard:{sql:string;values:string[]};
  renew():Promise<void>;
}

export async function withBankPollLease<T>(db:D1Database,accountNumber:string,credential:string,
  operation:(lease:BankPollLease)=>Promise<T>):Promise<T> {
  const keys=[await sha256Hex(`fio-account:${normalizedBankAccount(accountNumber)}`),await sha256Hex(`fio-token:${credential}`)].sort();
  const token=crypto.randomUUID(),held:string[]=[];
  try {
    for(const key of keys) {
      const result=await db.prepare(`INSERT INTO bank_poll_leases(credential_hash,token,lease_until,next_allowed_at)
        VALUES(?,?,datetime('now','+120 seconds'),datetime('now','+30 seconds'))
        ON CONFLICT(credential_hash) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until,next_allowed_at=excluded.next_allowed_at
        WHERE datetime(bank_poll_leases.lease_until)<=datetime('now') AND datetime(bank_poll_leases.next_allowed_at)<=datetime('now')`)
        .bind(key,token).run();
      if(result.meta.changes!==1) throw new Error('bank_poll_busy');
      held.push(key);
    }
    const guard={sql:held.map(()=>"EXISTS (SELECT 1 FROM bank_poll_leases WHERE credential_hash=? AND token=? AND datetime(lease_until)>datetime('now'))").join(' AND '),values:held.flatMap(key=>[key,token])};
    return await operation({token,guard,async renew(){
      for(const key of held) {
        const renewed=await db.prepare(`UPDATE bank_poll_leases SET lease_until=datetime('now','+120 seconds')
          WHERE credential_hash=? AND token=? AND datetime(lease_until)>datetime('now')`).bind(key,token).run();
        if(renewed.meta.changes!==1) throw new Error('bank_poll_lease_lost');
      }
    }});
  } finally {
    for(const key of held) await db.prepare(`UPDATE bank_poll_leases SET lease_until=datetime('now'),next_allowed_at=datetime('now','+30 seconds')
      WHERE credential_hash=? AND token=?`).bind(key,token).run();
  }
}
