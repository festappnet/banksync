import { describe, it, expect } from 'vitest';
import { classifyEmail, extractPairingCode, parseAllowlist } from './email_classify';
import type { ExtractedEmail } from './mime';
import type { BankAccount } from './types';

function mkEmail(over: Partial<ExtractedEmail> = {}): ExtractedEmail {
  return {
    subject: 'Příchozí platba',
    text: 'Fio banka — Částka: 100,00 CZK',
    fromHeader: 'noreply@fio.cz',
    toHeader: 'deadbeef01@banksync.festapp.net',
    messageId: 'msg-1',
    ...over,
  };
}

function mkAccount(over: Partial<BankAccount> = {}): BankAccount {
  return {
    id: 7,
    account_number: '2200123456/2010',
    account_type: 'business',
    ingest_mode: 'email',
    pairing_code: 'deadbeef01',
    label: null,
    owner_app_id: null,
    cf_rule_id: null,
    api_token_set: false,
    api_token_prefix: null,
    api_fetch_enabled: false,
    api_last_fetch_at: null,
    api_last_success_at: null,
    api_last_error: null,
    api_backfill_done: false,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const ALLOW = parseAllowlist('@fio.cz, noreply@airbank.cz');

function classify(extracted: ExtractedEmail, account: BankAccount | null, allowlist: string[]) {
  return classifyEmail(extracted, {
    sender: extracted.fromHeader ?? '',
    recipient: extracted.toHeader ?? '',
    authenticatedDomain: (extracted.fromHeader ?? '').split('@')[1] ?? '',
    mechanism: 'dkim',
  }, account, allowlist);
}

describe('extractPairingCode', () => {
  it('lowercases and strips the leading hex label', () => {
    expect(extractPairingCode('DeadBeef01@banksync.festapp.net')).toBe('deadbeef01');
  });
  it('returns null when the To: has no hex pairing label', () => {
    expect(extractPairingCode('hello@banksync.festapp.net')).toBeNull();
    expect(extractPairingCode('')).toBeNull();
  });
});

describe('parseAllowlist', () => {
  it('splits, trims, lowercases and drops blanks', () => {
    expect(parseAllowlist(' @Fio.cz ,, NoReply@AirBank.cz ')).toEqual(['@fio.cz', 'noreply@airbank.cz']);
    expect(parseAllowlist(undefined)).toEqual([]);
  });
});

describe('classifyEmail — security gate', () => {
  it('allows an exact allow-list sender match', () => {
    const out = classify(mkEmail({ fromHeader: 'noreply@airbank.cz' }), mkAccount({ account_number: '2200123456/2010' }), ALLOW);
    expect(out.kind).not.toBe('reject');
  });

  it('allows a subdomain of an allow-listed domain (DKIM subdomain match)', () => {
    const out = classify(mkEmail({ fromHeader: 'auto@mail.fio.cz' }), mkAccount(), ALLOW);
    // sender gate passes → not a sender_not_allowed reject
    if (out.kind === 'reject') expect(out.reason).not.toMatch(/^sender_not_allowed:/);
  });

  it('rejects a spoofed sender from an un-listed domain', () => {
    const out = classify(mkEmail({ fromHeader: 'attacker@evil.example' }), mkAccount(), ALLOW);
    expect(out).toMatchObject({ kind: 'reject', bankAccountId: null, received: false });
    expect((out as { reason: string }).reason).toBe('sender_not_allowed');
  });

  it('rejects when the To: carries no pairing code', () => {
    const out = classify(mkEmail({ toHeader: 'inbox@banksync.festapp.net' }), mkAccount(), ALLOW);
    expect((out as { reason: string }).reason).toMatch(/^no_pairing_code:/);
    expect((out as { received: boolean }).received).toBe(false);
  });

  it('rejects an unknown pairing code (account not found)', () => {
    const out = classify(mkEmail(), null, ALLOW);
    expect(out).toMatchObject({ kind: 'reject', bankAccountId: null, received: false });
    expect((out as { reason: string }).reason).toMatch(/^unknown_pairing_code:/);
  });

  it('rejects api-only accounts at the ingest-mode gate (account known, not received)', () => {
    const out = classify(mkEmail(), mkAccount({ ingest_mode: 'api' }), ALLOW);
    expect(out).toMatchObject({ kind: 'reject', reason: 'email_ingest_disabled', bankAccountId: 7, received: false });
  });

  it('passes the ingest gate for both email-only and dual-mode accounts', () => {
    for (const mode of ['email', 'both'] as const) {
      const out = classify(mkEmail(), mkAccount({ ingest_mode: mode }), ALLOW);
      expect(out.kind).not.toBe('reject');
    }
  });
});

describe('classifyEmail — transaction stage (received)', () => {
  it('rejects unknown_provider once past the gate', () => {
    const out = classify(
      mkEmail({ text: 'Generic bank notice, nothing to see' }),
      mkAccount({ account_number: '1234567/0100' }),
      ALLOW,
    );
    expect(out).toMatchObject({ kind: 'reject', bankAccountId: 7, received: true });
    expect((out as { reason: string }).reason).toMatch(/^unknown_provider:/);
  });

  it('skips non-transaction bank noise (received)', () => {
    const out = classify(
      mkEmail({ text: 'Fio: vaše měsíční výpis je připraven' }),
      mkAccount(),
      ALLOW,
    );
    expect(out).toMatchObject({ kind: 'skip', bankAccountId: 7, received: true });
    expect((out as { reason: string }).reason).toMatch(/^not_transaction:/);
  });

  it('returns an insert outcome carrying the parsed transaction', () => {
    const out = classify(mkEmail(), mkAccount(), ALLOW);
    expect(out.kind).toBe('insert');
    if (out.kind === 'insert') {
      expect(out.account.id).toBe(7);
      expect(out.parsed.amount_cents).toBe(10000);
      expect(out.parsed.currency).toBe('CZK');
      expect(out.received).toBe(true);
    }
  });
});

const airbankBalanceRelease = `Dobrý den,
zůstatek na účtu Běžný účet číslo 123456789/3030 se zvýšil o částku 1 500,00 CZK.
Pro úplnost uvádíme detaily této úhrady:
Uvolnění blokovaných peněz
Částka: 1 500,00 CZK
Datum uvolnění peněz: 20.10.2026
Zpráva pro odesílatele: Bankovní oznámení
Vaše Air Bank`;

describe('Air Bank non-transactional notices', () => {
  const email = () => mkEmail({subject:'Zvýšení zůstatku na účtu Běžný účet',
    fromHeader:'info@airbank.cz',text:airbankBalanceRelease});
  const account = () => mkAccount({account_number:'123456789/3030',account_type:'AIRBANK'});
  it.each([true,false])('skips an authenticated notice with registered account=%s', registered => {
    expect(classify(email(),registered?account():null,['@airbank.cz'])).toEqual({
      kind:'skip',reason:'not_transaction: airbank_notice',bankAccountId:registered?7:null,received:false,
    });
  });
  it('keeps the sender allowlist and recipient shape gates', () => {
    expect(classify(email(),account(),['@fio.cz'])).toMatchObject({kind:'reject',reason:'sender_not_allowed'});
    expect(classify({...email(),toHeader:'unrouted@example.test'},null,['@airbank.cz'])).toMatchObject({kind:'reject',reason:expect.stringMatching(/^no_pairing_code:/)});
  });
  it('does not suppress a real payment carrying a notice phrase in its message', () => {
    const text=`Částka: 25,00 CZK\nDatum zaúčtování: 20.10.2026\nZpráva pro příjemce: ${airbankBalanceRelease}`;
    expect(classify({...email(),text},account(),['@airbank.cz']).kind).toBe('insert');
  });
  it('does not ignore an unrecognized missing-date payment or an unknown account payment', () => {
    const payment={...email(),text:airbankBalanceRelease.replace('Datum uvolnění peněz: 20.10.2026','Datum: 20.10.2026')};
    expect(classify(payment,account(),['@airbank.cz']).kind).toBe('insert');
    expect(classify(payment,null,['@airbank.cz'])).toMatchObject({kind:'reject',reason:expect.stringMatching(/^unknown_pairing_code:/)});
  });
});
