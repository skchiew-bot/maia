import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

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

export interface MasterKeyPolicy {
  /**
   * Production (R6, threat model O-13 / T-18): the KEK comes only from an existing file outside `dataDir`, mode
   * 0400 or 0600, owned by aocd's user — or from a systemd credential in $CREDENTIALS_DIRECTORY. AOC_MASTER_KEY
   * is refused (child processes inherit the environment) and nothing is ever generated.
   */
  production?: boolean;
  /** The data directory a production KEK must live outside of (':memory:' skips that check). */
  dataDir?: string;
}

/**
 * Load the KEK (key-encryption key). Development order: AOC_MASTER_KEY env → file → generate one into `file`
 * (0600, missing parent directories 0700). Production: see MasterKeyPolicy and docs/runbooks/key-custody.md.
 */
export function loadOrCreateMasterKey(
  file: string,
  env: Record<string, string | undefined> = process.env,
  policy: MasterKeyPolicy = {},
): { key: Buffer; created: boolean } {
  if (policy.production) return { key: loadProductionKey(file, env, policy.dataDir), created: false };
  if (env.AOC_MASTER_KEY) return { key: parseKey(env.AOC_MASTER_KEY), created: false };
  if (existsSync(file)) return { key: parseKey(readFileSync(file, 'utf8')), created: false };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  writeFileSync(file, key.toString('hex') + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return { key, created: true };
}

function loadProductionKey(file: string, env: Record<string, string | undefined>, dataDir?: string): Buffer {
  const refuse = (why: string) => new Error(`production mode: ${why} (docs/runbooks/key-custody.md §2-§3)`);
  if (env.AOC_MASTER_KEY)
    throw refuse(
      'a KEK from AOC_MASTER_KEY is refused because child processes inherit the environment; keep it in keys.masterKeyFile',
    );
  let st: Stats;
  try {
    st = statSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'error';
    throw refuse(`the KEK file ${file} is unavailable (${code}); a production KEK is never generated`);
  }
  if (!st.isFile()) throw refuse(`the KEK file ${file} is not a regular file`);
  // A systemd credential is root-owned with an ACL for this service alone, in a service-private directory.
  const credentials = env.CREDENTIALS_DIRECTORY;
  if (!(credentials && isInside(credentials, file))) {
    const mode = st.mode & 0o777;
    if (mode !== 0o400 && mode !== 0o600)
      throw refuse(`the KEK file ${file} has mode 0${mode.toString(8)}; it must be 0400 or 0600`);
    const uid = process.geteuid?.();
    if (uid !== undefined && st.uid !== uid)
      throw refuse(`the KEK file ${file} is owned by uid ${st.uid}, not by aocd's user (uid ${uid})`);
  }
  if (dataDir && dataDir !== ':memory:' && isInside(dataDir, file))
    throw refuse(`the KEK file ${file} is inside dataDir, so every copy of the data would carry its own key`);
  return parseKey(readFileSync(file, 'utf8'));
}

function isInside(dir: string, file: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const rel = relative(real(dir), real(file));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
