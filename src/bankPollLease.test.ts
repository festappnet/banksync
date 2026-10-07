import {describe,it,expect} from 'vitest';
import {operationsDb} from './operationsTestSupport';
import {withBankPollLease,normalizedBankAccount} from './bankPollLease';
import {setBankAccountApiToken,clearBankAccountApiToken} from './db';

describe('bank poll leases and credential epochs',()=>{
  it('normalizes CZ aliases and preserves non-CZ IBAN representations',()=>{
    expect(normalizedBankAccount('1234/2010')).toBe(normalizedBankAccount(normalizedBankAccount('1234/2010')));
    expect(normalizedBankAccount(' sk12 3456 ')).toBe('SK123456');
  });
  it('blocks competing same-token and physical-account requests and fences a stale writer',async()=>{
    const {db,sqlite}=operationsDb();
    sqlite.exec("INSERT INTO bank_accounts(id,account_number,pairing_code) VALUES(1,'1234/2010','fixture')");
    await withBankPollLease(db,'1234/2010','synthetic',async lease=>{
      await expect(withBankPollLease(db,normalizedBankAccount('1234/2010'),'other',async()=>{})).rejects.toThrow('bank_poll_busy');
      await expect(withBankPollLease(db,'different-account','synthetic',async()=>{})).rejects.toThrow('bank_poll_busy');
      const write=()=>db.prepare(`UPDATE bank_accounts SET api_backfill_done=1 WHERE id=1 AND ${lease.guard.sql}`).bind(...lease.guard.values).run();
      expect((await write()).meta.changes).toBe(1);
      sqlite.exec("UPDATE bank_poll_leases SET token='replacement',lease_until=datetime('now','+120 seconds')");
      expect((await write()).meta.changes).toBe(0);
      await expect(lease.renew()).rejects.toThrow('bank_poll_lease_lost');
    });
    expect(sqlite.prepare('SELECT DISTINCT token FROM bank_poll_leases').all()).toEqual([{token:'replacement'}]);
  });
  it('updates token and digest atomically, resets bootstrap only for a changed token, and fences clear',async()=>{
    const {db,sqlite}=operationsDb();
    sqlite.exec("INSERT INTO bank_accounts(id,account_number,pairing_code,api_token_hash,api_backfill_done,api_reconciled_through) VALUES(1,'1234/2010','fixture','same',1,'2026-10-01')");
    const args={token_cipher:'encrypted',token_key_ver:1,token_prefix:'fixture',token_hash:'same',fetch_enabled:true};
    await setBankAccountApiToken(db,1,args);
    expect(sqlite.prepare('SELECT api_credential_generation,api_backfill_done,api_reconciled_through FROM bank_accounts').get()).toEqual({api_credential_generation:1,api_backfill_done:1,api_reconciled_through:'2026-10-01'});
    await setBankAccountApiToken(db,1,{...args,token_hash:'changed',token_cipher:'replacement'});
    expect(sqlite.prepare('SELECT api_credential_generation,api_backfill_done,api_reconciled_through,api_token_hash FROM bank_accounts').get()).toEqual({api_credential_generation:2,api_backfill_done:0,api_reconciled_through:null,api_token_hash:'changed'});
    await clearBankAccountApiToken(db,1);
    expect(sqlite.prepare('SELECT api_credential_generation,api_token_cipher,api_token_hash,api_fetch_enabled FROM bank_accounts').get()).toEqual({api_credential_generation:3,api_token_cipher:null,api_token_hash:null,api_fetch_enabled:0});
  });
});
