import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** AES-256-GCM sealed box: 12-byte nonce, 16-byte tag, AAD binds the ciphertext to its context. */
export interface Sealed {
  nonce: Buffer;
  ct: Buffer;
  tag: Buffer;
}

export function seal(key: Buffer, plaintext: Buffer, aad: string): Sealed {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { nonce, ct, tag: c.getAuthTag() };
}

export function open(key: Buffer, s: Sealed, aad: string): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, s.nonce);
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(s.tag);
  return Buffer.concat([d.update(s.ct), d.final()]);
}

export function parseKey(text: string): Buffer {
  const t = text.trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64');
  if (buf.length !== 32) throw new Error('master key must be 32 bytes (64 hex chars or base64)');
  return buf;
}

/**
 * Load the KEK (key-encryption key). Order: AOC_MASTER_KEY env → file. If neither exists, generate one
 * into `file` with 0600 permissions (dev default — production must follow docs/runbooks/key-custody.md, R6).
 */
export function loadOrCreateMasterKey(file: string, env: Record<string, string | undefined> = process.env): { key: Buffer; created: boolean } {
  if (env.AOC_MASTER_KEY) return { key: parseKey(env.AOC_MASTER_KEY), created: false };
  if (existsSync(file)) return { key: parseKey(readFileSync(file, 'utf8')), created: false };
  mkdirSync(dirname(file), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, key.toString('hex') + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return { key, created: true };
}
