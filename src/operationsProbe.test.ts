import { describe, it, expect, vi } from 'vitest';
import type { ExecutionContext } from '@cloudflare/workers-types';
import worker, { type Env } from './cloudflare';
import { operationsDb } from './operationsTestSupport';

const token = 'test-only-operations-read-token-000000000';
function request(path = '/health/operations', auth = token, method = 'GET') {
  return new Request('https://banksync.test' + path, { method, headers: { Authorization: 'Bearer ' + auth } });
}
function environment(version = 13) {
  const fixture = operationsDb(version);
  return { ...fixture, env: { DB: fixture.db, ADMIN_SECRET: 'separate-admin-secret', OPERATIONS_READ_TOKEN: token } as Env };
}
const ctx = {} as ExecutionContext;
describe('optional read-only operational protocol', () => {
  it('rejects missing, weak and wrong credentials before any database access', async () => {
    const { env } = environment();
    const prepare = vi.spyOn(env.DB, 'prepare');
    expect((await worker.fetch(request(undefined, 'wrong'), env, ctx)).status).toBe(401);
    const unconfigured = { ...env }; delete unconfigured.OPERATIONS_READ_TOKEN;
    expect((await worker.fetch(request(), unconfigured, ctx)).status).toBe(401);
    expect((await worker.fetch(request(undefined, 'weak'), { ...env, OPERATIONS_READ_TOKEN: 'weak' }, ctx)).status).toBe(401);
    expect((await worker.fetch(request('/status'), env, ctx)).status).toBe(401);
    expect((await worker.fetch(request(undefined, token, 'POST'), env, ctx)).status).toBe(405);
    expect(prepare).not.toHaveBeenCalled();
  });
  it('returns bounded aggregates without bank identities or database writes', async () => {
    const { env, sqlite } = environment();
    sqlite.exec(`INSERT INTO bank_accounts(id,account_number,pairing_code,api_fetch_enabled,ingest_mode,api_last_success_at)
      VALUES(1,'1234/2010','private-pairing-code',1,'api',datetime('now','-2 hours'));
      INSERT INTO schema_meta(key,value) VALUES('last_maintenance_at',datetime('now')),('last_backup_at',datetime('now'));`);
    const before = sqlite.prepare('SELECT total_changes() n').get();
    const response = await worker.fetch(request(), env, ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const data = await response.json() as { major: number; metrics: Record<string, number | null> };
    expect(data.major).toBe(1);
    expect(data.metrics.api_accounts).toBe(1);
    expect(data.metrics.api_freshness_age_s).toBeGreaterThanOrEqual(7200);
    expect(data.metrics.db_growth_bytes_per_day).toBeNull();
    expect(Object.values(data.metrics).every(value => value === null || Number.isSafeInteger(value))).toBe(true);
    expect(JSON.stringify(data)).not.toMatch(/1234|private-pairing-code|account_number|callback_url|secret/);
    expect(sqlite.prepare('SELECT total_changes() n').get()).toEqual(before);
  });
  it('fails closed on unsupported schema and storage failure with no exception details', async () => {
    const { env } = environment(12);
    expect((await worker.fetch(request(), env, ctx)).status).toBe(503);
    vi.spyOn(env.DB, 'prepare').mockImplementation(() => { throw Error('private-db-failure'); });
    const response = await worker.fetch(request(), env, ctx);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'operations_unavailable' });
  });
});
