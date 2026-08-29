import { describe, it, expect } from 'vitest';
import { buildWebhookEnvelope, signWebhook, verifyWebhook, WebhookVerificationError } from './relay';
import type { Transaction } from './types';

const stubTx: Transaction = {
  id: 1,
  bank_account_id: 2,
  amount_cents: 1990,
  currency: 'CZK',
  counter_account: null,
  bank_code: null,
  bank_name: null,
  vs: null,
  ks: null,
  ss: null,
  message: null,
  sender_name: 'Test Sender',
  user_identification: null,
  transaction_type: null,
  performed_by: null,
  comment: null,
  command_id: null,
  source: 'email',
  date: '2026-05-08',
  date_offset_min: null,
  transaction_id: 'TX-001',
  external_id: null,
};

const DELIVERY_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PAIRING_CODE = 'a3f92c1e44';
const SECRET = 'super-secret-key';
const TIMESTAMP = 1746710400;

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256(secret: string, data: Uint8Array): Promise<ArrayBuffer> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return globalThis.crypto.subtle.sign('HMAC', key, data.buffer as ArrayBuffer);
}

async function verificationArgs(envelope: unknown, deliveryId = DELIVERY_ID, timestamp = TIMESTAMP) {
  const bodyBytes = new TextEncoder().encode(JSON.stringify(envelope));
  const signing = new TextEncoder().encode(`${timestamp}.${deliveryId}.${new TextDecoder().decode(bodyBytes)}`);
  return {
    secret: SECRET,
    timestamp: String(timestamp),
    deliveryId,
    bodyBytes,
    signature: `sha256=${hex(await hmacSha256(SECRET, signing))}`,
    nowSeconds: TIMESTAMP,
  };
}

describe('buildWebhookEnvelope', () => {
  it('returns correct envelope shape', () => {
    const env = buildWebhookEnvelope({
      delivery_id: DELIVERY_ID,
      pairing_code: PAIRING_CODE,
      transaction: stubTx,
    });

    expect(env.event).toBe('transaction.received');
    expect(env.event_version).toBe('1');
    expect(env.delivery_id).toBe(DELIVERY_ID);
    expect(env.pairing_code).toBe(PAIRING_CODE);
    expect(env.data).toBe(stubTx);
    expect((env as unknown as Record<string, unknown>)['delivered_at']).toBeUndefined();
  });
});

describe('signWebhook', () => {
  it('round-trips through the public verifier and rejects changed bytes', async () => {
    const envelope = buildWebhookEnvelope({ delivery_id: DELIVERY_ID, pairing_code: PAIRING_CODE, transaction: stubTx });
    const signed = await signWebhook({ envelope, secret: SECRET, timestamp: TIMESTAMP });
    const input = {
      secret: SECRET,
      timestamp: signed.headers['X-BankSync-Timestamp'],
      deliveryId: signed.headers['X-BankSync-Delivery-Id'],
      bodyBytes: signed.bodyBytes,
      signature: signed.headers['X-BankSync-Signature'],
    };

    await expect(verifyWebhook({ ...input, nowSeconds: TIMESTAMP })).resolves.toEqual(envelope);
    await expect(verifyWebhook({
      ...input,
      bodyBytes: new TextEncoder().encode('{}'),
      nowSeconds: TIMESTAMP,
    })).rejects.toMatchObject({ code: 'signature_invalid' } satisfies Partial<WebhookVerificationError>);
  });

  it('round-trip determinism — same inputs produce identical bodyBytes and signature', async () => {
    const envelope = buildWebhookEnvelope({ delivery_id: DELIVERY_ID, pairing_code: PAIRING_CODE, transaction: stubTx });

    const r1 = await signWebhook({ envelope, secret: SECRET, timestamp: TIMESTAMP });
    const r2 = await signWebhook({ envelope, secret: SECRET, timestamp: TIMESTAMP });

    expect(r1.headers['X-BankSync-Signature']).toBe(r2.headers['X-BankSync-Signature']);
    expect(r1.bodyBytes).toEqual(r2.bodyBytes);
  });

  it('canonicalization invariant — consumer can verify HMAC using documented signing string', async () => {
    const envelope = buildWebhookEnvelope({ delivery_id: DELIVERY_ID, pairing_code: PAIRING_CODE, transaction: stubTx });
    const { bodyBytes, headers } = await signWebhook({ envelope, secret: SECRET, timestamp: TIMESTAMP });

    const signingString = `${TIMESTAMP}.${DELIVERY_ID}.${new TextDecoder().decode(bodyBytes)}`;
    const expectedMac = await hmacSha256(SECRET, new TextEncoder().encode(signingString));

    expect(headers['X-BankSync-Signature']).toBe('sha256=' + hex(expectedMac));
  });

  it('body bytes match independent JSON.stringify of envelope', async () => {
    const envelope = buildWebhookEnvelope({ delivery_id: DELIVERY_ID, pairing_code: PAIRING_CODE, transaction: stubTx });
    const { bodyBytes } = await signWebhook({ envelope, secret: SECRET, timestamp: TIMESTAMP });

    const expected = new TextEncoder().encode(JSON.stringify(envelope));
    expect(bodyBytes).toEqual(expected);
  });

  it('different secret → different signature', async () => {
    const envelope = buildWebhookEnvelope({ delivery_id: DELIVERY_ID, pairing_code: PAIRING_CODE, transaction: stubTx });

    const r1 = await signWebhook({ envelope, secret: 'secret-one', timestamp: TIMESTAMP });
    const r2 = await signWebhook({ envelope, secret: 'secret-two', timestamp: TIMESTAMP });

    expect(r1.headers['X-BankSync-Signature']).not.toBe(r2.headers['X-BankSync-Signature']);
  });

  it('different timestamp → different signature, same body', async () => {
    const envelope = buildWebhookEnvelope({ delivery_id: DELIVERY_ID, pairing_code: PAIRING_CODE, transaction: stubTx });

    const r1 = await signWebhook({ envelope, secret: SECRET, timestamp: TIMESTAMP });
    const r2 = await signWebhook({ envelope, secret: SECRET, timestamp: TIMESTAMP + 1 });

    expect(r1.headers['X-BankSync-Signature']).not.toBe(r2.headers['X-BankSync-Signature']);
    expect(r1.bodyBytes).toEqual(r2.bodyBytes);
  });

  it('different delivery_id → different signature', async () => {
    const env1 = buildWebhookEnvelope({ delivery_id: 'DELIVERY-A', pairing_code: PAIRING_CODE, transaction: stubTx });
    const env2 = buildWebhookEnvelope({ delivery_id: 'DELIVERY-B', pairing_code: PAIRING_CODE, transaction: stubTx });

    const r1 = await signWebhook({ envelope: env1, secret: SECRET, timestamp: TIMESTAMP });
    const r2 = await signWebhook({ envelope: env2, secret: SECRET, timestamp: TIMESTAMP });

    expect(r1.headers['X-BankSync-Signature']).not.toBe(r2.headers['X-BankSync-Signature']);
  });

  it('UTF-8 in envelope data preserved through bodyBytes round-trip', async () => {
    const tx: Transaction = { ...stubTx, sender_name: 'Příliš žluťoučký kůň' };
    const envelope = buildWebhookEnvelope({ delivery_id: DELIVERY_ID, pairing_code: PAIRING_CODE, transaction: tx });
    const { bodyBytes } = await signWebhook({ envelope, secret: SECRET, timestamp: TIMESTAMP });

    const decoded = new TextDecoder().decode(bodyBytes);
    expect(decoded).toBe(JSON.stringify(envelope));
    expect(JSON.parse(decoded).data.sender_name).toBe('Příliš žluťoučký kůň');
  });

  it('event_version is "1" in body bytes', async () => {
    const envelope = buildWebhookEnvelope({ delivery_id: DELIVERY_ID, pairing_code: PAIRING_CODE, transaction: stubTx });
    const { bodyBytes } = await signWebhook({ envelope, secret: SECRET, timestamp: TIMESTAMP });

    const parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
    expect(parsed.event_version).toBe('1');
  });
});

describe('verifyWebhook', () => {
  const envelope = buildWebhookEnvelope({ delivery_id: DELIVERY_ID, pairing_code: PAIRING_CODE, transaction: stubTx });

  it('rejects stale and future timestamps', async () => {
    await expect(verifyWebhook(await verificationArgs(envelope, DELIVERY_ID, TIMESTAMP - 301))).rejects.toMatchObject({ code: 'timestamp_out_of_range' });
    await expect(verifyWebhook(await verificationArgs(envelope, DELIVERY_ID, TIMESTAMP + 301))).rejects.toMatchObject({ code: 'timestamp_out_of_range' });
  });

  it('rejects malformed signatures and delivery header/body mismatch', async () => {
    await expect(verifyWebhook({ ...(await verificationArgs(envelope)), signature: 'nope' })).rejects.toMatchObject({ code: 'signature_invalid' });
    await expect(verifyWebhook(await verificationArgs(envelope, 'DIFFERENT-DELIVERY'))).rejects.toMatchObject({ code: 'delivery_id_mismatch' });
  });

  it('rejects unsupported events and versions after authenticating exact bytes', async () => {
    await expect(verifyWebhook(await verificationArgs({ ...envelope, event: 'transaction.changed' }))).rejects.toMatchObject({ code: 'event_unsupported' });
    await expect(verifyWebhook(await verificationArgs({ ...envelope, event_version: '2' }))).rejects.toMatchObject({ code: 'event_version_unsupported' });
  });

  it('rejects an authenticated envelope that does not satisfy the complete public type contract', async () => {
    await expect(verifyWebhook(await verificationArgs({ ...envelope, delivery_id: 'not-a-ulid' }, 'not-a-ulid'))).rejects.toMatchObject({ code: 'body_invalid' });
    await expect(verifyWebhook(await verificationArgs({ ...envelope, data: { ...stubTx, bank_account_id: '2' } }))).rejects.toMatchObject({ code: 'body_invalid' });
    await expect(verifyWebhook(await verificationArgs({ ...envelope, data: { ...stubTx, currency: 'czk' } }))).rejects.toMatchObject({ code: 'body_invalid' });
  });
});
