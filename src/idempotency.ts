import type { D1Database } from '@cloudflare/workers-types';

export type IdempotencyResult =
  | { kind: 'hit'; status: number; body: string }
  | { kind: 'mismatch' }
  | { kind: 'miss'; keyHash: string };

export interface IdempotencyArgs {
  db: D1Database;
  request: Request;
  authPrincipal: string;
  requestBodyText: string;
}

export interface RecordArgs {
  db: D1Database;
  keyHash: string;
  authPrincipal: string;
  requestPath: string;
  requestMethod: string;
  requestBodyHash: string | null;
  responseStatus: number;
  responseBody: string;
}

export async function sha256Hex(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function checkIdempotency(args: IdempotencyArgs): Promise<IdempotencyResult> {
  const { db, request, authPrincipal, requestBodyText } = args;

  const idemKey = request.headers.get('Idempotency-Key');
  if (!idemKey || idemKey.length < 1 || idemKey.length > 255) {
    return { kind: 'miss', keyHash: '' };
  }

  const keyHash = await sha256Hex(`${idemKey}:${authPrincipal}`);
  const bodyHash = requestBodyText.length > 0 ? await sha256Hex(requestBodyText) : null;

  const row = await db
    .prepare(`SELECT request_body_hash, response_status, response_body FROM idempotency_keys WHERE key_hash = ?`)
    .bind(keyHash)
    .first<{ request_body_hash: string | null; response_status: number; response_body: string }>();

  if (!row) return { kind: 'miss', keyHash };

  if ((row.request_body_hash ?? null) !== bodyHash) {
    return { kind: 'mismatch' };
  }

  return { kind: 'hit', status: row.response_status, body: row.response_body };
}

export async function recordIdempotency(args: RecordArgs): Promise<void> {
  const { db, keyHash, authPrincipal, requestPath, requestMethod, requestBodyHash, responseStatus, responseBody } = args;

  if (!keyHash) return;
  if (responseStatus >= 500) return;

  await db
    .prepare(`
      INSERT OR IGNORE INTO idempotency_keys
        (key_hash, auth_principal, request_path, request_method, request_body_hash, response_status, response_body)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(keyHash, authPrincipal, requestPath, requestMethod, requestBodyHash, responseStatus, responseBody)
    .run();
}
