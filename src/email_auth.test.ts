import { describe, expect, it } from 'vitest';
import { authenticateEmailIdentity, EmailAuthenticationError, inspectAuthenticationResults } from './email_auth';

const base = {
  mailFrom: 'noreply@fio.cz',
  rcptTo: 'aabbccdd11@banksync.example.com',
  trustedAuthservId: 'mx.cloudflare.net',
  authenticationResults: 'mx.cloudflare.net; dkim=pass header.d=fio.cz; dmarc=pass header.from=fio.cz',
};
const mime = { fromHeader: 'noreply@fio.cz', toHeader: 'aabbccdd11@banksync.example.com' };

describe('authenticateEmailIdentity', () => {
  it('extracts only one bounded DNS-shaped authserv-id for bootstrap logging', () => {
    expect(inspectAuthenticationResults('MX.Cloudflare.Net; dkim=pass header.d=fio.cz')).toEqual({
      observedAuthservId: 'mx.cloudflare.net',
      ambiguous: false,
    });
    expect(inspectAuthenticationResults('mx.cloudflare.net; dkim=pass, attacker.example; dkim=pass')).toEqual({
      observedAuthservId: null,
      ambiguous: true,
    });
    expect(inspectAuthenticationResults('attacker value; dkim=pass')).toEqual({
      observedAuthservId: null,
      ambiguous: false,
    });
  });

  it('accepts one aligned result from the configured authserv-id', () => {
    expect(authenticateEmailIdentity(base, mime)).toEqual({
      sender: 'noreply@fio.cz',
      recipient: 'aabbccdd11@banksync.example.com',
      authenticatedDomain: 'fio.cz',
      mechanism: 'dmarc',
    });
  });

  it('accepts relaxed DKIM subdomain alignment', () => {
    const evidence = { ...base, mailFrom: 'robot@mail.fio.cz', authenticationResults: 'mx.cloudflare.net; dkim=pass header.d=fio.cz; dmarc=fail header.from=mail.fio.cz' };
    expect(authenticateEmailIdentity(evidence, { ...mime, fromHeader: 'robot@mail.fio.cz' }).mechanism).toBe('dkim');
  });

  it.each([
    [null, 'trusted_authentication_missing'],
    ['attacker.example; dkim=pass header.d=fio.cz', 'trusted_authentication_ambiguous'],
    ['mx.cloudflare.net; dkim=pass header.d=fio.cz, mx.cloudflare.net; dkim=pass header.d=fio.cz', 'trusted_authentication_ambiguous'],
    ['attacker.example; dkim=pass header.d=evil.example, mx.cloudflare.net; dkim=pass header.d=fio.cz', 'trusted_authentication_ambiguous'],
    ['mx.cloudflare.net; dkim=fail header.d=evil.example, attacker.example; dkim=pass header.d=fio.cz', 'trusted_authentication_ambiguous'],
    ['mx.cloudflare.net; dkim=fail header.d=evil.example; dmarc=fail header.from=fio.cz; dkim=pass header.d=fio.cz', 'authenticated_sender_not_aligned'],
    ['mx.cloudflare.net; dkim=pass header.d=evil.example', 'authenticated_sender_not_aligned'],
  ])('rejects ambiguous or unaligned trusted evidence', (authenticationResults, code) => {
    expect(() => authenticateEmailIdentity({ ...base, authenticationResults }, mime))
      .toThrowError(expect.objectContaining({ code }) as EmailAuthenticationError);
  });

  it('rejects MIME identity disagreement with the envelope', () => {
    expect(() => authenticateEmailIdentity(base, { ...mime, fromHeader: 'attacker@example.com' }))
      .toThrowError(expect.objectContaining({ code: 'email_identity_mismatch' }) as EmailAuthenticationError);
  });
});
