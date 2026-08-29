import { describe, it, expect } from 'vitest';
import { decryptSecret, encryptSecret, webhookEncrypt, webhookDecrypt } from './crypto.js';

function makeKek32(seed: number): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed * (i + 1)) & 0xff;
  return btoa(String.fromCharCode(...bytes));
}

const KEK = makeKek32(7);

describe('webhookEncrypt / webhookDecrypt', () => {
  it('round-trip happy path', async () => {
    const ct = await webhookEncrypt('whsec_abc123', KEK);
    expect(await webhookDecrypt(ct, KEK)).toBe('whsec_abc123');
  });

  it('produces unique ciphertexts for same input (random IV)', async () => {
    const [a, b, c] = await Promise.all([
      webhookEncrypt('whsec_abc123', KEK),
      webhookEncrypt('whsec_abc123', KEK),
      webhookEncrypt('whsec_abc123', KEK),
    ]);
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });

  it('KEK isolation — decrypt with wrong key throws', async () => {
    const kek2 = makeKek32(13);
    const ct = await webhookEncrypt('secret', KEK);
    await expect(webhookDecrypt(ct, kek2)).rejects.toThrow();
  });

  it('tampered ciphertext throws (auth tag fails)', async () => {
    const ct = await webhookEncrypt('secret', KEK);
    const raw = Uint8Array.from(atob(ct), c => c.charCodeAt(0));
    // Flip a byte in the middle (past the 12-byte IV, before the 16-byte tag).
    const mid = Math.floor(raw.length / 2);
    raw.set([(raw[mid] ?? 0) ^ 0xff], mid);
    const tampered = btoa(String.fromCharCode(...raw));
    await expect(webhookDecrypt(tampered, KEK)).rejects.toThrow();
  });

  it('wrong KEK length (16-byte AES-128) throws with "32 bytes" message', async () => {
    const shortKek = btoa(String.fromCharCode(...new Uint8Array(16).fill(1)));
    await expect(webhookEncrypt('x', shortKek)).rejects.toThrow(/32 bytes/);
  });

  it('garbage cipher throws on decrypt', async () => {
    await expect(webhookDecrypt('not_base64_!', KEK)).rejects.toThrow();
  });

  it('empty plaintext round-trips to empty string', async () => {
    const ct = await webhookEncrypt('', KEK);
    expect(await webhookDecrypt(ct, KEK)).toBe('');
  });

  it('UTF-8 plaintext round-trips identically', async () => {
    const msg = 'Příliš žluťoučký kůň 🐴';
    const ct = await webhookEncrypt(msg, KEK);
    expect(await webhookDecrypt(ct, KEK)).toBe(msg);
  });
});

describe('encryptSecret / decryptSecret', () => {
  it('uses configured key version and round-trips', async () => {
    const env = { ENCRYPTION_KEY_VERSION: '1', ENCRYPTION_KEY_V1: KEK };
    const encrypted = await encryptSecret('fio-token-123456', env);
    expect(encrypted.keyVersion).toBe(1);
    expect(await decryptSecret(encrypted.cipher, encrypted.keyVersion, env)).toBe('fio-token-123456');
  });

  it('decrypts old version when current version has rotated', async () => {
    const oldKey = makeKek32(3);
    const newKey = makeKek32(5);
    const encrypted = await encryptSecret('fio-token-123456', { ENCRYPTION_KEY_VERSION: '1', ENCRYPTION_KEY_V1: oldKey });
    const rotatedEnv = { ENCRYPTION_KEY_VERSION: '2', ENCRYPTION_KEY_V1: oldKey, ENCRYPTION_KEY_V2: newKey };
    expect(await decryptSecret(encrypted.cipher, encrypted.keyVersion, rotatedEnv)).toBe('fio-token-123456');
  });
});
