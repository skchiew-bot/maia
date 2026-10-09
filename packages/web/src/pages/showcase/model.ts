import type {
  ConsoleSnapshot,
  DecisionCardView,
  ManifestPhaseDTO,
  ProjectSummary,
  SessionSummary,
} from '@aoc/contracts';
import type { AocEvent, StreamMessage } from '../../api/stream';
import { LIVENESS_META, LIVENESS_PRECEDENCE, isLivenessState, type LivenessState } from '../../components/liveness/liveness';

/**
 * Showcase (§12): a 2D map of the fleet. Each session is a node on a track made of its own plan's phases, sized
 * by declared weight; it moves only when an event changes the numbers behind it.
 */

export interface PhaseSegment {
  phaseId: string;
  name: string;
  /** Declared weight (removed tasks excluded) and the part of it done. */
  total: number;
  done: number;
  /** Weight declared before this phase (its start on the track). */
  start: number;
}

export interface TrackModel {
  sessionId: string;
  title: string;
  projectId: string | null;
  projectName: string;
  processType: string | null;
  mode: SessionSummary['mode'];
  /** Daemon-derived state; null when the daemon has none (finished sessions). */
  liveness: LivenessState | null;
  livenessSince: string | null;
  finished: boolean;
  phases: PhaseSegment[];
  totalWeight: number;
  doneWeight: number;
  /** Index of the first phase with work left (the last phase once everything is done); -1 without a plan. */
  currentPhase: number;
  decision: { kind: string; since: string } | null;
  throttledUntil: string | null;
}

export interface DecisionMark {
  id: string;
  kind: string;
  label: string;
  createdAt: string;
  sessionId: string | null;
}

export interface LaneModel {
  key: string;
  projectId: string | null;
  name: string;
  /** Project completion (tasks done over declared, weighted), when the project is known. */
  progressPct: number | null;
  tracks: TrackModel[];
  /** Decisions waiting on a human that no session on this lane carries (fix plans, go-lives, top-ups…). */
  decisions: DecisionMark[];
}

const FINISHED = new Set(['ended', 'retired']);

/** Short words for decision kinds (the kind enum is chained in clear; titles are not needed here). */
export const DECISION_WORD: Record<string, string> = {
  agent_decision: 'Agent decision',
  protected_operation: 'Protected operation',
  fix_plan: 'Fix plan',
  go_live: 'Go-live',
  rollback: 'Rollback',
  change_request: 'Change request',
  break_glass: 'Break-glass',
  playbook_approval: 'Playbook',
  lesson_binding: 'Lesson',
  credit_topup: 'Credit top-up',
  fx_discrepancy: 'FX discrepancy',
  triage_reconciliation: 'Triage reconciliation',
  low_confidence_diagnosis: 'Low-confidence diagnosis',
  uat_signoff: 'UAT sign-off',
};

export const decisionWord = (kind: string) => DECISION_WORD[kind] ?? kind.replace(/_/g, ' ');

/** Phases of a manifest in plan order, with declared and done weight per phase. */
export function phaseSegments(manifest: readonly ManifestPhaseDTO[]): PhaseSegment[] {
  let start = 0;
  return [...manifest]
    .sort((a, b) => a.order - b.order)
    .map((p) => {
      const tasks = p.tasks.filter((t) => t.status !== 'removed');
      const total = tasks.reduce((n, t) => n + t.weight, 0);
      const done = tasks.filter((t) => t.status === 'done').reduce((n, t) => n + t.weight, 0);
      const seg = { phaseId: p.phaseId, name: p.name, total, done, start };
      start += total;
      return seg;
    })
    .filter((s) => s.total > 0);
}

export function currentPhaseIndex(phases: readonly PhaseSegment[]): number {
  if (!phases.length) return -1;
  const open = phases.findIndex((p) => p.done < p.total);
  return open === -1 ? phases.length - 1 : open;
}

export function trackOf(s: SessionSummary, manifest: readonly ManifestPhaseDTO[] | undefined): TrackModel {
  const phases = phaseSegments(manifest ?? []);
  const state = s.liveness?.state ?? null;
  return {
    sessionId: s.sessionId,
    title: s.title,
    projectId: s.projectId,
    projectName: s.projectName ?? 'No project',
    processType: s.processType,
    mode: s.mode,
    liveness: isLivenessState(state) ? state : null,
    livenessSince: s.liveness?.since ?? null,
    finished: FINISHED.has(s.lifecycle),
    phases,
    totalWeight: phases.reduce((n, p) => n + p.total, 0),
    doneWeight: phases.reduce((n, p) => n + p.done, 0),
    currentPhase: currentPhaseIndex(phases),
    decision: s.openDecision ? { kind: s.openDecision.kind, since: s.openDecision.createdAt } : null,
    throttledUntil: s.throttledUntil,
  };
}

/** Rank for ordering tracks: §4 precedence first, then healthy, then finished. */
export function livenessRank(t: Pick<TrackModel, 'liveness' | 'finished'>): number {
  if (t.finished) return 100;
  const i = t.liveness ? LIVENESS_PRECEDENCE.indexOf(t.liveness) : -1;
  return i === -1 ? 50 : i;
}

export interface FleetInput {
  console: ConsoleSnapshot;
  projects: readonly ProjectSummary[] | undefined;
  manifests: ReadonlyMap<string, readonly ManifestPhaseDTO[]>;
  decisions: readonly DecisionCardView[] | undefined;
}

/** Lanes per project (projects in name order), each with its tracks and the decisions no track carries. */
export function buildLanes({ console: snap, projects, manifests, decisions }: FleetInput): LaneModel[] {
  const lanes = new Map<string, LaneModel>();
  const laneFor = (projectId: string | null, name: string | null): LaneModel => {
    const key = projectId ?? '_none';
    let lane = lanes.get(key);
    if (!lane) {
      const p = projects?.find((x) => x.projectId === projectId);
      lane = {
        key,
        projectId,
        name: p?.name ?? name ?? (projectId ? projectId : 'Across projects'),
        progressPct: p ? p.progress.pct : null,
        tracks: [],
        decisions: [],
      };
      lanes.set(key, lane);
    }
    return lane;
  };
  for (const p of projects ?? []) laneFor(p.projectId, p.name);
  for (const s of snap.sessions) laneFor(s.projectId, s.projectName).tracks.push(trackOf(s, manifests.get(s.sessionId)));
  const carried = new Set(snap.sessions.map((s) => s.openDecision?.decisionId).filter(Boolean));
  for (const d of decisions ?? []) {
    if (d.status !== 'open' || carried.has(d.id)) continue;
    if (d.sessionId && snap.sessions.some((s) => s.sessionId === d.sessionId)) continue;
    laneFor(d.projectId, null).decisions.push({
      id: d.id,
      kind: d.kind,
      label: decisionWord(d.kind),
      createdAt: d.createdAt,
      sessionId: d.sessionId,
    });
  }
  for (const lane of lanes.values()) {
    lane.tracks.sort((a, b) => livenessRank(a) - livenessRank(b) || a.title.localeCompare(b.title));
    lane.decisions.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }
  return [...lanes.values()].sort((a, b) => {
    if (a.projectId === null) return 1;
    if (b.projectId === null) return -1;
    return a.name.localeCompare(b.name);
  });
}

/** Sessions per liveness state among live (unfinished) tracks. */
export function livenessCounts(lanes: readonly LaneModel[]): Map<LivenessState, number> {
  const counts = new Map<LivenessState, number>();
  for (const lane of lanes)
    for (const t of lane.tracks) if (!t.finished && t.liveness) counts.set(t.liveness, (counts.get(t.liveness) ?? 0) + 1);
  return counts;
}

/** Events that change what the map draws (console, project progress, decisions). */
export const MAP_EVENT_PREFIXES = ['session.', 'decision.', 'throttle.', 'plan.', 'phase.', 'task.', 'rollover.', 'credit.'];

export function changesMap(m: StreamMessage): boolean {
  if (m.kind === 'liveness') return true;
  return MAP_EVENT_PREFIXES.some((p) => m.event.type.startsWith(p));
}

/** Events that change a session's own plan, phases or done weight. */
export const MANIFEST_EVENTS: ReadonlySet<string> = new Set([
  'plan.declared',
  'plan.amended',
  'task.done',
  'phase.completed',
  'session.rollover_completed',
]);

export function changesProjects(m: StreamMessage): boolean {
  return m.kind === 'aoc' && (MANIFEST_EVENTS.has(m.event.type) || m.event.type.startsWith('project.') || m.event.type === 'session.ended');
}

export function isDecisionEvent(m: StreamMessage): boolean {
  return m.kind === 'aoc' && m.event.type.startsWith('decision.');
}

const EVENT_WORDS: Record<string, string> = {
  'task.done': 'Task done',
  'phase.completed': 'Phase completed',
  'plan.declared': 'Plan declared',
  'plan.amended': 'Plan amended',
  'decision.requested': 'Decision requested',
  'decision.resolved': 'Decision answered',
  'decision.withdrawn': 'Decision withdrawn',
  'decision.escalated': 'Decision escalated',
  'session.launched': 'Session launched',
  'session.launch_requested': 'Launch requested',
  'session.ended': 'Session ended',
  'session.turn_started': 'Turn started',
  'session.turn_ended': 'Turn ended',
  'session.lifecycle_changed': 'Lifecycle changed',
  'throttle.hit': 'Plan limit hit',
  'throttle.reset': 'Plan limit reset',
  'drift.flagged': 'Drift flagged',
  'usage.recorded': 'Usage metered',
  'tool.used': 'Tool call',
  'ticket.uat_ready': 'Ready for UAT',
  'ticket.uat_result': 'UAT result',
  'intake.submitted': 'Ticket filed',
};

/** Plain words for an event type: known ones by name, others from the dotted type. */
export function eventWord(type: string): string {
  const known = EVENT_WORDS[type];
  if (known) return known;
  const [, rest = type] = type.split('.', 2);
  const text = rest.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface FeedItem {
  key: string;
  at: string;
  kind: 'event' | 'liveness' | 'tool';
  /** Consecutive tool calls of one session fold into one line. */
  count: number;
  word: string;
  /** Machine detail from chained meta: an enum, never free text. */
  detail: string | null;
  sessionId: string | null;
  liveness: LivenessState | null;
}

/** Ticker line for a stream message, or null for chatter that would drown the feed (metering, turns). */
export function feedItem(m: StreamMessage): FeedItem | null {
  if (m.kind === 'liveness') {
    return {
      key: `l-${m.event.sessionId}-${m.event.since}-${m.event.state}`,
      at: m.event.since,
      kind: 'liveness',
      count: 1,
      word: `Now ${LIVENESS_META[m.event.state].word.toLowerCase()}`,
      detail: null,
      sessionId: m.event.sessionId,
      liveness: m.event.state,
    };
  }
  const e: AocEvent = m.event;
  if (QUIET.has(e.type)) return null;
  return {
    key: `e-${e.seq}`,
    at: e.ts,
    kind: e.type === 'tool.used' ? 'tool' : 'event',
    count: 1,
    word: e.type === 'tool.used' ? 'Tool calls' : eventWord(e.type),
    detail: detailOf(e),
    sessionId: e.scope.sessionId ?? null,
    liveness: null,
  };
}

const QUIET = new Set(['usage.recorded', 'session.heartbeat', 'session.turn_started', 'session.turn_ended']);

/** Newest first, at most `max` lines; a tool call right after another of the same session adds to its count. */
export function pushFeed(prev: readonly FeedItem[], item: FeedItem, max: number): FeedItem[] {
  const head = prev[0];
  if (item.kind === 'tool' && head?.kind === 'tool' && head.sessionId === item.sessionId)
    return [{ ...head, at: item.at, count: head.count + 1 }, ...prev.slice(1)];
  return [item, ...prev.filter((p) => p.key !== item.key)].slice(0, max);
}

function detailOf(e: AocEvent): string | null {
  const m = e.meta as Record<string, unknown>;
  if (typeof m.kind === 'string' && e.type.startsWith('decision.')) return decisionWord(m.kind);
  if (typeof m.outcome === 'string') return m.outcome.replace(/_/g, ' ');
  if (e.type === 'session.lifecycle_changed' && typeof m.to === 'string') return `→ ${m.to.replace(/_/g, ' ')}`;
  if (typeof m.verdict === 'string') return m.verdict;
  if (e.type === 'tool.used' && typeof m.toolName === 'string') return m.toolName;
  return null;
}
