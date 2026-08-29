import { describe, expect, it, vi, afterEach } from 'vitest';
import { fetchNewTransactions, FioRateLimited, FioTransientFailure, mapFioTransaction, setFioPointer, type FioTransaction } from './fio';

function fioTx(overrides: Partial<FioTransaction> = {}): FioTransaction {
  return {
    column0: { value: '2026-05-08' },
    column1: { value: '1990.50' },
    column2: { value: '987654321' },
    column3: { value: '0300' },
    column4: { value: '0008' },
    column5: { value: '12345' },
    column6: { value: '777' },
    column7: { value: 'User note' },
    column8: { value: 'Credit transfer' },
    column9: { value: 'API' },
    column10: { value: 'Test Sender' },
    column12: { value: 'CSOB' },
    column14: { value: 'CZK' },
    column16: { value: 'Payment message' },
    column17: { value: '555' },
    column22: { value: '999000111' },
    column25: { value: 'Comment' },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mapFioTransaction', () => {
  it('maps representative Fio JSON columns to BankSync transaction payload', () => {
    const mapped = mapFioTransaction(fioTx());
    expect(mapped).not.toBeNull();
    expect(mapped).toMatchObject({
      amount_cents: 199050,
      currency: 'CZK',
      counter_account: '987654321',
      bank_code: '0300',
      ks: '0008',
      vs: '12345',
      ss: '777',
      user_identification: 'User note',
      transaction_type: 'Credit transfer',
      performed_by: 'API',
      sender_name: 'Test Sender',
      bank_name: 'CSOB',
      message: 'Payment message',
      command_id: '555',
      transaction_id: '999000111',
      comment: 'Comment',
      source: 'fio_api',
      external_id: null,
    });
    expect(mapped!.date).toBe('2026-05-08T12:00:00.000Z');
  });

  it('drops outgoing and zero payments', () => {
    expect(mapFioTransaction(fioTx({ column1: { value: '-10.00' } }))).toBeNull();
    expect(mapFioTransaction(fioTx({ column1: { value: '0.00' } }))).toBeNull();
  });

  it('throws on missing or unknown currency', () => {
    expect(() => mapFioTransaction(fioTx({ column14: undefined }))).toThrow('unknown_currency');
    expect(() => mapFioTransaction(fioTx({ column14: { value: 'BTC' } }))).toThrow('unknown_currency');
  });
});

describe('Fio API client', () => {
  it('fetchNewTransactions returns transaction array from Fio response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      accountStatement: { transactionList: { transaction: [fioTx()] } },
    }), { status: 200 })));

    const rows = await fetchNewTransactions('token-123');
    expect(rows).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith('https://fioapi.fio.cz/v1/rest/last/token-123/transactions.json');
  });

  it('fetchNewTransactions handles 429 as rate limited', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('rate limited', {
      status: 429,
      headers: { 'Retry-After': '60' },
    })));

    await expect(fetchNewTransactions('token-123')).rejects.toBeInstanceOf(FioRateLimited);
    await expect(fetchNewTransactions('token-123')).rejects.toMatchObject({ retryAfterS: 60 });
  });

  it('fetchNewTransactions handles 5xx as transient failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad gateway', { status: 502 })));
    await expect(fetchNewTransactions('token-123')).rejects.toBeInstanceOf(FioTransientFailure);
  });

  it('setFioPointer calls date endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok', { status: 200 })));
    await setFioPointer('token-123', '2026-02-07');
    expect(fetch).toHaveBeenCalledWith('https://fioapi.fio.cz/v1/rest/set-last-date/token-123/2026-02-07/');
  });

  const PROXY = { url: 'https://supabase.example/functions/v1/fio-proxy', secret: 's3cr3t' };

  it('fetchNewTransactions routes through the egress proxy when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      accountStatement: { transactionList: { transaction: [fioTx()] } },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const rows = await fetchNewTransactions('token-123', PROXY);
    expect(rows).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(PROXY.url);
    expect(init.method).toBe('POST');
    expect(init.headers['x-fio-proxy-secret']).toBe(PROXY.secret);
    expect(JSON.parse(init.body)).toEqual({ op: 'transactions', token: 'token-123' });
  });

  it('setFioPointer routes through the egress proxy when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await setFioPointer('token-123', '2026-02-07', PROXY);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(PROXY.url);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ op: 'set-last-date', token: 'token-123', date: '2026-02-07' });
  });

  it('proxy-forwarded Fio 525 still surfaces as transient failure (the incident path)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ssl handshake failed', { status: 525 })));
    await expect(fetchNewTransactions('token-123', PROXY)).rejects.toBeInstanceOf(FioTransientFailure);
  });

  it('falls back to a direct Fio fetch when no proxy is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      accountStatement: { transactionList: { transaction: [] } },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchNewTransactions('token-123');
    expect(fetchMock).toHaveBeenCalledWith('https://fioapi.fio.cz/v1/rest/last/token-123/transactions.json');
  });
});
