/** Fleet: liveness now, a 2h trend replayed from liveness changes, stall rate, throttle loss, rollover pressure. */
import {
  LIVENESS_STATES,
  MODEL_CONTEXT_TOKENS,
  modelTierOf,
  type LivenessState,
  type TowerFleet,
} from '@aoc/contracts';
import { all, inProject, iso, one, type ReadCtx } from './read';
import { pct } from './stats';
import { MINUTE } from './zoned';

export const TREND_BUCKETS = 24;
export const TREND_BUCKET_MS = 5 * MINUTE;
/** Live sessions above this share of their context window are approaching a rollover (§5). */
export const ROLLOVER_PRESSURE_PCT = 60;
const DEFAULT_CONTEXT_TOKENS = 1_000_000;

interface SessionState {
  session_id: string;
  liveness: LivenessState | null;
  ended_ms: number | null;
}
interface Change {
  session_id: string;
  ts_ms: number;
  from_state: LivenessState | null;
  to_state: LivenessState | null;
}

export function buildFleet(r: ReadCtx): TowerFleet {
  const [where, args] = inProject(r, 'project_id');
  const byLiveness = Object.fromEntries(LIVENESS_STATES.map((s) => [s, 0])) as Record<LivenessState, number>;
  for (const row of all<{ liveness: LivenessState; n: number }>(
    r,
    `SELECT liveness, COUNT(*) AS n FROM twr_sessions WHERE ended_ms IS NULL AND liveness IS NOT NULL${where} GROUP BY liveness`,
    ...args,
  )) {
    byLiveness[row.liveness] = row.n;
  }
  const endedToday = one<{ n: number }>(
    r,
    `SELECT COUNT(*) AS n FROM twr_sessions WHERE ended_ms >= ?${where}`,
    r.midnight,
    ...args,
  )!.n;

  // Replay: the state before a session's first loaded change is that change's `from`; without changes it is the
  // current state. So only changes after the earliest instant of interest are needed, never the full history.
  const windowStart = r.now - TREND_BUCKETS * TREND_BUCKET_MS;
  const from = Math.min(windowStart, r.midnight);
  const sessions = all<SessionState>(
    r,
    `SELECT session_id, liveness, ended_ms FROM twr_sessions WHERE (ended_ms IS NULL OR ended_ms > ?)${where}`,
    from,
    ...args,
  );
  const changes = new Map<string, Change[]>(sessions.map((s) => [s.session_id, []]));
  for (const c of all<Change>(
    r,
    'SELECT session_id, ts_ms, from_state, to_state FROM twr_liveness WHERE ts_ms > ? AND ts_ms <= ? ORDER BY seq',
    from,
    r.now,
  )) {
    changes.get(c.session_id)?.push(c);
  }
  const stateAt = (s: SessionState, t: number): LivenessState | null => {
    if (s.ended_ms !== null && s.ended_ms <= t) return null;
    const cs = changes.get(s.session_id)!;
    let state = cs.length ? cs[0]!.from_state : s.liveness;
    for (const c of cs) {
      if (c.ts_ms > t) break;
      state = c.to_state;
    }
    return state;
  };

  const trend: TowerFleet['trend'] = [];
  for (let i = 0; i < TREND_BUCKETS; i++) {
    const at = r.now - (TREND_BUCKETS - 1 - i) * TREND_BUCKET_MS;
    const point = {
      at: iso(at),
      working: 0,
      thinking: 0,
      stalled: 0,
      dead: 0,
      throttled: 0,
      waiting_on_you: 0,
    };
    for (const s of sessions) {
      const state = stateAt(s, at);
      if (state) point[state]++;
    }
    trend.push(point);
  }

  let liveToday = 0;
  let stalledToday = 0;
  for (const s of sessions) {
    if (s.ended_ms !== null && s.ended_ms <= r.midnight) continue;
    const today = changes.get(s.session_id)!.filter((c) => c.ts_ms > r.midnight);
    if (stateAt(s, r.midnight) !== null || today.some((c) => c.to_state !== null)) liveToday++;
    if (today.some((c) => c.to_state === 'stalled')) stalledToday++;
  }

  const [sw, sa] = inProject(r, 's.project_id');
  const idleClosed = one<{ n: number }>(
    r,
    `SELECT COALESCE(SUM(t.idle_ms), 0) AS n FROM twr_throttle_idle t LEFT JOIN twr_sessions s ON s.session_id = t.session_id
     WHERE t.ts_ms >= ? AND t.ts_ms <= ?${sw}`,
    r.midnight,
    r.now,
    ...sa,
  )!.n;
  const idleOpen = all<{ started: number }>(
    r,
    `SELECT throttle_started_ms AS started FROM twr_sessions WHERE throttle_started_ms IS NOT NULL AND ended_ms IS NULL${where}`,
    ...args,
  ).reduce((ms, x) => ms + Math.max(0, r.now - Math.max(x.started, r.midnight)), 0);

  const rolloverPressure = all<{ tokens: number; model: string | null }>(
    r,
    `SELECT context_tokens AS tokens, COALESCE(context_model, model) AS model FROM twr_sessions
     WHERE ended_ms IS NULL AND liveness IS NOT NULL AND context_tokens IS NOT NULL${where}`,
    ...args,
  ).filter((s) => {
    const tier = s.model ? modelTierOf(s.model) : 'unknown';
    const window =
      tier === 'unknown' ? DEFAULT_CONTEXT_TOKENS : (MODEL_CONTEXT_TOKENS[tier] ?? DEFAULT_CONTEXT_TOKENS);
    return s.tokens > (window * ROLLOVER_PRESSURE_PCT) / 100;
  }).length;

  return {
    byLiveness: { ...byLiveness, ended_today: endedToday },
    trend,
    stallRatePct: pct(stalledToday, liveToday),
    throttleLostMsToday: idleClosed + idleOpen,
    rolloverPressure,
  };
}
