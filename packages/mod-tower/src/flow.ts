/** Flow: verified throughput per local hour vs a same-hour baseline, WIP, the ticket funnel and gate latency. */
import { DECISION_KINDS, type TicketStage, type TowerFlow } from '@aoc/contracts';
import { all, inProject, iso, one, projectName, type ReadCtx } from './read';
import { decisionSlaMs } from './scoring';
import { pct, percentile, round1 } from './stats';
import { DAY, HOUR, isoWithOffset, startOfLocalHour } from './zoned';

const FLOW_HOURS = 12;
const BASELINE_DAYS = 7;
const ACTIVE_LIFECYCLES = "('launching','running','idle','waiting_decision','blocked','throttled')";
const OPEN_STAGES: TicketStage[] = [
  'received',
  'triage',
  'awaiting_human',
  'fix_plan_gate',
  'building',
  'uat',
  'go_live_gate',
];
const DONE_STAGES: TicketStage[] = ['completed', 'closed'];

export interface FlowFacts {
  flow: TowerFlow;
  tasksVerifiedToday: number;
  tasksVerifiedBaseline: number;
  gateLatencyP50Ms: number | null;
  gateLatencyP90Ms: number | null;
  openTickets: number;
  oldestTicketSince: string | null;
}

export function buildFlow(r: ReadCtx): FlowFacts {
  const throughput = tasks(r);
  const tickets = funnel(r);
  const latency = decisionLatency(r);
  return {
    flow: {
      tasksPerHour: throughput.tasksPerHour,
      baselinePerHour: throughput.baselinePerHour,
      wipByProject: wip(r),
      ticketFunnel: tickets.funnel,
      decisionLatency: latency.byKind,
    },
    tasksVerifiedToday: throughput.verifiedToday,
    tasksVerifiedBaseline: throughput.verifiedBaseline,
    gateLatencyP50Ms: latency.gateP50,
    gateLatencyP90Ms: latency.gateP90,
    openTickets: tickets.open,
    oldestTicketSince: tickets.oldestSubmitted,
  };
}

/**
 * Hourly verified/flagged closes for the last 12 local hours, the same-hour average of the previous 7 days and
 * today's verified count against the same-time-of-day 7-day average — aggregated in SQL (hour offsets from a
 * base 7 days before the first bucket: offset (7 − d) · 24 + i is hour i of the window d days back).
 */
function tasks(r: ReadCtx) {
  const first = startOfLocalHour(r.now, r.tz) - (FLOW_HOURS - 1) * HOUR;
  const base = first - BASELINE_DAYS * DAY;
  const [where, args] = inProject(r, 'project_id');
  const verified = new Array<number>(FLOW_HOURS).fill(0);
  const flagged = new Array<number>(FLOW_HOURS).fill(0);
  const past = new Array<number>(FLOW_HOURS).fill(0);
  for (const row of all<{ o: number; v: number; n: number }>(
    r,
    // node:sqlite binds numbers as REAL: cast so the offset is integer (whole-hour) division.
    `SELECT (ts_ms - CAST(? AS INTEGER)) / ${HOUR} AS o, SUM(verified) AS v, COUNT(*) AS n FROM twr_task_done
     WHERE ts_ms >= ? AND ts_ms < ? AND ts_ms <= ?${where} GROUP BY o`,
    base,
    base,
    first + FLOW_HOURS * HOUR,
    r.now,
    ...args,
  )) {
    const i = row.o % 24;
    if (i >= FLOW_HOURS) continue;
    if (row.o >= BASELINE_DAYS * 24) {
      verified[i] = row.v;
      flagged[i] = row.n - row.v;
    } else past[i]! += row.v;
  }
  const today = one<{ today: number | null; past: number | null }>(
    r,
    `SELECT SUM(ts_ms >= ?) AS today, SUM(ts_ms < ? AND (ts_ms - ?) % ${DAY} < ?) AS past FROM twr_task_done
     WHERE verified = 1 AND ts_ms >= ? AND ts_ms <= ?${where}`,
    r.midnight,
    r.midnight,
    r.midnight - BASELINE_DAYS * DAY,
    r.now - r.midnight,
    r.midnight - BASELINE_DAYS * DAY,
    r.now,
    ...args,
  );
  return {
    tasksPerHour: verified.map((v, i) => ({
      hour: isoWithOffset(first + i * HOUR, r.tz),
      verified: v,
      flagged: flagged[i]!,
    })),
    baselinePerHour: past.map((n) => round1(n / BASELINE_DAYS)),
    verifiedToday: today?.today ?? 0,
    verifiedBaseline: round1((today?.past ?? 0) / BASELINE_DAYS),
  };
}

function wip(r: ReadCtx): TowerFlow['wipByProject'] {
  const [w1, a1] = inProject(r, 'project_id');
  const active = new Map(
    all<{ project_id: string; n: number }>(
      r,
      `SELECT project_id, COUNT(*) AS n FROM twr_sessions WHERE ended_ms IS NULL AND lifecycle IN ${ACTIVE_LIFECYCLES} AND project_id IS NOT NULL${w1} GROUP BY project_id`,
      ...a1,
    ).map((x) => [x.project_id, x.n]),
  );
  // Tasks counted once (carried / removed excluded), weighted by declared size; manifests whose body was
  // crypto-shredded fall back to their meta counters.
  const plans = new Map<
    string,
    { project_id: string; open: number; done_weight: number; total_weight: number }
  >();
  for (const x of [
    ...all<{ project_id: string; open: number; done_weight: number; total_weight: number }>(
      r,
      `SELECT project_id, SUM(status = 'open') AS open, SUM(CASE WHEN status = 'done' THEN weight ELSE 0 END) AS done_weight,
         SUM(CASE WHEN status IN ('open', 'done') THEN weight ELSE 0 END) AS total_weight
       FROM twr_tasks WHERE meta_only = 0${w1} GROUP BY project_id`,
      ...a1,
    ),
    ...all<{ project_id: string; open: number; done_weight: number; total_weight: number }>(
      r,
      `SELECT project_id, SUM(MAX(task_count - done_count, 0)) AS open, SUM(done_weight) AS done_weight, SUM(total_weight) AS total_weight
       FROM twr_manifests WHERE has_tasks = 0${w1} GROUP BY project_id`,
      ...a1,
    ),
  ]) {
    const p = plans.get(x.project_id) ?? {
      project_id: x.project_id,
      open: 0,
      done_weight: 0,
      total_weight: 0,
    };
    plans.set(x.project_id, {
      project_id: x.project_id,
      open: p.open + x.open,
      done_weight: p.done_weight + x.done_weight,
      total_weight: p.total_weight + x.total_weight,
    });
  }
  const ids = [
    ...new Set([...active.keys(), ...[...plans.values()].filter((p) => p.open > 0).map((p) => p.project_id)]),
  ];
  return ids
    .map((projectId) => {
      const plan = plans.get(projectId);
      return {
        projectId,
        name: projectName(r, projectId) ?? projectId,
        activeSessions: active.get(projectId) ?? 0,
        openTasks: plan?.open ?? 0,
        progressPct:
          r.svc.projectProgressPct(projectId) ?? pct(plan?.done_weight ?? 0, plan?.total_weight ?? 0),
      };
    })
    .sort(
      (a, b) =>
        b.activeSessions - a.activeSessions || b.openTasks - a.openTasks || a.name.localeCompare(b.name),
    );
}

/** Open stages: count, oldest entry and median age in stage; terminal stages: tickets that reached them in 7d. */
function funnel(r: ReadCtx): {
  funnel: TowerFlow['ticketFunnel'];
  open: number;
  oldestSubmitted: string | null;
} {
  const [where, args] = inProject(r, 'project_id');
  const open = all<{ stage: TicketStage; stage_since_ms: number; submitted_ms: number }>(
    r,
    `SELECT stage, stage_since_ms, submitted_ms FROM twr_tickets WHERE stage NOT IN ('completed','closed')${where}`,
    ...args,
  );
  const done = new Map(
    all<{ stage: TicketStage; n: number }>(
      r,
      `SELECT stage, COUNT(*) AS n FROM twr_tickets WHERE stage IN ('completed','closed') AND closed_ms >= ?${where} GROUP BY stage`,
      r.now - BASELINE_DAYS * DAY,
      ...args,
    ).map((x) => [x.stage, x.n]),
  );
  const rows: TowerFlow['ticketFunnel'] = OPEN_STAGES.map((stage) => {
    const inStage = open.filter((t) => t.stage === stage);
    const oldest = inStage.length ? Math.min(...inStage.map((t) => t.stage_since_ms)) : null;
    return {
      stage,
      count: inStage.length,
      oldestSince: oldest === null ? null : iso(oldest),
      medianAgeMs: percentile(
        inStage.map((t) => r.now - t.stage_since_ms),
        0.5,
      ),
      bottleneck: false,
    };
  });
  let worst: (typeof rows)[number] | null = null;
  for (const row of rows) {
    if (!row.count || row.medianAgeMs === null) continue;
    if (!worst || row.medianAgeMs * row.count > worst.medianAgeMs! * worst.count) worst = row;
  }
  if (worst) worst.bottleneck = true;
  for (const stage of DONE_STAGES)
    rows.push({
      stage,
      count: done.get(stage) ?? 0,
      oldestSince: null,
      medianAgeMs: null,
      bottleneck: false,
    });
  const oldestSubmitted = open.length ? Math.min(...open.map((t) => t.submitted_ms)) : null;
  return {
    funnel: rows,
    open: open.length,
    oldestSubmitted: oldestSubmitted === null ? null : iso(oldestSubmitted),
  };
}

/**
 * Human latency per decision kind: p50/p90 of decisions resolved in 7d (policy resolutions excluded — they are
 * instant by construction), open count and SLA breaches (open past SLA + resolved slower than SLA in 7d).
 * The gate KPI pools every human-resolved kind except UAT sign-off, which measures the customer.
 */
function decisionLatency(r: ReadCtx) {
  const [where, args] = inProject(r, 'project_id');
  const open = all<{ kind: string; requested_ms: number }>(
    r,
    `SELECT kind, requested_ms FROM twr_decisions WHERE status = 'open'${where}`,
    ...args,
  );
  const resolved = all<{ kind: string; latency: number }>(
    r,
    `SELECT kind, resolved_ms - requested_ms AS latency FROM twr_decisions
     WHERE status = 'resolved' AND resolved_ms >= ? AND COALESCE(method, '') != 'policy'${where}`,
    r.now - BASELINE_DAYS * DAY,
    ...args,
  );
  const byKind: TowerFlow['decisionLatency'] = [];
  for (const kind of DECISION_KINDS) {
    const o = open.filter((d) => d.kind === kind);
    const lat = resolved.filter((d) => d.kind === kind).map((d) => Math.max(0, d.latency));
    if (!o.length && !lat.length) continue;
    const sla = decisionSlaMs(kind);
    byKind.push({
      kind,
      open: o.length,
      resolved7d: lat.length,
      p50Ms: percentile(lat, 0.5),
      p90Ms: percentile(lat, 0.9),
      slaMs: sla,
      breaches: o.filter((d) => r.now - d.requested_ms > sla).length + lat.filter((l) => l > sla).length,
    });
  }
  const gates = resolved.filter((d) => d.kind !== 'uat_signoff').map((d) => Math.max(0, d.latency));
  return { byKind, gateP50: percentile(gates, 0.5), gateP90: percentile(gates, 0.9) };
}
