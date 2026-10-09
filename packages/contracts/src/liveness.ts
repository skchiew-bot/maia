/**
 * Liveness derivation (§4). Liveness is derived from instrumented events, never animated by the UI.
 * Precedence: Waiting on you > Throttled > Dead > Stalled > Thinking > Working.
 * Pure function — shared by mod-sessions (server truth), the supervisor and tests.
 */
import { LIVENESS_STATES, type LivenessState, type SessionLifecycle } from './domain';

export interface LivenessInput {
  lifecycle: SessionLifecycle;
  /** null = unknown (sidecar not reporting yet). */
  processAlive: boolean | null;
  startedAt: number;
  lastHeartbeatAt: number | null;
  lastToolActivityAt: number | null;
  /** PreToolUse seen without PostToolUse (epoch ms of the PreToolUse). */
  toolInFlightSince: number | null;
  /** Model output observed (stream deltas / transcript growth). */
  lastStreamActivityAt: number | null;
  openDecisions: number;
  throttledUntil: number | null;
}

export interface LivenessThresholds {
  /** A tool call within this window means Working. */
  workingWindowMs: number;
  /** No activity at all for this long → Stalled. */
  stallAfterMs: number;
  /** A single tool running longer than this → Stalled (hung tool). */
  toolStallAfterMs: number;
  /** No heartbeat for this long while the process should be running → Dead. */
  deadAfterMs: number;
}

export const DEFAULT_LIVENESS_THRESHOLDS: LivenessThresholds = {
  workingWindowMs: 30_000,
  stallAfterMs: 10 * 60_000,
  toolStallAfterMs: 20 * 60_000,
  deadAfterMs: 45_000,
};

export interface LivenessVerdict {
  state: LivenessState | null; // null → not live (ended / retired)
  reason: string; // machine label, e.g. "open_decision", "no_heartbeat", "tool_in_flight"
}

export function livenessRank(s: LivenessState): number {
  return LIVENESS_STATES.indexOf(s);
}

/** Pick the highest-precedence state from a set of candidates. */
export function highestPrecedence(states: LivenessState[]): LivenessState | null {
  let best: LivenessState | null = null;
  for (const s of states) if (best === null || livenessRank(s) < livenessRank(best)) best = s;
  return best;
}

export function deriveLiveness(
  i: LivenessInput,
  now: number,
  t: LivenessThresholds = DEFAULT_LIVENESS_THRESHOLDS,
): LivenessVerdict {
  if (i.lifecycle === 'ended' || i.lifecycle === 'retired') return { state: null, reason: i.lifecycle };

  if (i.openDecisions > 0) return { state: 'waiting_on_you', reason: 'open_decision' };
  if (i.lifecycle === 'waiting_decision') return { state: 'waiting_on_you', reason: 'open_decision' };
  if (i.lifecycle === 'blocked') return { state: 'waiting_on_you', reason: 'blocked' };
  if (i.lifecycle === 'idle') return { state: 'waiting_on_you', reason: 'turn_ended' };

  if (i.lifecycle === 'throttled') return { state: 'throttled', reason: 'plan_limit' };
  if (i.throttledUntil !== null && now < i.throttledUntil) return { state: 'throttled', reason: 'plan_limit' };

  if (i.lifecycle === 'failed') return { state: 'dead', reason: 'process_failed' };
  if (i.processAlive === false) return { state: 'dead', reason: 'process_exited' };
  if (i.lastHeartbeatAt !== null && now - i.lastHeartbeatAt > t.deadAfterMs) return { state: 'dead', reason: 'no_heartbeat' };
  if (i.lastHeartbeatAt === null && i.lifecycle === 'running' && now - i.startedAt > t.deadAfterMs * 2) {
    return { state: 'dead', reason: 'never_reported' };
  }

  if (i.toolInFlightSince !== null) {
    return now - i.toolInFlightSince > t.toolStallAfterMs
      ? { state: 'stalled', reason: 'tool_hung' }
      : { state: 'working', reason: 'tool_in_flight' };
  }

  const lastActivity = Math.max(i.startedAt, i.lastToolActivityAt ?? 0, i.lastStreamActivityAt ?? 0);
  if (now - lastActivity > t.stallAfterMs) return { state: 'stalled', reason: 'no_activity' };
  if (i.lastToolActivityAt !== null && now - i.lastToolActivityAt <= t.workingWindowMs) {
    return { state: 'working', reason: 'recent_tool' };
  }
  return { state: 'thinking', reason: i.lastStreamActivityAt !== null ? 'streaming' : 'starting' };
}
