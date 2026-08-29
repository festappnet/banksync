import type { D1Database, Queue } from '@cloudflare/workers-types';
import { ulid } from 'ulid';
import { buildWebhookEnvelope } from './relay';
import type { Transaction, WebhookDeliveryReceipt, WebhookEnvelope } from './types';
import type { WebhookQueueMessage } from './queue';
import {
  MAX_AUTOMATIC_HTTP_ATTEMPTS,
  retryDelaySeconds,
  type OutcomeKind,
} from './deliveryPolicy';
import { enqueueRecoveryIfOpen, enqueueTerminalIncident } from './alertOutbox';

// Cloudflare Queue is at-least-once. We own the job for this long once we hand a
// message to the queue; only after the lease expires may a sweep re-open a job
// whose message was lost without any outcome. Derive/verify this against the
// real Queue max_retries + retry-delay + retention, not a bare guess.
const QUEUE_OWNERSHIP_HORIZON_SECONDS = 2 * 60 * 60;

export interface WebhookDeliveryEnv {
  DB: D1Database;
  WEBHOOK_QUEUE: Queue<WebhookQueueMessage>;
}

export interface DispatchResult {
  considered: number;
  queued: number;
  failed: number;
}

export interface ReplayResult {
  found: boolean;
  queued: boolean;
  delivery_id?: string;
  /** Set when nothing was re-driven: an active job, or an already-delivered job
   * without force. */
  noop?: 'active' | 'already_delivered';
  previous_status?: DeliveryStatus;
}

/** Result of persisting a delivery outcome. `stale` means the fencing predicate
 * (generation/token) rejected the write — a late message from an old lease or
 * generation. The caller acks such a message without changing the job. */
export interface OutcomeResult {
  applied: boolean;
  status: DeliveryStatus | 'stale' | 'not_found';
}

export type DeliveryStatus = 'pending' | 'dispatching' | 'queued' | 'delivered' | 'terminal';

export interface DeliveryJobRow {
  id: number;
  transaction_id: number;
  consumer_app_id: string;
  event_kind: string;
  delivery_id: string;
  payload: string;
  payload_sha256?: string | null;
  status: DeliveryStatus;
  generation: number;
  dispatch_token?: string | null;
  dispatch_count?: number;
  http_attempt_count?: number;
  next_attempt_at?: string;
  lease_until?: string | null;
  last_http_status?: number | null;
  last_error?: string | null;
  created_at?: string;
  delivered_at?: string | null;
  terminal_at?: string | null;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function newDispatchToken(): string {
  return crypto.randomUUID();
}

/**
 * Derive the durable outbox from facts that already survived ingest. Idempotent:
 * a lost queue.send can never make a transaction undispatchable, and a repeated
 * sweep cannot create a second delivery lineage (UNIQUE(transaction, consumer,
 * event_kind)).
 */
export async function ensureDeliveryJobs(db: D1Database, transactionId?: number): Promise<number> {
  const candidates = await db.prepare(`
    SELECT t.*, b.pairing_code, s.consumer_app_id
    FROM transactions t
    JOIN bank_accounts b ON b.id = t.bank_account_id
    JOIN webhook_subscriptions s ON s.bank_account_id = t.bank_account_id
    WHERE (? IS NULL OR t.id = ?)
      AND NOT EXISTS (
        SELECT 1 FROM webhook_delivery_jobs j
        WHERE j.transaction_id = t.id AND j.consumer_app_id = s.consumer_app_id
          AND j.event_kind = 'transaction.received'
      )
      -- Intent is decided by the subscription interval at ingest, not by the
      -- current active-subscription view. Exact UTC datetime (not julianday) so
      -- a same-second create/delete/transaction is deterministic.
      AND datetime(s.created_at) <= datetime(t.created_at)
      AND (s.deleted_at IS NULL OR datetime(t.created_at) < datetime(s.deleted_at))
  `).bind(transactionId ?? null, transactionId ?? null).all<(Transaction & {
    pairing_code: string;
    consumer_app_id: string;
  })>();

  let created = 0;
  for (const row of candidates.results) {
    const deliveryId = ulid();
    const envelope = buildWebhookEnvelope({
      delivery_id: deliveryId,
      pairing_code: row.pairing_code,
      transaction: row,
    });
    const payload = JSON.stringify(envelope);
    const result = await db.prepare(`
      INSERT OR IGNORE INTO webhook_delivery_jobs
        (transaction_id, consumer_app_id, event_kind, delivery_id, payload, payload_sha256, status, next_attempt_at)
      VALUES (?, ?, 'transaction.received', ?, ?, ?, 'pending', datetime('now'))
    `).bind(row.id, row.consumer_app_id, deliveryId, payload, await sha256Hex(payload)).run();
    created += result.meta.changes;
  }
  return created;
}

async function dueJobs(db: D1Database, limit: number): Promise<DeliveryJobRow[]> {
  // One DB time authority. A pending job is due immediately; a queued job only
  // after its ownership horizon; a dispatching job only after its lease expires.
  const result = await db.prepare(`
    SELECT id, transaction_id, consumer_app_id, event_kind, delivery_id, payload,
           payload_sha256, status, generation, dispatch_token, http_attempt_count
    FROM webhook_delivery_jobs
    WHERE status IN ('pending', 'dispatching', 'queued')
      AND datetime(next_attempt_at) <= datetime('now')
      AND (lease_until IS NULL OR datetime(lease_until) <= datetime('now'))
    ORDER BY next_attempt_at, id
    LIMIT ?
  `).bind(limit).all<DeliveryJobRow>();
  return result.results;
}

/**
 * Atomically claim a due job into `dispatching` with a fresh dispatch token and
 * a full ownership-horizon lease. Generation is preserved. Returns the claimed
 * token, or null if another worker already owns it.
 */
async function claimJob(db: D1Database, jobId: number): Promise<string | null> {
  const token = newDispatchToken();
  const result = await db.prepare(`
    UPDATE webhook_delivery_jobs
    SET status = 'dispatching',
        dispatch_token = ?,
        dispatch_count = dispatch_count + 1,
        lease_until = datetime('now', '+${QUEUE_OWNERSHIP_HORIZON_SECONDS} seconds'),
        last_error = NULL
    WHERE id = ?
      AND status IN ('pending', 'dispatching', 'queued')
      AND datetime(next_attempt_at) <= datetime('now')
      AND (lease_until IS NULL OR datetime(lease_until) <= datetime('now'))
  `).bind(token, jobId).run();
  return result.meta.changes === 1 ? token : null;
}

async function enqueueClaimedJob(env: WebhookDeliveryEnv, jobId: number, token: string): Promise<boolean> {
  const job = await env.DB.prepare(`
    SELECT id, transaction_id, consumer_app_id, event_kind, delivery_id, payload,
           payload_sha256, status, generation, dispatch_token
    FROM webhook_delivery_jobs WHERE id = ?
  `).bind(jobId).first<DeliveryJobRow>();
  if (!job || job.dispatch_token !== token) return false;

  let envelope: WebhookEnvelope;
  try {
    if (job.payload_sha256 && (await sha256Hex(job.payload)) !== job.payload_sha256) {
      throw new Error('payload_hash_mismatch');
    }
    envelope = JSON.parse(job.payload) as WebhookEnvelope;
  } catch (parseErr) {
    // A corrupt payload is a visible protocol incident, never an infinite retry.
    await recordDeliveryOutcome(env.DB, {
      deliveryJobId: job.id,
      generation: job.generation,
      dispatchToken: token,
      kind: 'terminal',
      error: `invalid_delivery_payload:${String(parseErr)}`,
    });
    return false;
  }

  // Separate try/catch for the send itself vs the post-send D1 update. A single
  // shared catch is the partial-failure bug: a successful send whose post-send
  // update fails must NOT return to `pending`, or one message becomes two.
  try {
    await env.WEBHOOK_QUEUE.send({
      message_version: 2,
      delivery_job_id: job.id,
      delivery_id: job.delivery_id,
      consumer_app_id: job.consumer_app_id,
      event_kind: job.event_kind,
      bank_account_id: envelope.data.bank_account_id,
      transaction_id: job.transaction_id,
      generation: job.generation,
      dispatch_token: token,
      envelope,
    });
  } catch (sendErr) {
    // The send provably failed: reopen the job. Fenced on the token so a
    // concurrent reclaim's state is never trampled.
    await env.DB.prepare(`
      UPDATE webhook_delivery_jobs
      SET status = 'pending', lease_until = NULL, next_attempt_at = datetime('now'),
          last_error = ?
      WHERE id = ? AND generation = ? AND dispatch_token = ? AND status = 'dispatching'
    `).bind(`queue_send_failed:${String(sendErr)}`, job.id, job.generation, token).run();
    return false;
  }

  // Best-effort dispatching -> queued. If THIS update fails, the job stays
  // `dispatching` with its long ownership lease; the incoming message (or lease
  // expiry) resolves it. It must never fall back to `pending`.
  try {
    await env.DB.prepare(`
      UPDATE webhook_delivery_jobs
      SET status = 'queued', lease_until = NULL,
          next_attempt_at = datetime('now', '+${QUEUE_OWNERSHIP_HORIZON_SECONDS} seconds'),
          last_error = NULL
      WHERE id = ? AND generation = ? AND dispatch_token = ? AND status = 'dispatching'
    `).bind(job.id, job.generation, token).run();
  } catch {
    // Intentionally swallowed: leaving `dispatching` is the safe post-send state.
  }
  return true;
}

/** Claim and enqueue one exact job. Used by immediate fan-out and manual replay
 * so an unrelated due job can never be delivered by accident. */
export async function dispatchDeliveryJob(env: WebhookDeliveryEnv, jobId: number): Promise<boolean> {
  const token = await claimJob(env.DB, jobId);
  if (!token) return false;
  return enqueueClaimedJob(env, jobId, token);
}

export async function dispatchDueDeliveryJobs(env: WebhookDeliveryEnv, limit = 50): Promise<DispatchResult> {
  const jobs = await dueJobs(env.DB, limit);
  let queued = 0;
  let failed = 0;
  for (const job of jobs) {
    if (await dispatchDeliveryJob(env, job.id)) queued++;
    else failed++;
  }
  return { considered: jobs.length, queued, failed };
}

/**
 * Persist a delivery outcome with monotonic, fenced SQL.
 * - `delivered` is absorbing: any attempt of the current generation may write
 *   it, and it can never be reduced by a later failure.
 * - `retryable`/`queue_retry`/`terminal` are fenced on generation AND dispatch
 *   token and refuse to touch an already-`delivered` job. A stale token/
 *   generation writes nothing and is reported as `stale`.
 * - the HTTP attempt counter is bumped in the same conditional UPDATE (no
 *   read-modify-write).
 */
export async function recordDeliveryOutcome(db: D1Database, args: {
  deliveryJobId: number;
  generation: number;
  dispatchToken?: string | null;
  kind: OutcomeKind;
  httpStatus?: number | null;
  error?: string | null;
  delaySeconds?: number;
  alertService?: string;
  receipt?: WebhookDeliveryReceipt;
}): Promise<OutcomeResult> {
  const { deliveryJobId, generation, dispatchToken, kind } = args;
  const httpStatus = args.httpStatus ?? null;

  let changes = 0;
  if (kind === 'delivered') {
    // Fenced on generation only: a real 2xx wins regardless of which lease
    // produced it, and it is idempotent (status <> 'delivered' guards repeats).
    const res = await db.prepare(`
      UPDATE webhook_delivery_jobs
      SET status = 'delivered', http_attempt_count = http_attempt_count + 1,
          lease_until = NULL, last_http_status = ?, last_error = NULL,
          business_outcome = ?, business_outcome_version = ?, receipt_json = ?,
          delivered_at = datetime('now')
      WHERE id = ? AND generation = ? AND status <> 'delivered'
    `).bind(
      httpStatus,
      args.receipt?.outcome ?? null,
      args.receipt?.receipt_version ?? null,
      args.receipt ? JSON.stringify(args.receipt) : null,
      deliveryJobId,
      generation,
    ).run();
    changes = res.meta.changes;
  } else if (kind === 'queue_retry') {
    // Cloudflare still owns this message and will make the next retry. Hold the
    // job in `queued` past the whole ownership horizon so the app sweep does not
    // produce a second independent message meanwhile.
    const res = await db.prepare(`
      UPDATE webhook_delivery_jobs
      SET status = 'queued', http_attempt_count = http_attempt_count + 1,
          lease_until = NULL, last_http_status = ?, last_error = ?,
          next_attempt_at = datetime('now', '+${QUEUE_OWNERSHIP_HORIZON_SECONDS} seconds')
      WHERE id = ? AND generation = ? AND dispatch_token = ? AND status NOT IN ('delivered', 'terminal')
    `).bind(httpStatus, args.error ?? null, deliveryJobId, generation, dispatchToken ?? null).run();
    changes = res.meta.changes;
  } else {
    // retryable | terminal. Terminal iff explicitly terminal OR the incremented
    // attempt count reaches the automatic budget. All CASE expressions see the
    // pre-update column value, so `http_attempt_count + 1` is consistent.
    const delay = args.delaySeconds ?? retryDelaySeconds(1);
    const forceTerminal = kind === 'terminal' ? 1 : 0;
    const res = await db.prepare(`
      UPDATE webhook_delivery_jobs
      SET http_attempt_count = http_attempt_count + 1,
          status = CASE WHEN ? = 1 OR http_attempt_count + 1 >= ? THEN 'terminal' ELSE 'pending' END,
          lease_until = NULL,
          last_http_status = ?,
          last_error = CASE WHEN ? = 1 OR http_attempt_count + 1 >= ?
                            THEN COALESCE(?, 'max_automatic_attempts_exhausted') ELSE ? END,
          next_attempt_at = CASE WHEN ? = 1 OR http_attempt_count + 1 >= ?
                                 THEN next_attempt_at ELSE datetime('now', ?) END,
          terminal_at = CASE WHEN ? = 1 OR http_attempt_count + 1 >= ?
                             THEN datetime('now') ELSE terminal_at END
      WHERE id = ? AND generation = ? AND dispatch_token = ? AND status NOT IN ('delivered', 'terminal')
    `).bind(
      forceTerminal, MAX_AUTOMATIC_HTTP_ATTEMPTS,
      httpStatus,
      forceTerminal, MAX_AUTOMATIC_HTTP_ATTEMPTS, args.error ?? null, args.error ?? null,
      forceTerminal, MAX_AUTOMATIC_HTTP_ATTEMPTS, `+${delay} seconds`,
      forceTerminal, MAX_AUTOMATIC_HTTP_ATTEMPTS,
      deliveryJobId, generation, dispatchToken ?? null,
    ).run();
    changes = res.meta.changes;
  }

  const row = await db.prepare(`
    SELECT id, status, generation, dispatch_token, delivery_id, consumer_app_id,
           incident_version, last_error, last_http_status
    FROM webhook_delivery_jobs WHERE id = ?
  `).bind(deliveryJobId).first<{
    id: number; status: DeliveryStatus; generation: number; dispatch_token: string | null;
    delivery_id: string; consumer_app_id: string; incident_version: number;
    last_error: string | null; last_http_status: number | null;
  }>();
  if (!row) return { applied: false, status: 'not_found' };
  if (changes > 0) {
    // Per-job alert outbox: a fresh terminal opens its own incident; a delivered
    // transition closes any open incident with exactly one recovery.
    const service = args.alertService ?? 'banksync';
    if (row.status === 'terminal') await enqueueTerminalIncident(db, row, service);
    else if (row.status === 'delivered') await enqueueRecoveryIfOpen(db, row, service);
    return { applied: true, status: row.status };
  }
  // No write applied. Distinguish absorbing-delivered from a stale fence.
  if (row.status === 'delivered') return { applied: false, status: 'delivered' };
  const generationMismatch = row.generation !== generation;
  const tokenMismatch = dispatchToken != null && row.dispatch_token !== dispatchToken;
  if (generationMismatch || tokenMismatch) return { applied: false, status: 'stale' };
  return { applied: false, status: row.status };
}

/**
 * Manual replay: bump generation, drop the old token/lease and re-open as
 * pending, then dispatch. Bumping the generation fences any in-flight message
 * from the previous generation. (Audited reason/actor and force/no-op guards
 * are layered on in a later slice.)
 */
export async function replayDelivery(
  db: D1Database,
  queue: Queue<WebhookQueueMessage>,
  jobId: number,
  opts: { force?: boolean } = {},
): Promise<ReplayResult> {
  const job = await db.prepare(`
    SELECT id, delivery_id, status FROM webhook_delivery_jobs WHERE id = ?
  `).bind(jobId).first<{ id: number; delivery_id: string; status: DeliveryStatus }>();
  if (!job) return { found: false, queued: false };

  // An in-flight job must not be re-driven — that would create a second
  // concurrent dispatch of the same lineage.
  if (job.status === 'pending' || job.status === 'dispatching' || job.status === 'queued') {
    return { found: true, queued: false, delivery_id: job.delivery_id, noop: 'active', previous_status: job.status };
  }
  // `delivered` is absorbing: a normal replay is a no-op. Only an explicit,
  // audited force-redrive re-sends an already-delivered job, and it bumps the
  // incident_version so a fresh alert incident can open.
  if (job.status === 'delivered' && !opts.force) {
    return { found: true, queued: false, delivery_id: job.delivery_id, noop: 'already_delivered', previous_status: job.status };
  }

  const incidentBump = job.status === 'delivered' && opts.force ? ', incident_version = incident_version + 1' : '';
  await db.prepare(`
    UPDATE webhook_delivery_jobs
    SET status = 'pending', generation = generation + 1, dispatch_token = NULL,
        http_attempt_count = 0, dispatch_count = 0, lease_until = NULL,
        next_attempt_at = datetime('now'), delivered_at = NULL, terminal_at = NULL,
        last_http_status = NULL, last_error = 'manual_replay_requested'${incidentBump}
    WHERE id = ?
  `).bind(jobId).run();
  const queued = await dispatchDeliveryJob({ DB: db, WEBHOOK_QUEUE: queue }, jobId);
  return { found: true, queued, delivery_id: job.delivery_id, previous_status: job.status };
}

export async function findDeliveryJob(db: D1Database, deliveryId: string): Promise<DeliveryJobRow | null> {
  return await db.prepare(`
    SELECT id, transaction_id, consumer_app_id, event_kind, delivery_id, status,
           generation, dispatch_token, http_attempt_count, next_attempt_at,
           lease_until, last_http_status, last_error, created_at, delivered_at, terminal_at
    FROM webhook_delivery_jobs WHERE delivery_id = ?
  `).bind(deliveryId).first<DeliveryJobRow>();
}

export async function findDeliveryJobsForTransaction(db: D1Database, transactionId: number): Promise<DeliveryJobRow[]> {
  const result = await db.prepare(`
    SELECT id, transaction_id, consumer_app_id, event_kind, delivery_id, payload,
           status, generation, http_attempt_count
    FROM webhook_delivery_jobs WHERE transaction_id = ? ORDER BY id
  `).bind(transactionId).all<DeliveryJobRow>();
  return result.results;
}

export interface DeliveryListQuery {
  limit: number;
  /** Tenant scope. When set, the predicate is applied IN SQL before LIMIT so a
   * tenant can never page into another consumer's jobs. */
  consumerAppId?: string;
  /** Stable cursor: return rows with id < cursor (descending by id). */
  cursor?: number;
  status?: DeliveryStatus;
}

export async function listDeliveryJobs(db: D1Database, query: DeliveryListQuery): Promise<DeliveryJobRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (query.consumerAppId !== undefined) { where.push('consumer_app_id = ?'); binds.push(query.consumerAppId); }
  if (query.status !== undefined) { where.push('status = ?'); binds.push(query.status); }
  if (query.cursor !== undefined) { where.push('id < ?'); binds.push(query.cursor); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  binds.push(query.limit);
  const result = await db.prepare(`
    SELECT id, transaction_id, consumer_app_id, event_kind, delivery_id, status,
           generation, http_attempt_count, next_attempt_at, lease_until,
           last_http_status, last_error, created_at, delivered_at, terminal_at
    FROM webhook_delivery_jobs
    ${whereSql}
    ORDER BY id DESC LIMIT ?
  `).bind(...binds).all<DeliveryJobRow>();
  return result.results;
}
