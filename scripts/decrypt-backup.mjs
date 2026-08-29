#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const [input, output] = process.argv.slice(2);
const encodedKey = process.env.BACKUP_DECRYPTION_KEY;
if (!input || !output || !encodedKey) {
  console.error('Usage: BACKUP_DECRYPTION_KEY=<base64-32-bytes> node scripts/decrypt-backup.mjs <input.sql.enc> <output.sql>');
  process.exit(2);
}
const envelope = JSON.parse(await readFile(input, 'utf8'));
if (envelope.format !== 'banksync-backup' || envelope.version !== 1 || envelope.algorithm !== 'AES-256-GCM') {
  throw new Error('unsupported_backup_format');
}
const metadata = {
  format: envelope.format,
  version: envelope.version,
  key_version: envelope.key_version,
  algorithm: envelope.algorithm,
  created_at: envelope.created_at,
};
const keyBytes = Buffer.from(encodedKey, 'base64');
if (keyBytes.length !== 32) throw new Error('BACKUP_DECRYPTION_KEY must decode to 32 bytes');
const key = await webcrypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
const plaintext = await webcrypto.subtle.decrypt({
  name: 'AES-GCM',
  iv: Buffer.from(envelope.iv, 'base64'),
  additionalData: new TextEncoder().encode(JSON.stringify(metadata)),
  tagLength: 128,
}, key, Buffer.from(envelope.ciphertext, 'base64'));
await writeFile(output, new Uint8Array(plaintext), { mode: 0o600, flag: 'wx' });
console.error(`Decrypted backup written to ${output} with mode 0600.`);
