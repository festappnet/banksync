import type { D1Database } from '@cloudflare/workers-types';

export interface AuditArgs {
  db: D1Database;
  authPrincipal: string;
  httpMethod: string;
  requestPath: string;
  httpStatus: number;
  requestBodySummary?: string | null;
  sourceIp?: string | null;
  userAgent?: string | null;
  durationMs?: number | null;
}

const REDACT_PATTERN = /^(.*secret.*|.*token.*|.*key.*|.*password.*|raw_email)$/i;
const REDACT_ALLOWLIST = new Set(['secret_prefix', 'admin_key_prefix', 'key_hash', 'api_token_prefix', 'fio_token_prefix']);
const MAX_BYTES = 4096;

function truncateTo4KB(s: string): string {
  const encoded = new TextEncoder().encode(s);
  if (encoded.length <= MAX_BYTES) return s;
  return new TextDecoder().decode(encoded.slice(0, MAX_BYTES));
}

function redactObject(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(redactObject);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (!REDACT_ALLOWLIST.has(k) && REDACT_PATTERN.test(k)) {
        result[k] = '[REDACTED]';
      } else {
        result[k] = redactObject(v);
      }
    }
    return result;
  }
  return obj;
}

export function redactBodyForAudit(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    const redacted = redactObject(parsed);
    return truncateTo4KB(JSON.stringify(redacted));
  } catch {
    return truncateTo4KB(body);
  }
}

export function shouldAuditMethod(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
}

export async function recordAudit(args: AuditArgs): Promise<void> {
  const {
    db,
    authPrincipal,
    httpMethod,
    requestPath,
    httpStatus,
    requestBodySummary,
    sourceIp,
    userAgent,
    durationMs,
  } = args;

  const summary =
    requestBodySummary != null ? truncateTo4KB(requestBodySummary) : null;

  try {
    await db
      .prepare(
        `INSERT INTO admin_audit_log
          (auth_principal, http_method, request_path, http_status, request_body_summary, source_ip, user_agent, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        authPrincipal,
        httpMethod,
        requestPath,
        httpStatus,
        summary ?? null,
        sourceIp ?? null,
        userAgent ?? null,
        durationMs ?? null,
      )
      .run();
  } catch (err) {
    console.error('audit_write_failed', err);
  }
}

export async function listAuditLog(
  db: D1Database,
  args: {
    since?: string;
    authPrincipal?: string;
    limit?: number;
  } = {},
): Promise<
  Array<{
    id: number;
    auth_principal: string;
    http_method: string;
    request_path: string;
    http_status: number;
    request_body_summary: string | null;
    source_ip: string | null;
    user_agent: string | null;
    duration_ms: number | null;
    created_at: string;
  }>
> {
  const since =
    args.since ??
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const principal = args.authPrincipal ?? null;
  const limit = Math.min(args.limit ?? 50, 500);

  const result = await db
    .prepare(
      `SELECT id, auth_principal, http_method, request_path, http_status,
              request_body_summary, source_ip, user_agent, duration_ms, created_at
       FROM admin_audit_log
       WHERE created_at > datetime(?) AND (? IS NULL OR auth_principal = ?)
       ORDER BY id DESC
       LIMIT ?`,
    )
    .bind(since, principal, principal, limit)
    .all<{
      id: number;
      auth_principal: string;
      http_method: string;
      request_path: string;
      http_status: number;
      request_body_summary: string | null;
      source_ip: string | null;
      user_agent: string | null;
      duration_ms: number | null;
      created_at: string;
    }>();

  return result.results;
}
