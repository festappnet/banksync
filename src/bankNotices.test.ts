import { describe, expect, it } from 'vitest';
import { detectProvider, parseEmail, type EmailProvider } from './parser.js';
import { extractEmailBody } from './mime.js';
import { classifyEmail } from './email_classify.js';
import type { BankAccount } from './types.js';

// Independently authored examples of documented bank field layouts. These are
// format tests, not original bank messages or evidence of movement identity.
const notices: { provider: EmailProvider; bank: string; incoming: string; outgoing: string; cents: number; vs: string | null; date: string | null }[] = [
  { provider: 'csob_email', bank: '0300', cents: 123456, vs: '000042', date: '2026-09-21',
    incoming: `Parametry platby\nÚčet\n123456/0300\nÚčet protistrany\n19-987654/0800\nDatum účtování\n21.9.2026\nČástka\n+1 234,56 CZK\nVariabilní symbol\n000042\nZůstatek na účtu po zaúčtování transakce: +99 999,99 CZK.`,
    outgoing: `Parametry platby\nDatum účtování\n21.9.2026\nČástka\n-1 234,56 CZK` },
  { provider: 'moneta_email', bank: '0600', cents: 123456, vs: '000042', date: '2026-09-21',
    incoming: `Přišly peníze\nÚčet:\n123***456\nDatum:\n21.09.2026\nČástka:\n1 234,56 Kč\nPopis:\nÚhrada VS: 000042\nOd:\n19-987654/0800\nDisponibilní zůstatek:\n99 999,99 Kč`,
    outgoing: `Odešly peníze\nDatum:\n21.09.2026\nČástka:\n1 234,56 Kč` },
  { provider: 'creditas_email', bank: '2250', cents: 123456, vs: '000042', date: '2026-09-21',
    incoming: `zůstatek na účtu 123456/2250 se zvýšil o částku 1 234,56 CZK (Příchozí úhrada).\nDetail platby:\n- účet protistrany: 19-987654 - banka protistrany: 0800 - datum: 21.09.2026 11:10\n- částka: 1 234,56 CZK\n- VS: 000042 - disponibilní zůstatek: 99 999,99 CZK`,
    outgoing: `zůstatek na účtu 123456/2250 se snížil o částku 1 234,56 CZK (Blokace).\n- datum: 21.09.2026\n- částka: 1 234,56 CZK` },
  { provider: 'raiffeisenbank_email', bank: '5500', cents: 123456, vs: '000042', date: '2026-09-21',
    incoming: `na účtě byla provedena následující příchozí platba:\nDatum a čas\n21. 09. 2026 11:10\nNa účet\n123456/5500Příjemce\nČástka v měně účtu\n+1.234,56 CZK\nZ účtu\n19-987654/0800Plátce\nVariabilní symbol\n000042\nDisponibilní zůstatek po pohybu\n+99.999,99 CZK`,
    outgoing: `Datum a čas\n21. 09. 2026 11:10\nZ účtu\n123456/5500Vlastník\nČástka v měně účtu\n-1.234,56 CZK\nNa účet\n19-987654/0800Dodavatel` },
  { provider: 'unicredit_email', bank: '2700', cents: 123456, vs: '000042', date: '2026-09-21',
    incoming: `na Vašem účtu č. 123456 (CZK) právě proběhla transakce s následujícími údaji:\nČástka: 1,234.56 CZK\nČíslo účtu protistrany: 19-987654/0800\nNázev účtu protistrany: Plátce\nVariabilní symbol: 000042\nSpecifický symbol: \nDetaily transakce: Vstupné\nDatum: 21.09.2026 11:10:00`,
    outgoing: `právě proběhla transakce\nČástka: -1,234.56 CZK\nDatum: 21.09.2026` },
  { provider: 'csas_email', bank: '0800', cents: 123456, vs: '000042', date: null,
    incoming: `Informace o transakci\nSměr platby: příchozí\nČíslo účtu: 123456/0800\nČíslo účtu protistrany: 19-987654/0800\nČástka v měně transakce: 50,00 EUR\nČástka v měně účtu: 1 234,56 Kč\nVariabilní symbol: 000042\nNa účtu je nově k dispozici 99 999,99 Kč.`,
    outgoing: `Informace o transakci\nSměr platby: odchozí\nZ účtu: 123456/0800\nNa účet: 19-987654/0800\nČástka v měně účtu: 1 234,56 Kč` },
];

function account(bank: string): BankAccount {
  return { id: 1, account_number: `123456/${bank}`, account_type: 'business', ingest_mode: 'email', pairing_code: 'abcdef1234', label: null, owner_app_id: null, cf_rule_id: null, api_token_set: false, api_token_prefix: null, api_fetch_enabled: false, api_last_fetch_at: null, api_last_success_at: null, api_last_error: null, api_backfill_done: false, created_at: '2026-09-21' };
}

describe.each(notices)('$provider notification layout', notice => {
  it('extracts the movement, preserves reference zeroes and does not use the balance', () => {
    const parsed = parseEmail(notice.incoming, notice.provider);
    expect(parsed).toMatchObject({ amount_cents: notice.cents, currency: 'CZK', counter_account: '19-987654', bank_code: '0800', vs: notice.vs, raw_vs: notice.vs, direction: 'incoming', identity_kind: 'observation', transaction_id: null });
    expect(parsed?.date?.slice(0, 10) ?? null).toBe(notice.date);
  });

  it('keeps outgoing amounts negative and selects the outgoing counterparty', () => {
    const parsed = parseEmail(notice.outgoing, notice.provider);
    expect(parsed).toMatchObject({ amount_cents: -notice.cents, direction: 'outgoing' });
    if (['csas_email', 'raiffeisenbank_email'].includes(notice.provider)) {
      expect(parsed?.counter_account).toBe('19-987654');
    }
  });

  it('routes plain and HTML-only MIME through the existing ingest classification', async () => {
    for (const html of [false, true]) {
      const raw = `From: notices@bank.test\r\nTo: abcdef1234@banksync.test\r\nMIME-Version: 1.0\r\nContent-Type: text/${html ? 'html' : 'plain'}; charset=utf-8\r\n\r\n${html ? '<div>' + notice.incoming.replace(/ /g, '&nbsp;').replace(/\n/g, '<br>') + '</div>' : notice.incoming}`;
      const extracted = await extractEmailBody(new Response(raw).body!);
      const result = classifyEmail(extracted, { sender: 'notices@bank.test', recipient: 'abcdef1234@banksync.test', authenticatedDomain: 'bank.test', mechanism: 'dkim' }, account(notice.bank), ['@bank.test']);
      expect(result).toMatchObject({ kind: 'insert', parsed: { amount_cents: notice.cents, vs: notice.vs, counter_account: '19-987654' } });
    }
  });

  it('rejects balance-only messages and malformed movement amounts', () => {
    expect(parseEmail('Disponibilní zůstatek: 99 999,99 CZK', notice.provider)).toBeNull();
    expect(parseEmail(notice.incoming.replace(/(?:\+?1[ .,]234[.,]56)/g, '1x234,56'), notice.provider)).toBeNull();
  });

  it('detects the provider from the registered domestic account or IBAN', () => {
    expect(detectProvider('', `123456/${notice.bank}`)).toBe(notice.provider);
    expect(detectProvider('', `CZ12${notice.bank}0000000000000000`)).toBe(notice.provider);
  });
});

it('does not infer a bank from a counterparty account or marketing text', () => {
  expect(detectProvider('Fio banka', '123456/0100')).toBe('unknown');
  expect(detectProvider('MONETA CREDITAS ČSOB', null)).toBe('unknown');
});

it('rejects conflicting direction and avoids reading the next label as a missing symbol', () => {
  expect(parseEmail('Přišly peníze\nČástka: -10,00 Kč', 'moneta_email')).toBeNull();
  expect(parseEmail(notices[4]!.incoming, 'unicredit_email')?.ss).toBeNull();
});

it('rejects malformed thousands grouping without changing the amount', () => {
  expect(parseEmail('právě proběhla transakce\nČástka: 1,23,4.56 CZK', 'unicredit_email')).toBeNull();
});

it('does not treat an empty amount as the following field', () => {
  expect(parseEmail('Přišly peníze\nČástka:\nDisponibilní zůstatek:\n500,00 Kč', 'moneta_email')).toBeNull();
});

it('decodes quoted-printable HTML table fields before parsing a notification', async () => {
  const raw = [
    'From: notices@bank.test', 'To: abcdef1234@banksync.test',
    'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
    '<div>P=C5=99i=C5=A1ly pen=C3=ADze</div><table><tr><td>=C4=8C=C3=A1stka:</td><td>12&nbsp;345,67 K=C4=8D</td></tr></table>',
  ].join('\r\n');
  const email = await extractEmailBody(new Response(raw).body!);
  expect(parseEmail(email.text, 'moneta_email')).toMatchObject({ amount_cents: 1234567, currency: 'CZK' });
});
