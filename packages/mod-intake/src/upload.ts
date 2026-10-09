import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import type { AocConfig } from '@aoc/contracts';
import { childEnv } from '@aoc/kernel';

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

/** Declared types that match a sniffed kind, with their usual extensions (the portal's file picker lists these). */
export const ACCEPTED_MEDIA: readonly { mime: string; kind: MediaKind; extensions: readonly string[] }[] = [
  { mime: 'image/png', kind: 'image', extensions: ['.png'] },
  { mime: 'image/jpeg', kind: 'image', extensions: ['.jpg', '.jpeg'] },
  { mime: 'image/gif', kind: 'image', extensions: ['.gif'] },
  { mime: 'image/webp', kind: 'image', extensions: ['.webp'] },
  { mime: 'video/mp4', kind: 'video', extensions: ['.mp4', '.m4v'] },
  { mime: 'video/quicktime', kind: 'video', extensions: ['.mov'] },
  { mime: 'video/webm', kind: 'video', extensions: ['.webm'] },
  { mime: 'application/pdf', kind: 'document', extensions: ['.pdf'] },
];

const DECLARED_FAMILY: Record<string, MediaKind> = {
  ...Object.fromEntries(ACCEPTED_MEDIA.map((m) => [m.mime, m.kind])),
  'image/jpg': 'image',
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

/** ClamAV clients, in order of preference: clamdscan streams to a running clamd, clamscan loads the signatures itself. */
export const CLAMAV_BINARIES = ['clamdscan', 'clamscan'] as const;

/**
 * ClamAV through `binary` (a path found by findOnPath), reading the upload from stdin. The client handles untrusted
 * bytes, so it gets the kernel's child allowlist, never aocd's whole environment (G-46, O-13).
 */
export function clamavScanner(binary: string): Scanner {
  const bin = basename(binary);
  return {
    name: bin,
    scan(buf) {
      const r = spawnSync(binary, bin === 'clamdscan' ? ['--stream', '--no-summary', '-'] : ['--no-summary', '-'], {
        input: buf,
        timeout: 120_000,
        env: childEnv(),
      });
      if (r.error) return { verdict: 'unscanned', scanner: bin, detail: String(r.error).slice(0, 200) };
      if (r.status === 0) return { verdict: 'clean', scanner: bin };
      if (r.status === 1) return { verdict: 'infected', scanner: bin, detail: String(r.stdout).slice(0, 200) };
      return { verdict: 'error', scanner: bin, detail: String(r.stderr).slice(0, 200) };
    },
  };
}

export const noScanner: Scanner = { name: 'none', scan: () => ({ verdict: 'unscanned', scanner: 'none' }) };

/** Absolute path of an executable `name` on PATH, or null. */
export function findOnPath(name: string, path = process.env.PATH ?? ''): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

export type ScannerSetting = AocConfig['intake']['scanner'];

/** What scans intake attachments right now, reported by /api/health (names and enums only, never paths). */
export interface ScannerStatus {
  configured: ScannerSetting | 'custom';
  /** The scanner that runs: a ClamAV client, `builtin`, `none`, or a custom integration's name. */
  active: string;
  /** A real anti-virus engine scans uploads; the builtin scanner is a heuristic. */
  avEngine: boolean;
  /** `refused`: every intake carrying files is answered 503 until a usable scanner is present. */
  attachments: 'accepted' | 'refused';
  reason: 'clamav_missing' | 'no_av_engine' | 'scanning_disabled' | null;
}

export interface ResolvedScanner {
  scanner: Scanner;
  status: ScannerStatus;
}

export interface ResolveScannerOptions {
  /** PATH lookup for the ClamAV clients (tests inject one). */
  find?: (binary: string) => string | null;
  /** Embedder-supplied scanner (custom AV integration, tests): an AV engine unless named `builtin` or `none`. */
  custom?: Scanner;
}

/**
 * Picks the scanner for `intake.scanner` (ClamAV preferred by `auto` when installed) and decides whether attachments
 * are accepted: with `requireScan`, a missing engine refuses them, and in production mode the builtin heuristic does
 * not count as a scan (§7, R4).
 */
export function resolveScanner(
  intake: Pick<AocConfig['intake'], 'scanner' | 'requireScan'>,
  mode: AocConfig['mode'],
  opts: ResolveScannerOptions = {},
): ResolvedScanner {
  const heuristicOnly = mode === 'production' ? 'no_av_engine' : null;
  const decide = (scanner: Scanner, configured: ScannerStatus['configured'], avEngine: boolean, refusal: ScannerStatus['reason']): ResolvedScanner => {
    const refused = intake.requireScan && refusal !== null;
    return { scanner, status: { configured, active: scanner.name, avEngine, attachments: refused ? 'refused' : 'accepted', reason: refused ? refusal : null } };
  };
  if (opts.custom) {
    const { name } = opts.custom;
    const refusal = name === 'none' ? 'scanning_disabled' : name === 'builtin' ? heuristicOnly : null;
    return decide(opts.custom, 'custom', name !== 'none' && name !== 'builtin', refusal);
  }
  if (intake.scanner === 'auto' || intake.scanner === 'clamav') {
    const find = opts.find ?? findOnPath;
    const binary = CLAMAV_BINARIES.map((b) => find(b)).find((p): p is string => !!p);
    if (binary) return decide(clamavScanner(binary), intake.scanner, true, null);
    if (intake.scanner === 'clamav') {
      const missing: Scanner = { name: 'clamav', scan: () => ({ verdict: 'unscanned', scanner: 'clamav', detail: 'ClamAV is not installed' }) };
      return decide(missing, 'clamav', false, 'clamav_missing');
    }
  }
  if (intake.scanner === 'none') return decide(noScanner, 'none', false, 'scanning_disabled');
  return decide(builtinScanner, intake.scanner, false, heuristicOnly);
}

/** File names are untrusted: keep a safe display name only. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  return base.replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'file';
}
