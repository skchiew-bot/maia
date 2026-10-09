/**
 * Anomaly radar: gaming / hollow-progress signals at PORTFOLIO level only (R11). Inputs are aggregated by
 * process type or project — never by person — and the last 7 days are compared with the 7 days before.
 * Status: watch at 1.5× the baseline, alert at 2×, where the baseline is never below a per-signal floor
 * (so a quiet previous week cannot turn one event into an alert). Percent signals need a minimum sample.
 */
import type { SQLInputValue } from 'node:sqlite';
import { BLIND_AFFIRM_DWELL_MS, type AnomalySignal, type TowerAnomaly } from '@aoc/contracts';
import { LATE_DONE_SHARE } from './projector';
import { all, inProject, type ReadCtx } from './read';
import { classifyRuns, runsLaunched } from './runs';
import { pct, round2 } from './stats';
import { DAY } from './zoned';

const WINDOW_MS = 7 * DAY;
/** A manifest is XS-heavy when more than this share of its tasks are XS. */
export const XS_HEAVY_SHARE = 0.6;

interface SignalDef {
  signal: AnomalySignal;
  label: string;
  unit: '%' | 'count';
  /** Lowest baseline used for thresholds. */
  floor: number;
  /** Percent signals: fewer observations in 7d than this → not judged. */
  minSample: number;
  /** What the observations are grouped by when the anomaly concentrates somewhere. */
  scopeKind: 'process_type' | 'project';
  describe(k: number, n: number, value: number): string;
}

const SIGNALS: Record<AnomalySignal, SignalDef> = {
  no_file_change_closes: {
    signal: 'no_file_change_closes',
    label: 'No-file-change closes',
    unit: '%',
    floor: 5,
    minSample: 5,
    scopeKind: 'process_type',
    describe: (k, n, v) =>
      `${k} of ${n} tasks closed in 7d had no file change since the previous close (${v}%).`,
  },
  xs_heavy_manifests: {
    signal: 'xs_heavy_manifests',
    label: 'XS-heavy manifests',
    unit: '%',
    floor: 10,
    minSample: 3,
    scopeKind: 'process_type',
    describe: (k, n, v) =>
      `${k} of ${n} plans declared in 7d were more than ${XS_HEAVY_SHARE * 100}% XS tasks (${v}%).`,
  },
  late_denominator_growth: {
    signal: 'late_denominator_growth',
    label: 'Late denominator growth',
    unit: 'count',
    floor: 2,
    minSample: 0,
    scopeKind: 'process_type',
    describe: (k) =>
      `${k} plan amendment${k === 1 ? '' : 's'} in 7d added weight after ${LATE_DONE_SHARE * 100}% of the declared work was done.`,
  },
  blind_affirm_rate: {
    signal: 'blind_affirm_rate',
    label: 'Blind affirm-without-edit',
    unit: '%',
    floor: 10,
    minSample: 5,
    scopeKind: 'project',
    describe: (k, n, v) =>
      `${k} of ${n} change-field affirmations in 7d were unedited with under ${BLIND_AFFIRM_DWELL_MS / 1000}s dwell (${v}%).`,
  },
  discovery_with_playbook: {
    signal: 'discovery_with_playbook',
    label: 'Discovery despite a playbook',
    unit: 'count',
    // One run → watch, two → alert while the previous week was clean.
    floor: 0.6,
    minSample: 0,
    scopeKind: 'process_type',
    describe: (k) =>
      `${k} run${k === 1 ? '' : 's'} in 7d launched on the discovery model although an approved playbook existed.`,
  },
  evidence_unverified: {
    signal: 'evidence_unverified',
    label: 'Evidence unverified',
    unit: '%',
    floor: 5,
    minSample: 5,
    scopeKind: 'process_type',
    describe: (k, n, v) =>
      `${k} of ${n} tasks closed in 7d carried evidence that could not be verified (${v}%).`,
  },
  self_approval_rate: {
    signal: 'self_approval_rate',
    label: 'Self-approval rate',
    unit: '%',
    floor: 40,
    minSample: 5,
    scopeKind: 'project',
    describe: (k, n, v) => `${k} of ${n} changes approved in 7d were self-approved (${v}%).`,
  },
};

/** Observations aggregated per window (current 7d or the 7d before) and process type / project. */
interface Group {
  cur: number;
  scope: string | null;
  n: number;
  k: number;
}

export function buildAnomalies(r: ReadCtx): TowerAnomaly[] {
  const from = r.now - 2 * WINDOW_MS;
  const split = r.now - WINDOW_MS;
  const [pw, pa] = inProject(r, 'project_id');
  const [cw, ca] = inProject(r, 'c.project_id');
  const tasks = all<{ cur: number; scope: string | null; n: number; nfc: number; unv: number }>(
    r,
    `SELECT ts_ms > ? AS cur, process_type AS scope, COUNT(*) AS n, SUM(flag = 'no_file_change') AS nfc, SUM(evidence_verified = 0) AS unv
     FROM twr_task_done WHERE ts_ms > ? AND ts_ms <= ?${pw} GROUP BY cur, scope`,
    split,
    from,
    r.now,
    ...pa,
  );
  const window = (sql: string, ...args: SQLInputValue[]) => all<Group>(r, sql, split, from, r.now, ...args);
  const groups: Record<AnomalySignal, Group[]> = {
    no_file_change_closes: tasks.map((t) => ({ cur: t.cur, scope: t.scope, n: t.n, k: t.nfc })),
    evidence_unverified: tasks.map((t) => ({ cur: t.cur, scope: t.scope, n: t.n, k: t.unv })),
    // More than 60% XS, in integers: xs / tasks > 3 / 5.
    xs_heavy_manifests: window(
      `SELECT ts_ms > ? AS cur, process_type AS scope, COUNT(*) AS n, SUM(xs_count * 5 > task_count * 3) AS k
       FROM twr_plan_log WHERE xs_count IS NOT NULL AND task_count > 0 AND ts_ms > ? AND ts_ms <= ?${pw} GROUP BY cur, scope`,
      ...pa,
    ),
    late_denominator_growth: window(
      `SELECT ts_ms > ? AS cur, process_type AS scope, COUNT(*) AS n, SUM(late) AS k FROM twr_amendments WHERE ts_ms > ? AND ts_ms <= ?${pw} GROUP BY cur, scope`,
      ...pa,
    ),
    blind_affirm_rate: window(
      `SELECT a.ts_ms > ? AS cur, c.project_id AS scope, COUNT(*) AS n, SUM(a.edited = 0 AND a.dwell_ms < ${BLIND_AFFIRM_DWELL_MS}) AS k
       FROM twr_affirmations a LEFT JOIN twr_changes c ON c.change_id = a.change_id WHERE a.ts_ms > ? AND a.ts_ms <= ?${cw} GROUP BY cur, scope`,
      ...ca,
    ),
    self_approval_rate: window(
      `SELECT approved_ms > ? AS cur, project_id AS scope, COUNT(*) AS n, SUM(self_approved = 1) AS k
       FROM twr_changes WHERE approved_ms > ? AND approved_ms <= ?${pw} GROUP BY cur, scope`,
      ...pa,
    ),
    discovery_with_playbook: runGroups(r, from, split),
  };
  return (Object.keys(SIGNALS) as AnomalySignal[]).map((s) => evaluate(r, SIGNALS[s], groups[s]));
}

/** Runs need the registry to classify, so they are grouped here rather than in SQL. */
function runGroups(r: ReadCtx, from: number, split: number): Group[] {
  const runs = runsLaunched(r, from + 1);
  const verdicts = classifyRuns(r, runs);
  const out = new Map<string, Group>();
  for (const run of runs) {
    const cur = run.launched_ms > split ? 1 : 0;
    const key = `${cur}:${run.process_type ?? ''}`;
    const g = out.get(key) ?? { cur, scope: run.process_type, n: 0, k: 0 };
    g.n++;
    if (verdicts.get(run.session_id)?.discoveryDespitePlaybook) g.k++;
    out.set(key, g);
  }
  return [...out.values()];
}

function evaluate(r: ReadCtx, def: SignalDef, groups: Group[]): TowerAnomaly {
  const sum = (gs: Group[], f: (g: Group) => number) => gs.reduce((a, g) => a + f(g), 0);
  const cur = groups.filter((g) => g.cur);
  const prev = groups.filter((g) => !g.cur);
  const n = sum(cur, (g) => g.n);
  const k = sum(cur, (g) => g.k);
  const nPrev = sum(prev, (g) => g.n);
  const kPrev = sum(prev, (g) => g.k);
  const percent = def.unit === '%';
  const value = percent ? pct(k, n) : k;
  const baseline = percent ? (nPrev >= def.minSample ? pct(kPrev, nPrev) : null) : kPrev;
  const effective = Math.max(baseline ?? 0, def.floor);
  // Counts are integers: show and compare the integer thresholds they imply.
  const threshold = (x: number) => (percent ? round2(x) : Math.ceil(round2(x)));
  const watchAt = threshold(1.5 * effective);
  const alertAt = threshold(2 * effective);
  const judged = !percent || n >= def.minSample;
  const status: TowerAnomaly['status'] = !judged
    ? 'normal'
    : value >= alertAt
      ? 'alert'
      : value >= watchAt
        ? 'watch'
        : 'normal';

  const baseScope = r.projectId ? `project:${r.projectId}` : 'portfolio';
  let scope = baseScope;
  let concentration = '';
  if (status !== 'normal' && k > 0) {
    const top = cur
      .filter((g) => g.scope && g.k > 0)
      .sort((a, b) => b.k - a.k || a.scope!.localeCompare(b.scope!))[0];
    if (top && top.k / k > 0.5) {
      scope = `${def.scopeKind}:${top.scope}`;
      concentration = ` Concentrated in ${def.scopeKind === 'process_type' ? 'process type' : 'project'} ${top.scope} (${top.k} of ${k}).`;
    }
  }
  const unit = percent ? '%' : '';
  const explanation = [
    def.describe(k, n, value),
    baseline === null ? 'No baseline yet (previous 7d too thin).' : `Previous 7d: ${baseline}${unit}.`,
    judged
      ? `Watch ≥ ${watchAt}${unit}, alert ≥ ${alertAt}${unit}.`
      : `Too few samples to judge (need ${def.minSample}).`,
  ].join(' ');
  return {
    signal: def.signal,
    label: def.label,
    value,
    baseline,
    unit: def.unit,
    status,
    scope,
    explanation: explanation + concentration,
  };
}
