import type { ExtractedEmail } from './mime';
import type { BankAccount } from './types';
import type { ParsedEmailTransaction } from './parser';
import { detectProvider, parseEmail } from './parser';
import type { AuthenticatedEmailIdentity } from './email_auth';

/**
 * Pure ingest decision for an inbound bank email. No I/O: the caller resolves the
 * bank account (by pairing code), then applies the chosen outcome —
 *   reject / skip → insertParseLog(reason)
 *   insert        → insertTransaction(parsed) + webhook fan-out
 *
 * `received` marks the decisions that occur AFTER the email clears the security
 * gate (auth + DKIM alignment + allowed sender + known account + email ingest
 * enabled). The caller fires the `email_received` audit effect for exactly those
 * outcomes, preserving the original ordering (audit before provider/parse).
 */
export type EmailOutcome =
  | { kind: 'reject'; reason: string; bankAccountId: number | null; received: boolean }
  | { kind: 'skip'; reason: string; bankAccountId: number; received: true }
  | { kind: 'insert'; account: BankAccount; parsed: ParsedEmailTransaction; received: true };

/** Pairing code = leading hex label of the To: address (10 hex in prod; {4,32} for tests). */
export function extractPairingCode(toAddress: string): string | null {
  const m = toAddress.match(/^([0-9a-f]{4,32})@/i);
  return m ? m[1]!.toLowerCase() : null;
}

/** Parse the comma-separated SENDER_ALLOWLIST env into normalized entries. */
export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Allow-list match. Entry format: '@domain.tld' matches any user@domain.tld (and
 * subdomains); otherwise an exact email match. Domain matching leans on DKIM
 * alignment (checked earlier) so a forged From: from a bank domain cannot pass.
 */
function senderAllowed(from: string, allowlist: string[]): boolean {
  if (!from) return false;
  const fromLc = from.toLowerCase();
  const fromDomain = fromLc.includes('@') ? fromLc.slice(fromLc.indexOf('@') + 1) : '';
  for (const entry of allowlist) {
    if (entry.startsWith('@')) {
      const dom = entry.slice(1);
      if (fromDomain === dom || fromDomain.endsWith('.' + dom)) return true;
    } else if (fromLc === entry) {
      return true;
    }
  }
  return false;
}

export function classifyEmail(
  extracted: ExtractedEmail,
  identity: AuthenticatedEmailIdentity,
  account: BankAccount | null,
  allowlist: string[],
): EmailOutcome {
  if (!senderAllowed(identity.sender, allowlist)) {
    return { kind: 'reject', reason: 'sender_not_allowed', bankAccountId: null, received: false };
  }

  // Step 5: extract pairing_code from To: <code>@banksync.<domain>
  const toAddress = identity.recipient;
  const pairingCode = extractPairingCode(toAddress);
  if (!pairingCode) {
    return { kind: 'reject', reason: `no_pairing_code: ${toAddress}`, bankAccountId: null, received: false };
  }

  // Step 6: bank account must exist for this pairing code
  if (!account) {
    return { kind: 'reject', reason: `unknown_pairing_code: ${pairingCode}`, bankAccountId: null, received: false };
  }

  // Step 6b: ingest-mode gate (api-only accounts reject email ingest)
  if (account.ingest_mode === 'api') {
    return { kind: 'reject', reason: 'email_ingest_disabled', bankAccountId: account.id, received: false };
  }

  // --- email cleared the security gate; everything below is `received` ---

  // Step 7: detect provider
  const provider = detectProvider(extracted.text, account.account_number);
  if (provider === 'unknown') {
    return { kind: 'reject', reason: `unknown_provider: ${account.account_number}`, bankAccountId: account.id, received: true };
  }

  // Step 8: parse email body
  let parsed: ParsedEmailTransaction | null;
  try {
    parsed = parseEmail(extracted.text, provider);
  } catch (err) {
    return { kind: 'reject', reason: `${err}`.replace(/^Error:\s*/, ''), bankAccountId: account.id, received: true };
  }

  if (parsed === null) {
    // Distinguish "not a transaction email" (expected bank noise) from a real parser bug.
    // Transaction emails always contain a currency or amount pattern; non-transaction
    // emails (statements, marketing, security alerts) don't → classify separately so
    // metrics stay clean.
    const looksLikeTransaction = /\d[\s.,]\d|Kč|CZK|EUR|USD/i.test(extracted.text);
    return looksLikeTransaction
      ? { kind: 'reject', reason: `parse_failed: ${provider}`, bankAccountId: account.id, received: true }
      : { kind: 'skip', reason: `not_transaction: ${provider}`, bankAccountId: account.id, received: true };
  }

  // Step 9 decision: insert the parsed transaction (caller performs the DB write).
  return { kind: 'insert', account, parsed, received: true };
}
