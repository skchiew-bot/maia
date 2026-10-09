import { z } from 'zod';
import type { AnchorProviderName } from '@aoc/contracts';
import { localDate } from '@aoc/kernel';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/** The previous anchor of the same provider: the off-host anchors form their own hash-linked list. */
export const PreviousAnchorSchema = z
  .object({ file: z.string().min(1).max(200), seq: z.number().int().min(1), hash: hex64 })
  .strict();

/** Content of `anchors/<YYYY-MM-DD>-<seq>.json` (git repo or RFC 3161 data file). */
export const AnchorRecordSchema = z
  .object({
    chainId: z.string().min(1).max(64),
    seq: z.number().int().min(1),
    hash: hex64,
    anchoredAt: z.string().min(10).max(40),
    previousAnchor: PreviousAnchorSchema.nullable(),
  })
  .strict();
export type AnchorRecord = z.infer<typeof AnchorRecordSchema>;
export type PreviousAnchor = z.infer<typeof PreviousAnchorSchema>;

/** An anchor as found in the external (off-host) store. */
export interface ExternalAnchor {
  provider: AnchorProviderName;
  /** File name inside the provider's anchors directory: `<YYYY-MM-DD>-<seq>.json`. */
  file: string;
  /** Exact file content (the bytes that were committed / timestamped). */
  raw: string;
  record: AnchorRecord;
  /** git: found only on the off-host remote (missing locally). */
  remoteOnly?: boolean;
}

/** `<local date>-<seq>.json` — the date is the anchoring day in the configured timezone. */
export function anchorFileName(record: Pick<AnchorRecord, 'seq' | 'anchoredAt'>, timezone: string): string {
  return `${localDate(Date.parse(record.anchoredAt), timezone)}-${record.seq}.json`;
}

/** Fixed key order + trailing newline so the committed / timestamped bytes are reproducible. */
export function serializeAnchor(r: AnchorRecord): string {
  const ordered = {
    chainId: r.chainId,
    seq: r.seq,
    hash: r.hash,
    anchoredAt: r.anchoredAt,
    previousAnchor: r.previousAnchor,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function parseAnchor(raw: string): AnchorRecord | null {
  try {
    const r = AnchorRecordSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function previousOf(anchors: ExternalAnchor[]): PreviousAnchor | null {
  const last = [...anchors].sort((a, b) => a.record.seq - b.record.seq).at(-1);
  return last ? { file: last.file, seq: last.record.seq, hash: last.record.hash } : null;
}

/**
 * Structural checks over one provider's off-host anchors: every record links to the previous one, so an
 * anchor can only be removed from the end of the list without breaking a link.
 */
export function linkageProblems(anchors: ExternalAnchor[]): string[] {
  const problems: string[] = [];
  const sorted = [...anchors].sort((a, b) => a.record.seq - b.record.seq);
  const byFile = new Map(sorted.map((a) => [a.file, a]));
  const seen = new Map<number, string>();
  sorted.forEach((a, i) => {
    const label = `${a.provider} anchor ${a.file}`;
    const dup = seen.get(a.record.seq);
    if (dup) problems.push(`${label}: duplicate anchor for seq ${a.record.seq} (also ${dup})`);
    seen.set(a.record.seq, a.file);
    const p = a.record.previousAnchor;
    if (i === 0) {
      if (p && byFile.get(p.file) === undefined)
        problems.push(`${label}: previous anchor ${p.file} (seq ${p.seq}) is missing`);
      return;
    }
    if (!p) {
      problems.push(`${label}: anchor list restarted (no previousAnchor although earlier anchors exist)`);
      return;
    }
    const prev = byFile.get(p.file);
    if (!prev) problems.push(`${label}: previous anchor ${p.file} (seq ${p.seq}) is missing`);
    else if (prev.record.seq !== p.seq || prev.record.hash !== p.hash)
      problems.push(`${label}: previousAnchor does not match ${p.file}`);
  });
  return problems;
}
