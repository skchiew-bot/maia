/**
 * Timelines (§9, §12): the session hero strip (phase bands to scale by elapsed time, event marks) and the
 * project master timeline (stacked per-phase segments, one per contributing developer).
 */
import type {
  MetaOf,
  PayloadOf,
  ProjectTimeline,
  SessionTimeline,
  StoredEvent,
  TimelineMark,
  TimelinePhaseBand,
} from '@aoc/contracts';
import type { ListQuery } from '@aoc/kernel';
import { ERASED, TERMINAL_LIFECYCLES, type LedgerCore } from './core';
import type { ManifestRow, PhaseRow, TaskRow } from './read-model';
import { evenSampleIndices, maxIso, minIso, oneLine } from './rules';
import {
  aggregateManifest,
  amendmentDTO,
  emptyProgress,
  mergedPhases,
  projectProgress,
  sessionManifest,
  sessionProgress,
  toProgressDTO,
} from './views';

const MAX_TOOL_MARKS = 300;

const PAGE = 5000;

/** Page through the log in seq order (a single list() is capped). */
function eachPage(
  core: LedgerCore,
  q: Omit<ListQuery, 'fromSeq' | 'limit' | 'order'>,
  fn: (page: StoredEvent[]) => void,
): void {
  for (let from = 1; ;) {
    const page = core.store.list({ ...q, fromSeq: from, limit: PAGE });
    fn(page);
    if (page.length < PAGE) return;
    from = page[page.length - 1]!.seq + 1;
  }
}

/** Evenly sampled tool calls in two passes, so memory stays bounded however long the session ran. */
function sampledToolEvents(core: LedgerCore, sessionId: string): StoredEvent[] {
  let n = 0;
  eachPage(core, { sessionId, types: ['tool.used'] }, (page) => (n += page.length));
  const picks = new Set(evenSampleIndices(n, MAX_TOOL_MARKS));
  const out: StoredEvent[] = [];
  let i = 0;
  eachPage(core, { sessionId, types: ['tool.used'] }, (page) => {
    for (const e of page) if (picks.has(i++)) out.push(e);
  });
  return out;
}

const SESSION_MARK_TYPES = [
  'decision.requested',
  'decision.resolved',
  'drift.detected',
  'enhancement.recorded',
  'phase.completed',
  'task.done',
  'throttle.hit',
  'plan.amended',
];

const sumWeight = (ts: TaskRow[]) => ts.reduce((a, t) => a + t.weight, 0);

/**
 * A closed task's activity window runs from the previous close (or its declaration) to its close; a phase
 * band spans the first window of its tasks to the phase's completion. The first unfinished phase in order
 * is in progress since the last close. Phases with no activity yet have no band.
 */
function phaseBands(manifest: ManifestRow | null, phases: PhaseRow[], tasks: TaskRow[]): TimelinePhaseBand[] {
  if (!manifest) return [];
  const closes = tasks
    .filter((t) => t.status === 'done' && t.done_at)
    .sort((a, b) => (a.done_seq ?? 0) - (b.done_seq ?? 0));
  const windowStart = new Map<string, string>();
  let lastClose = manifest.declared_at;
  for (const t of closes) {
    windowStart.set(t.task_id, maxIso(lastClose, t.added_at)!);
    lastClose = t.done_at!;
  }
  const unfinished = (t: TaskRow) => t.status === 'open' || t.status === 'carried';
  const current = phases.find((p) => tasks.some((t) => t.phase_id === p.phase_id && unfinished(t)));
  const bands: TimelinePhaseBand[] = [];
  for (const p of phases) {
    const live = tasks.filter((t) => t.phase_id === p.phase_id && t.status !== 'removed');
    let startAt = minIso(...live.map((t) => windowStart.get(t.task_id)));
    if (!startAt && p === current)
      startAt = maxIso(lastClose, minIso(...live.filter(unfinished).map((t) => t.added_at)));
    if (!startAt) continue;
    bands.push({
      phaseId: p.phase_id,
      name: p.name ?? ERASED,
      startAt,
      endAt: p.completed_at,
      doneWeight: sumWeight(live.filter((t) => t.status === 'done')),
      totalWeight: sumWeight(live),
    });
  }
  return bands;
}

function markOf(core: LedgerCore, e: StoredEvent, phaseNames: Map<string, string>): TimelineMark | null {
  const mark = (
    kind: TimelineMark['kind'],
    label: string,
    refId: string | null,
    severity: TimelineMark['severity'] = null,
  ): TimelineMark => ({
    kind,
    at: e.ts,
    label,
    refId,
    severity,
  });
  switch (e.type) {
    case 'tool.used': {
      const m = e.meta as MetaOf<'tool.used'>;
      return mark('tool', m.toolName, m.toolUseId ?? e.id);
    }
    case 'decision.requested': {
      const m = e.meta as MetaOf<'decision.requested'>;
      const p = core.store.readPayload(e) as PayloadOf<'decision.requested'> | null;
      return mark('decision', oneLine(p?.title, 80) || m.kind, m.decisionId);
    }
    case 'decision.resolved': {
      const m = e.meta as MetaOf<'decision.resolved'>;
      return mark('decision', `Resolved: ${m.optionId}`, m.decisionId);
    }
    case 'drift.detected': {
      const m = e.meta as MetaOf<'drift.detected'>;
      return mark('drift', m.kind, m.taskId ?? e.id, m.severity);
    }
    case 'enhancement.recorded': {
      const p = core.store.readPayload(e) as PayloadOf<'enhancement.recorded'> | null;
      return mark('enhancement', oneLine(p?.title, 80) || 'Enhancement', e.id);
    }
    case 'phase.completed': {
      const m = e.meta as MetaOf<'phase.completed'>;
      return mark('phase_complete', phaseNames.get(m.phaseId) ?? m.phaseId, m.phaseId);
    }
    case 'task.done': {
      const m = e.meta as MetaOf<'task.done'>;
      return mark(
        'task_done',
        m.flag ? `${m.taskId} · ${m.flag}` : m.taskId,
        m.taskId,
        m.flag ? 'medium' : null,
      );
    }
    case 'throttle.hit':
      return mark('throttle', 'Plan limit hit', e.id, 'medium');
    case 'plan.amended': {
      const m = e.meta as MetaOf<'plan.amended'>;
      return mark('amendment', `v${m.manifestVersion}: +${m.added} −${m.removed} ~${m.resized}`, e.id);
    }
    default:
      if (e.type.startsWith('rollback.')) {
        const rollbackId = typeof e.meta.rollbackId === 'string' ? e.meta.rollbackId : null;
        return mark('rollback', e.type.slice('rollback.'.length), rollbackId ?? e.id, 'high');
      }
      return null;
  }
}

export function sessionTimeline(core: LedgerCore, sessionId: string): SessionTimeline | null {
  const info = core.session(sessionId);
  const manifest = core.read.manifest(sessionId);
  const events: StoredEvent[] = [];
  eachPage(core, { sessionId, types: SESSION_MARK_TYPES }, (page) => events.push(...page));
  const tools = sampledToolEvents(core, sessionId);
  if (!info && !manifest && !events.length && !tools.length) return null;
  const now = core.clock.iso();
  const startAt = minIso(info?.startedAt, manifest?.declared_at, events[0]?.ts, tools[0]?.ts) ?? now;
  let endAt: string | null = null;
  if (info && TERMINAL_LIFECYCLES.has(info.lifecycle)) {
    endAt =
      core.store.list({ sessionId, types: ['session.ended'], order: 'desc', limit: 1 })[0]?.ts ??
      maxIso(events.at(-1)?.ts, tools.at(-1)?.ts) ??
      now;
  }

  const phases = core.read.phasesOf(sessionId);
  const phaseNames = new Map(phases.map((p) => [p.phase_id, p.name ?? ERASED]));
  const projectId = info?.projectId ?? manifest?.project_id ?? null;
  const rollbacks = projectId
    ? core.store
        .list({
          projectId,
          typePrefix: 'rollback.',
          fromTs: startAt,
          ...(endAt ? { toTs: endAt } : {}),
          limit: 10_000,
        })
        .filter((e) => !e.scope.sessionId || e.scope.sessionId === sessionId)
    : [];
  const marks = [...tools, ...events, ...rollbacks]
    .sort((a, b) => a.seq - b.seq)
    .map((e) => markOf(core, e, phaseNames))
    .filter((m): m is TimelineMark => m !== null);

  return {
    sessionId,
    startAt,
    endAt,
    now,
    phases: phaseBands(manifest, phases, core.read.tasksOf(sessionId)),
    marks,
    progress: toProgressDTO(sessionProgress(core, sessionId) ?? emptyProgress()),
    manifest: sessionManifest(core, sessionId),
    amendments: core.read.amendmentsOfSession(sessionId).map((a) => amendmentDTO(core, a)),
  };
}

export function projectTimeline(core: LedgerCore, projectId: string): ProjectTimeline | null {
  const project = core.read.project(projectId);
  if (!project) return null;
  const manifests = core.read.manifestsOfProject(projectId);
  const phaseRows = core.read.phasesOfProject(projectId);
  const tasks = core.read.tasksOfProject(projectId);
  // Each task counts once: carried-over copies live in the session that took them over.
  const live = tasks.filter((t) => t.status === 'open' || t.status === 'done');
  const manifest = aggregateManifest(manifests, phaseRows, tasks);
  const completedAt = new Map(manifest.map((p) => [p.phaseId, p.completedAt]));

  return {
    projectId,
    name: project.name ?? ERASED,
    progress: toProgressDTO(projectProgress(core, projectId) ?? emptyProgress()),
    phases: mergedPhases(manifests, phaseRows).map((ph) => {
      const ts = live.filter((t) => t.phase_id === ph.id);
      // Contributors in order of their first task in the phase; the owner is the developer, else the session.
      const owners = new Map<string, TaskRow[]>();
      for (const t of [...ts].sort((a, b) => a.added_seq - b.added_seq)) {
        const owner = t.owner_id ?? t.session_id;
        owners.set(owner, [...(owners.get(owner) ?? []), t]);
      }
      return {
        phaseId: ph.id,
        name: ph.name,
        order: ph.order,
        doneWeight: sumWeight(ts.filter((t) => t.status === 'done')),
        totalWeight: sumWeight(ts),
        completedAt: completedAt.get(ph.id) ?? null,
        segments: [...owners].map(([ownerId, own]) => ({
          ownerId,
          ownerName: core.userName(ownerId),
          doneWeight: sumWeight(own.filter((t) => t.status === 'done')),
          totalWeight: sumWeight(own),
        })),
      };
    }),
    amendments: core.read.amendmentsOfProject(projectId).map((a) => amendmentDTO(core, a)),
    manifest,
  };
}
