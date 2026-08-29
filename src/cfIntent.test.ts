import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { BankAccount } from './types';

// Mock the leaves so we can observe call ORDER without a real CF API or DB.
vi.mock('./cf_routing', () => ({
  createRule: vi.fn(),
  safeDeleteRule: vi.fn(),
  CfRoutingError: class CfRoutingError extends Error {
    constructor(public status: number, public cfErrors: unknown[], summary: string) {
      super(summary);
      this.name = 'CfRoutingError';
    }
  },
}));
vi.mock('./db', () => ({ regenerateBankAccountPairing: vi.fn() }));
vi.mock('./outbox', () => ({ enqueueDelete: vi.fn(), markCompleted: vi.fn(), markFailureAttempt: vi.fn() }));

import * as cfRouting from './cf_routing';
import * as db from './db';
import { regenerateRoute } from './cfIntent';

const createRule = cfRouting.createRule as Mock;
const safeDeleteRule = cfRouting.safeDeleteRule as Mock;
const regenPairing = db.regenerateBankAccountPairing as Mock;

const fakeDb = {} as never;
const fakeCfg = { apiToken: 't', zoneId: 'z', domain: 'd' } as never;

function mkAccount(over: Partial<BankAccount> = {}): BankAccount {
  return {
    id: 7, account_number: '2200/2010', account_type: 'FIO', ingest_mode: 'email',
    pairing_code: 'cafebabe01', label: null, owner_app_id: null, cf_rule_id: 'new-rule-id',
    api_token_set: false, api_token_prefix: null, api_fetch_enabled: false,
    api_last_fetch_at: null, api_last_success_at: null, api_last_error: null,
    api_backfill_done: false, created_at: '2026-01-01T00:00:00Z', ...over,
  };
}

beforeEach(() => {
  createRule.mockReset();
  safeDeleteRule.mockReset();
  regenPairing.mockReset();
});

describe('regenerateRoute — zero-downtime create-before-delete', () => {
  it('creates the NEW rule before deleting the OLD one', async () => {
    const calls: string[] = [];
    createRule.mockImplementation(async () => { calls.push('create'); return 'new-rule-id'; });
    regenPairing.mockImplementation(async () => { calls.push('db'); return mkAccount(); });
    safeDeleteRule.mockImplementation(async () => { calls.push('delete'); return true; });

    const result = await regenerateRoute(fakeDb, fakeCfg, { id: 7, existingCfRuleId: 'old-rule-id', newPairing: 'cafebabe01' });

    expect(result).toEqual({ ok: true, account: mkAccount() });
    // Strict ordering: new rule created, pairing swapped, THEN old rule deleted.
    expect(calls).toEqual(['create', 'db', 'delete']);
    expect(calls.indexOf('create')).toBeLessThan(calls.indexOf('delete'));
    // It is the OLD rule that gets deleted, with the new one already live.
    expect(safeDeleteRule).toHaveBeenCalledWith(fakeCfg, 'old-rule-id');
  });

  it('does not delete anything when the account had no prior rule', async () => {
    createRule.mockResolvedValue('new-rule-id');
    regenPairing.mockResolvedValue(mkAccount());

    const result = await regenerateRoute(fakeDb, fakeCfg, { id: 7, existingCfRuleId: null, newPairing: 'cafebabe01' });

    expect(result.ok).toBe(true);
    expect(safeDeleteRule).not.toHaveBeenCalled();
  });

  it('hard-fails (no DB mutate, no delete) when the new CF rule cannot be created', async () => {
    createRule.mockRejectedValue(new cfRouting.CfRoutingError(503, [], 'cf down'));

    const result = await regenerateRoute(fakeDb, fakeCfg, { id: 7, existingCfRuleId: 'old-rule-id', newPairing: 'cafebabe01' });

    expect(result).toEqual({ ok: false, status: 503, body: { error: 'cf_routing_create_failed', detail: expect.stringContaining('cf down') } });
    expect(regenPairing).not.toHaveBeenCalled();
    expect(safeDeleteRule).not.toHaveBeenCalled();
  });

  it('non-CfRoutingError create failure surfaces as 500', async () => {
    createRule.mockRejectedValue(new Error('boom'));
    const result = await regenerateRoute(fakeDb, fakeCfg, { id: 7, existingCfRuleId: 'old', newPairing: 'cafebabe01' });
    expect(result).toMatchObject({ ok: false, status: 500 });
  });

  it('rolls back the NEW rule and 404s when the account row vanished mid-rotation', async () => {
    createRule.mockResolvedValue('new-rule-id');
    regenPairing.mockResolvedValue(null);

    const result = await regenerateRoute(fakeDb, fakeCfg, { id: 7, existingCfRuleId: 'old-rule-id', newPairing: 'cafebabe01' });

    expect(result).toEqual({ ok: false, status: 404, body: { error: 'not_found' } });
    // The just-created rule is rolled back; the old one is NOT touched.
    expect(safeDeleteRule).toHaveBeenCalledTimes(1);
    expect(safeDeleteRule).toHaveBeenCalledWith(fakeCfg, 'new-rule-id');
  });
});
