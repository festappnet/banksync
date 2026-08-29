import type { D1Database } from '@cloudflare/workers-types';
import { findConsumerByAdminKeyPrefix } from './db';

export type AuthContext =
  | { type: 'admin' }
  | { type: 'tenant'; app_id: string }
  | { type: 'unauth' };

export interface AuthEnv {
  DB: D1Database;
  ADMIN_SECRET: string;
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function hashKey(plain: string): Promise<string> {
  const bytes = new TextEncoder().encode(plain);
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function generateTenantAdminKey(): Promise<{ plain: string; prefix: string; hash: string }> {
  const random = crypto.getRandomValues(new Uint8Array(32));
  // base64url encode
  const b64 = btoa(String.fromCharCode(...random))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const plain = `bksk_${b64}`;
  const prefix = plain.slice(0, 12);
  const hash = await hashKey(plain);
  return { plain, prefix, hash };
}

export async function resolveAuth(req: Request, env: AuthEnv): Promise<AuthContext> {
  const adminSecret = req.headers.get('X-Admin-Secret');
  if (adminSecret && env.ADMIN_SECRET && timingSafeEqual(adminSecret, env.ADMIN_SECRET)) {
    return { type: 'admin' };
  }

  const tenantKey = req.headers.get('X-Tenant-Secret');
  if (tenantKey && tenantKey.length >= 12) {
    const prefix = tenantKey.slice(0, 12);
    const consumer = await findConsumerByAdminKeyPrefix(env.DB, prefix);
    if (consumer && consumer.admin_key_hash) {
      const candidateHash = await hashKey(tenantKey);
      if (timingSafeEqual(candidateHash, consumer.admin_key_hash)) {
        return { type: 'tenant', app_id: consumer.app_id };
      }
    }
  }

  return { type: 'unauth' };
}
