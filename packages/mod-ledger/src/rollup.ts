/**
 * Console read models over the master timeline (§9): one roll-up row per project for the Projects list, and the
 * history marks behind a project's timeline (denominator changes, drift, enhancements, phase pins).
 */
import type {
  PhasePinDTO,
  ProjectDriftDTO,
  ProjectHistory,
  ProjectPhaseRollup,
  ProjectRollup,
  ScopeChangeDTO,
} from '@aoc/contracts';
import { ERASED, type LedgerCore } from './core';
import type { DriftRow, TaskRow } from './read-model';
import { aggregateManifest } from './views';

const WEEK_MS = 7 * 86_400_000;

function phaseRollups(core: LedgerCore, projectId: string): ProjectPhaseRollup[] {
  const manifest = aggregateManifest(
    core.read.manifestsOfProject(projectId),
    core.read.phasesOfProject(projectId),
    core.read.tasksOfProject(projectId),
  );
  return manifest.map((p) => {
    const live = p.tasks.filter((t) => t.status !== 'removed');
    const done = live.filter((t) => t.status === 'done');
    const flagged = done.filter((t) => t.flag !== null);
    const weight = (ts: typeof live) => ts.reduce((a, t) => a + t.weight, 0);
    return {
      phaseId: p.phaseId,
      name: p.name,
      order: p.order,
      doneTasks: done.length,
      totalTasks: live.length,
      doneWeight: weight(done),
      totalWeight: weight(live),
      flaggedTasks: flagged.length,
      flaggedWeight: weight(flagged),
      completedAt: p.completedAt,
      pinnedTag: p.pinnedTag,
      pinnedSha: p.pinnedSha,
    };
  });
}

function driftSummary(rows: DriftRow[], since: number): ProjectRollup['drift'] {
  const recent = rows.filter((d) => Date.parse(d.at) >= since);
  return {
    total: rows.length,
    last7d: recent.length,
    highLast7d: recent.filter((d) => d.severity === 'high').length,
    lastAt: rows.at(-1)?.at ?? null,
  };
}

export function projectRollups(core: LedgerCore): ProjectRollup[] {
  const since = core.clock.now() - WEEK_MS;
  return core.read.projects().map((project) => {
    const phases = phaseRollups(core, project.project_id);
    const amendments = core.read.amendmentsOfProject(project.project_id);
    return {
      projectId: project.project_id,
      phases,
      currentPhaseId: phases.find((p) => p.doneWeight < p.totalWeight)?.phaseId ?? null,
      drift: driftSummary(core.read.driftOfProject(project.project_id), since),
      amendments: {
        count: amendments.length,
        last7d: amendments.filter((a) => Date.parse(a.at) >= since).length,
        lastAt: amendments.at(-1)?.at ?? null,
      },
    };
  });
}

/** Work is attributed to the session's developer; ledger rows may only know the session. */
function ownerOf(core: LedgerCore, id: string | null, sessionId: string): string | null {
  if (id && id !== sessionId) return id;
  return core.session(sessionId)?.ownerId ?? null;
}

/**
 * Tasks a successor session took over from a previous writer, per declaration/amendment that re-declared them
 * (`sessionId:seq`). They were already in the denominator at the predecessor's weight, so they are not new scope.
 */
function carriedByEvent(tasks: TaskRow[]): Map<string, { tasks: number; weight: number }> {
  const copies = new Map(tasks.map((t) => [`${t.session_id}/${t.task_id}`, t]));
  const out = new Map<string, { tasks: number; weight: number }>();
  for (const p of tasks) {
    if (p.status !== 'carried' || !p.carried_to) continue;
    const successor = copies.get(`${p.carried_to}/${p.task_id}`);
    if (!successor) continue;
    const key = `${successor.session_id}:${successor.added_seq}`;
    const acc = out.get(key) ?? { tasks: 0, weight: 0 };
    out.set(key, { tasks: acc.tasks + 1, weight: acc.weight + p.weight });
  }
  return out;
}

function scopeChanges(core: LedgerCore, projectId: string): ScopeChangeDTO[] {
  const tasks = core.read.tasksOfProject(projectId);
  const carried = carriedByEvent(tasks);

  type Step = Omit<ScopeChangeDTO, 'projectWeightBefore' | 'projectWeightAfter' | 'weightDelta'> & {
    sessionDelta: number;
  };
  const steps: Step[] = [
    ...core.read.manifestsOfProject(projectId).map((m): Step => {
      const ownerId = ownerOf(core, m.owner_id, m.session_id);
      return {
        seq: m.declared_seq,
        at: m.declared_at,
        kind: 'declared',
        sessionId: m.session_id,
        ownerId,
        ownerName: core.userName(ownerId),
        manifestVersion: 1,
        added: tasks.filter((t) => t.session_id === m.session_id && t.added_seq === m.declared_seq).length,
        removed: 0,
        resized: 0,
        carriedOver: carried.get(`${m.session_id}:${m.declared_seq}`)?.tasks ?? 0,
        reason: null,
        sessionDelta: m.base_weight,
      };
    }),
    ...core.read.amendmentsOfProject(projectId).map((a): Step => {
      const ownerId = ownerOf(core, a.by_id, a.session_id);
      return {
        seq: a.seq,
        at: a.at,
        kind: 'amended',
        sessionId: a.session_id,
        ownerId,
        ownerName: core.userName(ownerId),
        manifestVersion: a.version,
        added: a.added,
        removed: a.removed,
        resized: a.resized,
        carriedOver: carried.get(`${a.session_id}:${a.seq}`)?.tasks ?? 0,
        reason: a.reason ?? ERASED,
        sessionDelta: a.new_total_weight - a.prev_total_weight,
      };
    }),
  ].sort((x, y) => x.seq - y.seq);

  let total = 0;
  return steps.map(({ sessionDelta, ...s }) => {
    const weightDelta = sessionDelta - (carried.get(`${s.sessionId}:${s.seq}`)?.weight ?? 0);
    const before = total;
    total += weightDelta;
    return { ...s, weightDelta, projectWeightBefore: before, projectWeightAfter: total };
  });
}

function driftDTO(d: DriftRow): ProjectDriftDTO {
  return {
    seq: d.seq,
    at: d.at,
    sessionId: d.session_id,
    kind: d.kind,
    severity: d.severity,
    taskId: d.task_id,
    detail: d.detail ?? ERASED,
  };
}

export function projectHistory(core: LedgerCore, projectId: string): ProjectHistory {
  const pins: PhasePinDTO[] = core.read
    .pinsOfProject(projectId)
    .filter((p) => p.pinned_tag || p.pinned_sha)
    .map((p) => ({
      phaseId: p.phase_id,
      sessionId: p.session_id,
      tag: p.pinned_tag,
      sha: p.pinned_sha,
      at: p.pinned_at!,
    }));
  return {
    projectId,
    scope: scopeChanges(core, projectId),
    drift: core.read.driftOfProject(projectId).map(driftDTO),
    enhancements: core.read.enhancementsOfProject(projectId).map((e) => ({
      eventId: e.event_id,
      projectId: e.project_id,
      sessionId: e.session_id,
      changeId: e.change_id,
      at: e.at,
      by: e.by_id,
      title: e.title ?? ERASED,
      detail: e.detail,
    })),
    pins,
  };
}
