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
