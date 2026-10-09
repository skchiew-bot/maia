/**
 * Pure read-side rules for the Projects area: phase statistics from the master timeline (§9), attribution of
 * work to developers, the liveness mix of a project's sessions (§4) and the attention order of the list.
 * Everything here is deterministic (time comes in as `now`) so it is unit-tested without a daemon.
 */
import type {
  ManifestPhaseDTO,
  ManifestTaskDTO,
  ProjectPhaseRollup,
  ProjectRollup,
  ProjectSummary,
  SessionSummary,
} from '@aoc/contracts';
import { LIVENESS_PRECEDENCE, type LivenessState } from '../../components/liveness/liveness';

/** Declared size → weight (§4; mirrors TASK_SIZE_WEIGHT in contracts, which the UI bundle does not import). */
export const SIZE_WEIGHT = { xs: 1, s: 2, m: 3, l: 5, xl: 8 } as const;
export const SIZE_LEGEND = 'xs 1 · s 2 · m 3 · l 5 · xl 8';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A failed session stays on the project's live mix this long, so a crash is seen before it scrolls away. */
export const RECENT_FAILURE_MS = DAY;
/** No build activity for this long while work is still open reads as stale. */
export const STALE_AFTER_MS = 3 * DAY;

export type PhaseState = 'done' | 'active' | 'pending';

export interface Contributor {
  /** User id when known, else the session id the work was declared in. */
  id: string;
  name: string;
  doneWeight: number;
  flaggedWeight: number;
  totalWeight: number;
  doneTasks: number;
  totalTasks: number;
}

export interface PhaseStat {
  id: string;
  name: string;
  /** 1-based position in manifest order (P1, P2…). */
  index: number;
  doneWeight: number;
  /** Part of doneWeight closed with no file change or unverified evidence (counts until reviewed). */
  flaggedWeight: number;
  totalWeight: number;
  doneTasks: number;
  flaggedTasks: number;
  totalTasks: number;
  state: PhaseState;
  completedAt: string | null;
  pinnedTag: string | null;
  pinnedSha: string | null;
}

export function phaseState(p: { doneWeight: number; totalWeight: number; doneTasks: number }): PhaseState {
  if (p.totalWeight > 0 && p.doneWeight >= p.totalWeight) return 'done';
  return p.doneTasks > 0 ? 'active' : 'pending';
}

export function phaseStatsFromRollup(phases: readonly ProjectPhaseRollup[]): PhaseStat[] {
  return [...phases]
    .sort((a, b) => a.order - b.order)
    .map((p, i) => ({
      id: p.phaseId,
      name: p.name,
      index: i + 1,
      doneWeight: p.doneWeight,
      flaggedWeight: p.flaggedWeight,
      totalWeight: p.totalWeight,
      doneTasks: p.doneTasks,
      flaggedTasks: p.flaggedTasks,
      totalTasks: p.totalTasks,
      state: phaseState(p),
      completedAt: p.completedAt,
      pinnedTag: p.pinnedTag,
      pinnedSha: p.pinnedSha,
    }));
}

export const isLiveTask = (t: ManifestTaskDTO) => t.status !== 'removed';
export const isFlagged = (t: ManifestTaskDTO) => t.status === 'done' && t.flag !== null;

/** Phase statistics straight from the aggregate manifest (the project page has every task). */
export function phaseStatsFromManifest(manifest: readonly ManifestPhaseDTO[]): PhaseStat[] {
  return [...manifest]
    .sort((a, b) => a.order - b.order)
    .map((p, i) => {
      const live = p.tasks.filter(isLiveTask);
      const done = live.filter((t) => t.status === 'done');
      const flagged = done.filter(isFlagged);
      const sum = (ts: ManifestTaskDTO[]) => ts.reduce((a, t) => a + t.weight, 0);
      const stat = {
        doneWeight: sum(done),
        totalWeight: sum(live),
        doneTasks: done.length,
      };
      return {
        id: p.phaseId,
        name: p.name,
        index: i + 1,
        ...stat,
        flaggedWeight: sum(flagged),
        flaggedTasks: flagged.length,
        totalTasks: live.length,
        state: phaseState(stat),
        completedAt: p.completedAt,
        pinnedTag: p.pinnedTag,
        pinnedSha: p.pinnedSha,
      };
    });
}

export interface Totals {
  doneWeight: number;
  flaggedWeight: number;
  totalWeight: number;
  doneTasks: number;
  flaggedTasks: number;
  totalTasks: number;
}

export function totalsOf(phases: readonly PhaseStat[]): Totals {
  return phases.reduce<Totals>(
    (t, p) => ({
      doneWeight: t.doneWeight + p.doneWeight,
      flaggedWeight: t.flaggedWeight + p.flaggedWeight,
      totalWeight: t.totalWeight + p.totalWeight,
      doneTasks: t.doneTasks + p.doneTasks,
      flaggedTasks: t.flaggedTasks + p.flaggedTasks,
      totalTasks: t.totalTasks + p.totalTasks,
    }),
    { doneWeight: 0, flaggedWeight: 0, totalWeight: 0, doneTasks: 0, flaggedTasks: 0, totalTasks: 0 },
  );
}

/** The phase work is happening in: first unfinished phase in manifest order. */
export function currentPhase(phases: readonly PhaseStat[]): PhaseStat | null {
  return phases.find((p) => p.state !== 'done' && p.totalWeight > 0) ?? null;
}

// ── attribution ─────────────────────────────────────────────────────────────

export interface People {
  /** Developer of a task or scope change: `declaredBy` is a user id, or a session id when the ledger only knows the session. */
  resolve(declaredBy: string, sessionId?: string | null): { id: string; name: string };
}

/** Name directory built from what the project's reads already carry (no extra user lookup). */
export function buildPeople(
  sessions: readonly SessionSummary[],
  knownNames: Iterable<readonly [string, string | null]> = [],
): People {
  const names = new Map<string, string>();
  for (const [id, name] of knownNames) if (name) names.set(id, name);
  const sessionOwner = new Map<string, { id: string; name: string | null }>();
  for (const s of sessions) {
    if (s.ownerId) {
      sessionOwner.set(s.sessionId, { id: s.ownerId, name: s.ownerName });
      if (s.ownerName) names.set(s.ownerId, s.ownerName);
    }
  }
  return {
    resolve(declaredBy, sessionId) {
      const viaSession =
        sessionOwner.get(declaredBy) ?? (sessionId ? sessionOwner.get(sessionId) : undefined);
      if (declaredBy.startsWith('ses_') && viaSession)
        return {
          id: viaSession.id,
          name: viaSession.name ?? names.get(viaSession.id) ?? shortId(viaSession.id),
        };
      const name = names.get(declaredBy);
      if (name) return { id: declaredBy, name };
      return declaredBy.startsWith('ses_')
        ? { id: declaredBy, name: `session ${shortId(declaredBy)}` }
        : { id: declaredBy, name: shortId(declaredBy) };
    },
  };
}

/** `ses_01M4F99XFHZFENRS689DVVJW1N` → `…VVJW1N`: the distinguishing tail of a ULID-style id. */
export function shortId(id: string): string {
  const body = id.includes('_') ? id.slice(id.indexOf('_') + 1) : id;
  return body.length > 8 ? `…${body.slice(-6)}` : body;
}

/**
 * Who declared the work in a phase, in order of first declaration (never by amount: this is attribution, not
 * a ranking — §11). Each contributor carries their share of the phase's weight.
 */
export function contributorsOf(phase: ManifestPhaseDTO, people: People): Contributor[] {
  const out = new Map<string, Contributor>();
  for (const t of phase.tasks) {
    if (!isLiveTask(t)) continue;
    const who = people.resolve(t.declaredBy, t.sessionId);
    const c = out.get(who.id) ?? {
      id: who.id,
      name: who.name,
      doneWeight: 0,
      flaggedWeight: 0,
      totalWeight: 0,
      doneTasks: 0,
      totalTasks: 0,
    };
    c.totalWeight += t.weight;
    c.totalTasks += 1;
    if (t.status === 'done') {
      c.doneWeight += t.weight;
      c.doneTasks += 1;
      if (t.flag !== null) c.flaggedWeight += t.weight;
    }
    out.set(who.id, c);
  }
  return [...out.values()];
}

// ── sessions ────────────────────────────────────────────────────────────────

const TERMINAL = new Set(['ended', 'retired', 'failed']);

/** A session that belongs on the live mix: not finished, or failed recently enough to need a restart decision. */
export function isLiveSession(s: SessionSummary, now: number): boolean {
  if (!TERMINAL.has(s.lifecycle)) return true;
  if (s.lifecycle !== 'failed') return false;
  const since = Date.parse(s.liveness?.since ?? s.lastActivityAt ?? s.startedAt);
  return Number.isFinite(since) && now - since <= RECENT_FAILURE_MS;
}

/** The badge a session wears: daemon-derived liveness, else its terminal lifecycle. */
export function sessionBadgeState(s: SessionSummary): LivenessState {
  if (s.liveness?.state) return s.liveness.state;
  if (s.lifecycle === 'retired') return 'retired';
  if (s.lifecycle === 'failed') return 'dead';
  return 'ended';
}

export type LivenessCounts = Partial<Record<LivenessState, number>>;

export function livenessCounts(sessions: readonly SessionSummary[], now: number): LivenessCounts {
  const counts: LivenessCounts = {};
  for (const s of sessions) {
    if (!isLiveSession(s, now)) continue;
    const st = sessionBadgeState(s);
    counts[st] = (counts[st] ?? 0) + 1;
  }
  return counts;
}

/** Counts in §4 precedence order (Waiting on you first), zero states left out. */
export function orderedCounts(counts: LivenessCounts): Array<[LivenessState, number]> {
  return LIVENESS_PRECEDENCE.filter((s) => (counts[s] ?? 0) > 0).map((s) => [s, counts[s]!]);
}

export function liveTotal(counts: LivenessCounts): number {
  return Object.values(counts).reduce((a, n) => a + (n ?? 0), 0);
}

/** Sort key for a session table: §4 precedence, then most recent activity. */
export function sessionRank(s: SessionSummary): number {
  const i = LIVENESS_PRECEDENCE.indexOf(sessionBadgeState(s));
  return i === -1 ? LIVENESS_PRECEDENCE.length : i;
}

// ── attention (Projects list order) ─────────────────────────────────────────

export type AttentionKind =
  'decisions' | 'dead' | 'stalled' | 'throttled' | 'drift_high' | 'drift' | 'flagged' | 'scope' | 'stale';

export interface AttentionReason {
  kind: AttentionKind;
  count: number;
  /** Contribution to the order (weight × count). */
  points: number;
  tone: 'danger' | 'warn' | 'info' | 'neutral';
}

/**
 * Points per item. A human-required decision or a dead session blocks work now; drift and unreviewed flagged
 * closes erode the timeline's honesty; recent amendments and throttling are context. The basis is printed
 * as words beside every project, so the order is never a black box.
 */
export const ATTENTION_POINTS: Record<AttentionKind, number> = {
  decisions: 40,
  dead: 30,
  stalled: 20,
  drift_high: 15,
  stale: 10,
  throttled: 5,
  flagged: 4,
  drift: 3,
  scope: 2,
};

const TONE: Record<AttentionKind, AttentionReason['tone']> = {
  decisions: 'warn',
  dead: 'danger',
  stalled: 'warn',
  drift_high: 'warn',
  stale: 'neutral',
  throttled: 'info',
  flagged: 'warn',
  drift: 'warn',
  scope: 'info',
};

export interface AttentionInput {
  summary: ProjectSummary;
  rollup?: ProjectRollup;
  liveness: LivenessCounts;
  now: number;
}

export function attentionFor({ summary, rollup, liveness, now }: AttentionInput): {
  score: number;
  reasons: AttentionReason[];
} {
  const lastActivity = summary.lastActivityAt ? Date.parse(summary.lastActivityAt) : Number.NaN;
  const openWork = summary.progress.totalWeight > summary.progress.doneWeight;
  const counts: Array<[AttentionKind, number]> = [
    ['decisions', summary.openDecisions],
    ['dead', liveness.dead ?? 0],
    ['stalled', liveness.stalled ?? 0],
    ['drift_high', rollup?.drift.highLast7d ?? 0],
    ['stale', openWork && Number.isFinite(lastActivity) && now - lastActivity > STALE_AFTER_MS ? 1 : 0],
    ['throttled', liveness.throttled ?? 0],
    ['flagged', summary.progress.flaggedTasks],
    ['drift', (rollup?.drift.last7d ?? 0) - (rollup?.drift.highLast7d ?? 0)],
    ['scope', rollup?.amendments.last7d ?? 0],
  ];
  const reasons = counts
    .filter(([, n]) => n > 0)
    .map(([kind, count]) => ({ kind, count, points: count * ATTENTION_POINTS[kind], tone: TONE[kind] }))
    .sort((a, b) => b.points - a.points || ATTENTION_POINTS[b.kind] - ATTENTION_POINTS[a.kind]);
  return { score: reasons.reduce((a, r) => a + r.points, 0), reasons };
}

export function attentionLabel(r: AttentionReason): string {
  const n = r.count;
  const s = (one: string, many: string) => (n === 1 ? one : many);
  switch (r.kind) {
    case 'decisions':
      return `${n} ${s('decision', 'decisions')} open`;
    case 'dead':
      return `${n} dead ${s('session', 'sessions')}`;
    case 'stalled':
      return `${n} stalled ${s('session', 'sessions')}`;
    case 'throttled':
      return `${n} throttled`;
    case 'drift_high':
      return `${n} high drift (7d)`;
    case 'drift':
      return `${n} drift (7d)`;
    case 'flagged':
      return `${n} flagged ${s('close', 'closes')}`;
    case 'scope':
      return `${n} ${s('amendment', 'amendments')} (7d)`;
    case 'stale':
      return 'no activity in 3 days';
  }
}

// ── vocabulary ──────────────────────────────────────────────────────────────

export const DRIFT_KIND_LABEL: Record<string, string> = {
  off_plan_change: 'Off-plan change',
  playbook_deviation: 'Playbook deviation',
  scope_growth: 'Scope growth',
  overrun: 'Overrun',
};

export const DRIFT_KIND_HINT: Record<string, string> = {
  off_plan_change: 'Files changed while no declared task was open',
  playbook_deviation: 'A step outside the active playbook',
  scope_growth: 'Amendments grew the plan past its threshold',
  overrun: 'A task ran past its size budget',
};

export const FLAG_LABEL: Record<NonNullable<ManifestTaskDTO['flag']>, string> = {
  no_file_change: 'Closed with no file change',
  evidence_unverified: 'Evidence could not be verified',
};

/** Hex SHAs read as commits; anything else is a test id or diff reference shown verbatim. */
export function isSha(ref: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(ref);
}

/** Weight with one decimal only when needed. */
export function weightText(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Calendar day key in local time (YYYY-MM-DD) — matches how daily rollups are dated. */
export function localDay(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The trailing seven calendar days ending today, as the metering API's `from`/`to`. */
export function lastSevenDays(now: number): { from: string; to: string } {
  return { from: localDay(now - 6 * DAY), to: localDay(now) };
}
