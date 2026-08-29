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

/** Verify the exact bytes and headers emitted by {@link signWebhook}. */
export async function verifyWebhookSignature(args: {
  secret: string;
  timestamp: string;
  deliveryId: string;
  bodyBytes: Uint8Array;
  signature: string;
}): Promise<boolean> {
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
  if (expected.length !== args.signature.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ args.signature.charCodeAt(index);
  }
  return difference === 0;
}
