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

type FioOp = 'transactions' | 'set-last-date' | 'set-last-id' | 'periods';

/** Created only at the network/body-read boundary, never inferred from an arbitrary TypeError. */
export class FioTransportError extends Error {
  readonly code: string;
  constructor(error: unknown, readonly observation: {
    operation?: 'transactions' | 'periods'; transport: 'direct' | 'proxy'; http_status?: number;
  }) {
    super(error instanceof Error ? error.message : 'fio_transport_failed');
    this.code = error instanceof Error && ['TimeoutError', 'AbortError', 'TypeError'].includes(error.name)
      ? error.name : 'bank_sync_internal_error';
    this.name = this.code;
  }
}


async function fioRequest(
  op: FioOp,
  token: string,
  directUrl: string,
  proxy: FioProxyConfig | undefined,
  date?: string,
  toDate?: string,
  movementId?: string,
): Promise<Response> {
  const observation = {
    ...(op === 'transactions' || op === 'periods' ? {operation: op} : {}),
    transport: proxy?.url && proxy.secret ? 'proxy' as const : 'direct' as const,
  };
  try {
    if (proxy?.url && proxy.secret) {
      return await fetch(proxy.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fio-proxy-secret': proxy.secret },
        body: JSON.stringify({op,token,...(date === undefined ? {} : {date}),...(toDate === undefined ? {} : {toDate}),...(movementId === undefined ? {} : {id:movementId})}),
        signal: AbortSignal.timeout(55_000),
      });
    }
    return await fetch(directUrl, {signal: AbortSignal.timeout(55_000)});
  } catch (error) {
    throw new FioTransportError(error, observation);
  }
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

/** Preserve the account and bank cursor header. The rows-only compatibility
 * helper above is intentionally not used by durable recovery. */
export interface FioStatement {
  info: Record<string, unknown>;
  transactions: FioTransaction[];
}

type JsonShape = 'missing' | 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean';
function jsonShape(value: unknown): JsonShape {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as JsonShape;
}

export class FioResponseError extends Error {
  constructor(code: 'invalid_statement_json' | 'missing_statement_info', readonly observation: {
    operation: 'transactions' | 'periods'; transport: 'direct' | 'proxy'; http_status: number;
    document_shape?: JsonShape; statement_shape?: JsonShape; info_shape?: JsonShape;
  }) { super(code); }
}

async function readFioStatement(response: Response, operation: 'transactions' | 'periods', proxy?: FioProxyConfig): Promise<FioStatement> {
  const context = {operation, transport: proxy?.url && proxy.secret ? 'proxy' as const : 'direct' as const, http_status:response.status};
  let document: unknown;
  try { document = await response.json(); }
  catch (error) {
    if (error instanceof SyntaxError) throw new FioResponseError('invalid_statement_json',context);
    throw new FioTransportError(error, context);
  }
  const statement = document && typeof document === 'object' && !Array.isArray(document)
    ? (document as {accountStatement?: unknown}).accountStatement : undefined;
  const info = statement && typeof statement === 'object' && !Array.isArray(statement)
    ? (statement as {info?: unknown}).info : undefined;
  if (!info || typeof info !== 'object' || Array.isArray(info)) throw new FioResponseError('missing_statement_info', {
    ...context, document_shape:jsonShape(document), statement_shape:jsonShape(statement), info_shape:jsonShape(info),
  });
  const rows = (statement as {transactionList?:{transaction?:FioTransaction[]|FioTransaction}}).transactionList?.transaction ?? [];
  return {info:info as Record<string,unknown>,transactions:Array.isArray(rows)?rows:[rows]};
}

export async function fetchFioDelta(token: string, proxy?: FioProxyConfig): Promise<FioStatement> {
  const response = await fioRequest('transactions',token,`${endpoint('last',token)}/transactions.json`,proxy);
  await ensureFioResponse(response,proxy);
  return readFioStatement(response,'transactions',proxy);
}

export function fioMovementId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('unsafe_fio_identity');
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('invalid_fio_movement_id');
  const id = String(value);
  if (!/^[1-9][0-9]{0,19}$/.test(id)) throw new Error('invalid_fio_movement_id');
  return id;
}

export async function setFioPointerById(token: string, id: string, proxy?: FioProxyConfig): Promise<void> {
  if (fioMovementId(id) === null) throw new Error('invalid_fio_movement_id');
  const response = await fioRequest('set-last-id',token,`${endpoint('set-last-id',token)}/${id}/`,proxy,undefined,undefined,id);
  await ensureFioResponse(response,proxy);
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
  return readFioStatement(response,'periods',proxy);
}
