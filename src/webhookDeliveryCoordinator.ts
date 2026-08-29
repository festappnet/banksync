import type { D1Database, Queue } from '@cloudflare/workers-types';
import { insertWebhookLogEntry } from './db';
import { log } from './logger';
import { backoffSeconds, classifyHttpStatus } from './deliveryPolicy';
import {
  dispatchDeliveryJob,
  dispatchDueDeliveryJobs,
  ensureDeliveryJobs,
  findDeliveryJobsForTransaction,
  listDeliveryJobs,
  recordDeliveryOutcome,
  replayDelivery,
  type DispatchResult,
  type OutcomeResult,
  type ReplayResult,
} from './webhookDelivery';
import { createWebhookSender, type WebhookSender } from './webhookSender';
import type { WebhookQueueMessage } from './queue';

/** What the queue adapter should do with a message after the coordinator has
 * decided. The adapter only translates this into `msg.ack()` / `msg.retry()`;
 * it never classifies status or touches lifecycle SQL. */
export type QueueDisposition = { action: 'ack' } | { action: 'retry'; delaySeconds: number };

export interface AttemptContext {
  attempts: number;
  source: 'primary' | 'dead_letter';
}

/**
 * The single deep module for webhook delivery. Callers use these four
 * intent-named methods and never see `ensureDeliveryJobs`, lifecycle SQL, or
 * the pending/dispatching/queued rules. Read-only operator queries live in
 * `DeliveryQueries`; alerting and reconciliation are separate modules.
 */
export interface WebhookDeliveryCoordinator {
  observeTransaction(transactionId: number): Promise<{ created: number; dispatched: number }>;
  sweep(options?: { limit?: number }): Promise<{ created: number } & DispatchResult>;
  handleAttempt(message: WebhookQueueMessage, ctx: AttemptContext): Promise<QueueDisposition>;
  replay(jobId: number, opts?: { force?: boolean }): Promise<ReplayResult>;
}

export interface CoordinatorEnv {
  DB: D1Database;
  WEBHOOK_KEK: string;
  WEBHOOK_QUEUE: Queue<WebhookQueueMessage>;
}

/** Strictly decode the V2 fencing coordinates. Returns null for anything that is
 * not a valid V2 delivery message (e.g. a legacy V1 message with no generation/
 * token). Such a message is a protocol incident: it is ack'd WITHOUT processing,
 * and the durable job's lease re-drives it as a proper V2 message. There is no
 * V1 compatibility path — the delivery message contract is single and forward. */
function decodeV2Fence(m: WebhookQueueMessage): { generation: number; dispatchToken: string } | null {
  if (m.message_version !== 2) return null;
  if (typeof m.generation !== 'number') return null;
  if (typeof m.dispatch_token !== 'string' || m.dispatch_token.length === 0) return null;
  return { generation: m.generation, dispatchToken: m.dispatch_token };
}

type Fence = { generation: number; dispatchToken: string };

function retryUnlessSettled(outcome: OutcomeResult, delaySeconds: number): QueueDisposition {
  if (outcome.status === 'stale' || outcome.status === 'delivered') return { action: 'ack' };
  return { action: 'retry', delaySeconds };
}

export function createWebhookDeliveryCoordinator(
  env: CoordinatorEnv,
  deps: { sender?: WebhookSender } = {},
): WebhookDeliveryCoordinator {
  const db = env.DB;
  const sender = deps.sender ?? createWebhookSender(env);

  async function deadLetter(m: WebhookQueueMessage, fence: Fence): Promise<QueueDisposition> {
    // Re-drive the existing canonical job — no second DLQ record, no new
    // delivery id. Fenced + monotonic: an already-terminal job is not reopened.
    await recordDeliveryOutcome(db, {
      deliveryJobId: m.delivery_job_id,
      ...fence,
      kind: 'retryable',
      error: 'queue_max_retries_exhausted',
      delaySeconds: 300,
    });
    log('webhook_delivery_dead_letter_requeued', { delivery_id: m.delivery_id, consumer_app_id: m.consumer_app_id });
    return { action: 'ack' };
  }

  async function handlePrimary(m: WebhookQueueMessage, attempts: number, fence: Fence): Promise<QueueDisposition> {
    const logBase = {
      delivery_id: m.delivery_id,
      consumer_app_id: m.consumer_app_id,
      bank_account_id: m.bank_account_id,
      transaction_id: m.transaction_id,
      attempt: attempts,
    };
    const result = await sender.send({ delivery_id: m.delivery_id, consumer_app_id: m.consumer_app_id, envelope: m.envelope });

    if (result.kind === 'no_consumer') {
      log('webhook_consumer_not_found', { delivery_id: m.delivery_id, consumer_app_id: m.consumer_app_id });
      await insertWebhookLogEntry(db, { ...logBase, http_status: null, error_message: 'consumer_not_found' });
      await recordDeliveryOutcome(db, { deliveryJobId: m.delivery_job_id, ...fence, kind: 'terminal', error: 'consumer_not_found' });
      return { action: 'ack' };
    }

    if (result.kind === 'configuration_error') {
      log('webhook_consumer_configuration_error', { delivery_id: m.delivery_id, consumer_app_id: m.consumer_app_id });
      await insertWebhookLogEntry(db, { ...logBase, http_status: null, error_message: result.error });
      await recordDeliveryOutcome(db, { deliveryJobId: m.delivery_job_id, ...fence, kind: 'terminal', error: result.error });
      return { action: 'ack' };
    }

    if (result.kind === 'network_error') {
      const delaySeconds = backoffSeconds(attempts);
      const errorMessage = result.usedPrevSecret ? `retry_with_prev:network_error:${result.error}` : result.error;
      await insertWebhookLogEntry(db, { ...logBase, http_status: 0, error_message: errorMessage });
      const outcome = await recordDeliveryOutcome(db, { deliveryJobId: m.delivery_job_id, ...fence, kind: 'queue_retry', httpStatus: 0, error: errorMessage, delaySeconds });
      log('webhook_network_error', { delivery_id: m.delivery_id, consumer_app_id: m.consumer_app_id, attempts, delay_seconds: delaySeconds });
      return retryUnlessSettled(outcome, delaySeconds);
    }

    const { httpStatus, usedPrevSecret, primaryStatus } = result;
    const cls = classifyHttpStatus(httpStatus);

    if (cls === 'delivered') {
      await insertWebhookLogEntry(db, { ...logBase, http_status: httpStatus, error_message: usedPrevSecret ? 'retry_with_prev' : null });
      await recordDeliveryOutcome(db, { deliveryJobId: m.delivery_job_id, ...fence, kind: 'delivered', httpStatus });
      log(usedPrevSecret ? 'webhook_delivered_with_prev_secret' : 'webhook_delivered', { delivery_id: m.delivery_id, consumer_app_id: m.consumer_app_id, http_status: httpStatus });
      return { action: 'ack' };
    }

    if (cls === 'terminal') {
      const errorMessage = usedPrevSecret
        ? `retry_with_prev:4xx_client_error:primary_${primaryStatus}_prev_${httpStatus}`
        : '4xx_client_error';
      await insertWebhookLogEntry(db, { ...logBase, http_status: httpStatus, error_message: errorMessage });
      await recordDeliveryOutcome(db, { deliveryJobId: m.delivery_job_id, ...fence, kind: 'terminal', httpStatus, error: errorMessage });
      log('webhook_4xx_ack', { delivery_id: m.delivery_id, consumer_app_id: m.consumer_app_id, http_status: httpStatus });
      return { action: 'ack' };
    }

    // retryable (408/429/5xx)
    const delaySeconds = backoffSeconds(attempts);
    const errorMessage = `http_${httpStatus}`;
    await insertWebhookLogEntry(db, { ...logBase, http_status: httpStatus, error_message: errorMessage });
    const outcome = await recordDeliveryOutcome(db, { deliveryJobId: m.delivery_job_id, ...fence, kind: 'queue_retry', httpStatus, error: errorMessage, delaySeconds });
    log('webhook_retry', { delivery_id: m.delivery_id, consumer_app_id: m.consumer_app_id, http_status: httpStatus, attempts, delay_seconds: delaySeconds });
    return retryUnlessSettled(outcome, delaySeconds);
  }

  return {
    async observeTransaction(transactionId: number) {
      const created = await ensureDeliveryJobs(db, transactionId);
      const jobs = await findDeliveryJobsForTransaction(db, transactionId);
      const results = await Promise.all(jobs.map(job => dispatchDeliveryJob(env, job.id)));
      return { created, dispatched: results.filter(Boolean).length };
    },

    async sweep(options?: { limit?: number }) {
      const created = await ensureDeliveryJobs(db);
      const dispatch = await dispatchDueDeliveryJobs(env, options?.limit ?? 50);
      return { created, ...dispatch };
    },

    handleAttempt(message: WebhookQueueMessage, ctx: AttemptContext) {
      const fence = decodeV2Fence(message);
      if (!fence) {
        // Not a valid V2 message → protocol incident, ack'd unprocessed. The
        // durable lease re-drives the job as a proper V2 message.
        log('webhook_message_protocol_error', { delivery_id: message.delivery_id, consumer_app_id: message.consumer_app_id });
        return Promise.resolve<QueueDisposition>({ action: 'ack' });
      }
      return ctx.source === 'dead_letter' ? deadLetter(message, fence) : handlePrimary(message, ctx.attempts, fence);
    },

    replay(jobId: number, opts?: { force?: boolean }) {
      return replayDelivery(db, env.WEBHOOK_QUEUE, jobId, opts);
    },
  };
}

/** Read-only operator projection. Deliberately not on the coordinator so the
 * lifecycle interface does not grow into a CRUD facade. */
export const DeliveryQueries = {
  list(db: D1Database, query: import('./webhookDelivery').DeliveryListQuery) {
    return listDeliveryJobs(db, query);
  },
};
