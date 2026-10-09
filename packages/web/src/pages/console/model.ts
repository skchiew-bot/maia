import type { ConsoleSnapshot, DecisionCardView, SessionSummary } from '@aoc/contracts';
import { LIVENESS_PRECEDENCE, type LivenessState } from '../../components/liveness/liveness';
import { isEnded, sessionLiveness } from '../sessions/sessionText';

/**
 * Console view model (pure). The daemon derives liveness, progress and cost; this only groups, orders and
 * filters what it sent so the grid, the counts and the filters always agree.
 */

/** Shared APM scale for every tile (approved mock: 0–15), widened only if a session goes above it. */
export const APM_SCALE_MAX = 15;
/** Zero-activity minutes before a line is drawn as a stall (the badge flips at 10 min, §4 / CEO decision). */
export const FLAT_AFTER_MINUTES = 3;

export type LiveState = (typeof LIVENESS_PRECEDENCE)[number];

export interface ConsoleFilters {
  project: string;
  liveness: LiveState | '';
  owner: string;
  mine: boolean;
}

export const NO_FILTERS: ConsoleFilters = { project: '', liveness: '', owner: '', mine: false };

export interface ConsoleSplit {
  /** Sessions shown as tiles: live ones and dead ones awaiting a restart. */
  live: SessionSummary[];
  /** Sessions that ended today (the snapshot's own day), most recent first. */
  endedToday: SessionSummary[];
}

/** Tiles vs the "Ended today" table. A crashed session stays a tile: it needs a restart, not a record. */
export function splitSessions(snapshot: Pick<ConsoleSnapshot, 'sessions'>): ConsoleSplit {
  const live: SessionSummary[] = [];
  const endedToday: SessionSummary[] = [];
  for (const s of snapshot.sessions) {
    if (isEnded(s) || (s.lifecycle === 'failed' && s.endedAt)) endedToday.push(s);
    else live.push(s);
  }
  endedToday.sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''));
  return { live, endedToday };
}

function rank(s: SessionSummary): number {
  const i = (LIVENESS_PRECEDENCE as readonly LivenessState[]).indexOf(sessionLiveness(s));
  return i === -1 ? LIVENESS_PRECEDENCE.length : i;
}

/**
 * Tiles in §4 precedence (Waiting on you › Throttled › Dead › Stalled › Thinking › Working); within a state,
 * the one that has been in it longest first, because that is the one costing the most.
 */
export function sortByPrecedence(sessions: readonly SessionSummary[]): SessionSummary[] {
  return [...sessions].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.liveness?.since ?? a.startedAt).localeCompare(b.liveness?.since ?? b.startedAt) ||
      a.sessionId.localeCompare(b.sessionId),
  );
}

/** Live sessions per liveness state, in precedence order (zero counts included, so the row never jumps). */
export function fleetCounts(sessions: readonly SessionSummary[]): { state: LiveState; count: number }[] {
  const counts = new Map<LivenessState, number>();
  for (const s of sessions) {
    const st = sessionLiveness(s);
    counts.set(st, (counts.get(st) ?? 0) + 1);
  }
  return LIVENESS_PRECEDENCE.map((state) => ({ state, count: counts.get(state) ?? 0 }));
}

export function applyFilters(
  sessions: readonly SessionSummary[],
  f: ConsoleFilters,
  viewerId: string | null,
): SessionSummary[] {
  return sessions.filter(
    (s) =>
      (!f.project || s.projectId === f.project) &&
      (!f.liveness || sessionLiveness(s) === f.liveness) &&
      (!f.owner || s.ownerId === f.owner) &&
      (!f.mine || (viewerId !== null && s.ownerId === viewerId)),
  );
}

export function hasFilters(f: ConsoleFilters): boolean {
  return Boolean(f.project || f.liveness || f.owner || f.mine);
}

export interface Option {
  value: string;
  label: string;
}

/** Projects and owners present in the snapshot, by name. */
export function filterOptions(sessions: readonly SessionSummary[]): { projects: Option[]; owners: Option[] } {
  const projects = new Map<string, string>();
  const owners = new Map<string, string>();
  for (const s of sessions) {
    if (s.projectId) projects.set(s.projectId, s.projectName ?? s.projectId);
    if (s.ownerId) owners.set(s.ownerId, s.ownerName ?? s.ownerId);
  }
  const byLabel = (a: Option, b: Option) => a.label.localeCompare(b.label);
  return {
    projects: [...projects].map(([value, label]) => ({ value, label })).sort(byLabel),
    owners: [...owners].map(([value, label]) => ({ value, label })).sort(byLabel),
  };
}

/** One y-scale for every sparkline, so a quiet session looks quiet next to a busy one. */
export function sharedApmMax(sessions: readonly SessionSummary[]): number {
  let max = APM_SCALE_MAX;
  for (const s of sessions) for (const v of s.apm.points) if (v > max) max = v;
  return max;
}

/** Filters ↔ URL search params, so a filtered console can be linked and survives reloads. */
export function filtersFromParams(params: URLSearchParams): ConsoleFilters {
  const liveness = params.get('liveness') ?? '';
  return {
    project: params.get('project') ?? '',
    liveness: (LIVENESS_PRECEDENCE as readonly string[]).includes(liveness) ? (liveness as LiveState) : '',
    owner: params.get('owner') ?? '',
    mine: params.get('mine') === '1',
  };
}

export function filtersToParams(f: ConsoleFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.project) p.set('project', f.project);
  if (f.liveness) p.set('liveness', f.liveness);
  if (f.owner) p.set('owner', f.owner);
  if (f.mine) p.set('mine', '1');
  return p;
}

/** Open decisions, oldest first (R15: the longest wait is the most expensive). */
export function openDecisionsOldestFirst(decisions: readonly DecisionCardView[]): DecisionCardView[] {
  return decisions
    .filter((d) => d.status === 'open')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Projects with at least one live session, for the "in N projects" line. */
export function projectCount(sessions: readonly SessionSummary[]): number {
  return new Set(sessions.map((s) => s.projectId).filter(Boolean)).size;
}

/** Today's notional cost of the sessions that ended today (part of the day's total). */
export function endedSpend(sessions: readonly SessionSummary[]): { usd: number; rm: number | null } {
  let usd = 0;
  let rm: number | null = 0;
  for (const s of sessions) {
    usd += s.costTodayUsd;
    rm = rm === null || s.costTodayRm === null || s.costTodayRm === undefined ? null : rm + s.costTodayRm;
  }
  return { usd, rm };
}
