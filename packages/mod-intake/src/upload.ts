import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** Allowed media, identified by MAGIC BYTES (never by extension or declared type alone). */
export type MediaKind = 'image' | 'video' | 'document';
export interface SniffResult {
  mime: string;
  kind: MediaKind;
}

export function sniff(buf: Buffer): SniffResult | null {
  const b = buf;
  const at = (i: number, bytes: number[]) => bytes.every((x, j) => b[i + j] === x);
  if (b.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', kind: 'image' };
  if (b.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', kind: 'image' };
  if (b.length >= 6 && (b.subarray(0, 6).toString('ascii') === 'GIF87a' || b.subarray(0, 6).toString('ascii') === 'GIF89a')) return { mime: 'image/gif', kind: 'image' };
  if (b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', kind: 'image' };
  if (b.length >= 12 && b.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = b.subarray(8, 12).toString('ascii');
    return { mime: brand.startsWith('qt') ? 'video/quicktime' : 'video/mp4', kind: 'video' };
  }
  if (b.length >= 4 && at(0, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: 'video/webm', kind: 'video' };
  if (b.length >= 5 && b.subarray(0, 5).toString('ascii') === '%PDF-') return { mime: 'application/pdf', kind: 'document' };
  return null;
}

const DECLARED_FAMILY: Record<string, MediaKind> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/jpg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'video/webm': 'video',
  'application/pdf': 'document',
};

/** A declared type that contradicts the sniffed content is rejected (polyglot / disguised uploads). */
export function declaredMatches(declared: string | undefined, sniffed: SniffResult): boolean {
  if (!declared || declared === 'application/octet-stream') return true;
  const fam = DECLARED_FAMILY[declared.toLowerCase()];
  return fam === sniffed.kind;
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export interface ScanResult {
  verdict: 'clean' | 'infected' | 'unscanned' | 'error';
  scanner: string;
  detail?: string;
}
export interface Scanner {
  name: string;
  scan(buf: Buffer): ScanResult;
}

// The standard EICAR anti-malware test string (built from parts so this file is not itself flagged).
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('');

/** Built-in scanner: EICAR test signature, script polyglots in the header region, active content in PDFs. */
export const builtinScanner: Scanner = {
  name: 'builtin',
  scan(buf) {
    const text = buf.subarray(0, Math.min(buf.length, 4 * 1024 * 1024)).toString('latin1');
    if (text.includes(EICAR)) return { verdict: 'infected', scanner: 'builtin', detail: 'EICAR test signature' };
    if (/<script[\s>]/i.test(text.slice(0, 65_536))) return { verdict: 'infected', scanner: 'builtin', detail: 'script polyglot' };
    if (text.startsWith('%PDF-') && /\/(JavaScript|JS|Launch|EmbeddedFile)\b/.test(text)) {
      return { verdict: 'infected', scanner: 'builtin', detail: 'PDF with active content' };
    }
    return { verdict: 'clean', scanner: 'builtin' };
  },
};

/** ClamAV via clamdscan/clamscan when installed (stdin stream); "unscanned" when unavailable. */
export const clamavScanner: Scanner = {
  name: 'clamav',
  scan(buf) {
    for (const bin of ['clamdscan', 'clamscan']) {
      const r = spawnSync(bin, bin === 'clamdscan' ? ['--stream', '--no-summary', '-'] : ['--no-summary', '-'], { input: buf, timeout: 120_000 });
      if (r.error) continue;
      if (r.status === 0) return { verdict: 'clean', scanner: bin };
      if (r.status === 1) return { verdict: 'infected', scanner: bin, detail: String(r.stdout).slice(0, 200) };
      return { verdict: 'error', scanner: bin, detail: String(r.stderr).slice(0, 200) };
    }
    return { verdict: 'unscanned', scanner: 'clamav' };
  },
};

export const noScanner: Scanner = { name: 'none', scan: () => ({ verdict: 'unscanned', scanner: 'none' }) };

export function scannerFor(kind: 'clamav' | 'builtin' | 'none'): Scanner {
  return kind === 'clamav' ? clamavScanner : kind === 'none' ? noScanner : builtinScanner;
}

/** File names are untrusted: keep a safe display name only. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  return base.replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'file';
}
