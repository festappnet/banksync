export interface EmailEnvelopeEvidence {
  mailFrom: string;
  rcptTo: string;
  authenticationResults: string | null;
  trustedAuthservId: string;
}

export interface AuthenticatedEmailIdentity {
  sender: string;
  recipient: string;
  authenticatedDomain: string;
  mechanism: 'dmarc' | 'dkim';
}

export class EmailAuthenticationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'EmailAuthenticationError';
  }
}

function normalizeAddress(value: string | undefined): string | null {
  if (!value) return null;
  const match = /<([^<>]+)>/.exec(value);
  const normalized = (match?.[1] ?? value).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(normalized) ? normalized : null;
}

function addressDomain(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1);
}

function aligned(child: string, parent: string): boolean {
  return child === parent || child.endsWith(`.${parent}`);
}

function resultDomain(fields: string[], mechanism: 'dkim' | 'dmarc'): string | null {
  const property = mechanism === 'dkim' ? 'header.d' : 'header.from';
  const mechanismFields = fields.filter(value => new RegExp(`^${mechanism}\\s*=`, 'i').test(value));
  if (mechanismFields.length !== 1) return null;
  const field = mechanismFields[0]!;
  if (!new RegExp(`^${mechanism}\\s*=\\s*pass\\b`, 'i').test(field)) return null;
  const match = new RegExp(`(?:^|\\s)${property.replace('.', '\\.')}=([^\\s;,]+)`, 'i').exec(field);
  return match?.[1]?.toLowerCase().replace(/\.$/, '') ?? null;
}

/**
 * Authenticate identity only from the Cloudflare SMTP envelope and the single
 * Authentication-Results field whose authserv-id is configured by the owner.
 * Raw MIME headers are used solely to require identity agreement.
 */
export function authenticateEmailIdentity(
  evidence: EmailEnvelopeEvidence,
  mime: { fromHeader: string | undefined; toHeader: string | undefined },
): AuthenticatedEmailIdentity {
  const sender = normalizeAddress(evidence.mailFrom);
  const recipient = normalizeAddress(evidence.rcptTo);
  const headerSender = normalizeAddress(mime.fromHeader);
  const headerRecipient = normalizeAddress(mime.toHeader);
  if (!sender || !recipient || !headerSender || !headerRecipient) {
    throw new EmailAuthenticationError('email_identity_missing');
  }
  if (sender !== headerSender || recipient !== headerRecipient) {
    throw new EmailAuthenticationError('email_identity_mismatch');
  }

  const trusted = evidence.trustedAuthservId.trim().toLowerCase();
  const auth = evidence.authenticationResults?.trim() ?? '';
  if (!trusted || !auth) throw new EmailAuthenticationError('trusted_authentication_missing');
  // Headers.get() combines repeated Authentication-Results fields with commas.
  // Reject every combined/ambiguous value instead of allowing an appended
  // untrusted result to contribute a passing method or identity property.
  const separator = auth.indexOf(';');
  const observedAuthservId = separator >= 0 ? auth.slice(0, separator).trim().toLowerCase() : '';
  if (auth.includes(',') || observedAuthservId !== trusted) {
    throw new EmailAuthenticationError('trusted_authentication_ambiguous');
  }
  const fields = auth.split(';').slice(1).map(value => value.trim()).filter(Boolean);

  const senderDomain = addressDomain(sender);
  const dmarcDomain = resultDomain(fields, 'dmarc');
  if (dmarcDomain && aligned(senderDomain, dmarcDomain)) {
    return { sender, recipient, authenticatedDomain: dmarcDomain, mechanism: 'dmarc' };
  }
  const dkimDomain = resultDomain(fields, 'dkim');
  if (dkimDomain && aligned(senderDomain, dkimDomain)) {
    return { sender, recipient, authenticatedDomain: dkimDomain, mechanism: 'dkim' };
  }
  throw new EmailAuthenticationError('authenticated_sender_not_aligned');
}
