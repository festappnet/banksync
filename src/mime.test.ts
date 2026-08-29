import { describe, it, expect } from 'vitest';
import { extractEmailBody } from './mime.js';

function toStream(s: string): ReadableStream<Uint8Array> {
  return new Response(s).body!;
}

// Minimal valid RFC822 email builder
function makeRaw({
  subject = 'Test subject',
  from = 'noreply@fio.cz',
  to = 'bank-ABC123@banksync.festapp.net',
  messageId = '<test-001@fio.cz>',
  authResults,
  body = 'Test body text.',
  contentType = 'text/plain; charset=utf-8',
}: {
  subject?: string;
  from?: string;
  to?: string;
  messageId?: string;
  authResults?: string;
  body?: string;
  contentType?: string;
}): string {
  const lines: string[] = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    `MIME-Version: 1.0`,
    `Content-Type: ${contentType}`,
  ];
  if (authResults !== undefined) {
    lines.push(`Authentication-Results: ${authResults}`);
  }
  lines.push('');
  lines.push(body);
  return lines.join('\r\n');
}

// ----- test 1: plain Fio email — full DKIM+DMARC pass -----
describe('extractEmailBody', () => {
  it('plain Fio email — DKIM+DMARC pass + aligned', async () => {
    const raw = makeRaw({
      subject: 'Fio: Příchozí platba',
      from: 'noreply@fio.cz',
      authResults:
        'mx.cloudflare.com; dkim=pass header.d=fio.cz; dmarc=pass; spf=pass',
      body: 'Na váš účet dorazila platba 100,00 CZK.',
    });
    const result = await extractEmailBody(toStream(raw));
    expect(result.dkimPass).toBe(true);
    expect(result.dmarcPass).toBe(true);
    expect(result.dkimDomain).toBe('fio.cz');
    expect(result.isAligned).toBe(true);
    expect(result.from).toBe('noreply@fio.cz');
    expect(result.subject).toBe('Fio: Příchozí platba');
    expect(result.text).toContain('platba');
  });

  // ----- test 2: MIME-encoded subject -----
  it('MIME-encoded subject decodes to UTF-8', async () => {
    // base64 of "Fio platba došla"
    const encoded = Buffer.from('Fio platba došla').toString('base64');
    const raw = makeRaw({
      subject: `=?UTF-8?B?${encoded}?=`,
      authResults: 'mx.cf.com; dkim=pass header.d=fio.cz; dmarc=pass',
    });
    const result = await extractEmailBody(toStream(raw));
    expect(result.subject).toBe('Fio platba došla');
  });

  // ----- test 3: DKIM alignment fail (anti-spoof critical) -----
  it('DKIM alignment fail — header.d=attacker.example with From: fio.cz', async () => {
    const raw = makeRaw({
      from: 'noreply@fio.cz',
      authResults: 'mx.cf.com; dkim=pass header.d=attacker.example; spf=fail',
    });
    const result = await extractEmailBody(toStream(raw));
    expect(result.dkimPass).toBe(true);
    expect(result.dkimDomain).toBe('attacker.example');
    expect(result.dmarcPass).toBe(false);
    expect(result.isAligned).toBe(false);
  });

  // ----- test 4: subdomain alignment — mail.fio.cz aligned with fio.cz -----
  it('subdomain alignment — From: mail.fio.cz, dkim d=fio.cz → aligned', async () => {
    const raw = makeRaw({
      from: 'noreply@mail.fio.cz',
      authResults: 'mx.cf.com; dkim=pass header.d=fio.cz',
    });
    const result = await extractEmailBody(toStream(raw));
    expect(result.dkimPass).toBe(true);
    expect(result.dkimDomain).toBe('fio.cz');
    expect(result.dmarcPass).toBe(false);
    expect(result.isAligned).toBe(true);
  });

  // ----- test 5: DMARC pass overrides DKIM domain mismatch -----
  it('dmarc=pass makes isAligned true even when dkim domain mismatches', async () => {
    const raw = makeRaw({
      from: 'noreply@fio.cz',
      authResults:
        'mx.cf.com; dkim=pass header.d=attacker.example; dmarc=pass',
    });
    const result = await extractEmailBody(toStream(raw));
    expect(result.dmarcPass).toBe(true);
    expect(result.dkimDomain).toBe('attacker.example');
    expect(result.isAligned).toBe(true);
  });

  // ----- test 6: No Authentication-Results header -----
  it('missing Authentication-Results → all auth false, authResults undefined', async () => {
    const raw = makeRaw({});
    const result = await extractEmailBody(toStream(raw));
    expect(result.authResults).toBeUndefined();
    expect(result.dkimPass).toBe(false);
    expect(result.dmarcPass).toBe(false);
    expect(result.isAligned).toBe(false);
    expect(result.dkimDomain).toBeUndefined();
  });

  // ----- test 7: HTML-only body -----
  it('HTML-only body extracts readable text after tag stripping', async () => {
    const htmlBody =
      '<html><body><p>Příchozí platba <strong>500,00 CZK</strong> dorazila.</p></body></html>';
    const boundary = '----=_Part_1_boundary';
    const multipart = [
      `From: noreply@fio.cz`,
      `To: bank-X@banksync.festapp.net`,
      `Subject: Fio HTML`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      `Authentication-Results: mx.cf.com; dkim=pass header.d=fio.cz; dmarc=pass`,
      ``,
      `--${boundary}`,
      `Content-Type: text/html; charset=utf-8`,
      ``,
      htmlBody,
      `--${boundary}--`,
    ].join('\r\n');

    const result = await extractEmailBody(toStream(multipart));
    expect(result.text).toContain('500,00 CZK');
    expect(result.text).toContain('platba');
    expect(result.text).not.toContain('<p>');
    expect(result.text).not.toContain('<strong>');
  });
});
