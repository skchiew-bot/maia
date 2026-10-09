import type { FunnelStage } from '../../charts/FunnelBar';
import type { LatencyRow } from '../../charts/LatencyBars';
import type { StackedBarRow, StackedBarSeries } from '../../charts/StackedBar';
import type {
  DailyValue,
  PairedBarRow,
  PhaseProgress,
  RecurrenceClass,
  Segment,
  TimelineMark,
  TimelinePhase,
} from '../../charts/types';
import type { LivenessState } from '../../components/liveness/liveness';

/** Fixed "now" for the gallery: 2026-10-08 14:05 in Kuala Lumpur (06:05 UTC). Screenshots are deterministic. */
export const NOW = Date.UTC(2026, 9, 8, 6, 5, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;

/** Deterministic PRNG so sample data is stable across renders and screenshot runs. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Actions-per-minute series: 30 one-minute samples, optional flat (zero) tail. */
export function apmSeries(seed: number, base: number, flatTail = 0, n = 30): number[] {
  const r = prng(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    if (i >= n - flatTail) {
      out.push(0);
      continue;
    }
    const wave = Math.sin(i / 3 + seed) * base * 0.35;
    out.push(Math.max(0, Math.round(base + wave + (r() - 0.5) * base * 0.8)));
  }
  return out;
}

export interface SampleAgent {
  id: string;
  name: string;
  project: string;
  processType: string;
  state: LivenessState;
  detail?: string;
  apm: number[];
  seq: number;
  done: number;
  declared: number;
  tokens: number;
  usd: number;
  myr: number;
  lastActivity: number;
  head: string;
}

export const AGENTS: SampleAgent[] = [
  {
    id: 'ses_7f3a91',
    name: 'billing-revamp · build',
    project: 'Billing revamp',
    processType: 'Feature build',
    state: 'working',
    apm: apmSeries(1, 14),
    seq: 10_482,
    done: 9,
    declared: 14,
    tokens: 4_812_330,
    usd: 61.42,
    myr: 289.67,
    lastActivity: NOW - 12_000,
    head: '9c1e4b7a2f0d58e3b6a1c9d4e7f20a3b5c6d8e91',
  },
  {
    id: 'ses_2c9140',
    name: 'intake-portal · discovery',
    project: 'Intake portal',
    processType: 'Discovery',
    state: 'thinking',
    apm: apmSeries(2, 6),
    seq: 3_310,
    done: 2,
    declared: 7,
    tokens: 2_204_118,
    usd: 38.9,
    myr: 183.46,
    lastActivity: NOW - 48_000,
    head: '4be1907c3d2a6f81e0b5c4d3a2f1e0d9c8b7a6f5',
  },
  {
    id: 'ses_88d0e2',
    name: 'fx-scraper · fix',
    project: 'FX rates',
    processType: 'Bug fix',
    state: 'stalled',
    detail: 'no progress 9m',
    apm: apmSeries(3, 9, 9),
    seq: 1_207,
    done: 3,
    declared: 5,
    tokens: 806_412,
    usd: 9.84,
    myr: 46.41,
    lastActivity: NOW - 9 * MIN,
    head: 'e7a03c5d9b1f4e2a8c6d0b3f5a7e9c1d2b4f6a80',
  },
  {
    id: 'ses_51be07',
    name: 'billing-revamp · migrate',
    project: 'Billing revamp',
    processType: 'Schema migration',
    state: 'waiting_on_you',
    detail: 'decision 2h 14m',
    apm: apmSeries(4, 10, 14),
    seq: 6_022,
    done: 4,
    declared: 6,
    tokens: 1_532_906,
    usd: 22.15,
    myr: 104.47,
    lastActivity: NOW - (2 * HOUR + 14 * MIN),
    head: '0d4e8f2a6c1b9e3d7f5a0c4e8b2d6f1a3c5e7b90',
  },
  {
    id: 'ses_0d4ea3',
    name: 'release-notes · draft',
    project: 'Release tooling',
    processType: 'Release notes',
    state: 'throttled',
    detail: 'resets 14:40',
    apm: apmSeries(5, 8, 6),
    seq: 742,
    done: 1,
    declared: 3,
    tokens: 412_220,
    usd: 3.12,
    myr: 14.72,
    lastActivity: NOW - 6 * MIN,
    head: 'b2c4d6e8f0a1b3c5d7e9f1a2b4c6d8e0f2a4b6c8',
  },
  {
    id: 'ses_9a77c1',
    name: 'fx-scraper · triage',
    project: 'FX rates',
    processType: 'Triage',
    state: 'dead',
    detail: 'no heartbeat 4m',
    apm: apmSeries(6, 7, 5),
    seq: 388,
    done: 0,
    declared: 2,
    tokens: 96_310,
    usd: 0.81,
    myr: 3.82,
    lastActivity: NOW - 4 * MIN,
    head: 'c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0',
  },
  {
    id: 'ses_c3f2d9',
    name: 'intake-portal · uploads',
    project: 'Intake portal',
    processType: 'Feature build',
    state: 'working',
    apm: apmSeries(7, 18),
    seq: 8_190,
    done: 11,
    declared: 12,
    tokens: 3_970_544,
    usd: 47.6,
    myr: 224.51,
    lastActivity: NOW - 5_000,
    head: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  },
  {
    id: 'ses_e810b4',
    name: 'audit-anchor · verify',
    project: 'Audit anchor',
    processType: 'Verification',
    state: 'ended',
    apm: apmSeries(8, 5, 12),
    seq: 2_046,
    done: 6,
    declared: 6,
    tokens: 1_120_870,
    usd: 14.03,
    myr: 66.17,
    lastActivity: NOW - 47 * MIN,
    head: 'f0e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d',
  },
];

/** Session timeline: started 4h 53m ago, three phases, ticks and governance marks. */
export const TIMELINE_START = NOW - (4 * HOUR + 53 * MIN);

export const TIMELINE_PHASES: TimelinePhase[] = [
  { id: 'discovery', label: 'Discovery', start: TIMELINE_START, end: TIMELINE_START + 72 * MIN },
  { id: 'plan', label: 'Plan', start: TIMELINE_START + 72 * MIN, end: TIMELINE_START + 100 * MIN },
  { id: 'build', label: 'Build', start: TIMELINE_START + 100 * MIN },
];

export const TIMELINE_MARKS: TimelineMark[] = (() => {
  const r = prng(42);
  const marks: TimelineMark[] = [];
  const span = NOW - TIMELINE_START;
  for (let i = 0; i < 142; i += 1) {
    // Denser during the build phase.
    const u = r();
    const t = TIMELINE_START + (u < 0.3 ? (u / 0.3) * 0.33 : 0.33 + ((u - 0.3) / 0.7) * 0.67) * span;
    marks.push({ id: `tool-${i}`, kind: 'tool', at: Math.round(t) });
  }
  marks.push(
    {
      id: 'd1',
      kind: 'decision',
      at: TIMELINE_START + 55 * MIN,
      label: 'Read production schema',
      detail: 'Approved by the Approver',
    },
    {
      id: 'd2',
      kind: 'decision',
      at: TIMELINE_START + 98 * MIN,
      label: 'Fix-plan sign-off',
      detail: 'Approved by the Approver',
    },
    { id: 'd3', kind: 'decision', at: NOW - 22 * MIN, label: 'Promote to UAT', detail: 'Waiting on you' },
    {
      id: 'dr1',
      kind: 'drift',
      at: TIMELINE_START + 130 * MIN,
      label: 'Edited files outside the plan',
      detail: 'src/payments/legacy.ts',
    },
    {
      id: 'dr2',
      kind: 'drift',
      at: TIMELINE_START + 185 * MIN,
      label: 'Endpoint not in manifest',
      detail: 'Amendment requested',
    },
    {
      id: 'rb1',
      kind: 'rollback',
      at: TIMELINE_START + 150 * MIN,
      label: 'Rolled back to v1.4.2',
      detail: 'Acceptance tests passed',
    },
    {
      id: 'en1',
      kind: 'enhancement',
      at: TIMELINE_START + 250 * MIN,
      label: 'Retry on FX fetch',
      detail: 'Lesson L-12 applied',
    },
  );
  return marks;
})();

export const PHASE_PROGRESS: PhaseProgress[] = [
  {
    id: 'discovery',
    label: 'Discovery',
    doneWeight: 8,
    declaredWeight: 8,
    doneTasks: 5,
    declaredTasks: 5,
    state: 'done',
  },
  {
    id: 'plan',
    label: 'Plan',
    doneWeight: 3,
    declaredWeight: 3,
    doneTasks: 3,
    declaredTasks: 3,
    state: 'done',
  },
  {
    id: 'build',
    label: 'Build',
    doneWeight: 15,
    declaredWeight: 26,
    doneTasks: 9,
    declaredTasks: 14,
    state: 'active',
  },
  {
    id: 'uat',
    label: 'UAT',
    doneWeight: 0,
    declaredWeight: 6,
    doneTasks: 0,
    declaredTasks: 4,
    state: 'pending',
  },
  {
    id: 'release',
    label: 'Release',
    doneWeight: 0,
    declaredWeight: 2,
    doneTasks: 0,
    declaredTasks: 2,
    state: 'pending',
  },
];

export const PAIRED_ROWS: PairedBarRow[] = [
  { id: 'schema', label: 'Schema migration', discovery: 18.6, execution: 9.1, runs: 7 },
  { id: 'bugfix', label: 'Bug fix', discovery: 11.8, execution: 2.95, runs: 31 },
  { id: 'triage', label: 'Triage', discovery: 4.2, execution: 0.38, runs: 46 },
  { id: 'release', label: 'Release notes', discovery: 2.4, execution: 0.31, runs: 18 },
  { id: 'fx', label: 'FX scrape', discovery: 0.92, execution: 0.06, runs: 212 },
];

/** Weekly cost per run, oldest first, per process type. */
export const COST_TRENDS: Record<string, number[]> = {
  schema: [18.6, 17.2, 15.9, 14.1, 12.8, 11.0, 9.9, 9.1],
  bugfix: [11.8, 9.4, 7.7, 6.1, 4.9, 3.8, 3.2, 2.95],
  triage: [4.2, 2.6, 1.4, 0.9, 0.62, 0.51, 0.44, 0.38],
  release: [2.4, 1.9, 1.1, 0.8, 0.52, 0.41, 0.33, 0.31],
  fx: [0.31, 0.2, 0.12, 0.09, 0.07, 0.06, 0.07, 0.06],
};

export const CREDIT_SEGMENTS: Segment[] = [
  { id: 'billing', label: 'Billing revamp', value: 412.3 },
  { id: 'intake', label: 'Intake portal', value: 188.1 },
  { id: 'fx', label: 'FX rates', value: 64.4 },
  { id: 'release', label: 'Release tooling', value: 22.0 },
  { id: 'audit', label: 'Audit anchor', value: 9.2 },
];

export const DAILY_COST: DailyValue[] = (() => {
  const r = prng(7);
  const out: DailyValue[] = [];
  for (let i = 29; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(2026, 9, 8) - i * 24 * HOUR);
    const date = d.toISOString().slice(0, 10);
    const weekday = d.getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    const value = Math.round((weekend ? 6 : 28) + r() * (weekend ? 8 : 34) + (29 - i) * 0.6);
    out.push({
      date,
      value,
      note: weekend ? 'Weekend · FX carried forward from Friday' : undefined,
    });
  }
  return out;
})();

export const RECURRENCE: RecurrenceClass[] = [
  {
    id: 'spec',
    label: 'Ambiguous acceptance criteria',
    stage: 'root_caused',
    note: '≈ US$42 per recurrence',
    weeks: [3, 4, 2, 5, 3, 2, 1, 2].map((count, i) => ({ week: `W${34 + i}`, count })),
  },
  {
    id: 'fixtures',
    label: 'Stale test fixtures',
    stage: 'fix_applied',
    note: '≈ US$18 per recurrence',
    weeks: [1, 2, 4, 3, 1, 0, 1, 0].map((count, i) => ({ week: `W${34 + i}`, count })),
  },
  {
    id: 'guard',
    label: 'Missing migration guard',
    stage: 'verified_closed',
    note: 'no recurrence in 4 wk',
    weeks: [2, 1, 1, 0, 0, 0, 0, 0].map((count, i) => ({ week: `W${34 + i}`, count })),
  },
  {
    id: 'ratelimit',
    label: 'No retry on upstream rate limit',
    stage: 'detected',
    note: '≈ US$9 per recurrence',
    weeks: [0, 0, 1, 1, 2, 2, 3, 4].map((count, i) => ({ week: `W${34 + i}`, count })),
  },
];

/** Control Tower: the work pipeline, oldest/median age per stage. */
export const TICKET_FUNNEL: FunnelStage[] = [
  { id: 'intake', label: 'Intake', count: 4, oldestAgeMs: 2 * HOUR, medianAgeMs: 40 * MIN },
  { id: 'diagnosis', label: 'Diagnosis', count: 7, oldestAgeMs: 27 * HOUR, medianAgeMs: 6 * HOUR },
  {
    id: 'fix-plan',
    label: 'Fix-plan gate',
    count: 3,
    oldestAgeMs: 2 * HOUR + 14 * MIN,
    medianAgeMs: 65 * MIN,
  },
  { id: 'build', label: 'Build', count: 5, oldestAgeMs: 9 * HOUR, medianAgeMs: 3 * HOUR },
  { id: 'uat', label: 'UAT', count: 6, oldestAgeMs: 52 * HOUR, medianAgeMs: 26 * HOUR },
  { id: 'done', label: 'Done this week', count: 42, terminal: true },
];

/** Control Tower: decision latency against SLA, by decision type. */
export const DECISION_LATENCY: LatencyRow[] = [
  {
    id: 'fix-plan',
    label: 'Fix-plan sign-off',
    p50Ms: 42 * MIN,
    p90Ms: 3 * HOUR + 10 * MIN,
    slaMs: 4 * HOUR,
    breaches: 1,
    total: 18,
  },
  {
    id: 'go-live',
    label: 'Go-live approval',
    p50Ms: 65 * MIN,
    p90Ms: 5 * HOUR + 20 * MIN,
    slaMs: 4 * HOUR,
    breaches: 3,
    total: 9,
  },
  {
    id: 'rollback',
    label: 'Rollback approval',
    p50Ms: 18 * MIN,
    p90Ms: 55 * MIN,
    slaMs: HOUR,
    breaches: 0,
    total: 4,
  },
  {
    id: 'top-up',
    label: 'Credit top-up',
    p50Ms: 150 * MIN,
    p90Ms: 9 * HOUR,
    slaMs: 8 * HOUR,
    breaches: 2,
    total: 11,
  },
];

export const TASK_STATE_SERIES: StackedBarSeries[] = [
  { id: 'done', label: 'Done' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'not_started', label: 'Not started' },
  { id: 'blocked', label: 'Blocked' },
];

export const TASKS_BY_PROJECT: StackedBarRow[] = [
  {
    id: 'billing',
    label: 'Billing revamp',
    values: { done: 17, in_progress: 4, not_started: 6, blocked: 1 },
  },
  { id: 'intake', label: 'Intake portal', values: { done: 11, in_progress: 3, not_started: 9 } },
  { id: 'fx', label: 'FX rates', values: { done: 6, in_progress: 1, not_started: 2, blocked: 2 } },
  { id: 'release', label: 'Release tooling', values: { done: 4, in_progress: 1, not_started: 3 } },
  { id: 'audit', label: 'Audit anchor', values: { done: 6 } },
];
