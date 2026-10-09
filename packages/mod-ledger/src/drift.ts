/** Drift from the declared plan (amber marks on the timeline): off-plan changes, scope growth, playbook deviation, overrun. */
import type { MetaOf, StoredEvent } from '@aoc/contracts';
import type { Job, Reactor } from '@aoc/kernel';
import { LEDGER_ACTOR, type LedgerCore } from './core';
import type { DriftKind } from './read-model';
import { maxIso, scopeGrowth } from './rules';

interface DriftInput {
  sessionId: string;
  projectId: string;
  kind: DriftKind;
  severity: 'low' | 'medium' | 'high';
  detail: string;
  taskId?: string | null;
  causationId?: string;
}

function recentlyRecorded(core: LedgerCore, sessionId: string, kind: DriftKind): boolean {
  const last = core.read.lastDriftAt(sessionId, kind);
  return last !== null && core.clock.now() - Date.parse(last) < core.opts.driftDedupMs;
}

/** Appends drift.detected unless the same kind was already recorded for the session within the dedup window. */
export function recordDrift(core: LedgerCore, d: DriftInput): StoredEvent | null {
  if (recentlyRecorded(core, d.sessionId, d.kind)) return null;
  return core.store.append({
    type: 'drift.detected',
    actor: LEDGER_ACTOR,
    scope: { projectId: d.projectId, sessionId: d.sessionId, ...(d.taskId ? { taskId: d.taskId } : {}) },
    meta: {
      sessionId: d.sessionId,
      projectId: d.projectId,
      kind: d.kind,
      severity: d.severity,
      taskId: d.taskId ?? null,
    },
    payload: { detail: d.detail },
    source: 'system',
    causationId: d.causationId,
  });
}

/** File-changing work outside the plan: before any plan (guard bypassed) or after every task is closed. */
function checkOffPlanChange(core: LedgerCore, e: StoredEvent): void {
  const m = e.meta as MetaOf<'tool.used'>;
  if (!m.fileChanging || !m.ok) return;
  const session = core.session(m.sessionId);
  if (!session || session.mode !== 'managed') return;
  const manifest = core.read.manifest(m.sessionId);
  if (!manifest) {
    if (!session.projectId || !core.requiresPlan(session)) return;
    recordDrift(core, {
      sessionId: m.sessionId,
      projectId: session.projectId,
      kind: 'off_plan_change',
      severity: 'high',
      detail: `${m.toolName} changed files before a plan manifest was declared.`,
      causationId: e.id,
    });
    return;
  }
  if (core.read.openTaskCount(m.sessionId) > 0) return;
  recordDrift(core, {
    sessionId: m.sessionId,
    projectId: manifest.project_id,
    kind: 'off_plan_change',
    severity: 'medium',
    detail: `${m.toolName} changed files while no declared task is open; amend the plan to cover this work.`,
    causationId: e.id,
  });
}

const SESSION_TIME_STATES: ReadonlySet<string> = new Set(['launching', 'running']);

/**
 * Session time since `sinceMs`: only intervals in which the session was launching or running count —
 * waiting on a decision, blocked, throttled or idle do not. Without lifecycle events it is wall time.
 */
function sessionTimeSince(core: LedgerCore, sessionId: string, sinceMs: number, nowMs: number): number {
  let state = 'running';
  let cursor = sinceMs;
  let active = 0;
  for (const e of core.store.list({ sessionId, types: ['session.lifecycle_changed'], limit: 100_000 })) {
    const at = Date.parse(e.ts);
    const to = (e.meta as MetaOf<'session.lifecycle_changed'>).to;
    if (at > sinceMs) {
      if (SESSION_TIME_STATES.has(state)) active += Math.min(at, nowMs) - cursor;
      cursor = Math.min(at, nowMs);
    }
    state = to;
  }
  if (SESSION_TIME_STATES.has(state)) active += nowMs - cursor;
  return Math.max(0, active);
}

/**
 * Overrun: the task the agent is presumed to be on (first open task in manifest order) has used more
 * session time than its size budget since the later of the previous close and the task's declaration.
 * A session that is not running right now is not overrunning (it is waiting on someone).
 */
function checkOverrun(core: LedgerCore, sessionId: string, causationId?: string): StoredEvent | null {
  const manifest = core.read.manifest(sessionId);
  if (!manifest) return null;
  const session = core.session(sessionId);
  if (core.service('sessions') && session?.lifecycle !== 'running') return null;
  const task = core.read.firstOpenTask(sessionId);
  if (!task) return null;
  const since = Date.parse(
    maxIso(core.read.sessionState(sessionId)?.last_close_at, manifest.declared_at, task.added_at)!,
  );
  const now = core.clock.now();
  const budgetMin = core.opts.overrunBudgetMinutes[task.size];
  // Session time never exceeds wall time: skip the lifecycle scan while under budget or deduplicated.
  if (now - since <= budgetMin * 60_000 || recentlyRecorded(core, sessionId, 'overrun')) return null;
  const elapsedMs = sessionTimeSince(core, sessionId, since, now);
  if (elapsedMs <= budgetMin * 60_000) return null;
  const elapsedMin = Math.floor(elapsedMs / 60_000);
  return recordDrift(core, {
    sessionId,
    projectId: manifest.project_id,
    kind: 'overrun',
    severity: elapsedMs > 2 * budgetMin * 60_000 ? 'high' : 'medium',
    detail: `Task ${task.task_id} (size ${task.size}) has been in progress for ${elapsedMin} min; its budget is ${budgetMin} min.`,
    taskId: task.task_id,
    causationId,
  });
}

/** Scope growth: amendments grew the plan weight beyond the threshold over the declared baseline. */
export function checkScopeGrowth(core: LedgerCore, sessionId: string, amendment: StoredEvent): void {
  const m = amendment.meta as MetaOf<'plan.amended'>;
  const manifest = core.read.manifest(sessionId);
  if (!manifest) return;
  const growth = scopeGrowth(manifest.base_weight, m.newTotalWeight);
  const threshold = core.opts.scopeGrowthThreshold;
  if (growth <= threshold) return;
  recordDrift(core, {
    sessionId,
    projectId: manifest.project_id,
    kind: 'scope_growth',
    severity: growth >= 2 * threshold ? 'high' : 'medium',
    detail: `Amendments grew the plan weight by ${Math.round(growth * 100)}% over the declared baseline (${manifest.base_weight} → ${m.newTotalWeight}).`,
    causationId: amendment.id,
  });
}

export function createDriftReactor(core: LedgerCore): Reactor {
  return {
    name: 'ledger.drift',
    handles: ['tool.used'],
    react(e) {
      if (core.store.findByCausation(e.id, 'drift.detected').length) return;
      checkOffPlanChange(core, e);
      checkOverrun(core, (e.meta as MetaOf<'tool.used'>).sessionId, e.id);
    },
  };
}

/** Catches overruns in sessions that stopped making tool calls. */
export function createOverrunJob(core: LedgerCore): Job {
  return {
    name: 'ledger.overrun-scan',
    schedule: { everyMs: core.opts.overrunScanEveryMs },
    run() {
      for (const sessionId of core.read.sessionsWithOpenTasks()) checkOverrun(core, sessionId);
    },
  };
}
