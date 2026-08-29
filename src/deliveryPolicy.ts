// Pure delivery policy. State transitions are first expressed here as a small
// domain function/table, then the SAME rules are enforced by the fenced SQL in
// webhookDelivery.ts. Reducer tests never substitute for the SQL integration
// tests — they only prove the policy is correct in isolation.

export type OutcomeKind = 'delivered' | 'retryable' | 'queue_retry' | 'terminal';

/** Automatic HTTP attempts before the coordinator gives up and writes a
 * terminal incident. Producer (dispatch) failures are counted separately and do
 * not consume this budget. */
export const MAX_AUTOMATIC_HTTP_ATTEMPTS = 32;

/**
 * Classify an HTTP response status into a transport outcome.
 * - 2xx        → delivered (transport accepted; business outcome is separate)
 * - 408/429/5xx→ retryable (transient)
 * - other 4xx  → terminal (consumer bug; repeating the same request won't help)
 * - anything else (defensive) → retryable
 */
export function classifyHttpStatus(status: number): 'delivered' | 'retryable' | 'terminal' {
  if (status >= 200 && status <= 299) return 'delivered';
  if (status === 408 || status === 429 || status >= 500) return 'retryable';
  if (status >= 400 && status <= 499) return 'terminal';
  return 'retryable';
}

/** Exponential backoff over the HTTP attempt count, capped at one hour. Used
 * when the app sweep owns the next attempt (job returned to `pending`). */
export function retryDelaySeconds(httpAttempt: number): number {
  return Math.min(30 * 2 ** Math.max(0, httpAttempt - 1), 3600);
}

/** Exponential backoff for a Cloudflare-owned retry (msg.retry delay), capped
 * at 30 minutes to stay within the queue ownership horizon. */
export function backoffSeconds(attempts: number): number {
  return Math.min(30 * 2 ** (attempts - 1), 1800);
}

/**
 * Whether an attempt should become terminal: either explicitly terminal, or the
 * automatic HTTP attempt budget is exhausted. Evaluated over the ALREADY
 * incremented attempt count so the limit is applied atomically with the write.
 */
export function isTerminalOutcome(kind: OutcomeKind, httpAttemptAfterIncrement: number): boolean {
  return kind === 'terminal' || httpAttemptAfterIncrement >= MAX_AUTOMATIC_HTTP_ATTEMPTS;
}
