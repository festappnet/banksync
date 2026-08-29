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

const MAX_AMOUNT_FIELD_CHARS = 64;

function isAsciiDigit(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isAsciiLetter(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAmountChar(char: string): boolean {
  return isAsciiDigit(char)
    || char === ' '
    || char === '\t'
    || char === '\u00a0'
    || char === ','
    || char === '.'
    || char === '-';
}

function findLabeledLineValue(text: string, labels: readonly string[]): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    const lower = trimmed.toLowerCase();
    for (const label of labels) {
      let searchFrom = 0;
      while (searchFrom < lower.length) {
        const labelAt = lower.indexOf(label, searchFrom);
        if (labelAt < 0) break;
        const before = labelAt > 0 ? (lower[labelAt - 1] ?? '') : '';
        let cursor = labelAt + label.length;
        while (cursor < trimmed.length && (trimmed[cursor] === ' ' || trimmed[cursor] === '\t')) cursor += 1;
        if (!isAsciiLetter(before) && trimmed[cursor] === ':') return trimmed.slice(cursor + 1).trimStart();
        searchFrom = labelAt + label.length;
      }
    }
  }
  return null;
}

function parseLabeledAmount(
  text: string,
  labels: readonly string[],
): { rawAmount: string; currency: string } | null {
  const value = findLabeledLineValue(text, labels);
  if (!value) return null;

  let cursor = 0;
  while (cursor < value.length && cursor <= MAX_AMOUNT_FIELD_CHARS && isAmountChar(value[cursor] ?? '')) cursor += 1;
  if (cursor === 0 || cursor > MAX_AMOUNT_FIELD_CHARS) return null;

  const rawAmount = value.slice(0, cursor).trim();
  if (![...rawAmount].some(isAsciiDigit)) return null;

  const currencyStart = cursor;
  while (cursor < value.length && cursor - currencyStart < 3 && isAsciiLetter(value[cursor] ?? '')) cursor += 1;
  const currency = value.slice(currencyStart, cursor);
  if (currency.length < 2 || currency.length > 3 || isAsciiLetter(value[cursor] ?? '')) return null;
  return { rawAmount, currency };
}

function parseAccountPrefix(value: string): string | null {
  let cursor = 0;
  while (cursor < value.length && cursor < 20 && isAsciiDigit(value[cursor] ?? '')) cursor += 1;
  if (cursor === 0 || value[cursor] !== '/') return null;
  cursor += 1;
  for (let digits = 0; digits < 4; digits += 1, cursor += 1) {
    if (!isAsciiDigit(value[cursor] ?? '')) return null;
  }
  if (isAsciiDigit(value[cursor] ?? '')) return null;
  return value.slice(0, cursor);
}

function parseAirbankCounterparty(text: string): { account: string; senderName: string | null } | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();
    const marker = 'z účtu';
    const markerAt = lower.indexOf(marker);
    if (markerAt < 0) continue;

    const remainder = trimmed.slice(markerAt + marker.length).trimStart();
    const numberMarker = ' číslo ';
    const numberAt = remainder.toLowerCase().lastIndexOf(numberMarker);
    const accountText = numberAt >= 0
      ? remainder.slice(numberAt + numberMarker.length).trimStart()
      : remainder;
    const account = parseAccountPrefix(accountText);
    if (!account) continue;

    const senderName = numberAt >= 0
      ? (remainder.slice(0, numberAt).trim().replace(/\s+/g, ' ') || null)
      : null;
    return { account, senderName };
  }
  return null;
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
    const amountField = parseLabeledAmount(text, ['částka', 'castka', 'amount']);
    if (!amountField) return null;

    const rawCurrencyStr = amountField.currency;
    // normalizeCurrency throws on unknown — caller catches and logs unknown_currency
    const currency = normalizeCurrency(rawCurrencyStr);

    const amount = parseAmount(amountField.rawAmount);
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
    const amountField = parseLabeledAmount(text, ['částka', 'castka', 'amount']);
    if (!amountField) return null;

    const rawCurrencyStr = amountField.currency;
    const currency = normalizeCurrency(rawCurrencyStr);

    const amountStr = amountField.rawAmount.replace(/\s/g, '');
    if (!amountStr) return null;
    const amount = parseAmount(amountField.rawAmount);
    if (isNaN(amount)) return null;
    if (amount < 0) return null;

    const amount_cents = toCents(amount, currency);

    // AirBank: "z účtu Name Name číslo 123/2010" or "z účtu 123/2010"
    const counterparty = parseAirbankCounterparty(text);

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

    if (counterparty) {
      sender_name = counterparty.senderName;
      const rawAcc = counterparty.account;
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
