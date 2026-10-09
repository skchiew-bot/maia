/**
 * Audit trail and integrity (§13) as the UI reads it: chain coverage by anchors, anchor age, the verify verdict
 * (only verify-against-anchor proves integrity), and the event explorer's filters. Pure functions.
 */
import type { AnchorDTO, AuditEventHeaderDTO, VerifyReportDTO } from '@aoc/contracts';
import type { Tone } from '../../components/tone';
import { toEpoch } from '../../lib/format';

/** Anchor age after which the console warns (mod-audit's default staleAfterMs; health reports the live value). */
export const DEFAULT_STALE_AFTER_MS = 26 * 3_600_000;

export interface ChainCoverage {
  headSeq: number;
  /** Highest seq protected by an anchor (0 when there is none). */
  anchoredThrough: number;
  /** Events after the last anchor: rewritable by a host-level attacker until the next anchor (R2). */
  unanchored: number;
  /** Share of the chain at or below the last anchor. */
  ratio: number;
  /** Anchor positions as a share of the chain, oldest first. */
  ticks: { seq: number; at: number }[];
}

export function chainCoverage(headSeq: number, anchors: readonly Pick<AnchorDTO, 'seq'>[]): ChainCoverage {
  const seqs = anchors.map((a) => a.seq).filter((s) => s > 0 && s <= headSeq);
  const anchoredThrough = seqs.length ? Math.max(...seqs) : 0;
  const head = Math.max(0, headSeq);
  return {
    headSeq: head,
    anchoredThrough,
    unanchored: Math.max(0, head - anchoredThrough),
    ratio: head > 0 ? anchoredThrough / head : 0,
    ticks: [...new Set(seqs)].sort((a, b) => a - b).map((seq) => ({ seq, at: head > 0 ? seq / head : 0 })),
  };
}

export function anchorAge(
  lastAnchorAt: string | null | undefined,
  now: number,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
): { ageMs: number | null; stale: boolean } {
  if (!lastAnchorAt) return { ageMs: null, stale: true };
  const ageMs = Math.max(0, now - toEpoch(lastAnchorAt));
  return { ageMs, stale: ageMs > staleAfterMs };
}

export interface VerifyVerdict {
  tone: Tone;
  title: string;
  /** Why the verdict is what it is, in one sentence. */
  detail: string;
}

/**
 * The in-file chain check alone is defeatable by anyone who can recompute it (R2); integrity is proven only when
 * the recomputed chain matches every external anchor. Local-only anchors are said plainly.
 */
export function verifyVerdict(r: VerifyReportDTO, offHost: boolean): VerifyVerdict {
  const matched = r.anchors.filter((a) => a.matched && a.proofOk).length;
  if (!r.chainOk)
    return {
      tone: 'danger',
      title: `Chain broken${r.firstBadSeq !== null ? ` at #${r.firstBadSeq}` : ''}`,
      detail:
        'Recomputing the hashes does not reproduce the log. Freeze gates and follow the anchoring runbook (Sev-1).',
    };
  if (r.anchors.length === 0)
    return {
      tone: 'warn',
      title: 'Not proven: no anchor to verify against',
      detail:
        'The in-file chain recomputes, but that alone is defeatable. Anchor the head off-host, then verify again.',
    };
  if (matched < r.anchors.length)
    return {
      tone: 'danger',
      title: `${r.anchors.length - matched} of ${r.anchors.length} anchors do not match`,
      detail:
        'The recomputed chain differs from an external anchor or its proof failed: history before that anchor changed.',
    };
  if (!r.ok)
    return {
      tone: 'danger',
      title: 'Verification failed',
      detail: r.problems[0] ?? 'Verify reported a problem.',
    };
  if (!offHost)
    return {
      tone: 'warn',
      title: `Matches ${matched} ${matched === 1 ? 'anchor' : 'anchors'}, but they are local only`,
      detail:
        'The anchors live on this host, so they do not yet defend against a host-level rewrite (R2). Configure an off-host remote or RFC 3161.',
    };
  return {
    tone: 'ok',
    title: `Verified against ${matched} off-host ${matched === 1 ? 'anchor' : 'anchors'}`,
    detail: 'The recomputed chain matches every external anchor, so the log up to the last anchor is intact.',
  };
}

/** `git:<commit>:<path>` → the commit and file the anchor lives in; RFC 3161 → the token reference. */
export function parseProofRef(
  proofRef: string,
): { kind: 'git'; commit: string; path: string } | { kind: 'other'; ref: string } {
  const m = /^git:([0-9a-f]{7,64}):(.+)$/i.exec(proofRef);
  return m ? { kind: 'git', commit: m[1]!, path: m[2]! } : { kind: 'other', ref: proofRef };
}

export type RangePreset = '1h' | '24h' | '7d' | '30d' | 'all';

export const RANGE_OPTIONS: readonly { value: RangePreset; label: string }[] = [
  { value: '1h', label: '1 hour' },
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All' },
];

const RANGE_MS: Record<Exclude<RangePreset, 'all'>, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

/** Earliest event time inside the range (null = no lower bound). */
export function rangeCutoff(range: RangePreset, now: number): number | null {
  return range === 'all' ? null : now - RANGE_MS[range];
}

/** Event families of the catalog, for the explorer's type suggestions (prefix match). */
export const EVENT_FAMILIES: readonly string[] = [
  'change.',
  'rollback.',
  'breakglass.',
  'promotion.',
  'git.',
  'phase.',
  'decision.',
  'anchor.',
  'chain.',
  'body.',
  'selfmod.',
  'config.',
  'mapping.',
  'evidence_pack.',
  'session.',
  'task.',
  'manifest.',
  'tool.',
  'usage.',
  'throttle.',
  'credit.',
  'fx.',
  'ratecard.',
  'error.',
  'rootcause.',
  'lesson.',
  'playbook.',
  'ticket.',
  'intake.',
  'user.',
  'token.',
  'passkey.',
  'project.',
  'registry.',
];

/**
 * Explorer type filter: `change.` (or `change`) is a prefix; `change.submitted` an exact type; several exact types
 * may be comma-separated. Anything else is ignored rather than sent to the daemon.
 */
export function parseTypeFilter(input: string): { type?: string; typePrefix?: string } {
  const v = input.trim().toLowerCase();
  if (!v) return {};
  if (/^[a-z0-9_]+(\.[a-z0-9_]+)+(,\s*[a-z0-9_]+(\.[a-z0-9_]+)+)*$/.test(v))
    return {
      type: v
        .split(',')
        .map((t) => t.trim())
        .join(','),
    };
  if (/^[a-z0-9_.]+$/.test(v)) return { typePrefix: v.endsWith('.') ? v : `${v}.` };
  return {};
}

/** Scope ids typed into the explorer go to the matching filter by their prefix. */
export function parseScopeFilter(input: string): {
  sessionId?: string;
  ticketId?: string;
  projectId?: string;
} {
  const v = input.trim();
  if (!v) return {};
  if (v.startsWith('ses_')) return { sessionId: v };
  if (v.startsWith('tkt_')) return { ticketId: v };
  if (v.startsWith('prj_')) return { projectId: v };
  return {};
}

/** Events at or after the cutoff (the page arrives newest first). */
export function withinRange(
  events: readonly AuditEventHeaderDTO[],
  cutoff: number | null,
): AuditEventHeaderDTO[] {
  return cutoff === null ? [...events] : events.filter((e) => toEpoch(e.ts) >= cutoff);
}

export const ERASE_REASONS = [
  { value: 'pdpa_request', label: 'PDPA request from the data subject' },
  { value: 'secret_leak', label: 'A secret leaked into a body' },
  { value: 'retention', label: 'Retention period ended' },
  { value: 'other', label: 'Other (explain on the decision)' },
] as const;
export type EraseReason = (typeof ERASE_REASONS)[number]['value'];

/** A body scope id as mod-audit accepts it. */
export function validScopeId(id: string): boolean {
  return /^[A-Za-z0-9_.:#@-]{1,64}$/.test(id.trim());
}
