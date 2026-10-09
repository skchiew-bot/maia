import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, type Hash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { keyFingerprint } from '@aoc/kernel';

/**
 * The `.aocbk` container (G-21). Layout:
 *
 *   "AOCBKUP1" | u32 header length | header JSON (clear: format, salt, backup-key fingerprint, ids)
 *   frames: u8 flags (1 = final) | u32 ciphertext length (≤ 64 KiB) | AES-256-GCM ciphertext | 16-byte tag
 *
 * The frame key is HKDF-SHA256(backup key, salt), so every backup has its own key; the nonce is the flags byte and
 * a 64-bit frame counter, and the AAD is the exact header bytes. Reordered, dropped, truncated or edited frames and
 * an edited header all fail authentication; a stream without a final frame is truncated. The plaintext is a sequence
 * of records — u32 length | record JSON, then `size` content bytes for a file — ending with the manifest.
 */
export const BACKUP_FORMAT = 'aoc-backup/1';
const MAGIC = Buffer.from('AOCBKUP1', 'ascii');
const CHUNK = 64 * 1024;
const TAG_BYTES = 16;
const MAX_HEADER_BYTES = 4096;
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const WRITE_BATCH = 1024 * 1024;
const FINAL = 1;

export interface BackupHeader {
  format: typeof BACKUP_FORMAT;
  cipher: 'aes-256-gcm';
  kdf: 'hkdf-sha256';
  chunk: number;
  salt: string;
  keyId: string;
  backupId: string;
  createdAt: string;
}

export interface BackupManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

/** The last record of every archive: what was packed and the state it captured. */
export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  backupId: string;
  createdAt: string;
  chainId: string;
  headSeq: number;
  headHash: string;
  /** Fingerprint of the KEK that unwraps the bodies' data keys — the KEK itself is never in a backup. */
  kekId: string;
  bodies: number;
  bodiesMissing: number;
  blobs: number;
  /** Blob paths whose files were gone when they were packed (their scope was being erased). */
  skippedBlobs: string[];
  files: BackupManifestFile[];
}

export type BackupRecord = { t: 'file'; path: string; size: number } | { t: 'end'; manifest: BackupManifest };

export class BackupFormatError extends Error {
  constructor(
    readonly code:
      | 'not_a_backup'
      | 'unsupported_format'
      | 'wrong_backup_key'
      | 'corrupt'
      | 'truncated'
      | 'bad_path',
    message: string,
  ) {
    super(message);
  }
}

export const backupKeyId = (key: Buffer): string => keyFingerprint(key, 'backup');

function frameKey(backupKey: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', backupKey, salt, `${BACKUP_FORMAT} frame key`, 32));
}

function nonce(flags: number, counter: bigint): Buffer {
  const n = Buffer.alloc(12);
  n[0] = flags;
  n.writeBigUInt64BE(counter, 4);
  return n;
}

const SEGMENT = /^[A-Za-z0-9_~-][A-Za-z0-9_.~-]{0,254}$/;

/**
 * The only paths an archive may hold, relative to the data dir: the two databases, `blobs/<scope>/<id>`, and files
 * under `anchors/` (RFC 3161 tokens) or `evidence/` (frozen packs). Never `master.key`, `bootstrap-token` or anything
 * else in the data dir; never `.`/`..`, hidden or absolute paths.
 */
export function isArchivePath(path: string): boolean {
  if (path === 'aoc.db' || path === 'bodies.db') return true;
  const segs = path.split('/');
  if (!segs.every((s) => SEGMENT.test(s))) return false;
  if (segs[0] === 'blobs') return segs.length === 3;
  return (segs[0] === 'anchors' || segs[0] === 'evidence') && segs.length >= 2 && segs.length <= 4;
}

/** Writes the encrypted container. Plaintext goes in through write(); finish() seals the final frame. */
export class SealedWriter {
  private readonly key: Buffer;
  private readonly aad: Buffer;
  private readonly fileHash: Hash = createHash('sha256');
  private plain: Buffer[] = [];
  private plainBytes = 0;
  private out: Buffer[] = [];
  private outBytes = 0;
  private counter = 0n;
  private written = 0;

  private constructor(
    private readonly fh: FileHandle,
    backupKey: Buffer,
    salt: Buffer,
    header: Buffer,
  ) {
    this.key = frameKey(backupKey, salt);
    this.aad = header;
  }

  /** Creates `path` exclusively (mode 0600) and writes the header. */
  static async create(
    path: string,
    backupKey: Buffer,
    ids: { backupId: string; createdAt: string },
  ): Promise<SealedWriter> {
    const salt = randomBytes(32);
    const header: BackupHeader = {
      format: BACKUP_FORMAT,
      cipher: 'aes-256-gcm',
      kdf: 'hkdf-sha256',
      chunk: CHUNK,
      salt: salt.toString('hex'),
      keyId: backupKeyId(backupKey),
      backupId: ids.backupId,
      createdAt: ids.createdAt,
    };
    const json = Buffer.from(JSON.stringify(header), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(json.length);
    const head = Buffer.concat([MAGIC, len, json]);
    const fh = await open(path, 'wx', 0o600);
    const w = new SealedWriter(fh, backupKey, salt, head);
    w.queue(head);
    return w;
  }

  async write(data: Buffer): Promise<void> {
    this.plain.push(data);
    this.plainBytes += data.length;
    if (this.plainBytes >= CHUNK) {
      const all = Buffer.concat(this.plain);
      let off = 0;
      for (; all.length - off >= CHUNK; off += CHUNK) this.seal(all.subarray(off, off + CHUNK), 0);
      this.plain = off < all.length ? [all.subarray(off)] : [];
      this.plainBytes = all.length - off;
    }
    if (this.outBytes >= WRITE_BATCH) await this.flush();
  }

  /** Seals the final frame, fsyncs and closes. Returns the size and SHA-256 of the whole file. */
  async finish(): Promise<{ bytes: number; sha256: string }> {
    this.seal(Buffer.concat(this.plain), FINAL);
    this.plain = [];
    await this.flush();
    await this.fh.sync();
    await this.fh.close();
    return { bytes: this.written, sha256: this.fileHash.digest('hex') };
  }

  /** Close without finishing (the caller removes the partial file). */
  async abort(): Promise<void> {
    await this.fh.close().catch(() => undefined);
  }

  private seal(chunk: Buffer, flags: number): void {
    const c = createCipheriv('aes-256-gcm', this.key, nonce(flags, this.counter++));
    c.setAAD(this.aad);
    const ct = Buffer.concat([c.update(chunk), c.final()]);
    const frame = Buffer.alloc(5);
    frame[0] = flags;
    frame.writeUInt32BE(ct.length, 1);
    this.queue(frame, ct, c.getAuthTag());
  }

  private queue(...parts: Buffer[]): void {
    for (const p of parts) {
      this.out.push(p);
      this.outBytes += p.length;
    }
  }

  private async flush(): Promise<void> {
    if (!this.outBytes) return;
    const buf = Buffer.concat(this.out);
    this.out = [];
    this.outBytes = 0;
    let off = 0;
    while (off < buf.length) off += (await this.fh.write(buf, off, buf.length - off)).bytesWritten;
    this.fileHash.update(buf);
    this.written += buf.length;
  }
}

/** Reads and authenticates the container frame by frame; read(n) returns exactly n plaintext bytes. */
export class SealedReader {
  private readonly key: Buffer;
  private pos: number;
  private counter = 0n;
  private plain: Buffer[] = [];
  private plainBytes = 0;
  private final = false;

  private constructor(
    private readonly fh: FileHandle,
    private readonly size: number,
    readonly header: BackupHeader,
    private readonly aad: Buffer,
    backupKey: Buffer,
  ) {
    this.key = frameKey(backupKey, Buffer.from(header.salt, 'hex'));
    this.pos = aad.length;
  }

  static async open(path: string, backupKey: Buffer): Promise<SealedReader> {
    const fh = await open(path, 'r');
    try {
      const size = (await fh.stat()).size;
      const lead = await readAt(fh, 0, 12);
      if (lead.length < 12 || !lead.subarray(0, 8).equals(MAGIC))
        throw new BackupFormatError('not_a_backup', 'not an AOC backup file');
      const len = lead.readUInt32BE(8);
      if (len > MAX_HEADER_BYTES) throw new BackupFormatError('corrupt', 'backup header too large');
      const json = await readAt(fh, 12, len);
      if (json.length !== len) throw new BackupFormatError('truncated', 'backup header is truncated');
      let header: BackupHeader;
      try {
        header = JSON.parse(json.toString('utf8')) as BackupHeader;
      } catch {
        throw new BackupFormatError('corrupt', 'backup header is not JSON');
      }
      if (header.format !== BACKUP_FORMAT || header.cipher !== 'aes-256-gcm' || header.kdf !== 'hkdf-sha256')
        throw new BackupFormatError('unsupported_format', `unsupported backup format ${String(header.format)}`);
      if (header.chunk !== CHUNK || !/^[0-9a-f]{64}$/.test(header.salt))
        throw new BackupFormatError('corrupt', 'backup header is invalid');
      const supplied = backupKeyId(backupKey);
      if (header.keyId !== supplied)
        throw new BackupFormatError(
          'wrong_backup_key',
          `this backup needs backup key ${header.keyId}; the supplied key is ${supplied}`,
        );
      return new SealedReader(fh, size, header, Buffer.concat([lead, json]), backupKey);
    } catch (err) {
      await fh.close();
      throw err;
    }
  }

  async read(n: number): Promise<Buffer> {
    while (this.plainBytes < n) {
      if (this.final) throw new BackupFormatError('truncated', 'backup ended in the middle of a record');
      await this.nextFrame();
    }
    const all = this.plain.length === 1 ? this.plain[0]! : Buffer.concat(this.plain);
    this.plain = [all.subarray(n)];
    this.plainBytes = all.length - n;
    return all.subarray(0, n);
  }

  /** True once the final frame was read, every plaintext byte consumed, and nothing follows in the file. */
  async atEnd(): Promise<boolean> {
    while (!this.final && this.plainBytes === 0) await this.nextFrame();
    return this.final && this.plainBytes === 0;
  }

  async close(): Promise<void> {
    await this.fh.close().catch(() => undefined);
  }

  private async nextFrame(): Promise<void> {
    const head = await readAt(this.fh, this.pos, 5);
    if (head.length < 5) throw new BackupFormatError('truncated', 'backup is truncated (no final frame)');
    const flags = head[0]!;
    const len = head.readUInt32BE(1);
    if ((flags & ~FINAL) !== 0 || len > CHUNK) throw new BackupFormatError('corrupt', 'backup frame is invalid');
    const body = await readAt(this.fh, this.pos + 5, len + TAG_BYTES);
    if (body.length < len + TAG_BYTES) throw new BackupFormatError('truncated', 'backup is truncated mid-frame');
    let plain: Buffer;
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, nonce(flags, this.counter++));
      d.setAAD(this.aad);
      d.setAuthTag(body.subarray(len));
      plain = Buffer.concat([d.update(body.subarray(0, len)), d.final()]);
    } catch {
      throw new BackupFormatError('corrupt', 'backup failed authentication (altered, or a different key)');
    }
    this.pos += 5 + len + TAG_BYTES;
    if (flags & FINAL) {
      this.final = true;
      if (this.pos !== this.size) throw new BackupFormatError('corrupt', 'data follows the final backup frame');
    }
    this.plain.push(plain);
    this.plainBytes += plain.length;
  }
}

function isManifest(m: unknown): m is BackupManifest {
  const x = m as Partial<BackupManifest> | null;
  return (
    !!x &&
    x.format === BACKUP_FORMAT &&
    typeof x.backupId === 'string' &&
    typeof x.chainId === 'string' &&
    Number.isSafeInteger(x.headSeq) &&
    typeof x.headHash === 'string' &&
    typeof x.kekId === 'string' &&
    Number.isSafeInteger(x.bodiesMissing) &&
    Array.isArray(x.skippedBlobs) &&
    Array.isArray(x.files)
  );
}

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let off = 0;
  while (off < length) {
    const { bytesRead } = await fh.read(buf, off, length - off, position + off);
    if (bytesRead === 0) break;
    off += bytesRead;
  }
  return buf.subarray(0, off);
}

/** Record layer on top of SealedWriter. */
export class ArchiveWriter {
  readonly files: BackupManifestFile[] = [];

  constructor(private readonly sealed: SealedWriter) {}

  /**
   * Pack one file under its archive path. Returns null when the source no longer exists (erased between the
   * snapshot and the copy). The file is opened before its size is read, so an unlink cannot cut it short.
   */
  async addFile(path: string, source: string, signal?: AbortSignal): Promise<BackupManifestFile | null> {
    if (!isArchivePath(path)) throw new BackupFormatError('bad_path', `refusing to pack ${path}`);
    let fh: FileHandle;
    try {
      fh = await open(source, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    try {
      const size = (await fh.stat()).size;
      await this.record({ t: 'file', path, size });
      const hash = createHash('sha256');
      const buf = Buffer.alloc(Math.min(size, 1024 * 1024) || 1);
      let done = 0;
      while (done < size) {
        signal?.throwIfAborted();
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - done), done);
        if (bytesRead === 0) throw new Error(`${path} shrank while it was being packed`);
        const chunk = Buffer.from(buf.subarray(0, bytesRead));
        hash.update(chunk);
        await this.sealed.write(chunk);
        done += bytesRead;
      }
      const entry = { path, bytes: size, sha256: hash.digest('hex') };
      this.files.push(entry);
      return entry;
    } finally {
      await fh.close();
    }
  }

  async end(manifest: Omit<BackupManifest, 'files'>): Promise<{ bytes: number; sha256: string }> {
    await this.record({ t: 'end', manifest: { ...manifest, files: this.files } });
    return this.sealed.finish();
  }

  abort(): Promise<void> {
    return this.sealed.abort();
  }

  private async record(r: BackupRecord): Promise<void> {
    const json = Buffer.from(JSON.stringify(r), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(json.length);
    await this.sealed.write(Buffer.concat([len, json]));
  }
}

/** Record layer on top of SealedReader. */
export class ArchiveReader {
  constructor(private readonly sealed: SealedReader) {}

  get header(): BackupHeader {
    return this.sealed.header;
  }

  async next(): Promise<BackupRecord> {
    const len = (await this.sealed.read(4)).readUInt32BE(0);
    if (len > MAX_RECORD_BYTES) throw new BackupFormatError('corrupt', 'backup record too large');
    let r: BackupRecord;
    try {
      r = JSON.parse((await this.sealed.read(len)).toString('utf8')) as BackupRecord;
    } catch (err) {
      if (err instanceof BackupFormatError) throw err;
      throw new BackupFormatError('corrupt', 'backup record is not JSON');
    }
    if (r.t === 'file') {
      if (!isArchivePath(r.path) || !Number.isSafeInteger(r.size) || r.size < 0)
        throw new BackupFormatError('bad_path', `backup holds an unexpected entry ${String(r.path)}`);
    } else if (r.t !== 'end' || !isManifest(r.manifest)) throw new BackupFormatError('corrupt', 'unknown backup record');
    return r;
  }

  /** Stream a file record's content to `fh`; returns its SHA-256. */
  async copyTo(size: number, fh: FileHandle): Promise<string> {
    const hash = createHash('sha256');
    let left = size;
    while (left > 0) {
      const chunk = await this.sealed.read(Math.min(left, CHUNK));
      hash.update(chunk);
      let off = 0;
      while (off < chunk.length) off += (await fh.write(chunk, off, chunk.length - off)).bytesWritten;
      left -= chunk.length;
    }
    return hash.digest('hex');
  }

  atEnd(): Promise<boolean> {
    return this.sealed.atEnd();
  }

  close(): Promise<void> {
    return this.sealed.close();
  }
}
