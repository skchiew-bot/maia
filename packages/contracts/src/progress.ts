/**
 * Measured progress (§4, §9): weighted tasks done over tasks declared. ETA hidden until ≥3 tasks done.
 * Pure — used by mod-ledger, the UI and tests.
 */
import { TASK_SIZE_WEIGHT, type TaskSize } from './mcp';

export interface ProgressTask {
  id: string;
  phaseId: string;
  size: TaskSize;
  status: 'open' | 'done' | 'removed';
  doneAt?: number | null;
  flagged?: boolean;
}
export interface ProgressPhase {
  id: string;
  name: string;
  order: number;
}

export interface PhaseProgress {
  phaseId: string;
  name: string;
  doneTasks: number;
  totalTasks: number;
  doneWeight: number;
  totalWeight: number;
  pct: number;
  complete: boolean;
}
export interface Progress {
  doneTasks: number;
  totalTasks: number;
  doneWeight: number;
  totalWeight: number;
  /** 0..100, rounded to 1 decimal. */
  pct: number;
  flaggedTasks: number;
  phases: PhaseProgress[];
  /** null while fewer than ETA_MIN_DONE tasks are done (§4). */
  etaMs: number | null;
  etaHiddenReason: 'fewer_than_3_done' | 'complete' | null;
}

export const ETA_MIN_DONE = 3;

export function weightOf(size: TaskSize): number {
  return TASK_SIZE_WEIGHT[size];
}

export function computeProgress(
  phases: ProgressPhase[],
  tasks: ProgressTask[],
  opts: { startedAt?: number | null; now?: number } = {},
): Progress {
  const live = tasks.filter((t) => t.status !== 'removed');
  const byPhase = [...phases].sort((a, b) => a.order - b.order).map<PhaseProgress>((p) => {
    const ts = live.filter((t) => t.phaseId === p.id);
    const doneTs = ts.filter((t) => t.status === 'done');
    const totalWeight = sum(ts.map((t) => weightOf(t.size)));
    const doneWeight = sum(doneTs.map((t) => weightOf(t.size)));
    return {
      phaseId: p.id,
      name: p.name,
      doneTasks: doneTs.length,
      totalTasks: ts.length,
      doneWeight,
      totalWeight,
      pct: pct(doneWeight, totalWeight),
      complete: ts.length > 0 && doneTs.length === ts.length,
    };
  });
  const done = live.filter((t) => t.status === 'done');
  const totalWeight = sum(live.map((t) => weightOf(t.size)));
  const doneWeight = sum(done.map((t) => weightOf(t.size)));

  let etaMs: number | null = null;
  let etaHiddenReason: Progress['etaHiddenReason'] = null;
  if (done.length > 0 && done.length === live.length) etaHiddenReason = 'complete';
  else if (done.length < ETA_MIN_DONE) etaHiddenReason = 'fewer_than_3_done';
  else if (opts.startedAt != null && opts.now != null && doneWeight > 0) {
    const elapsed = Math.max(0, opts.now - opts.startedAt);
    etaMs = Math.round((elapsed / doneWeight) * (totalWeight - doneWeight));
  }

  return {
    doneTasks: done.length,
    totalTasks: live.length,
    doneWeight,
    totalWeight,
    pct: pct(doneWeight, totalWeight),
    flaggedTasks: done.filter((t) => t.flagged).length,
    phases: byPhase,
    etaMs,
    etaHiddenReason,
  };
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
function pct(a: number, b: number): number {
  return b === 0 ? 0 : Math.round((a / b) * 1000) / 10;
}
