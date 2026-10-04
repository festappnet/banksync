export const ISO_ALIASES: Record<string, string> = {
  'kč': 'CZK',
  'kc': 'CZK',
  'czk': 'CZK',
  '€': 'EUR',
  'eur': 'EUR',
  '$': 'USD',
  'usd': 'USD',
};

export const MINOR_UNIT_DECIMALS: Record<string, number> = {
  CZK: 2,
  EUR: 2,
  USD: 2,
};

export function normalizeCurrency(raw: string): string {
  const key = raw.trim().toLowerCase();
  const out = ISO_ALIASES[key];
  if (!out) {
    throw new Error(`unknown_currency: ${JSON.stringify(raw)}`);
  }
  return out;
}

export function toCents(amount: number, currency: string): number {
  const dec = MINOR_UNIT_DECIMALS[currency];
  if (dec === undefined) {
    throw new Error(`unsupported_currency_minor_unit: ${currency}`);
  }
  return Math.round(amount * 10 ** dec);
}

/** Convert a decimal representation without binary floating point rounding. */
export function decimalToCents(raw: string, currency: string): number {
  if (MINOR_UNIT_DECIMALS[currency] !== 2) throw new Error('unsupported_currency_minor_unit');
  const normalized = raw.replace(/\s/g, '').replace(',', '.');
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) throw new Error('invalid_exact_amount');
  const cents = (BigInt(match[2]!) * 100n + BigInt((match[3] ?? '').padEnd(2, '0'))) * (match[1] === '-' ? -1n : 1n);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('amount_out_of_range');
  return Number(cents);
}
