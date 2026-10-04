import type { Transaction } from './types';
import { normalizeCurrency, decimalToCents } from './normalize';

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

/** Fio documents HTTP 500 as a nonexistent/inactive token, including one
 * created but not yet authorized in Internetbanking. Never infer this from
 * a proxy-generated 500 or a transport timeout. */
export class FioTokenInvalidOrInactive extends FioApiError {
  readonly code = 'fio_token_invalid_or_inactive';
  constructor() {
    super('fio_token_invalid_or_inactive', 500);
    this.name = 'FioTokenInvalidOrInactive';
  }
}

export class FioReceivingAccountMismatch extends Error {
  readonly code = 'fio_receiving_account_mismatch';
  constructor(readonly expectedAccount: string, readonly receivedAccount: string) {
    super('fio_receiving_account_mismatch');
    this.name = 'FioReceivingAccountMismatch';
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

type FioOp = 'transactions' | 'set-last-date' | 'periods';

async function fioRequest(
  op: FioOp,
  token: string,
  directUrl: string,
  proxy: FioProxyConfig | undefined,
  date?: string,
  toDate?: string,
): Promise<Response> {
  if (proxy?.url && proxy.secret) {
    return fetch(proxy.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fio-proxy-secret': proxy.secret },
      body: JSON.stringify(date === undefined ? { op, token } : { op, token, date, ...(toDate ? { toDate } : {}) }),
      signal: AbortSignal.timeout(55_000),
    });
  }
  return fetch(directUrl, {signal: AbortSignal.timeout(55_000)});
}

function retryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get('Retry-After');
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function ensureFioResponse(res: Response, proxy?: FioProxyConfig): Promise<void> {
  if ((res.status === 500 && !proxy) || (proxy && [422, 500].includes(res.status) && res.headers.get("x-fio-upstream-status") === "500")) {
    throw new FioTokenInvalidOrInactive();
  }
  if (res.status === 429 || res.status === 409) {
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
  await ensureFioResponse(res, proxy);
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
  await ensureFioResponse(res, proxy);
}

function column(raw: FioTransaction, idx: number): string | null {
  const value = raw[`column${idx}`]?.value;
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && (idx === 22 || idx === 17) && !Number.isSafeInteger(value)) throw new Error('unsafe_fio_identity');
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
  if (!raw) throw new Error('missing_fio_date');

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
  const rawAmount = column(raw, 1);
  if (rawAmount === null) throw new Error('missing_fio_amount');

  const currency = normalizeCurrency(column(raw, 14) ?? '');
  const { date, date_offset_min } = parseFioDate(column(raw, 0));

  return {
    amount_cents: decimalToCents(rawAmount, currency),
    payer_reference: column(raw, 27),
    raw_vs: column(raw, 5),
    direction: decimalToCents(rawAmount, currency) > 0 ? 'incoming' : decimalToCents(rawAmount, currency) < 0 ? 'outgoing' : 'zero',
    identity_kind: column(raw, 22) ? 'movement' : 'observation',
    identity_provenance: 'fio_api_column22',
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

/** A bounded read that does not advance the bank's last-movement cursor. */
export async function fetchFioStatement(token: string, from: string, to: string, proxy?: FioProxyConfig): Promise<{
  info: Record<string, unknown>; transactions: FioTransaction[];
}> {
  for (const date of [from,to]) if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))) throw new Error('invalid_statement_window');
  if (from > to || Date.parse(to)-Date.parse(from) > 90*86400000) throw new Error('unbounded_statement_window');
  const response = await fioRequest('periods',token,`${endpoint('periods',token)}/${from}/${to}/transactions.json`,proxy,from,to);
  await ensureFioResponse(response, proxy);
  const document = await response.json() as {accountStatement?: {info?:Record<string,unknown>; transactionList?:{transaction?:FioTransaction[]|FioTransaction}}};
  const statement = document.accountStatement;
  if (!statement?.info) throw new Error('missing_statement_info');
  const rows = statement.transactionList?.transaction ?? [];
  return {info:statement.info,transactions:Array.isArray(rows)?rows:[rows]};
}
