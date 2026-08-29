import type { D1Database } from '@cloudflare/workers-types';

export type IdempotencyResult =
  | { kind: 'hit'; status: number; body: string }
  | { kind: 'in_flight' }
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

  const requestPath = new URL(request.url).pathname;
  const requestMethod = request.method.toUpperCase();
  const keyHash = await sha256Hex(`${authPrincipal}\n${requestMethod}\n${requestPath}\n${idemKey}`);
  const bodyHash = requestBodyText.length > 0 ? await sha256Hex(requestBodyText) : null;

  const reservation = await db.prepare(`
    INSERT OR IGNORE INTO idempotency_keys
      (key_hash, auth_principal, request_path, request_method, request_body_hash, response_status, response_body)
    VALUES (?, ?, ?, ?, ?, 0, '')
  `).bind(keyHash, authPrincipal, requestPath, requestMethod, bodyHash).run();
  if (reservation.meta.changes === 1) return { kind: 'miss', keyHash };

  const row = await db
    .prepare(`SELECT auth_principal, request_path, request_method, request_body_hash, response_status, response_body FROM idempotency_keys WHERE key_hash = ?`)
    .bind(keyHash)
    .first<{ auth_principal: string; request_path: string; request_method: string; request_body_hash: string | null; response_status: number; response_body: string }>();

  if (!row) return { kind: 'miss', keyHash };

  if (row.auth_principal !== authPrincipal || row.request_path !== requestPath || row.request_method !== requestMethod || (row.request_body_hash ?? null) !== bodyHash) {
    return { kind: 'mismatch' };
  }

  if (row.response_status === 0) return { kind: 'in_flight' };

  return { kind: 'hit', status: row.response_status, body: row.response_body };
}

export async function recordIdempotency(args: RecordArgs): Promise<void> {
  const { db, keyHash, authPrincipal, requestPath, requestMethod, requestBodyHash, responseStatus, responseBody } = args;

  if (!keyHash) return;
  if (responseStatus >= 500) {
    await db.prepare(`DELETE FROM idempotency_keys WHERE key_hash = ? AND response_status = 0`).bind(keyHash).run();
    return;
  }

  await db
    .prepare(`
      UPDATE idempotency_keys
      SET response_status = ?, response_body = ?
      WHERE key_hash = ? AND auth_principal = ? AND request_path = ?
        AND request_method = ? AND request_body_hash IS ? AND response_status = 0
    `)
    .bind(responseStatus, responseBody, keyHash, authPrincipal, requestPath, requestMethod, requestBodyHash)
    .run();
}
