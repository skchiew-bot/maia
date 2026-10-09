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
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
  /**
   * The data directory. A production KEK must live outside it (':memory:' skips that check); a development KEK is
   * generated only while it holds no data (default: the key file's directory, where `<dataDir>/master.key` lives).
   */
  dataDir?: string;
}

/** Where a loaded KEK came from: the environment, an existing file, or a freshly generated file. */
export type MasterKeySource = 'env' | 'file' | 'generated';

/**
 * Load the KEK (key-encryption key). Development order: AOC_MASTER_KEY env → file → generate one into `file`
 * (0600, missing parent directories 0700), but only for a data directory that holds no data yet: a new KEK cannot
 * unwrap the data keys already in bodies.db, so generating one beside existing data (a restore, a lost or mistyped
 * key path) would orphan every encrypted body. Production: see MasterKeyPolicy and docs/runbooks/key-custody.md.
 */
export function loadOrCreateMasterKey(
  file: string,
  env: Record<string, string | undefined> = process.env,
  policy: MasterKeyPolicy = {},
): { key: Buffer; created: boolean; source: MasterKeySource } {
  if (policy.production)
    return { key: loadProductionKey(file, env, policy.dataDir), created: false, source: 'file' };
  if (env.AOC_MASTER_KEY) return { key: parseKey(env.AOC_MASTER_KEY), created: false, source: 'env' };
  if (existsSync(file)) return { key: parseKey(readFileSync(file, 'utf8')), created: false, source: 'file' };
  refuseToOrphanData(file, policy.dataDir ?? dirname(file));
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  writeFileSync(file, key.toString('hex') + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return { key, created: true, source: 'generated' };
}

function refuseToOrphanData(file: string, dataDir: string): void {
  if (dataDir === ':memory:') return;
  const held = dataSealedUnderTheKek(dataDir);
  if (!held.length) return;
  throw new Error(
    `refusing to generate a new KEK: ${dataDir} already holds data (${held.join(', ')}) and there is no KEK at ${file}. ` +
      'A new key cannot unwrap the data keys that exist, so every encrypted body would be lost for good. ' +
      `Restore the original KEK to ${file} (or point keys.masterKeyFile at it); to start over on purpose, move ${dataDir} aside ` +
      '(docs/runbooks/key-custody.md §8)',
  );
}

/**
 * What the databases in `dataDir` hold that only the KEK they were sealed under can read: events (their bodies were
 * sealed under it) and wrapped data keys. A database that cannot be read counts as data — this check fails closed.
 */
function dataSealedUnderTheKek(dataDir: string): string[] {
  const held: string[] = [];
  for (const [database, table, what] of [
    ['aoc.db', 'events', 'events'],
    ['bodies.db', 'body_keys', 'wrapped data keys'],
  ] as const) {
    const path = join(dataDir, database);
    if (!existsSync(path)) continue;
    try {
      if (tableHasRows(path, table)) held.push(`${database} holds ${what}`);
    } catch (err) {
      held.push(`${database} cannot be read: ${(err as Error).message}`);
    }
  }
  return held;
}

function tableHasRows(databaseFile: string, table: string): boolean {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return false;
    return db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined;
  } finally {
    db.close();
  }
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
