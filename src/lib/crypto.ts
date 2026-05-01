import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * AES-256-GCM encrypted-field helpers.
 *
 * Storage format (single base64 string):
 *   [version 1B][iv 12B][auth_tag 16B][ciphertext]
 *
 * The leading version byte lets us rotate algorithms without touching
 * existing rows. Currently only version 1 (AES-256-GCM) is defined.
 *
 * Key:
 *   WORKGRAPH_SECRET_KEY env var, 32 bytes encoded as hex (64 chars) or
 *   base64 (44 chars). Generate with `bunx tsx scripts/gen-secret.ts`.
 *   Without it, encrypt/decrypt throw — callers must surface that loudly.
 */

const VERSION = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.WORKGRAPH_SECRET_KEY;
  if (!raw) {
    throw new Error(
      'WORKGRAPH_SECRET_KEY is not set. Generate one with `bunx tsx scripts/gen-secret.ts` ' +
      'and add it to .env.local before storing or reading encrypted fields.',
    );
  }
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw.trim())) {
    key = Buffer.from(raw.trim(), 'hex');
  } else {
    try {
      key = Buffer.from(raw.trim(), 'base64');
    } catch {
      throw new Error('WORKGRAPH_SECRET_KEY must be 32 bytes encoded as hex (64 chars) or base64 (44 chars).');
    }
  }
  if (key.length !== KEY_LEN) {
    throw new Error(`WORKGRAPH_SECRET_KEY must decode to ${KEY_LEN} bytes (got ${key.length}).`);
  }
  cachedKey = key;
  return key;
}

export function isCryptoConfigured(): boolean {
  try { loadKey(); return true; } catch { return false; }
}

export function encrypt(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, enc]).toString('base64');
}

export function decrypt(payload: string): string {
  const key = loadKey();
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < 1 + IV_LEN + TAG_LEN) {
    throw new Error('Encrypted payload is too short to be valid.');
  }
  const version = buf[0];
  if (version !== VERSION) {
    throw new Error(`Unknown encrypted-field version: ${version}`);
  }
  const iv = buf.subarray(1, 1 + IV_LEN);
  const tag = buf.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const enc = buf.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export function encryptOptional(plaintext: string | null | undefined): string | null {
  if (plaintext == null || plaintext === '') return null;
  return encrypt(plaintext);
}

export function decryptOptional(payload: string | null | undefined): string | null {
  if (payload == null || payload === '') return null;
  return decrypt(payload);
}

// Test-only reset of the cached key (used after env mutation in tests).
export function _resetCachedKey() {
  cachedKey = null;
}
