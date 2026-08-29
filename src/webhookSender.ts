import type { D1Database } from '@cloudflare/workers-types';
import type { WebhookDeliveryReceipt, WebhookEnvelope } from './types';
import { webhookDecrypt } from './crypto';
import { signWebhook } from './relay';
import { getConsumerSecretMaterials } from './db';
import { validateCallbackUrl } from './validation';

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
  | { kind: 'configuration_error'; error: 'consumer_secret_decrypt_failed' | 'callback_url_not_allowed' }
  | { kind: 'network_error'; error: string; usedPrevSecret: boolean }
  | {
      kind: 'http';
      httpStatus: number;
      usedPrevSecret: boolean;
      primaryStatus: number | null;
      receipt?: WebhookDeliveryReceipt;
      receiptError?: 'receipt_missing' | 'receipt_too_large' | 'receipt_invalid' | 'receipt_read_failed';
    };

export interface WebhookSenderEnv {
  DB: D1Database;
  WEBHOOK_KEK: string;
  ENV?: string;
  CALLBACK_HOST_ALLOWLIST?: string;
}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RECEIPT_BYTES = 8 * 1024;

async function readReceipt(response: Response, deliveryId: string): Promise<
  { receipt: WebhookDeliveryReceipt } | { error: NonNullable<Extract<SenderResult, { kind: 'http' }>['receiptError']> }
> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RECEIPT_BYTES) return { error: 'receipt_too_large' };
  if (!response.body) return { error: 'receipt_missing' };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RECEIPT_BYTES) {
        await reader.cancel();
        return { error: 'receipt_too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { error: 'receipt_read_failed' };
  }
  if (total === 0) return { error: 'receipt_missing' };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>;
    if (parsed.ok !== true || parsed.receipt_version !== 1 || parsed.delivery_id !== deliveryId
      || typeof parsed.outcome !== 'string' || !/^[a-z0-9_]{1,64}$/.test(parsed.outcome)
      || (parsed.order_id !== undefined && (typeof parsed.order_id !== 'string' || parsed.order_id.length > 200))) {
      return { error: 'receipt_invalid' };
    }
    const receipt: WebhookDeliveryReceipt = {
      receipt_version: 1,
      delivery_id: parsed.delivery_id,
      outcome: parsed.outcome,
    };
    if (typeof parsed.order_id === 'string') receipt.order_id = parsed.order_id;
    return { receipt };
  } catch {
    return { error: 'receipt_invalid' };
  }
}

async function httpResult(response: Response, deliveryId: string, usedPrevSecret: boolean, primaryStatus: number | null): Promise<SenderResult> {
  if (response.status < 200 || response.status > 299) {
    return { kind: 'http', httpStatus: response.status, usedPrevSecret, primaryStatus };
  }
  const parsed = await readReceipt(response, deliveryId);
  return 'receipt' in parsed
    ? { kind: 'http', httpStatus: response.status, usedPrevSecret, primaryStatus, receipt: parsed.receipt }
    : { kind: 'http', httpStatus: response.status, usedPrevSecret, primaryStatus, receiptError: parsed.error };
}

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
      redirect: 'manual',
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

      let callbackUrl: string;
      try {
        callbackUrl = validateCallbackUrl(consumer.callback_url, {
          environment: env.ENV,
          allowlist: env.CALLBACK_HOST_ALLOWLIST,
        });
      } catch {
        return { kind: 'configuration_error', error: 'callback_url_not_allowed' };
      }

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
        primary = await postSigned(callbackUrl, job.envelope, primarySecret);
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
          prev = await postSigned(callbackUrl, job.envelope, prevSecret);
        } catch (err) {
          return { kind: 'network_error', error: String(err), usedPrevSecret: true };
        }
        return httpResult(prev, job.delivery_id, true, primary.status);
      }

      return httpResult(primary, job.delivery_id, false, null);
    },
  };
}
