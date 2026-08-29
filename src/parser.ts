import type { Transaction } from './types.js';
import { normalizeCurrency, toCents } from './normalize.js';

export const BANK_CODES: Record<string, string> = {
  '0100': 'Komerční banka, a.s.',
  '0300': 'Československá obchodní banka, a. s.',
  '0600': 'MONETA Money Bank, a.s.',
  '0800': 'Česká spořitelna, a.s.',
  '2010': 'Fio banka, a.s.',
  '2700': 'UniCredit Bank Czech Republic and Slovakia, a.s.',
  '3030': 'Air Bank a.s.',
  '5500': 'Raiffeisenbank a.s.',
  '6210': 'mBank S.A.',
  '6000': 'PPF banka a.s.',
  '4000': 'Expobank CZ a.s.',
  '2250': 'Banka CREDITAS a.s.',
};

export type EmailProvider = 'fio_email' | 'airbank_email';

export function detectProvider(
  text: string,
  accountNumber: string | null,
): 'fio_email' | 'airbank_email' | 'unknown' {
  if (accountNumber) {
    const acc = accountNumber.replace(/\s/g, '');
    if (acc.includes('/2010')) return 'fio_email';
    if (acc.includes('/3030')) return 'airbank_email';
    if (acc.toUpperCase().startsWith('CZ') && acc.length >= 8) {
      const bankCode = acc.substring(4, 8);
      if (bankCode === '2010') return 'fio_email';
      if (bankCode === '3030') return 'airbank_email';
    }
  }
  // Keyword fallback — festapp uses bankType; here we inspect the email body
  if (/fio/i.test(text)) return 'fio_email';
  if (/air\s*bank/i.test(text)) return 'airbank_email';
  return 'unknown';
}

// Parses a floating-point amount string that may use European (1 234,50) or
// US (1,234.50) notation. Returns NaN if unparseable.
function parseAmount(raw: string): number {
  let s = raw.replace(/\s/g, '');
  // Both comma and dot present: the one further right is the decimal separator
  if (s.includes(',') && s.includes('.')) {
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > lastDot) {
      // European: 1.234,50
      s = s.replace('.', '').replace(',', '.');
    } else {
      // US: 1,234.50
      s = s.replace(',', '');
    }
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  return parseFloat(s);
}

// noUncheckedIndexedAccess makes regex capture groups string|undefined.
// Use this to safely read a required capture group (regex is written to always capture).
function g(m: RegExpMatchArray, i: number, fallback = ''): string {
  return m[i] ?? fallback;
}

// Converts a Czech/ISO date string to UTC ISO 8601 'Z' form.
// Handles:
//   "dd.mm.yyyy hh:mm +0200"  → UTC, date_offset_min = 120
//   "dd.mm.yyyy hh:mm"        → treat as Europe/Prague local bank-domain data.
// This is intentionally independent of the authenticated user's timezone.
//   "dd.mm.yyyy"              → noon UTC (neutral anchor; caller fills in reception time if null preferred)
//   unrecognised              → { date: null, date_offset_min: null }
function parseDateToUTC(raw: string): { date: string | null; date_offset_min: number | null } {
  // Full datetime with explicit offset: dd.mm.yyyy hh:mm ±hhmm or ±hh:mm
  const withOffsetRe =
    /(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*([+-])(\d{2}):?(\d{2})/;
  const wm = raw.match(withOffsetRe);
  if (wm) {
    const sign = g(wm, 7);
    const offsetMin =
      (parseInt(g(wm, 8), 10) * 60 + parseInt(g(wm, 9), 10)) * (sign === '+' ? 1 : -1);
    const localMs =
      Date.UTC(
        parseInt(g(wm, 3), 10),
        parseInt(g(wm, 2), 10) - 1,
        parseInt(g(wm, 1), 10),
        parseInt(g(wm, 4), 10),
        parseInt(g(wm, 5), 10),
        parseInt(g(wm, 6, '0'), 10),
      ) -
      offsetMin * 60_000;
    return { date: new Date(localMs).toISOString(), date_offset_min: offsetMin };
  }

  // Datetime without offset: dd.mm.yyyy hh:mm — treat as Europe/Prague
  const noOffsetRe = /(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/;
  const nm = raw.match(noOffsetRe);
  if (nm) {
    // Approximate Europe/Prague offset: CEST (UTC+2) Apr–Oct, CET (UTC+1) Nov–Mar
    const month = parseInt(g(nm, 2), 10);
    const pragueOffsetMin = month >= 4 && month <= 10 ? 120 : 60;
    const localMs =
      Date.UTC(
        parseInt(g(nm, 3), 10),
        parseInt(g(nm, 2), 10) - 1,
        parseInt(g(nm, 1), 10),
        parseInt(g(nm, 4), 10),
        parseInt(g(nm, 5), 10),
        parseInt(g(nm, 6, '0'), 10),
      ) -
      pragueOffsetMin * 60_000;
    return { date: new Date(localMs).toISOString(), date_offset_min: pragueOffsetMin };
  }

  // Date only: dd.mm.yyyy — use noon UTC as neutral anchor
  const dateOnlyRe = /(\d{2})\.(\d{2})\.(\d{4})/;
  const dm = raw.match(dateOnlyRe);
  if (dm) {
    const iso = new Date(
      Date.UTC(parseInt(g(dm, 3), 10), parseInt(g(dm, 2), 10) - 1, parseInt(g(dm, 1), 10), 12, 0, 0),
    ).toISOString();
    return { date: iso, date_offset_min: null };
  }

  return { date: null, date_offset_min: null };
}

export type ParsedEmailTransaction = Omit<
  Transaction,
  'id' | 'bank_account_id' | 'created_at' | 'date'
> & { date: string | null };

export function parseEmail(
  text: string,
  provider: EmailProvider,
): ParsedEmailTransaction | null {
  if (provider === 'fio_email') {
    const amountMatch = text.match(
      /(?:Částka|Castka|Amount):\s*([\d\s,.-]+)\s*([A-Za-z]{2,3})/i,
    );
    if (!amountMatch) return null;

    const rawCurrencyStr = amountMatch[2] ?? '';
    // normalizeCurrency throws on unknown — caller catches and logs unknown_currency
    const currency = normalizeCurrency(rawCurrencyStr);

    const amount = parseAmount(amountMatch[1] ?? '');
    if (isNaN(amount)) return null;
    // Incoming-only: negative amount → return null (caller logs outgoing_filtered)
    if (amount < 0) return null;

    const amount_cents = toCents(amount, currency);

    const accountMatch = text.match(/(?:Protiúčet|Protiucet|Account):\s*([0-9\/\s]+)/i);
    const vsMatch = text.match(/VS:\s*([0-9]+)/i);
    const ksMatch = text.match(/KS:\s*([0-9]+)/i);
    const ssMatch = text.match(/SS:\s*([0-9]+)/i);
    const msgMatch = text.match(/(?:Zpráva pro příjemce|Message):\s*(.*)/i);
    const nameMatch = text.match(/(?:Název protiúčtu|Account Name):\s*(.*)/i);
    const idMatch = text.match(/(?:ID pokynu|Transaction ID):\s*([0-9]+)/i);

    // Extract date from body; Fio emails often include "Datum: dd.mm.yyyy hh:mm"
    const dateMatch = text.match(
      /Datum(?:\s+pohybu|\s+provedení|\s+zaúčtování)?:\s*(\d{2}\.\d{2}\.\d{4}(?:\s+\d{2}:\d{2}(?::\d{2})?(?:\s*[+-]\d{2}:?\d{2})?)?)/i,
    );

    let counter_account: string | null = null;
    let bank_code: string | null = null;
    if (accountMatch) {
      const rawAcc = (accountMatch[1] ?? '').replace(/\s/g, '');
      const parts = rawAcc.split('/');
      counter_account = parts[0] ?? null;
      bank_code = parts.length > 1 ? (parts[1] ?? null) : null;
    }

    const { date, date_offset_min } = dateMatch
      ? parseDateToUTC(dateMatch[1] ?? '')
      : { date: null, date_offset_min: null as number | null };

    return {
      amount_cents,
      currency,
      counter_account: counter_account || null,
      bank_code: bank_code || null,
      bank_name: bank_code ? (BANK_CODES[bank_code] ?? null) : null,
      vs: vsMatch ? (vsMatch[1] ?? null) : null,
      ks: ksMatch ? (ksMatch[1] ?? null) : null,
      ss: ssMatch ? (ssMatch[1] ?? null) : null,
      message: msgMatch ? ((msgMatch[1] ?? '').trim() || null) : null,
      sender_name: nameMatch ? ((nameMatch[1] ?? '').trim() || null) : null,
      user_identification: null,
      transaction_type: null,
      performed_by: null,
      comment: null,
      command_id: null,
      source: 'email',
      date,
      date_offset_min,
      transaction_id: idMatch ? (idMatch[1] ?? null) : null,
      external_id: null,
    } satisfies ParsedEmailTransaction;
  }

  if (provider === 'airbank_email') {
    const amountMatch = text.match(
      /(?:Částka|Castka|Amount)[\s\S]*?:\s*([\d\s,.-]+)\s*([A-Za-z]{2,3})/i,
    );
    if (!amountMatch) return null;

    const rawCurrencyStr = amountMatch[2] ?? '';
    const currency = normalizeCurrency(rawCurrencyStr);

    const amountStr = (amountMatch[1] ?? '').replace(/\s/g, '');
    if (!amountStr) return null;
    const amount = parseAmount(amountMatch[1] ?? '');
    if (isNaN(amount)) return null;
    if (amount < 0) return null;

    const amount_cents = toCents(amount, currency);

    // AirBank: "z účtu Name Name číslo 123/2010" or "z účtu 123/2010"
    const accountLineMatch = text.match(
      /(?:z účtu|Příchozí úhrada z účtu)\s+([\s\S]*?)\s+číslo\s*([0-9\/]+)/i,
    );
    const simpleAccountMatch = text.match(/z účtu\s*([0-9\/]+)/i);

    const vsMatch = text.match(/(?:Variabilní symbol|\bVS\b)\s*:\s*([0-9]+)/i);
    const ksMatch = text.match(/(?:Konstantní symbol|\bKS\b)\s*:\s*([0-9]+)/i);
    const ssMatch = text.match(/(?:Specifický symbol|\bSS\b)\s*:\s*([0-9]+)/i);
    const msgMatch = text.match(/(?:Zpráva pro příjemce|Zprava)\s*:\s*(.*)/i);
    const idMatch = text.match(/(?:Kód transakce|Kod transakce)\s*:\s*([0-9]+)/i);
    const dateMatch = text.match(
      /(?:Datum zaúčtování|Datum zauctovani)\s*:\s*(\d{2}\.\d{2}\.\d{4}(?:\s+\d{2}:\d{2}(?::\d{2})?(?:\s*[+-]\d{2}:?\d{2})?)?)/i,
    );

    let counter_account: string | null = null;
    let bank_code: string | null = null;
    let sender_name: string | null = null;

    if (accountLineMatch) {
      sender_name = (accountLineMatch[1] ?? '').trim().replace(/\s+/g, ' ') || null;
      const rawAcc = accountLineMatch[2] ?? '';
      const parts = rawAcc.split('/');
      counter_account = parts[0] ?? null;
      bank_code = parts.length > 1 ? (parts[1] ?? null) : null;
    } else if (simpleAccountMatch) {
      const rawAcc = (simpleAccountMatch[1] ?? '').replace(/\s/g, '');
      const parts = rawAcc.split('/');
      counter_account = parts[0] ?? null;
      bank_code = parts.length > 1 ? (parts[1] ?? null) : null;
    }

    const { date, date_offset_min } = dateMatch
      ? parseDateToUTC(dateMatch[1] ?? '')
      : { date: null, date_offset_min: null as number | null };

    return {
      amount_cents,
      currency,
      counter_account: counter_account || null,
      bank_code: bank_code || null,
      bank_name: bank_code ? (BANK_CODES[bank_code] ?? null) : null,
      vs: vsMatch ? (vsMatch[1] ?? null) : null,
      ks: ksMatch ? (ksMatch[1] ?? null) : null,
      ss: ssMatch ? (ssMatch[1] ?? null) : null,
      message: msgMatch ? ((msgMatch[1] ?? '').trim() || null) : null,
      sender_name,
      user_identification: null,
      transaction_type: null,
      performed_by: null,
      comment: null,
      command_id: null,
      source: 'email',
      date,
      date_offset_min,
      transaction_id: idMatch ? (idMatch[1] ?? null) : null,
      external_id: null,
    } satisfies ParsedEmailTransaction;
  }

  return null;
}
