/**
 * Fleet: liveness now, a 2h trend replayed from liveness changes, today's stall rate against the previous 7 local
 * days, throttle loss and rollover pressure.
 */
import {
  LIVENESS_STATES,
  MODEL_CONTEXT_TOKENS,
  modelTierOf,
  type LivenessState,
  type TowerFleet,
} from '@aoc/contracts';
import { addDays } from '@aoc/kernel';
import { all, inProject, iso, one, type ReadCtx } from './read';
import { pct } from './stats';
import { MINUTE, zonedEpoch } from './zoned';

export const TREND_BUCKETS = 24;
export const TREND_BUCKET_MS = 5 * MINUTE;
/** Live sessions above this share of their context window are approaching a rollover (§5). */
export const ROLLOVER_PRESSURE_PCT = 60;
const DEFAULT_CONTEXT_TOKENS = 1_000_000;
/** Local days before today that the stall-rate average pools. */
export const STALL_AVG_DAYS = 7;

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

  // Each session is replayed once, in seq order: its state before the first loaded change is that change's `from`
  // (without changes, its current state), so only changes after the earliest instant of interest are loaded.
  // Day bounds are real local midnights: the previous 7 days, then today up to now.
  const days = [
    ...Array.from({ length: STALL_AVG_DAYS }, (_, i) =>
      zonedEpoch(addDays(r.today, i - STALL_AVG_DAYS), '00:00', r.tz),
    ),
    r.midnight,
    r.now,
  ];
  const points = Array.from(
    { length: TREND_BUCKETS },
    (_, i) => r.now - (TREND_BUCKETS - 1 - i) * TREND_BUCKET_MS,
  );
  const from = Math.min(days[0]!, points[0]!);
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

  const trend: TowerFleet['trend'] = points.map((at) => ({
    at: iso(at),
    working: 0,
    thinking: 0,
    stalled: 0,
    dead: 0,
    throttled: 0,
    waiting_on_you: 0,
  }));
  // Per local day (index STALL_AVG_DAYS is today): sessions live at some point — a state at the day's start or a
  // change into one — and sessions that entered Stalled.
  const live = new Array<number>(STALL_AVG_DAYS + 1).fill(0);
  const stalled = new Array<number>(STALL_AVG_DAYS + 1).fill(0);
  for (const s of sessions) {
    const cs = changes.get(s.session_id)!;
    const ended = (t: number) => s.ended_ms !== null && s.ended_ms <= t;
    let state = cs.length ? cs[0]!.from_state : s.liveness;
    let i = 0;
    for (let p = 0; p < TREND_BUCKETS && !ended(points[p]!); p++) {
      while (i < cs.length && cs[i]!.ts_ms <= points[p]!) state = cs[i++]!.to_state;
      if (state) trend[p]![state]++;
    }
    state = cs.length ? cs[0]!.from_state : s.liveness;
    i = 0;
    for (let d = 0; d <= STALL_AVG_DAYS && !ended(days[d]!); d++) {
      while (i < cs.length && cs[i]!.ts_ms <= days[d]!) state = cs[i++]!.to_state;
      let wasLive = state !== null;
      let wasStalled = false;
      while (i < cs.length && cs[i]!.ts_ms <= days[d + 1]!) {
        state = cs[i++]!.to_state;
        wasLive ||= state !== null;
        wasStalled ||= state === 'stalled';
      }
      if (wasLive) live[d]!++;
      if (wasStalled) stalled[d]!++;
    }
  }
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const livePast = sum(live.slice(0, STALL_AVG_DAYS));

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
    stallRatePct: pct(stalled[STALL_AVG_DAYS]!, live[STALL_AVG_DAYS]!),
    stallRateAvg7dPct: livePast ? pct(sum(stalled.slice(0, STALL_AVG_DAYS)), livePast) : null,
    throttleLostMsToday: idleClosed + idleOpen,
    rolloverPressure,
  };
}
