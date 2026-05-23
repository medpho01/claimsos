/**
 * Symmetric encryption utility for secrets stored at-rest in Postgres
 * (e.g. OAuth refresh tokens on panel_attributes.value_encrypted).
 *
 * Uses AES-256-GCM with a 32-byte master key supplied via env. The IV
 * (12 bytes) is generated fresh per encryption and prepended to the
 * ciphertext along with the 16-byte auth tag, so the stored blob is
 * self-contained:
 *
 *     [ IV (12) | AUTH_TAG (16) | CIPHERTEXT (var) ]
 *
 * Base64-encoded for storage in a TEXT column.
 *
 * Key rotation note: when ENC_KEY_PREVIOUS is set, decrypt tries both
 * keys (current first). Rotation flow:
 *   1. Generate new key.
 *   2. Set ENC_KEY_PREVIOUS = old key, ENC_KEY = new key.
 *   3. Run a backfill that re-encrypts every value_encrypted row with
 *      the new key.
 *   4. Once done, unset ENC_KEY_PREVIOUS.
 *
 * For v2 we can swap this for AWS KMS envelope encryption without
 * changing call sites — encrypt()/decrypt() are the public surface.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function loadKey(envName: string): Buffer | null {
  const raw = process.env[envName];
  if (!raw) return null;

  // Accept either a 64-char hex string or 44-char base64 (32 bytes)
  let buf: Buffer;
  try {
    buf = raw.length === 64 ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  } catch {
    throw new Error(`${envName} could not be decoded as hex or base64`);
  }
  if (buf.length !== 32) {
    throw new Error(`${envName} must decode to 32 bytes; got ${buf.length}`);
  }
  return buf;
}

function getCurrentKey(): Buffer {
  const k = loadKey('ENC_KEY');
  if (!k) {
    throw new Error(
      'ENC_KEY is not set. Generate a 32-byte key (e.g. `openssl rand -base64 32`) and set it in the env.'
    );
  }
  return k;
}

export function encrypt(plaintext: string): string {
  const key = getCurrentKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decrypt(payloadB64: string): string {
  const blob = Buffer.from(payloadB64, 'base64');
  if (blob.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('encrypted blob too short');
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = blob.subarray(IV_LEN + TAG_LEN);

  const keys = [getCurrentKey()];
  const prev = loadKey('ENC_KEY_PREVIOUS');
  if (prev) keys.push(prev);

  let lastErr: Error | null = null;
  for (const k of keys) {
    try {
      const decipher = createDecipheriv(ALGO, k, iv);
      decipher.setAuthTag(tag);
      const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return dec.toString('utf8');
    } catch (err) {
      lastErr = err as Error;
    }
  }
  throw lastErr ?? new Error('decryption failed with all candidate keys');
}

/**
 * Convenience: encrypt/decrypt JSON objects. Throws on parse errors.
 */
export function encryptJson<T>(value: T): string {
  return encrypt(JSON.stringify(value));
}

export function decryptJson<T>(payloadB64: string): T {
  return JSON.parse(decrypt(payloadB64)) as T;
}
