import type { CurrentPhaseDTO, ProgressDTO, SessionSummary } from '@aoc/contracts';
import type { LivenessState } from '../../components/liveness/liveness';
import { formatAge, formatClock, shortHash, toEpoch } from '../../lib/format';

/**
 * Wording shared by the Console tiles and the Session page. Pure: every function takes `now` so the same
 * session reads the same way in both places and in tests.
 */

/** Rollover threshold when the process type does not set one (registry default, §5). */
export const DEFAULT_ROLLOVER_PCT = 70;

type LivenessInput = Pick<SessionSummary, 'liveness' | 'lifecycle'>;

/** True once a session is finished for good (a crashed session stays restartable, so it is not ended). */
export function isEnded(s: Pick<SessionSummary, 'lifecycle'>): boolean {
  return s.lifecycle === 'ended' || s.lifecycle === 'retired';
}

/**
 * The badge state: the daemon's derived liveness (§4), or the terminal state once the session ended. A live
 * session the sweep has not classified yet reads as Thinking, the neutral state.
 */
export function sessionLiveness(s: LivenessInput): LivenessState {
  if (s.lifecycle === 'retired') return 'retired';
  if (s.lifecycle === 'ended') return 'ended';
  if (s.liveness?.state) return s.liveness.state;
  return s.lifecycle === 'failed' ? 'dead' : 'thinking';
}

function since(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const t = toEpoch(iso);
  return Number.isFinite(t) ? formatAge(now - t) : null;
}

/** Context after the badge word: "decision 34m", "resets 14:05", "no heartbeat 4m". */
export function livenessDetail(
  s: Pick<SessionSummary, 'liveness' | 'lifecycle' | 'openDecision' | 'throttledUntil' | 'endedAt' | 'lastActivityAt' | 'startedAt'>,
  now: number,
): string | undefined {
  const state = sessionLiveness(s);
  const reason = s.liveness?.reason ?? '';
  const age = since(s.liveness?.since, now);
  const withAge = (word: string) => (age ? `${word} ${age}` : word);
  switch (state) {
    case 'waiting_on_you':
      if (s.openDecision) return `decision ${since(s.openDecision.createdAt, now) ?? ''}`.trim();
      if (reason === 'blocked') return withAge('blocked');
      if (reason === 'turn_ended') return withAge('turn ended');
      return withAge('waiting');
    case 'throttled':
      return s.throttledUntil ? `resets ${formatClock(s.throttledUntil)}` : 'reset time unknown';
    case 'dead':
      if (reason === 'no_heartbeat') return withAge('no heartbeat');
      if (reason === 'never_reported') return 'never reported';
      if (reason === 'process_exited') return withAge('exited');
      return withAge('process failed');
    case 'stalled': {
      if (reason === 'tool_hung') return withAge('tool hung');
      // `since` is when the stall threshold was crossed, so the quiet time is measured from the last
      // recorded activity instead (the daemon's own rule: the later of start and last activity).
      const quietFrom = Math.max(toEpoch(s.startedAt), s.lastActivityAt ? toEpoch(s.lastActivityAt) : 0);
      return Number.isFinite(quietFrom) && quietFrom > 0 ? `no output ${formatAge(now - quietFrom)}` : withAge('no output');
    }
    case 'thinking':
      return reason === 'starting' ? 'starting' : withAge('generating');
    case 'working':
      return reason === 'tool_in_flight' ? 'tool running' : withAge('for');
    case 'ended':
    case 'retired':
      return s.endedAt ? formatClock(s.endedAt) : undefined;
  }
}

/** Model id → the tier word people use ("claude-sonnet-5-5" → "Sonnet"). */
export function modelLabel(model: string | null | undefined): string | null {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const [tier, word] of [
    ['opus', 'Opus'],
    ['sonnet', 'Sonnet'],
    ['haiku', 'Haiku'],
    ['fable', 'Fable'],
  ] as const) {
    if (m.includes(tier)) return word;
  }
  return model;
}

/** "P2 Fix" — position in the plan and the phase name. */
export function phaseLabel(p: CurrentPhaseDTO | null | undefined): string | null {
  return p ? `P${p.index} ${p.name}` : null;
}

/**
 * ETA under the task meter. Hidden until three tasks are done (§4); never a clock time while the session
 * is not moving, because the daemon's estimate assumes it is.
 */
export function etaText(p: ProgressDTO | null, state: LivenessState, now: number): string {
  if (!p) return 'No plan declared';
  if (p.etaHiddenReason === 'complete') return 'Plan complete';
  if (state === 'ended' || state === 'retired') return 'Ended before done';
  if (p.etaHiddenReason === 'fewer_than_3_done' || p.doneTasks < 3) return 'ETA after 3 tasks';
  if (state === 'dead') return 'ETA —';
  if (state === 'waiting_on_you' || state === 'throttled') return 'ETA paused';
  if (state === 'stalled') return 'ETA on hold';
  return p.etaMs === null ? 'ETA —' : `ETA ${formatClock(now + p.etaMs)}`;
}

/** Why a session ended, in words (session.ended outcome). */
export function outcomeText(s: Pick<SessionSummary, 'lifecycle' | 'outcome' | 'progress'>): string {
  const p = s.progress;
  const tasks = p ? `${p.doneTasks} of ${p.totalTasks} tasks` : null;
  if (s.lifecycle === 'retired' || s.outcome === 'retired') return 'Rolled over to a fresh session';
  switch (s.outcome) {
    case 'completed':
      return p && p.etaHiddenReason === 'complete' ? 'Completed, plan done' : `Completed${tasks ? `, ${tasks}` : ''}`;
    case 'killed':
      return `Stopped by an operator${tasks ? `, ${tasks}` : ''}`;
    case 'abandoned':
      return `Stopped before finishing${tasks ? `, ${tasks}` : ''}`;
    case 'failed':
      return `Failed${tasks ? `, ${tasks}` : ''}`;
    default:
      return s.lifecycle === 'failed' ? 'Process died' : 'Ended';
  }
}

/** Last characters of an id, enough to tell sessions apart in a list ("…GK5D9"). */
export function shortId(id: string, length = 6): string {
  return id.length > length + 4 ? `…${id.slice(-length)}` : id;
}

/** Evidence reference as shown in a chip: commits shortened, test ids and diffs as given. */
export function evidenceRef(kind: string, ref: string): string {
  return kind === 'commit' && /^[0-9a-f]{12,}$/i.test(ref) ? shortHash(ref, 7) : ref;
}
