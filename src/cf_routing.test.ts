import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRule, deleteRule, safeDeleteRule, cfRoutingEnabled, pairingEmail, CfRoutingError } from './cf_routing';

const cfgEnabled = {
  apiToken: 'test-token',
  zoneId: 'zone-abc',
  domain: 'banksync.festapp.net',
};
const cfgDisabled = {
  apiToken: undefined,
  zoneId: 'zone-abc',
  domain: 'banksync.festapp.net',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cfRoutingEnabled', () => {
  it('false when token undefined', () => expect(cfRoutingEnabled(cfgDisabled)).toBe(false));
  it('false when token empty', () => expect(cfRoutingEnabled({ ...cfgEnabled, apiToken: '' })).toBe(false));
  it('true when token set', () => expect(cfRoutingEnabled(cfgEnabled)).toBe(true));
});

describe('pairingEmail', () => {
  it('builds bank-<code>@<domain>', () => {
    expect(pairingEmail('banksync.festapp.net', 'abc123')).toBe('abc123@banksync.festapp.net');
  });
});

describe('createRule', () => {
  it('returns null when cf disabled (no fetch)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const id = await createRule(cfgDisabled, 'abc123');
    expect(id).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs to /zones/:id/email/routing/rules with bearer + literal matcher', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, result: { id: 'rule-xyz' }, errors: [] }), { status: 200 }),
    );
    const id = await createRule(cfgEnabled, 'abc123');
    expect(id).toBe('rule-xyz');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.cloudflare.com/client/v4/zones/zone-abc/email/routing/rules');
    expect(init?.method).toBe('POST');
    const headers = init!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-token');
    const body = JSON.parse(init!.body as string);
    expect(body.matchers).toEqual([{ type: 'literal', field: 'to', value: 'abc123@banksync.festapp.net' }]);
    expect(body.actions).toEqual([{ type: 'worker', value: ['banksync'] }]);
    expect(body.enabled).toBe(true);
  });

  it('throws CfRoutingError on CF 4xx', async () => {
    const buildResp = () => new Response(JSON.stringify({
      success: false,
      errors: [{ code: 10000, message: 'Authentication error' }],
    }), { status: 401 });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(buildResp())
      .mockResolvedValueOnce(buildResp());
    await expect(createRule(cfgEnabled, 'abc123')).rejects.toThrow(CfRoutingError);
    await expect(createRule(cfgEnabled, 'abc123')).rejects.toThrow(/cf_routing_create_failed.*Authentication error/);
  });

  it('throws when result.id missing even on 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, result: {}, errors: [] }), { status: 200 }),
    );
    await expect(createRule(cfgEnabled, 'abc123')).rejects.toThrow(CfRoutingError);
  });
});

describe('deleteRule', () => {
  it('skips fetch when cf disabled', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await deleteRule(cfgDisabled, 'rule-xyz');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('DELETEs the right URL with bearer', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, result: null, errors: [] }), { status: 200 }),
    );
    await deleteRule(cfgEnabled, 'rule-xyz');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.cloudflare.com/client/v4/zones/zone-abc/email/routing/rules/rule-xyz');
    expect(init?.method).toBe('DELETE');
    expect((init!.headers as Record<string, string>)['Authorization']).toBe('Bearer test-token');
  });

  it('treats 404 as idempotent success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('', { status: 404 }),
    );
    await expect(deleteRule(cfgEnabled, 'gone-rule')).resolves.toBeUndefined();
  });

  it('throws CfRoutingError on 5xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: 'CF down' }] }), { status: 500 }),
    );
    await expect(deleteRule(cfgEnabled, 'rule-xyz')).rejects.toThrow(CfRoutingError);
  });
});

describe('safeDeleteRule', () => {
  it('returns true on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    expect(await safeDeleteRule(cfgEnabled, 'rule-xyz')).toBe(true);
  });

  it('returns false on failure (does not throw)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network fail'));
    expect(await safeDeleteRule(cfgEnabled, 'rule-xyz')).toBe(false);
  });
});
