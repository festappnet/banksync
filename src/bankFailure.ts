import {FioApiError, FioReceivingAccountMismatch, FioResponseError, FioTransportError} from './fio';

/** Safe metadata only. Never persist URLs, response bodies, bank facts or exception text here. */
export interface BankFailureDiagnostic {
  version: 1;
  id: string;
  occurred_at: string;
  code: string;
  stage: 'response_decode' | 'bank_http' | 'account_identity' | 'transport' | 'bank_sync';
  operation?: 'transactions' | 'periods';
  transport?: 'direct' | 'proxy';
  http_status?: number;
  document_shape?: string;
  statement_shape?: string;
  info_shape?: string;
}

export function bankFailureDiagnostic(error: unknown): BankFailureDiagnostic {
  const base = {version: 1 as const, id: crypto.randomUUID(), occurred_at: new Date().toISOString()};
  if (error instanceof FioResponseError) return {...base, stage:'response_decode', code:error.message, ...error.observation};
  if (error instanceof FioApiError) return {...base, stage:'bank_http', code:error.name, http_status:error.status};
  if (error instanceof FioReceivingAccountMismatch) return {...base, stage:'account_identity', code:error.code};
  if (error instanceof FioTransportError) return {...base, stage:'transport', code:error.code, ...error.observation};
  return {...base, stage:'bank_sync', code:'bank_sync_internal_error'};
}
