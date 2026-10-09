import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { sha256hex } from '@aoc/kernel';

const TAIL_BYTES = 64 * 1024;

function lastLine(fd: number): string | null {
  const size = fstatSync(fd).size;
  if (size === 0) return null;
  const len = Math.min(size, TAIL_BYTES);
  const buf = Buffer.alloc(len);
  readSync(fd, buf, 0, len, size - len);
  const lines = buf
    .toString('utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
  return lines.length ? lines[lines.length - 1]! : null;
}

/**
 * Append one JSON line to the self-modification log that lives OUTSIDE AOC's database ("audited outside AOC",
 * §13/R14). Each line carries the sha256 of the previous line, so truncation or edits in the middle are evident
 * to anyone re-hashing the file. fsync'd before returning. Returns the new line's hash.
 */
export function appendExternalAuditLine(file: string, entry: Record<string, unknown>): string {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const fd = openSync(file, 'a+', 0o600);
  try {
    const prev = lastLine(fd);
    const line = JSON.stringify({ ...entry, prev: prev === null ? null : sha256hex(prev) });
    writeSync(fd, `${line}\n`);
    fsyncSync(fd);
    return sha256hex(line);
  } finally {
    closeSync(fd);
  }
}

/** Re-hash the external log: index of the first line whose `prev` does not match (null = intact). */
export function verifyExternalAuditLog(text: string): number | null {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  let prev: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    let parsed: { prev?: unknown };
    try {
      parsed = JSON.parse(lines[i]!) as { prev?: unknown };
    } catch {
      return i;
    }
    if ((parsed.prev ?? null) !== prev) return i;
    prev = sha256hex(lines[i]!);
  }
  return null;
}
