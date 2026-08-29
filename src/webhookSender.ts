import type { D1Database } from '@cloudflare/workers-types';
import type { WebhookEnvelope } from './types';
import { webhookDecrypt } from './crypto';
import { signWebhook } from './relay';
import { getConsumerSecretMaterials } from './db';

/** The port the coordinator uses to actually hit a consumer. Cryptography and
 * the network fetch live here; HTTP-status classification and lifecycle
 * decisions live in the coordinator. Every attempt re-signs the exact bytes
 * with a fresh timestamp, so a delayed retry never presents a stale signature. */
export interface WebhookSender {
  send(job: DeliverableJob): Promise<SenderResult>;
}

export interface DeliverableJob {
  delivery_id: string;
  consumer_app_id: string;
  envelope: WebhookEnvelope;
}

export type SenderResult =
  | { kind: 'no_consumer' }
  | { kind: 'configuration_error'; error: 'consumer_secret_decrypt_failed' }
  | { kind: 'network_error'; error: string; usedPrevSecret: boolean }
  | { kind: 'http'; httpStatus: number; usedPrevSecret: boolean; primaryStatus: number | null };

export interface WebhookSenderEnv {
  DB: D1Database;
  WEBHOOK_KEK: string;
}

const FETCH_TIMEOUT_MS = 10_000;

async function postSigned(url: string, envelope: WebhookEnvelope, secret: string): Promise<Response> {
  const signed = await signWebhook({ envelope, secret });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      body: signed.bodyBytes.buffer as ArrayBuffer,
      headers: signed.headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export function createWebhookSender(env: WebhookSenderEnv): WebhookSender {
  return {
    async send(job: DeliverableJob): Promise<SenderResult> {
      const consumer = await getConsumerSecretMaterials(env.DB, job.consumer_app_id);
      if (!consumer) return { kind: 'no_consumer' };

      let primarySecret: string;
      try {
        primarySecret = await webhookDecrypt(consumer.primary_cipher, env.WEBHOOK_KEK);
      } catch {
        // A mismatched KEK or corrupt ciphertext is not transient. Retrying it
        // through the Queue/DLQ cycle only delays and obscures the root cause.
        return { kind: 'configuration_error', error: 'consumer_secret_decrypt_failed' };
      }
      let primary: Response;
      try {
        primary = await postSigned(consumer.callback_url, job.envelope, primarySecret);
      } catch (err) {
        return { kind: 'network_error', error: String(err), usedPrevSecret: false };
      }

      // Grace-window secret fallback only on an auth rejection.
      if ((primary.status === 401 || primary.status === 403) && consumer.prev_cipher_in_grace !== null) {
        let prevSecret: string;
        try {
          prevSecret = await webhookDecrypt(consumer.prev_cipher_in_grace, env.WEBHOOK_KEK);
        } catch {
          return { kind: 'configuration_error', error: 'consumer_secret_decrypt_failed' };
        }
        let prev: Response;
        try {
          prev = await postSigned(consumer.callback_url, job.envelope, prevSecret);
        } catch (err) {
          return { kind: 'network_error', error: String(err), usedPrevSecret: true };
        }
        return { kind: 'http', httpStatus: prev.status, usedPrevSecret: true, primaryStatus: primary.status };
      }

      return { kind: 'http', httpStatus: primary.status, usedPrevSecret: false, primaryStatus: null };
    },
  };
}
