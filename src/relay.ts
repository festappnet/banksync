import type { Transaction, WebhookEnvelope } from './types';

export interface SignedWebhook {
  bodyBytes: Uint8Array;
  headers: {
    'Content-Type': 'application/json';
    'X-BankSync-Timestamp': string;
    'X-BankSync-Delivery-Id': string;
    'X-BankSync-Signature': string;
  };
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function buildWebhookEnvelope(args: {
  delivery_id: string;
  pairing_code: string;
  transaction: Transaction;
}): WebhookEnvelope {
  return {
    event: 'transaction.received',
    event_version: '1',
    delivery_id: args.delivery_id,
    pairing_code: args.pairing_code,
    data: args.transaction,
  };
}

export async function signWebhook(args: {
  envelope: WebhookEnvelope;
  secret: string;
  timestamp?: number;
}): Promise<SignedWebhook> {
  const timestamp = args.timestamp ?? Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();

  const bodyBytes = enc.encode(JSON.stringify(args.envelope));

  const signingInput = concatBytes(
    enc.encode(String(timestamp)),
    new Uint8Array([0x2e]),
    enc.encode(args.envelope.delivery_id),
    new Uint8Array([0x2e]),
    bodyBytes,
  );

  const secretBytes = enc.encode(args.secret);
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    secretBytes.buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await globalThis.crypto.subtle.sign('HMAC', key, signingInput.buffer as ArrayBuffer);

  return {
    bodyBytes,
    headers: {
      'Content-Type': 'application/json',
      'X-BankSync-Timestamp': String(timestamp),
      'X-BankSync-Delivery-Id': args.envelope.delivery_id,
      'X-BankSync-Signature': 'sha256=' + hex(mac),
    },
  };
}

export type WebhookVerificationCode =
  | 'timestamp_invalid'
  | 'timestamp_out_of_range'
  | 'signature_invalid'
  | 'body_invalid'
  | 'delivery_id_mismatch'
  | 'event_unsupported'
  | 'event_version_unsupported';

export class WebhookVerificationError extends Error {
  constructor(readonly code: WebhookVerificationCode) {
    super(code);
    this.name = 'WebhookVerificationError';
  }
}

export interface VerifyWebhookArgs {
  secret: string;
  timestamp: string;
  deliveryId: string;
  bodyBytes: Uint8Array;
  signature: string;
  toleranceSeconds?: number;
  nowSeconds?: number;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isTransaction(value: unknown): value is Transaction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  const nullableStrings = [
    'counter_account', 'bank_code', 'bank_name', 'vs', 'ks', 'ss', 'message',
    'sender_name', 'user_identification', 'transaction_type', 'performed_by',
    'comment', 'command_id', 'transaction_id', 'external_id',
  ];
  return isPositiveSafeInteger(data.id)
    && isPositiveSafeInteger(data.bank_account_id)
    && isPositiveSafeInteger(data.amount_cents)
    && typeof data.currency === 'string' && /^[A-Z]{3}$/.test(data.currency)
    && nullableStrings.every(field => isNullableString(data[field]))
    && (data.source === 'email' || data.source === 'fio_api')
    && typeof data.date === 'string' && data.date.length > 0
    && (data.date_offset_min === null || (typeof data.date_offset_min === 'number' && Number.isSafeInteger(data.date_offset_min)));
}

/**
 * Safe public verification contract. Consumers must durably claim the returned
 * delivery_id before performing side effects; transport verification cannot
 * provide durable replay protection by itself.
 */
export async function verifyWebhook(args: VerifyWebhookArgs): Promise<WebhookEnvelope> {
  if (!/^\d{10}$/.test(args.timestamp)) throw new WebhookVerificationError('timestamp_invalid');
  const timestamp = Number(args.timestamp);
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = args.toleranceSeconds ?? 300;
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > tolerance) {
    throw new WebhookVerificationError('timestamp_out_of_range');
  }
  if (!/^sha256=[0-9a-f]{64}$/i.test(args.signature)) {
    throw new WebhookVerificationError('signature_invalid');
  }
  const encoder = new TextEncoder();
  const signingInput = concatBytes(
    encoder.encode(args.timestamp),
    new Uint8Array([0x2e]),
    encoder.encode(args.deliveryId),
    new Uint8Array([0x2e]),
    args.bodyBytes,
  );
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(args.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    signingInput.buffer as ArrayBuffer,
  );
  const expected = 'sha256=' + hex(mac);
  if (expected.length !== args.signature.length) throw new WebhookVerificationError('signature_invalid');
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ args.signature.charCodeAt(index);
  }
  if (difference !== 0) throw new WebhookVerificationError('signature_invalid');

  let envelope: unknown;
  try {
    envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(args.bodyBytes));
  } catch {
    throw new WebhookVerificationError('body_invalid');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new WebhookVerificationError('body_invalid');
  }
  const value = envelope as Record<string, unknown>;
  if (value.delivery_id !== args.deliveryId) throw new WebhookVerificationError('delivery_id_mismatch');
  if (typeof value.delivery_id !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(value.delivery_id)) {
    throw new WebhookVerificationError('body_invalid');
  }
  if (value.event !== 'transaction.received') throw new WebhookVerificationError('event_unsupported');
  if (value.event_version !== '1') throw new WebhookVerificationError('event_version_unsupported');
  if (typeof value.pairing_code !== 'string' || !/^[0-9a-f]{10}$/i.test(value.pairing_code) || !isTransaction(value.data)) {
    throw new WebhookVerificationError('body_invalid');
  }
  return envelope as WebhookEnvelope;
}
