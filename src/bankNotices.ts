import { decimalToCents, normalizeCurrency } from './normalize.js';

// Bank-specific text layouts only. MIME decoding and sender authentication belong
// to ingress; payment matching and movement identity belong to the consumer.
export type NoticeProvider = 'csob_email' | 'moneta_email' | 'creditas_email'
  | 'raiffeisenbank_email' | 'unicredit_email' | 'csas_email';

interface NoticeFields {
  amountLabels: string[];
  dateLabels: string[];
  counterpartyLabels: string[];
  nameLabels?: string[];
  messageLabels?: string[];
  direction?: 'incoming' | 'outgoing';
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// Labels are whole lines or colon-delimited. A missing value must not consume
// the following label. CREDITAS separates multiple fields with " - ".
const FIELD_LABELS = new Set([
  'castka', 'castka v mene uctu', 'datum', 'datum uctovani', 'datum a cas',
  'ucet', 'ucet protistrany', 'banka protistrany', 'nazev protistrany',
  'cislo uctu', 'cislo uctu protistrany', 'nazev uctu protistrany',
  'od', 'na ucet', 'z uctu', 'popis', 'detaily transakce', 'smer platby',
  'variabilni symbol', 'konstantni symbol', 'specificky symbol', 'vs', 'ks', 'ss',
  'zprava pro prijemce', 'disponibilni zustatek', 'ucetni zustatek',
]);

function fields(text: string): Map<string, string> {
  const lines = text.replace(/\u00a0|\u202f/g, ' ').replace(/\r/g, '')
    .replace(/ +-[ \t]+(?=[^\n:]+:)/g, '\n').split('\n')
    .map(line => line.trim().replace(/^-[ \t]+/, '')).filter(Boolean);
  const values = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const colon = line.indexOf(':');
    if (colon >= 0) {
      const key = fold(line.slice(0, colon).trim());
      if (!FIELD_LABELS.has(key)) continue;
      const inline = line.slice(colon + 1).trim();
      const next = lines[i + 1];
      const nextIsLabel = next && FIELD_LABELS.has(fold(next.split(':')[0]!.trim()));
      if (!values.has(key)) values.set(key, inline || (next && !nextIsLabel ? next : ''));
    } else if (FIELD_LABELS.has(fold(line)) && lines[i + 1] && !values.has(fold(line))) {
      values.set(fold(line), lines[i + 1]!);
    }
  }
  return values;
}

function value(values: Map<string, string>, labels: string[]): string | null {
  for (const label of labels) {
    const found = values.get(label);
    if (found) return found;
  }
  return null;
}

function layout(provider: NoticeProvider, text: string, values: Map<string, string>): NoticeFields | null {
  const normalized = fold(text);
  const base = { amountLabels: ['castka'], dateLabels: ['datum'], counterpartyLabels: ['ucet protistrany'] };
  switch (provider) {
    case 'csob_email':
      if (!normalized.includes('parametry platby')) return null;
      return { ...base, dateLabels: ['datum uctovani'], nameLabels: ['nazev protistrany'] };
    case 'moneta_email': {
      const incoming = /(?:^|\n)\s*prisly penize\s*(?:\n|$)/.test(normalized);
      const outgoing = /(?:^|\n)\s*odesly penize\s*(?:\n|$)/.test(normalized);
      if (incoming === outgoing) return null;
      return { ...base, direction: incoming ? 'incoming' : 'outgoing',
        counterpartyLabels: ['od'], messageLabels: ['popis'] };
    }
    case 'creditas_email': {
      const direction = normalized.match(/zustatek na uctu[^\n]{0,100} se (zvysil|snizil) o castku/);
      if (!direction) return null;
      return { ...base, direction: direction[1] === 'zvysil' ? 'incoming' : 'outgoing' };
    }
    case 'raiffeisenbank_email':
      if (!values.has('castka v mene uctu')) return null;
      return { ...base, amountLabels: ['castka v mene uctu'], dateLabels: ['datum a cas'],
        counterpartyLabels: [value(values, ['castka v mene uctu'])?.startsWith('-') ? 'na ucet' : 'z uctu'],
        messageLabels: ['zprava pro prijemce'] };
    case 'unicredit_email':
      if (!normalized.includes('prave probehla transakce')) return null;
      return { ...base, counterpartyLabels: ['cislo uctu protistrany'],
        nameLabels: ['nazev uctu protistrany'], messageLabels: ['detaily transakce'] };
    case 'csas_email': {
      const direction = fold(value(values, ['smer platby']) ?? '');
      if (!['prichozi', 'odchozi'].includes(direction)) return null;
      return { ...base, amountLabels: ['castka v mene uctu'],
        direction: direction === 'prichozi' ? 'incoming' : 'outgoing',
        counterpartyLabels: direction === 'prichozi' ? ['cislo uctu protistrany', 'z uctu'] : ['cislo uctu protistrany', 'na ucet'] };
    }
  }
}

export function parseBankNotice(text: string, provider: NoticeProvider) {
  const values = fields(text);
  const config = layout(provider, text, values);
  if (!config) return null;
  const amount = value(values, config.amountLabels)?.match(/^([+-]?[0-9][0-9 .,]*[.,][0-9]{2})\s*(CZK|Kč|Kc|EUR|USD|€)\s*$/i);
  if (!amount) return null;
  const currency = normalizeCurrency(amount[2]!);
  const rawAmount = amount[1]!;
  const validAmount = /^[+-]?(?:[0-9]+|[0-9]{1,3}(?:[ .][0-9]{3})+),[0-9]{2}$/.test(rawAmount)
    || /^[+-]?(?:[0-9]+|[0-9]{1,3}(?:[ ,][0-9]{3})+)\.[0-9]{2}$/.test(rawAmount);
  if (!validAmount) return null;
  let decimal = amount[1]!.replace(/\s/g, '');
  const separator = Math.max(decimal.lastIndexOf(','), decimal.lastIndexOf('.'));
  decimal = decimal.slice(0, separator).replace(/[.,]/g, '') + '.' + decimal.slice(separator + 1);
  let amount_cents = decimalToCents(decimal, currency);
  if (config.direction === 'outgoing') amount_cents = -Math.abs(amount_cents);
  else if (config.direction === 'incoming' && amount_cents < 0) return null;

  const account = value(values, config.counterpartyLabels)?.match(/^((?:[0-9]{1,6}-)?[0-9]{1,10})\/([0-9]{4})(?![0-9])(.*)$/);
  // CREDITAS supplies account number and bank code as separate fields.
  const creditasAccount = provider === 'creditas_email' ? value(values, ['ucet protistrany']) : null;
  const creditasBank = provider === 'creditas_email' ? value(values, ['banka protistrany']) : null;
  const counter_account = account?.[1] ?? (creditasAccount && /^(?:[0-9]{1,6}-)?[0-9]{1,10}$/.test(creditasAccount) ? creditasAccount : null);
  const bank_code = account?.[2] ?? (creditasBank && /^[0-9]{4}$/.test(creditasBank) ? creditasBank : null);
  const symbol = (labels: string[]) => value(values, labels)?.match(/^([0-9]+)(?:\s|$)/)?.[1] ?? null;
  const message = value(values, config.messageLabels ?? ['zprava pro prijemce']);
  const vs = symbol(['variabilni symbol', 'vs']) ?? (provider === 'moneta_email' ? message?.match(/\bVS:\s*([0-9]+)(?![0-9])/i)?.[1] ?? null : null);
  const dateRaw = value(values, config.dateLabels);
  const dateText = dateRaw?.replace(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/, (_, d: string, m: string, y: string) => `${d.padStart(2, '0')}.${m.padStart(2, '0')}.${y}`) ?? null;
  return { amount_cents, currency, counter_account, bank_code, vs,
    ks: symbol(['konstantni symbol', 'ks']), ss: symbol(['specificky symbol', 'ss']),
    message, sender_name: value(values, config.nameLabels ?? []) || account?.[3]?.trim() || null,
    dateText };
}
