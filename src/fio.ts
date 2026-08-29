import type { Transaction } from './types';
import { normalizeCurrency, toCents } from './normalize';

const FIO_BASE = 'https://fioapi.fio.cz/v1/rest';

export interface FioColumn {
  value?: unknown;
}

export type FioTransaction = Record<`column${number}`, FioColumn | undefined>;

export class FioApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'FioApiError';
  }
}

export class FioRateLimited extends FioApiError {
  constructor(status: number, public readonly retryAfterS: number | null) {
    super(`Fio API ${status}`, status);
    this.name = 'FioRateLimited';
  }
}

export class FioTransientFailure extends FioApiError {
  constructor(status: number) {
    super(`Fio API ${status}`, status);
    this.name = 'FioTransientFailure';
  }
}

function endpoint(path: string, token: string): string {
  return `${FIO_BASE}/${path}/${encodeURIComponent(token)}`;
}

/**
 * Egress relay for Fio pulls. Cloudflare Workers `fetch()` to fioapi.fio.cz
 * fails the TLS handshake (HTTP 525) — Fio blocks Cloudflare egress — while a
 * a relay on a network accepted by Fio can reach it. When configured,
 * Fio requests are POSTed to the proxy edge function which makes the real call
 * from a non-Cloudflare IP and forwards Fio's status + body verbatim. When
 * unset, requests go directly to Fio (legacy behaviour, used by unit tests).
 */
export interface FioProxyConfig {
  url: string;
  secret: string;
}

type FioOp = 'transactions' | 'set-last-date';

async function fioRequest(
  op: FioOp,
  token: string,
  directUrl: string,
  proxy: FioProxyConfig | undefined,
  date?: string,
): Promise<Response> {
  if (proxy?.url && proxy.secret) {
    return fetch(proxy.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fio-proxy-secret': proxy.secret },
      body: JSON.stringify(date === undefined ? { op, token } : { op, token, date }),
    });
  }
  return fetch(directUrl);
}

function retryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get('Retry-After');
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function ensureFioResponse(res: Response): Promise<void> {
  if (res.status === 429) {
    throw new FioRateLimited(res.status, retryAfterSeconds(res.headers));
  }
  if (res.status >= 500) {
    throw new FioTransientFailure(res.status);
  }
  if (!res.ok) {
    throw new FioApiError(`Fio API ${res.status}`, res.status);
  }
}

export async function fetchNewTransactions(token: string, proxy?: FioProxyConfig): Promise<FioTransaction[]> {
  const res = await fioRequest('transactions', token, `${endpoint('last', token)}/transactions.json`, proxy);
  await ensureFioResponse(res);
  const json = await res.json() as {
    accountStatement?: {
      transactionList?: {
        transaction?: FioTransaction[] | FioTransaction;
      };
    };
  };
  const transactions = json.accountStatement?.transactionList?.transaction ?? [];
  return Array.isArray(transactions) ? transactions : [transactions];
}

export async function setFioPointer(token: string, yyyyMmDd: string, proxy?: FioProxyConfig): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyyMmDd)) {
    throw new Error('invalid_fio_pointer_date');
  }
  const res = await fioRequest('set-last-date', token, `${endpoint('set-last-date', token)}/${yyyyMmDd}/`, proxy, yyyyMmDd);
  await ensureFioResponse(res);
}

function column(raw: FioTransaction, idx: number): string | null {
  const value = raw[`column${idx}`]?.value;
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

function parseAmount(raw: string | null): number {
  if (raw === null) return 0;
  const normalized = raw.replace(/\s/g, '').replace(',', '.');
  return Number.parseFloat(normalized);
}

function parseOffsetMinutes(raw: string): number | null {
  const m = raw.match(/([+-])(\d{2}):?(\d{2})$/);
  if (!m) return null;
  const sign = m[1] === '+' ? 1 : -1;
  return sign * (Number.parseInt(m[2] ?? '0', 10) * 60 + Number.parseInt(m[3] ?? '0', 10));
}

function parseFioDate(raw: string | null): { date: string; date_offset_min: number | null } {
  if (!raw) return { date: new Date().toISOString(), date_offset_min: null };

  const isoDateOnly = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[+-]\d{2}:?\d{2})?$/);
  if (isoDateOnly) {
    return {
      date: `${isoDateOnly[1]}T12:00:00.000Z`,
      date_offset_min: parseOffsetMinutes(raw),
    };
  }

  const czechDateOnly = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (czechDateOnly) {
    return {
      date: `${czechDateOnly[3]}-${czechDateOnly[2]}-${czechDateOnly[1]}T12:00:00.000Z`,
      date_offset_min: null,
    };
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return {
      date: parsed.toISOString(),
      date_offset_min: parseOffsetMinutes(raw),
    };
  }

  throw new Error(`invalid_fio_date: ${JSON.stringify(raw)}`);
}

export function mapFioTransaction(raw: FioTransaction): Omit<Transaction, 'id' | 'bank_account_id'> | null {
  const amount = parseAmount(column(raw, 1));
  if (!(amount > 0)) return null;

  const currency = normalizeCurrency(column(raw, 14) ?? '');
  const { date, date_offset_min } = parseFioDate(column(raw, 0));

  return {
    amount_cents: toCents(amount, currency),
    currency,
    counter_account: column(raw, 2),
    bank_code: column(raw, 3),
    bank_name: column(raw, 12),
    vs: column(raw, 5),
    ks: column(raw, 4),
    ss: column(raw, 6),
    message: column(raw, 16),
    sender_name: column(raw, 10),
    user_identification: column(raw, 7),
    transaction_type: column(raw, 8),
    performed_by: column(raw, 9),
    comment: column(raw, 25),
    command_id: column(raw, 17),
    source: 'fio_api',
    date,
    date_offset_min,
    transaction_id: column(raw, 22),
    external_id: null,
  };
}
