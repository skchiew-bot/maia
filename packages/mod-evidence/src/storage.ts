import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** evp_ + 26 Crockford base32 chars (contracts newId) — also the path-traversal guard for pack files. */
export const PACK_ID_RE = /^evp_[0-9A-HJKMNP-TV-Z]{26}$/;

export class PackExistsError extends Error {
  constructor(readonly path: string) {
    super(`evidence pack already exists (write-once): ${path}`);
  }
}

export function packPath(dir: string, packId: string): string {
  if (!PACK_ID_RE.test(packId)) throw new Error(`invalid pack id ${packId}`);
  return join(dir, `${packId}.zip`);
}

/** Write-once: refuses to overwrite (O_EXCL), fsyncs, and leaves the file read-only (0444). */
export function writeFrozen(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o444);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new PackExistsError(path);
    throw err;
  }
  try {
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    unlinkSync(path);
    throw err;
  }
  closeSync(fd);
  chmodSync(path, 0o444);
}

/** Stored bytes, or null when the file is gone. */
export function readStored(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Remove a pack that never got its audit event (append failed after the write). */
export function discardUnrecorded(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}
