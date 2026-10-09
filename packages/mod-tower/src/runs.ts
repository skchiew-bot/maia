/**
 * Discovery vs execution runs (§10 distillation economics). The launch event carries the model but not the
 * process type's class or discovery model, so the registry decides when present: a run of a discovery- or
 * execution-class type is an execution run when it launched on a model other than the type's discovery
 * model (i.e. routed to the playbook's execution model). Without the registry the type's discovery model is
 * approximated by the strongest tier seen for it, and triage/maintenance types cannot be told apart.
 */
import { modelTierOf, type ModelTier } from '@aoc/contracts';
import { all, inProject, type ReadCtx } from './read';

export interface RunRow {
  session_id: string;
  process_type: string | null;
  model: string | null;
  playbook: number;
  launched_ms: number;
  project_id: string | null;
}

export interface RunVerdict {
  /** null: not part of the distillation economics (triage / maintenance types). */
  cls: 'discovery' | 'execution' | null;
  /** Launched on the type's discovery model although an approved playbook existed (a routing anomaly). */
  discoveryDespitePlaybook: boolean;
}

const STRENGTH: Record<ModelTier | 'unknown', number> = {
  fable: 3,
  opus: 3,
  sonnet: 2,
  haiku: 1,
  unknown: 0,
};

export function runsLaunched(r: ReadCtx, fromMs: number): RunRow[] {
  const [where, args] = inProject(r, 'project_id');
  return all<RunRow>(
    r,
    `SELECT session_id, process_type, model, playbook_at_launch AS playbook, launched_ms, project_id FROM twr_sessions
     WHERE mode = 'managed' AND launched_ms >= ? AND launched_ms <= ?${where}`,
    fromMs,
    r.now,
    ...args,
  );
}

export function classifyRuns(r: ReadCtx, runs: RunRow[]): Map<string, RunVerdict> {
  const strongest = new Map<string, number>();
  for (const run of runs) {
    const key = run.process_type ?? '';
    strongest.set(key, Math.max(strongest.get(key) ?? 0, STRENGTH[modelTierOf(run.model ?? '')]));
  }
  const out = new Map<string, RunVerdict>();
  for (const run of runs) {
    const tier = modelTierOf(run.model ?? '');
    const type = run.process_type ? r.svc.processType(run.process_type) : null;
    if (type) {
      const distillable = type.class === 'discovery' || type.class === 'execution';
      const onDiscoveryModel = tier === type.model;
      out.set(run.session_id, {
        cls: distillable ? (onDiscoveryModel ? 'discovery' : 'execution') : null,
        discoveryDespitePlaybook:
          run.playbook === 1 &&
          type.class !== 'discovery' &&
          type.executionModel !== null &&
          type.executionModel !== type.model &&
          onDiscoveryModel,
      });
      continue;
    }
    const onDiscoveryModel = STRENGTH[tier] === strongest.get(run.process_type ?? '');
    out.set(run.session_id, {
      cls: onDiscoveryModel ? 'discovery' : 'execution',
      discoveryDespitePlaybook: run.playbook === 1 && onDiscoveryModel,
    });
  }
  return out;
}
