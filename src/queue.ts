import type { D1Database, Message, MessageBatch, Queue } from '@cloudflare/workers-types';
import type { WebhookEnvelope } from './types';
import { assertSchemaVersion } from './db';
import { logError } from './logger';
import { backoffSeconds } from './deliveryPolicy';
import { createWebhookDeliveryCoordinator, type QueueDisposition } from './webhookDeliveryCoordinator';

// Re-exported for callers/tests that still import the CF-retry backoff here.
export { backoffSeconds };

export interface QueueEnv {
  DB: D1Database;
  WEBHOOK_KEK: string;
  WEBHOOK_QUEUE: Queue<WebhookQueueMessage>;
  ENV?: string;
  CALLBACK_HOST_ALLOWLIST?: string;
}

export interface WebhookQueueMessage {
  // Single, forward-only message contract — every message is V2 with fencing
  // coordinates. There is no V1 compatibility path; a message missing these is a
  // protocol incident, ack'd unprocessed (the durable lease re-drives it).
  message_version: 2;
  delivery_job_id: number;
  delivery_id: string;
  consumer_app_id: string;
  event_kind?: string;
  bank_account_id: number;
  transaction_id: number;
  // The job generation and per-claim dispatch token this message was sent under.
  // A late message from a superseded generation/lease is ack'd as stale by the
  // coordinator and never mutates a newer job.
  generation: number;
  dispatch_token: string;
  envelope: WebhookEnvelope;
}

/**
 * Thin Cloudflare Queue adapter. It only:
 *   1. asserts the schema is within the supported range,
 *   2. hands each message to the coordinator,
 *   3. translates the returned disposition into ack()/retry().
 * All HTTP-status classification and lifecycle decisions live in the
 * coordinator; cryptography and the fetch live in the WebhookSender.
 */
export async function handleQueueBatch(batch: MessageBatch<unknown>, env: QueueEnv): Promise<void> {
  await assertSchemaVersion(env.DB);
  const coordinator = createWebhookDeliveryCoordinator(env);

  if (batch.queue === 'banksync-webhooks') {
    for (const raw of batch.messages) {
      const msg = raw as Message<WebhookQueueMessage>;
      await applyDisposition(msg, () => coordinator.handleAttempt(msg.body, { attempts: msg.attempts, source: 'primary' }));
    }
  } else if (batch.queue === 'banksync-webhooks-dlq') {
    for (const raw of batch.messages) {
      const msg = raw as Message<WebhookQueueMessage>;
      await applyDisposition(msg, () => coordinator.handleAttempt(msg.body, { attempts: msg.attempts, source: 'dead_letter' }));
    }
  } else {
    logError('queue_unknown_binding', new Error(`unknown queue: ${batch.queue}`), { queue: batch.queue });
    for (const raw of batch.messages) (raw as Message<WebhookQueueMessage>).ack();
  }
}

async function applyDisposition(
  msg: Message<WebhookQueueMessage>,
  run: () => Promise<QueueDisposition>,
): Promise<void> {
  try {
    const disposition = await run();
    if (disposition.action === 'ack') msg.ack();
    else msg.retry({ delaySeconds: disposition.delaySeconds });
  } catch (err) {
    // A persist failure (e.g. the 2xx + D1-write-fails case) must NOT ack: the
    // idempotent consumer safely repeats on the next retry.
    logError('webhook_unexpected_error', err, { delivery_id: msg.body.delivery_id, consumer_app_id: msg.body.consumer_app_id });
    msg.retry({ delaySeconds: 60 });
  }
}
