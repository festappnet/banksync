// AES-GCM symmetric encryption for webhook_consumers.secret_cipher (Phase 1).
// Wire format: base64(iv[12] || ciphertext || tag[16]).
// Uses Web Crypto (globalThis.crypto.subtle) — native in Cloudflare Workers and Node 20+.

const IV_BYTES = 12;
const MIN_PAYLOAD = IV_BYTES + 16; // IV + auth tag

async function importAesGcmKey(b64: string, label: string): Promise<CryptoKey> {
  let bytes: Uint8Array;
  try {
    // Accept both standard and URL-safe base64 by normalising first.
    const std = b64.replace(/-/g, '+').replace(/_/g, '/');
    bytes = Uint8Array.from(atob(std), c => c.charCodeAt(0));
  } catch {
    throw new Error(`${label} must be 32 bytes (256 bits) base64-encoded`);
  }
  if (bytes.length !== 32) {
    throw new Error(`${label} must be 32 bytes (256 bits) base64-encoded`);
  }
  return crypto.subtle.importKey('raw', bytes.buffer as ArrayBuffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function toBase64(bytes: Uint8Array): string {
  // Process in 8 KB chunks to avoid call-stack overflow for large inputs.
  const CHUNK = 8192;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

export async function webhookEncrypt(plaintext: string, kekBase64OrRaw: string): Promise<string> {
  const key = await importAesGcmKey(kekBase64OrRaw, 'WEBHOOK_KEK');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ptBytes = new TextEncoder().encode(plaintext);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, ptBytes);
  const combined = new Uint8Array(IV_BYTES + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), IV_BYTES);
  return toBase64(combined);
}

export async function webhookDecrypt(cipherBase64: string, kekBase64OrRaw: string): Promise<string> {
  const key = await importAesGcmKey(kekBase64OrRaw, 'WEBHOOK_KEK');
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(cipherBase64), c => c.charCodeAt(0));
  } catch {
    throw new Error('cipher payload invalid base64');
  }
  if (bytes.length < MIN_PAYLOAD) {
    throw new Error('cipher payload too short');
  }
  const iv = bytes.slice(0, IV_BYTES);
  const ctAndTag = bytes.slice(IV_BYTES);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ctAndTag);
  return new TextDecoder().decode(pt);
}

export interface VersionedSecretEnv {
  ENCRYPTION_KEY_VERSION?: string;
  [key: `ENCRYPTION_KEY_V${number}`]: string | undefined;
}

function parseKeyVersion(raw: string | undefined): number {
  const value = raw ?? '1';
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error('ENCRYPTION_KEY_VERSION must be a positive integer');
  }
  return Number(value);
}

function getVersionedKey(env: VersionedSecretEnv, version: number): string {
  const key = env[`ENCRYPTION_KEY_V${version}`];
  if (!key) {
    throw new Error(`ENCRYPTION_KEY_V${version} is not configured`);
  }
  return key;
}

async function encryptWithBase64Key(plaintext: string, keyBase64: string, keyLabel: string): Promise<string> {
  const key = await importAesGcmKey(keyBase64, keyLabel);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ptBytes = new TextEncoder().encode(plaintext);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, ptBytes);
  const combined = new Uint8Array(IV_BYTES + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), IV_BYTES);
  return toBase64(combined);
}

async function decryptWithBase64Key(cipherBase64: string, keyBase64: string, keyLabel: string): Promise<string> {
  const key = await importAesGcmKey(keyBase64, keyLabel);
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(cipherBase64), c => c.charCodeAt(0));
  } catch {
    throw new Error('cipher payload invalid base64');
  }
  if (bytes.length < MIN_PAYLOAD) {
    throw new Error('cipher payload too short');
  }
  const iv = bytes.slice(0, IV_BYTES);
  const ctAndTag = bytes.slice(IV_BYTES);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ctAndTag);
  return new TextDecoder().decode(pt);
}

export async function encryptSecret(plaintext: string, env: VersionedSecretEnv): Promise<{
  cipher: string;
  keyVersion: number;
}> {
  const keyVersion = parseKeyVersion(env.ENCRYPTION_KEY_VERSION);
  const keyLabel = `ENCRYPTION_KEY_V${keyVersion}`;
  const cipher = await encryptWithBase64Key(plaintext, getVersionedKey(env, keyVersion), keyLabel);
  return { cipher, keyVersion };
}

export async function decryptSecret(cipher: string, keyVersion: number, env: VersionedSecretEnv): Promise<string> {
  if (!Number.isInteger(keyVersion) || keyVersion <= 0) {
    throw new Error('invalid encryption key version');
  }
  const keyLabel = `ENCRYPTION_KEY_V${keyVersion}`;
  return decryptWithBase64Key(cipher, getVersionedKey(env, keyVersion), keyLabel);
}
