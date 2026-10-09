/** Read-side DTO builders: measured progress (§4), manifests, project/thread summaries (§9). */
import {
  computeProgress,
  type AmendmentDTO,
  type ManifestPhaseDTO,
  type ManifestTaskDTO,
  type Progress,
  type ProgressDTO,
  type ProgressPhase,
  type ProgressTask,
  type ProjectDetail,
  type ProjectSummary,
  type ThreadDetail,
  type ThreadSummary,
} from '@aoc/contracts';
import { ERASED, TERMINAL_LIFECYCLES, type LedgerCore } from './core';
import { threadSessionIds } from './projects';
import type { AmendmentRow, ManifestRow, PhaseRow, ProjectRow, TaskRow, ThreadRow } from './read-model';
import { maxIso } from './rules';

/**
 * 'session': a session's own manifest — tasks it handed to a successor still count as open there.
 * 'aggregate': project / thread totals — a carried-over task counts once, in the session that took it.
 */
type View = 'session' | 'aggregate';

function progressStatus(t: TaskRow, view: View): ProgressTask['status'] {
  if (t.status === 'carried') return view === 'session' ? 'open' : 'removed';
  return t.status;
}

function progressOf(
  phases: ProgressPhase[],
  tasks: TaskRow[],
  view: View,
  startedAt: string | null,
  now: number,
): Progress {
  return computeProgress(
    phases,
    tasks.map((t) => ({
      id: `${t.session_id}/${t.task_id}`,
      phaseId: t.phase_id,
      size: t.size,
      status: progressStatus(t, view),
      doneAt: t.done_at ? Date.parse(t.done_at) : null,
      flagged: t.flag !== null,
    })),
    { startedAt: startedAt ? Date.parse(startedAt) : null, now },
  );
}

export function toProgressDTO(p: Progress): ProgressDTO {
  return {
    doneTasks: p.doneTasks,
    totalTasks: p.totalTasks,
    doneWeight: p.doneWeight,
    totalWeight: p.totalWeight,
    pct: p.pct,
    flaggedTasks: p.flaggedTasks,
    etaMs: p.etaMs,
    etaHiddenReason: p.etaHiddenReason,
  };
}

export const emptyProgress = (): Progress => computeProgress([], []);

function sessionPhases(core: LedgerCore, sessionId: string): ProgressPhase[] {
  return core.read.phasesOf(sessionId).map((p) => ({ id: p.phase_id, name: p.name ?? ERASED, order: p.ord }));
}

/** ETA runs from the plan declaration (§4: hidden until three tasks are done). */
export function sessionProgress(core: LedgerCore, sessionId: string): Progress | null {
  const m = core.read.manifest(sessionId);
  if (!m) return null;
  return progressOf(
    sessionPhases(core, sessionId),
    core.read.tasksOf(sessionId),
    'session',
    m.declared_at,
    core.clock.now(),
  );
}

/** Phases merged by id across manifests (developers declare into the same phase, §9), in first-declared order. */
export function mergedPhases(manifests: ManifestRow[], phases: PhaseRow[]): ProgressPhase[] {
  const seqOf = new Map(manifests.map((m) => [m.session_id, m.declared_seq]));
  const sorted = [...phases].sort(
    (a, b) => (seqOf.get(a.session_id) ?? 0) - (seqOf.get(b.session_id) ?? 0) || a.ord - b.ord,
  );
  const out: ProgressPhase[] = [];
  for (const p of sorted) {
    const existing = out.find((o) => o.id === p.phase_id);
    if (!existing) out.push({ id: p.phase_id, name: p.name ?? ERASED, order: out.length });
    else if (existing.name === ERASED && p.name) existing.name = p.name;
  }
  return out;
}

/** Master timeline (§9): tasks done over tasks declared across every session and developer of the project. */
export function projectProgress(core: LedgerCore, projectId: string): Progress | null {
  const manifests = core.read.manifestsOfProject(projectId);
  if (!manifests.length) return core.read.project(projectId) ? emptyProgress() : null;
  const phases = mergedPhases(manifests, core.read.phasesOfProject(projectId));
  return progressOf(
    phases,
    core.read.tasksOfProject(projectId),
    'aggregate',
    manifests[0]!.declared_at,
    core.clock.now(),
  );
}

interface ThreadScope {
  sessionIds: string[];
  manifests: ManifestRow[];
  phases: PhaseRow[];
  tasks: TaskRow[];
}

export function threadScope(core: LedgerCore, threadId: string, extraSessionId?: string | null): ThreadScope {
  const sessionIds = threadSessionIds(core, threadId, extraSessionId);
  const manifests = sessionIds.map((s) => core.read.manifest(s)).filter((m): m is ManifestRow => m !== null);
  return {
    sessionIds,
    manifests,
    phases: sessionIds.flatMap((s) => core.read.phasesOf(s)),
    tasks: sessionIds.flatMap((s) => core.read.tasksOf(s)),
  };
}

function threadProgress(core: LedgerCore, scope: ThreadScope): Progress {
  if (!scope.manifests.length) return emptyProgress();
  return progressOf(
    mergedPhases(scope.manifests, scope.phases),
    scope.tasks,
    'aggregate',
    scope.manifests[0]!.declared_at,
    core.clock.now(),
  );
}

// ── manifests ───────────────────────────────────────────────────────────────
function taskDTO(t: TaskRow): ManifestTaskDTO {
  return {
    taskId: t.task_id,
    phaseId: t.phase_id,
    title: t.title ?? ERASED,
    acceptance: t.acceptance,
    size: t.size,
    weight: t.weight,
    status: t.status === 'carried' ? 'open' : t.status,
    declaredBy: t.owner_id ?? t.session_id,
    sessionId: t.session_id,
    doneAt: t.done_at,
    evidence: t.evidence_kind
      ? { kind: t.evidence_kind, ref: t.evidence_ref ?? ERASED, verified: t.evidence_verified === 1 }
      : null,
    flag: t.flag,
    ...(t.carried_to ? { carriedToSessionId: t.carried_to } : {}),
  };
}

export function sessionManifest(core: LedgerCore, sessionId: string): ManifestPhaseDTO[] {
  const tasks = core.read.tasksOf(sessionId);
  return core.read.phasesOf(sessionId).map((p) => ({
    phaseId: p.phase_id,
    name: p.name ?? ERASED,
    order: p.ord,
    completedAt: p.completed_at,
    pinnedSha: p.pinned_sha,
    pinnedTag: p.pinned_tag,
    tasks: tasks.filter((t) => t.phase_id === p.phase_id).map(taskDTO),
  }));
}

/** A merged phase is complete when every live task in it (any session) is done; it shows the latest pin. */
export function aggregateManifest(
  manifests: ManifestRow[],
  phaseRows: PhaseRow[],
  tasks: TaskRow[],
): ManifestPhaseDTO[] {
  const visible = tasks.filter((t) => t.status !== 'carried');
  return mergedPhases(manifests, phaseRows).map((ph) => {
    const ts = visible.filter((t) => t.phase_id === ph.id);
    const live = ts.filter((t) => t.status !== 'removed');
    const complete = live.length > 0 && live.every((t) => t.status === 'done');
    const pin = phaseRows
      .filter((r) => r.phase_id === ph.id && r.pinned_at)
      .sort((a, b) => Date.parse(b.pinned_at!) - Date.parse(a.pinned_at!))[0];
    return {
      phaseId: ph.id,
      name: ph.name,
      order: ph.order,
      completedAt: complete ? maxIso(...live.map((t) => t.done_at)) : null,
      pinnedSha: pin?.pinned_sha ?? null,
      pinnedTag: pin?.pinned_tag ?? null,
      tasks: ts.map(taskDTO),
    };
  });
}

export function amendmentDTO(core: LedgerCore, a: AmendmentRow): AmendmentDTO {
  return {
    at: a.at,
    by: a.by_id,
    byName: core.userName(a.by_id),
    sessionId: a.session_id,
    added: a.added,
    removed: a.removed,
    resized: a.resized,
    prevTotalWeight: a.prev_total_weight,
    newTotalWeight: a.new_total_weight,
    reason: a.reason ?? ERASED,
  };
}

// ── projects & threads ──────────────────────────────────────────────────────
export function projectSummary(core: LedgerCore, row: ProjectRow): ProjectSummary {
  const sessions = core.service('sessions');
  const active = sessions
    ? sessions.list({ projectId: row.project_id }).filter((s) => !TERMINAL_LIFECYCLES.has(s.lifecycle)).length
    : 0;
  const openDecisions =
    core.service('decisions')?.list({ projectId: row.project_id, status: ['open'] }).length ?? 0;
  return {
    projectId: row.project_id,
    name: row.name ?? ERASED,
    slug: row.slug,
    repoPath: row.repo_path,
    progress: toProgressDTO(projectProgress(core, row.project_id) ?? emptyProgress()),
    activeSessions: active,
    openDecisions,
    lastActivityAt: maxIso(row.last_activity_at, core.read.lastToolActivityOfProject(row.project_id)),
  };
}

export function threadSummary(t: ThreadRow): ThreadSummary {
  return {
    threadId: t.thread_id,
    projectId: t.project_id,
    title: t.title ?? ERASED,
    activeWriterSessionId: t.writer_session_id,
    createdAt: t.created_at,
  };
}

export function projectDetail(core: LedgerCore, row: ProjectRow): ProjectDetail {
  return {
    ...projectSummary(core, row),
    description: row.description,
    defaultBranch: row.default_branch,
    createdAt: row.created_at,
    threads: core.read.threadsOf(row.project_id).map(threadSummary),
  };
}

export function threadDetail(core: LedgerCore, t: ThreadRow): ThreadDetail {
  const scope = threadScope(core, t.thread_id);
  return {
    ...threadSummary(t),
    writers: core.read
      .writers(t.thread_id)
      .map((w) => ({
        sessionId: w.session_id,
        acquiredAt: w.acquired_at,
        releasedAt: w.released_at,
        reason: w.reason,
      })),
    sessionIds: scope.sessionIds,
    progress: toProgressDTO(threadProgress(core, scope)),
  };
}
