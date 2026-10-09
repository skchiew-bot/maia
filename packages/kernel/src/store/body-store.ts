import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { open, seal } from '../crypto';

/**
 * One directory-entry name per id, injective and traversal-proof: plain ids (every generated id) are used as-is;
 * anything else — '.', '..', '', separators — becomes a hash, so a scope can never reach outside the blob
 * directory (erasure deletes recursively) nor share a directory with another scope.
 */
function pathSegment(id: string): string {
  return /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(id) ? id : `~${createHash('sha256').update(id).digest('hex').slice(0, 40)}`;
}

/**
 * Per-scope encrypted body store (§13). Bodies (prompts, file contents, intake text/media) live here,
 * encrypted with a per-scope data key (DEK) that is itself wrapped by the master key (KEK).
 * Erasing a scope destroys its DEKs and deletes its rows → bodies become unrecoverable while the hash
 * chain (which only holds blinded payload hashes) stays valid.
 */
export class BodyStore {
  readonly db: DatabaseSync;
  private readonly dekCache = new Map<string, Buffer>();

  constructor(
    path: string,
    private readonly kek: Buffer,
    /** Directory for large encrypted blobs (intake media). */
    private readonly blobDir: string,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS body_keys (
        key_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        generation INTEGER NOT NULL,
        wrapped_nonce BLOB, wrapped_ct BLOB, wrapped_tag BLOB,
        created_at TEXT NOT NULL,
        destroyed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS body_keys_scope ON body_keys(scope, generation);
      CREATE TABLE IF NOT EXISTS bodies (
        event_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        key_id TEXT NOT NULL,
        nonce BLOB NOT NULL, ct BLOB NOT NULL, tag BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS bodies_scope ON bodies(scope);
      CREATE TABLE IF NOT EXISTS blobs (
        blob_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        key_id TEXT NOT NULL,
        nonce BLOB NOT NULL, tag BLOB NOT NULL,
        bytes INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS blobs_scope ON blobs(scope);
    `);
  }

  private activeKey(scope: string, nowIso: string): { keyId: string; dek: Buffer } {
    const row = this.db
      .prepare('SELECT key_id FROM body_keys WHERE scope = ? AND destroyed_at IS NULL ORDER BY generation DESC LIMIT 1')
      .get(scope) as { key_id: string } | undefined;
    if (row) return { keyId: row.key_id, dek: this.unwrap(row.key_id)! };
    const gen = (
      this.db.prepare('SELECT COALESCE(MAX(generation), 0) AS g FROM body_keys WHERE scope = ?').get(scope) as { g: number }
    ).g + 1;
    const keyId = `${scope}#${gen}`;
    const dek = randomBytes(32);
    const w = seal(this.kek, dek, `aoc-dek:${keyId}`);
    this.db
      .prepare('INSERT INTO body_keys (key_id, scope, generation, wrapped_nonce, wrapped_ct, wrapped_tag, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(keyId, scope, gen, w.nonce, w.ct, w.tag, nowIso);
    this.dekCache.set(keyId, dek);
    return { keyId, dek };
  }

  private unwrap(keyId: string): Buffer | null {
    const cached = this.dekCache.get(keyId);
    if (cached) return cached;
    const row = this.db
      .prepare('SELECT wrapped_nonce n, wrapped_ct c, wrapped_tag t, destroyed_at d FROM body_keys WHERE key_id = ?')
      .get(keyId) as { n: Uint8Array | null; c: Uint8Array | null; t: Uint8Array | null; d: string | null } | undefined;
    if (!row || row.d || !row.n || !row.c || !row.t) return null;
    const dek = open(this.kek, { nonce: Buffer.from(row.n), ct: Buffer.from(row.c), tag: Buffer.from(row.t) }, `aoc-dek:${keyId}`);
    this.dekCache.set(keyId, dek);
    return dek;
  }

  put(eventId: string, scope: string, plaintext: string, nowIso: string): void {
    const { keyId, dek } = this.activeKey(scope, nowIso);
    const s = seal(dek, Buffer.from(plaintext, 'utf8'), `aoc-body:${eventId}`);
    this.db
      .prepare('INSERT INTO bodies (event_id, scope, key_id, nonce, ct, tag) VALUES (?,?,?,?,?,?)')
      .run(eventId, scope, keyId, s.nonce, s.ct, s.tag);
  }

  /** null when the body never existed or its scope was erased. */
  get(eventId: string): string | null {
    const row = this.db.prepare('SELECT key_id k, nonce n, ct c, tag t FROM bodies WHERE event_id = ?').get(eventId) as
      | { k: string; n: Uint8Array; c: Uint8Array; t: Uint8Array }
      | undefined;
    if (!row) return null;
    const dek = this.unwrap(row.k);
    if (!dek) return null;
    return open(dek, { nonce: Buffer.from(row.n), ct: Buffer.from(row.c), tag: Buffer.from(row.t) }, `aoc-body:${eventId}`).toString('utf8');
  }

  delete(eventId: string): void {
    this.db.prepare('DELETE FROM bodies WHERE event_id = ?').run(eventId);
  }

  private blobPath(scope: string, blobId: string): string {
    return join(this.blobDir, pathSegment(scope), pathSegment(blobId));
  }

  /** Store a large binary (e.g. intake video) encrypted on disk under the scope's DEK. */
  putBlob(blobId: string, scope: string, data: Buffer, nowIso: string): void {
    const { keyId, dek } = this.activeKey(scope, nowIso);
    const s = seal(dek, data, `aoc-blob:${blobId}`);
    const path = this.blobPath(scope, blobId);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, s.ct, { mode: 0o600 });
    this.db.prepare('INSERT INTO blobs (blob_id, scope, key_id, nonce, tag, bytes) VALUES (?,?,?,?,?,?)').run(blobId, scope, keyId, s.nonce, s.tag, data.length);
  }

  /** null when absent or erased. */
  getBlob(blobId: string): Buffer | null {
    const row = this.db.prepare('SELECT scope, key_id k, nonce n, tag t FROM blobs WHERE blob_id = ?').get(blobId) as
      | { scope: string; k: string; n: Uint8Array; t: Uint8Array }
      | undefined;
    if (!row) return null;
    const dek = this.unwrap(row.k);
    if (!dek) return null;
    let ct: Buffer;
    try {
      ct = readFileSync(this.blobPath(row.scope, blobId));
    } catch {
      return null;
    }
    return open(dek, { nonce: Buffer.from(row.n), ct, tag: Buffer.from(row.t) }, `aoc-blob:${blobId}`);
  }

  /** Crypto-shred a scope: destroy every key generation and delete the ciphertexts (rows + blob files). Returns items removed. */
  eraseScope(scope: string, nowIso: string): number {
    const n =
      (this.db.prepare('SELECT COUNT(*) AS n FROM bodies WHERE scope = ?').get(scope) as { n: number }).n +
      (this.db.prepare('SELECT COUNT(*) AS n FROM blobs WHERE scope = ?').get(scope) as { n: number }).n;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('UPDATE body_keys SET wrapped_nonce = NULL, wrapped_ct = NULL, wrapped_tag = NULL, destroyed_at = ? WHERE scope = ? AND destroyed_at IS NULL')
        .run(nowIso, scope);
      this.db.prepare('DELETE FROM bodies WHERE scope = ?').run(scope);
      this.db.prepare('DELETE FROM blobs WHERE scope = ?').run(scope);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    for (const k of [...this.dekCache.keys()]) if (k.startsWith(`${scope}#`)) this.dekCache.delete(k);
    rmSync(join(this.blobDir, pathSegment(scope)), { recursive: true, force: true });
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return n;
  }

  isErased(scope: string): boolean {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM body_keys WHERE scope = ? AND destroyed_at IS NOT NULL').get(scope) as { n: number };
    return r.n > 0;
  }

  close(): void {
    this.db.close();
  }
}
