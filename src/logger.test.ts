import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { log, logError } from './logger.js';

describe('logger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('log() outputs JSON with ts, event, and data', () => {
    log('email_received', { pairing_code: 'abc' });

    expect(logSpy).toHaveBeenCalledOnce();
    const arg = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(arg);

    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(parsed.event).toBe('email_received');
    expect(parsed.pairing_code).toBe('abc');
  });

  it('log() with secret key redacts value', () => {
    log('boot', { secret: 'whsec_aaaaa' });

    expect(logSpy).toHaveBeenCalledOnce();
    const arg = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(arg);

    expect(parsed.secret).toBe('[REDACTED]');
  });

  it('log() with fio_secret redacts value', () => {
    log('boot', { fio_secret: 'topsecret' });

    expect(logSpy).toHaveBeenCalledOnce();
    const arg = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(arg);

    expect(parsed.fio_secret).toBe('[REDACTED]');
  });

  it('log() redacts nested secret keys', () => {
    log('boot', { user: { secret: 'inner', name: 'ok' } });

    expect(logSpy).toHaveBeenCalledOnce();
    const arg = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(arg);

    expect(parsed.user.secret).toBe('[REDACTED]');
    expect(parsed.user.name).toBe('ok');
  });

  it('log() preserves secret_prefix in allow-list', () => {
    log('boot', { secret_prefix: 'whsec_' });

    expect(logSpy).toHaveBeenCalledOnce();
    const arg = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(arg);

    expect(parsed.secret_prefix).toBe('whsec_');
  });

  it('log() without data argument works', () => {
    log('event_only');

    expect(logSpy).toHaveBeenCalledOnce();
    const arg = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(arg);

    expect(parsed.event).toBe('event_only');
    expect(parsed.ts).toBeDefined();
  });

  it('logError() outputs JSON with ts, event, error, and data', () => {
    const err = new Error('500 Internal');
    logError('webhook_failed', err, { consumer_app_id: 'festapp' });

    expect(errorSpy).toHaveBeenCalledOnce();
    const arg = errorSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(arg);

    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(parsed.event).toBe('webhook_failed');
    expect(parsed.error).toBe('Error: 500 Internal');
    expect(parsed.consumer_app_id).toBe('festapp');
  });

  it('logError() without data argument works', () => {
    logError('parse_failed', new Error('Invalid format'));

    expect(errorSpy).toHaveBeenCalledOnce();
    const arg = errorSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(arg);

    expect(parsed.error).toBe('Error: Invalid format');
    expect(parsed.ts).toBeDefined();
  });

  it('logError() redacts secrets in data', () => {
    logError('webhook_failed', new Error('500'), { webhook_kek: 'secret' });

    expect(errorSpy).toHaveBeenCalledOnce();
    const arg = errorSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(arg);

    expect(parsed.webhook_kek).toBe('[REDACTED]');
  });

  it('log() redacts array of objects with secrets', () => {
    log('batch_event', { items: [{ secret: 'x', name: 'y' }, { secret: 'z', name: 'w' }] });

    expect(logSpy).toHaveBeenCalledOnce();
    const arg = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(arg);

    expect(parsed.items[0]?.secret).toBe('[REDACTED]');
    expect(parsed.items[0]?.name).toBe('y');
    expect(parsed.items[1]?.secret).toBe('[REDACTED]');
    expect(parsed.items[1]?.name).toBe('w');
  });

  it('log() handles deeply nested structures', () => {
    log('deep', { level1: { level2: { level3: { encryption_key: 'secret', value: 42 } } } });

    expect(logSpy).toHaveBeenCalledOnce();
    const arg = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(arg);

    expect(parsed.level1.level2.level3.encryption_key).toBe('[REDACTED]');
    expect(parsed.level1.level2.level3.value).toBe(42);
  });

  it('logError() handles non-Error objects', () => {
    logError('custom_error', 'some string error');

    expect(errorSpy).toHaveBeenCalledOnce();
    const arg = errorSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(arg);

    expect(parsed.error).toBe('some string error');
  });

  it('log() handles primitives correctly (no crash on null/undefined)', () => {
    log('primitives', { nullVal: null, undefinedVal: undefined, boolVal: true, numVal: 42, strVal: 'hello' });

    expect(logSpy).toHaveBeenCalledOnce();
    const arg = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(arg);

    expect(parsed.nullVal).toBeNull();
    expect(parsed.undefinedVal).toBeUndefined();
    expect(parsed.boolVal).toBe(true);
    expect(parsed.numVal).toBe(42);
    expect(parsed.strVal).toBe('hello');
  });

  it('log() case-insensitive key matching for redaction', () => {
    log('test', {
      SECRET: 'caps',
      Secret: 'mixed',
      api_secret: 'secret_suffix',
      Api_Secret: 'secret_suffix_mixed',
    });

    expect(logSpy).toHaveBeenCalledOnce();
    const arg = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(arg);

    expect(parsed.SECRET).toBe('[REDACTED]');
    expect(parsed.Secret).toBe('[REDACTED]');
    expect(parsed.api_secret).toBe('[REDACTED]');
    expect(parsed.Api_Secret).toBe('[REDACTED]');
  });

  it('log() redacts all *_key patterns', () => {
    log('keys', { api_key: 'secret', jwt_key: 'secret', db_key: 'secret', custom_kek: 'secret' });

    expect(logSpy).toHaveBeenCalledOnce();
    const arg = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(arg);

    expect(parsed.api_key).toBe('[REDACTED]');
    expect(parsed.jwt_key).toBe('[REDACTED]');
    expect(parsed.db_key).toBe('[REDACTED]');
    expect(parsed.custom_kek).toBe('[REDACTED]');
  });

  it('log() redacts raw_email', () => {
    log('test', { raw_email: 'From: <sender@test.com>\nTo: <user@test.com>' });

    expect(logSpy).toHaveBeenCalledOnce();
    const arg = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(arg);

    expect(parsed.raw_email).toBe('[REDACTED]');
  });
});
