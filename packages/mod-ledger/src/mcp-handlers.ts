/** Handlers behind /ingest/mcp/* (the agent's structured voice, §2): plan manifests, evidence-backed closes, playbook steps. */
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import {
  TASK_SIZE_WEIGHT,
  type AmendPlanInput,
  type AmendPlanResult,
  type BoundaryInstruction,
  type DeclarePlanInput,
  type DeclarePlanLedgerResult,
  type EvidenceKind,
  type GetStatusResult,
  type LessonInfo,
  type PlaybookStepInput,
  type PlaybookStepResult,
  type SessionInfo,
  type StoredEvent,
  type TaskDoneInput,
  type TaskDoneResult,
} from '@aoc/contracts';
import { LEDGER_ACTOR, LedgerError, agentActor, type LedgerCore } from './core';
import { checkScopeGrowth, recordDrift } from './drift';
import { ensureProject } from './projects';
import type { PlaybookStepRow, TaskRow } from './read-model';
import {
  contextWindowFor,
  duplicates,
  isPlaceholderRef,
  isPlausibleTestId,
  matchPlaybookStep,
  oneLine,
  phaseTagName,
  testFileOf,
} from './rules';
import { sessionManifest, sessionProgress, toProgressDTO } from './views';

const STOP_INSTRUCTION =
  'The operator asked this session to stop at the next task boundary. Do not start another task: end your turn now.';

function requireSession(core: LedgerCore, sessionId: string): SessionInfo {
  const s = core.session(sessionId);
  if (!s) throw new LedgerError(404, `Unknown session ${sessionId}`);
  return s;
}

function scopeOf(session: SessionInfo, projectId: string, extra: { taskId?: string } = {}) {
  return {
    projectId,
    sessionId: session.sessionId,
    ...(session.threadId ? { threadId: session.threadId } : {}),
    ...(session.ownerId ? { userId: session.ownerId } : {}),
    ...extra,
  };
}

/**
 * Task ids already used in this thread by a previous writer session: open ones are carried over to this
 * session (counted once), done ones may not be declared again (the master timeline would double count).
 */
function carryCheck(
  core: LedgerCore,
  session: SessionInfo,
  taskIds: string[],
): { carried: number; doneElsewhere: { taskId: string; sessionId: string }[] } {
  if (!session.threadId) return { carried: 0, doneElsewhere: [] };
  let carried = 0;
  const doneElsewhere: { taskId: string; sessionId: string }[] = [];
  for (const id of taskIds) {
    const copies = core.read.carrySources(session.threadId, session.sessionId, id);
    const done = copies.find((t) => t.status === 'done');
    if (done) doneElsewhere.push({ taskId: id, sessionId: done.session_id });
    else if (copies.some((t) => t.status === 'open')) carried++;
  }
  return { carried, doneElsewhere };
}

function doneElsewhereError(doneElsewhere: { taskId: string; sessionId: string }[]): LedgerError {
  return new LedgerError(
    422,
    `Task ids already completed earlier in this thread cannot be declared again: ${doneElsewhere.map((d) => d.taskId).join(', ')}. Declare follow-up work under new task ids.`,
    { doneElsewhere },
  );
}

// ── declare_plan ────────────────────────────────────────────────────────────
export function declarePlan(
  core: LedgerCore,
  sessionId: string,
  input: DeclarePlanInput,
): DeclarePlanLedgerResult {
  const session = requireSession(core, sessionId);
  const existing = core.read.manifest(sessionId);
  if (existing) {
    throw new LedgerError(
      409,
      `A plan manifest (v${existing.version}) is already declared for this session. Use mcp__aoc__amend_plan to add, remove or resize tasks (amendments are audited).`,
    );
  }
  if (!session.projectId)
    throw new LedgerError(409, 'This session is not attached to a project, so it cannot declare a plan.');
  const projectId = session.projectId;
  const taskIds = input.phases.flatMap((p) => p.tasks.map((t) => t.id));
  const dupPhases = duplicates(input.phases.map((p) => p.id));
  const dupTasks = duplicates(taskIds);
  if (dupPhases.length || dupTasks.length) {
    throw new LedgerError(422, 'Phase ids and task ids must be unique within the plan.', {
      duplicatePhaseIds: dupPhases,
      duplicateTaskIds: dupTasks,
    });
  }
  const carry = carryCheck(core, session, taskIds);
  if (carry.doneElsewhere.length) throw doneElsewhereError(carry.doneElsewhere);

  ensureProject(core, projectId);
  const repo = core.repoFor(sessionId, projectId);
  const totalWeight = input.phases.reduce(
    (a, p) => a + p.tasks.reduce((b, t) => b + TASK_SIZE_WEIGHT[t.size], 0),
    0,
  );
  core.store.append({
    type: 'plan.declared',
    actor: agentActor(sessionId),
    scope: scopeOf(session, projectId),
    meta: {
      sessionId,
      projectId,
      threadId: session.threadId,
      manifestVersion: 1,
      phaseCount: input.phases.length,
      taskCount: taskIds.length,
      totalWeight,
      ownerId: session.ownerId,
      baseHead: repo ? core.git.head(repo) : null,
      treeFingerprint: repo ? core.git.workingTreeFingerprint(repo) : null,
      carriedOver: carry.carried,
    },
    payload: {
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      phases: input.phases.map((p) => ({
        id: p.id,
        name: p.name,
        tasks: p.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          size: t.size,
          ...(t.acceptance !== undefined ? { acceptance: t.acceptance } : {}),
        })),
      })),
    },
    source: 'mcp',
  });
  return {
    ok: true,
    manifestVersion: 1,
    totalTasks: taskIds.length,
    totalWeight,
    carriedOver: carry.carried,
  };
}

// ── amend_plan ──────────────────────────────────────────────────────────────
const liveWeight = (tasks: TaskRow[]) =>
  tasks.filter((t) => t.status !== 'removed').reduce((a, t) => a + t.weight, 0);

export function amendPlan(core: LedgerCore, sessionId: string, input: AmendPlanInput): AmendPlanResult {
  const session = requireSession(core, sessionId);
  const manifest = core.read.manifest(sessionId);
  if (!manifest)
    throw new LedgerError(
      409,
      'No plan manifest is declared for this session yet; call mcp__aoc__declare_plan first.',
    );
  const tasks = core.read.tasksOf(sessionId);
  const byId = new Map(tasks.map((t) => [t.task_id, t]));
  const problems: string[] = [];
  const add = input.add ?? [];
  const remove = input.remove ?? [];
  const touched = new Set<string>();

  for (const id of duplicates([
    ...add.map((t) => t.id),
    ...remove,
    ...(input.resize ?? []).map((r) => r.taskId),
  ])) {
    problems.push(`task ${id} appears more than once in the amendment`);
  }
  for (const t of add) {
    const existing = byId.get(t.id);
    if (existing) problems.push(`task ${t.id} already exists in this manifest (${existing.status})`);
  }
  for (const id of remove) {
    const t = byId.get(id);
    if (!t) problems.push(`cannot remove unknown task ${id}`);
    else if (t.status === 'done') problems.push(`task ${id} is done; completed work cannot be removed`);
    else if (t.status !== 'open') problems.push(`task ${id} is ${t.status} and cannot be removed`);
    else touched.add(t.phase_id);
  }
  const resize = (input.resize ?? []).filter((r) => {
    const t = byId.get(r.taskId);
    if (!t) problems.push(`cannot resize unknown task ${r.taskId}`);
    else if (t.status === 'done') problems.push(`task ${r.taskId} is done; its size is fixed`);
    else if (t.status !== 'open') problems.push(`task ${r.taskId} is ${t.status} and cannot be resized`);
    else return t.size !== r.size;
    return false;
  });
  const carry = carryCheck(
    core,
    session,
    add.map((t) => t.id),
  );
  if (carry.doneElsewhere.length)
    problems.push(
      ...carry.doneElsewhere.map(
        (d) => `task ${d.taskId} was already completed in this thread by ${d.sessionId}`,
      ),
    );
  if (problems.length) throw new LedgerError(422, 'The amendment is invalid.', { problems });
  if (!add.length && !remove.length && !resize.length)
    throw new LedgerError(422, 'The amendment changes nothing (add, remove or resize at least one task).');

  const prevTotalWeight = liveWeight(tasks);
  const newTotalWeight =
    prevTotalWeight +
    add.reduce((a, t) => a + TASK_SIZE_WEIGHT[t.size], 0) -
    remove.reduce((a, id) => a + byId.get(id)!.weight, 0) +
    resize.reduce((a, r) => a + TASK_SIZE_WEIGHT[r.size] - byId.get(r.taskId)!.weight, 0);
  const manifestVersion = manifest.version + 1;
  const e = core.store.append({
    type: 'plan.amended',
    actor: agentActor(sessionId),
    scope: scopeOf(session, manifest.project_id),
    meta: {
      sessionId,
      projectId: manifest.project_id,
      manifestVersion,
      added: add.length,
      removed: remove.length,
      resized: resize.length,
      prevTotalWeight,
      newTotalWeight,
      ownerId: session.ownerId ?? manifest.owner_id,
      carriedOver: carry.carried,
    },
    payload: {
      reason: input.reason,
      ...(add.length
        ? {
            add: add.map((t) => ({
              id: t.id,
              title: t.title,
              size: t.size,
              phaseId: t.phaseId,
              ...(t.acceptance !== undefined ? { acceptance: t.acceptance } : {}),
              ...(t.phaseName !== undefined ? { phaseName: t.phaseName } : {}),
            })),
          }
        : {}),
      ...(remove.length ? { remove } : {}),
      ...(resize.length ? { resize } : {}),
    },
    source: 'mcp',
  });

  // Removing the last open task of a phase completes it (and pins it) just like a close would.
  const phasesCompleted = core.read
    .phasesOf(sessionId)
    .filter((p) => touched.has(p.phase_id))
    .map((p) => completePhaseIfDone(core, sessionId, manifest.project_id, p.phase_id, e))
    .filter((x): x is { phaseId: string; pinnedRef: string | null } => x !== null);
  checkScopeGrowth(core, sessionId, e);
  const live = core.read.tasksOf(sessionId).filter((t) => t.status !== 'removed');
  return {
    ok: true,
    manifestVersion,
    totalTasks: live.length,
    totalWeight: newTotalWeight,
    prevTotalWeight,
    added: add.length,
    removed: remove.length,
    resized: resize.length,
    carriedOver: carry.carried,
    phasesCompleted,
  };
}

// ── task_done ───────────────────────────────────────────────────────────────
function testFileExists(core: LedgerCore, file: string, repo: string | null, cwd: string | null): boolean {
  if (isAbsolute(file)) return existsSync(file);
  const dirs = [cwd, repo].filter((d): d is string => d !== null && existsSync(d));
  // No working copy to check against: plausibility is all that can be verified.
  if (!dirs.length) return true;
  if (dirs.some((d) => existsSync(join(d, file)))) return true;
  if (!repo) return false;
  // Test ids are often relative to a package, not the repo root.
  const r = core.git.run(repo, ['ls-files', '--cached', '--others', '--exclude-standard']);
  return r.code === 0 && r.stdout.split('\n').some((p) => p === file || p.endsWith(`/${file}`));
}

/**
 * Evidence verification (§4, R9): a commit must exist in the session's repo and post-date the plan
 * baseline; a test id must be plausible (and its test file must exist when one is named); a diff ref
 * must be present and, in a repo, the working tree must have changed since the previous close.
 */
function verifyEvidence(
  core: LedgerCore,
  kind: EvidenceKind,
  ref: string,
  ctx: { repo: string | null; cwd: string | null; baseHead: string | null; treeChanged: boolean },
): boolean {
  const git = core.git;
  switch (kind) {
    case 'commit': {
      const sha = ref.trim().toLowerCase();
      if (!ctx.repo || !git.commitExists(ctx.repo, sha)) return false;
      const full = git.revParse(ctx.repo, sha);
      // A commit that already existed when the plan was declared is not evidence for this task.
      return !(full && ctx.baseHead && git.isAncestor(ctx.repo, full, ctx.baseHead));
    }
    case 'test': {
      if (!isPlausibleTestId(ref)) return false;
      const file = testFileOf(ref);
      return file === null || testFileExists(core, file, ctx.repo, ctx.cwd);
    }
    case 'diff':
      return !isPlaceholderRef(ref) && (ctx.repo === null || ctx.treeChanged);
  }
}

/** Pins a just-completed phase: annotated tag aoc/<slug>/<phase>/<seq> at HEAD when there is a repo (§8). */
function completePhaseIfDone(
  core: LedgerCore,
  sessionId: string,
  projectId: string,
  phaseId: string,
  cause: StoredEvent,
): { phaseId: string; pinnedRef: string | null } | null {
  const phase = core.read.phase(sessionId, phaseId);
  if (!phase || phase.completed_at) return null;
  const live = core.read.tasksOf(sessionId).filter((t) => t.phase_id === phaseId && t.status !== 'removed');
  if (!live.length || live.some((t) => t.status !== 'done')) return null;
  const repo = core.repoFor(sessionId, projectId);
  const sha = repo ? core.git.head(repo) : null;
  let tag: string | null = null;
  if (repo && sha) {
    const name = phaseTagName(core.read.project(projectId)?.slug ?? projectId, phaseId, cause.seq);
    try {
      core.git.tag(
        repo,
        name,
        sha,
        `AOC phase ${phaseId} complete (project ${projectId}, session ${sessionId}, event ${cause.id})`,
      );
      tag = name;
    } catch (err) {
      core.ctx.log.warn('phase pin tag failed; pinning the sha only', {
        projectId,
        phaseId,
        err: String(err),
      });
    }
  }
  core.store.append({
    type: 'phase.completed',
    actor: LEDGER_ACTOR,
    scope: { projectId, sessionId },
    meta: { sessionId, projectId, phaseId, pinnedSha: sha, pinnedTag: tag },
    source: 'system',
    causationId: cause.id,
  });
  return { phaseId, pinnedRef: tag ?? sha };
}

/**
 * Clean task boundary (§5, R16): no file changes since the last close, no playbook step in progress and,
 * for risky process types, no phase half-applied.
 */
export function boundaryState(
  core: LedgerCore,
  sessionId: string,
): { atBoundary: boolean; reason: string | null; openTasks: number } {
  const openTasks = core.read.openTaskCount(sessionId);
  if ((core.read.sessionState(sessionId)?.file_changes_since_close ?? 0) > 0)
    return { atBoundary: false, reason: 'task_in_progress', openTasks };
  if (openPlaybookSteps(core.read.playbookSteps(sessionId)).length)
    return { atBoundary: false, reason: 'playbook_step_in_progress', openTasks };
  if (core.processType(core.session(sessionId))?.risky && phaseHalfDone(core.read.tasksOf(sessionId))) {
    return { atBoundary: false, reason: 'risky_mid_operation', openTasks };
  }
  return { atBoundary: true, reason: null, openTasks };
}

/** A failed step is unfinished business too; only done/skipped close a step. */
function openPlaybookSteps(steps: PlaybookStepRow[]): PlaybookStepRow[] {
  return steps.filter((s) => s.state === 'started' || s.state === 'failed');
}

function phaseHalfDone(tasks: TaskRow[]): boolean {
  const phases = new Map<string, TaskRow[]>();
  for (const t of tasks)
    if (t.status !== 'removed') phases.set(t.phase_id, [...(phases.get(t.phase_id) ?? []), t]);
  return [...phases.values()].some(
    (ts) => ts.some((t) => t.status === 'done') && ts.some((t) => t.status !== 'done'),
  );
}

function rolloverDue(core: LedgerCore, session: SessionInfo): { pct: number; threshold: number } | null {
  if (!session.threadId) return null;
  const tokens = core.service('sessions')?.contextTokens(session.sessionId) ?? 0;
  if (tokens <= 0) return null;
  const threshold = core.processType(session)?.rolloverContextPct ?? core.opts.defaultRolloverContextPct;
  const pct = (tokens / contextWindowFor(session.model)) * 100;
  if (pct < threshold) return null;
  const boundary = boundaryState(core, session.sessionId);
  // Nothing left to hand over, or mid-operation (never roll over a risky op half-done, R16).
  if (!boundary.atBoundary || boundary.openTasks === 0) return null;
  return { pct: Math.round(pct * 10) / 10, threshold };
}

/** What the agent must do next; credit cap and rollover are enforced only here, at task boundaries (§5, §10, R7). */
function boundaryInstruction(core: LedgerCore, session: SessionInfo, taskId: string): BoundaryInstruction {
  if (core.service('supervisor')?.stopRequested(session.sessionId))
    return { continue: false, reason: 'stop_requested', instruction: STOP_INSTRUCTION };
  const credits = core.service('credits');
  if (credits) {
    const b = credits.checkBoundary(session.sessionId, taskId, agentActor(session.sessionId));
    if (!b.continue) return b;
  }
  const rollover = rolloverDue(core, session);
  if (rollover) {
    return {
      continue: false,
      reason: 'rollover',
      instruction:
        `Context is at ${rollover.pct}% of the window (rollover threshold ${rollover.threshold}%). This is a clean task boundary: ` +
        'do not start another task; end your turn now. The supervisor continues this thread in a fresh session seeded with a handoff brief.',
    };
  }
  return { continue: true };
}

export function taskDone(core: LedgerCore, sessionId: string, input: TaskDoneInput): TaskDoneResult {
  const session = requireSession(core, sessionId);
  const manifest = core.read.manifest(sessionId);
  if (!manifest)
    throw new LedgerError(
      409,
      'No plan manifest is declared for this session; call mcp__aoc__declare_plan first.',
    );
  const task = core.read.task(sessionId, input.task_id);
  if (!task) throw new LedgerError(422, `Task ${input.task_id} is not declared in this session's manifest.`);
  if (task.status === 'done')
    throw new LedgerError(409, `Task ${input.task_id} is already done (closed at ${task.done_at}).`);
  if (task.status === 'removed')
    throw new LedgerError(409, `Task ${input.task_id} was removed from the manifest by an amendment.`);
  if (task.status === 'carried')
    throw new LedgerError(409, `Task ${input.task_id} was carried over to session ${task.carried_to}.`);

  const projectId = manifest.project_id;
  const repo = core.repoFor(sessionId, projectId);
  const state = core.read.sessionState(sessionId);
  const fileChanges = state?.file_changes_since_close ?? 0;
  const fingerprint = repo ? core.git.workingTreeFingerprint(repo) : null;
  const head = repo ? core.git.head(repo) : null;
  const baseline = state?.last_close_fingerprint ?? manifest.base_fingerprint;
  const treeChanged = fingerprint !== null && baseline !== null && fingerprint !== baseline;
  const { kind, ref, detail } = input.evidence;
  const verified = verifyEvidence(core, kind, ref, {
    repo,
    cwd: session.cwd,
    baseHead: manifest.base_head,
    treeChanged,
  });
  const flag = !verified
    ? 'evidence_unverified'
    : fileChanges === 0 && !treeChanged
      ? 'no_file_change'
      : null;

  const done = core.store.append({
    type: 'task.done',
    actor: agentActor(sessionId),
    scope: scopeOf(session, projectId, { taskId: task.task_id }),
    meta: {
      sessionId,
      projectId,
      taskId: task.task_id,
      phaseId: task.phase_id,
      weight: task.weight,
      evidenceKind: kind,
      evidenceVerified: verified,
      flag,
      fileChangesSinceLast: fileChanges,
      headSha: head,
      treeFingerprint: fingerprint,
      treeChanged,
    },
    payload: { evidence: { kind, ref, ...(detail !== undefined ? { detail } : {}) } },
    source: 'mcp',
  });
  const phaseCompleted = completePhaseIfDone(core, sessionId, projectId, task.phase_id, done);
  const p = sessionProgress(core, sessionId)!;
  return {
    ok: true,
    flagged: flag,
    progress: {
      doneTasks: p.doneTasks,
      totalTasks: p.totalTasks,
      doneWeight: p.doneWeight,
      totalWeight: p.totalWeight,
      pct: p.pct,
    },
    phaseCompleted,
    boundary: boundaryInstruction(core, session, task.task_id),
  };
}

// ── playbook_step ───────────────────────────────────────────────────────────
export function playbookStep(
  core: LedgerCore,
  sessionId: string,
  input: PlaybookStepInput,
): PlaybookStepResult {
  const session = requireSession(core, sessionId);
  const projectId = session.projectId ?? core.read.manifest(sessionId)?.project_id ?? null;
  const playbook = session.processType
    ? (core.service('registry')?.activePlaybook(session.processType) ?? null)
    : null;
  const match = playbook ? matchPlaybookStep(playbook, input.step) : null;
  let deviation: string | null = null;
  if (playbook) {
    if (input.playbook_id && input.playbook_id !== playbook.playbookId) {
      deviation = `Reported playbook ${input.playbook_id}, but the active playbook for ${session.processType} is ${playbook.playbookId}.`;
    } else if (!match) {
      deviation = `Step "${oneLine(input.step, 80)}" is not part of the active playbook ${playbook.playbookId}.`;
    } else if (input.state !== 'skipped') {
      const reached = Math.max(
        -1,
        ...core.read
          .playbookSteps(sessionId)
          .filter((s) => s.playbook_id === playbook.playbookId && s.step_index !== null)
          .map((s) => s.step_index!),
      );
      if (match.index > reached + 1) {
        const expected = playbook.steps[reached + 1]!;
        deviation = `Step ${match.id} (#${match.index + 1}) was reported before step ${expected.id} (#${reached + 2}); follow the playbook order or report skipped steps.`;
      }
    }
  }
  const e = core.store.append({
    type: 'playbook.step_reported',
    actor: agentActor(sessionId),
    scope: { sessionId, ...(projectId ? { projectId } : {}) },
    meta: {
      sessionId,
      playbookId: playbook?.playbookId ?? input.playbook_id ?? null,
      state: input.state,
      projectId,
      stepId: match?.id ?? null,
      stepIndex: match?.index ?? null,
    },
    payload: { step: input.step, ...(input.note !== undefined ? { note: input.note } : {}) },
    source: 'mcp',
  });
  if (deviation && projectId) {
    recordDrift(core, {
      sessionId,
      projectId,
      kind: 'playbook_deviation',
      severity: 'medium',
      detail: deviation,
      causationId: e.id,
    });
  }
  return { ok: true, stepId: match?.id ?? null, deviation };
}

// ── get_status ──────────────────────────────────────────────────────────────
/** Code areas for lesson scoping: directories of the files the sessions changed, relative to the cwd. */
function codeAreasOf(paths: string[], cwd: string | null): string[] {
  const areas = new Set<string>();
  for (const p of paths) {
    const rel = cwd && isAbsolute(p) && p.startsWith(`${cwd}/`) ? relative(cwd, p) : p;
    const d = dirname(rel);
    if (d && d !== '.') areas.add(d);
  }
  return [...areas].sort().slice(0, 50);
}

export function lessonsFor(
  core: LedgerCore,
  session: SessionInfo | null,
  sessionIds: string[],
): LessonInfo[] {
  const learning = core.service('learning');
  if (!learning || !session?.processType) return [];
  const codeAreas = codeAreasOf(
    core.read.files(sessionIds).map((f) => f.path),
    session.cwd,
  );
  return [...learning.lessonsForScope({ processType: session.processType, codeAreas })].sort((a, b) =>
    a.lessonId.localeCompare(b.lessonId),
  );
}

export function playbookStatus(core: LedgerCore, session: SessionInfo): GetStatusResult['playbook'] {
  const pb = session.processType ? core.service('registry')?.activePlaybook(session.processType) : null;
  if (!pb) return null;
  const states = new Map(
    core.read
      .playbookSteps(session.sessionId)
      .filter((s) => s.step_id)
      .map((s) => [s.step_id!, s.state]),
  );
  return {
    playbookId: pb.playbookId,
    title: pb.title,
    steps: pb.steps.map((s) => ({ id: s.id, title: s.title, state: states.get(s.id) ?? null })),
  };
}

export function getStatus(core: LedgerCore, sessionId: string): GetStatusResult {
  const session = requireSession(core, sessionId);
  const manifest = core.read.manifest(sessionId);
  const progress = sessionProgress(core, sessionId);
  const decisions = core.service('decisions')?.list({ sessionId, status: ['open'] }) ?? [];
  return {
    ok: true,
    sessionId,
    projectId: session.projectId ?? manifest?.project_id ?? null,
    threadId: session.threadId,
    manifestVersion: manifest?.version ?? null,
    manifest: sessionManifest(core, sessionId),
    progress: progress ? toProgressDTO(progress) : null,
    boundary: boundaryState(core, sessionId),
    openDecisions: decisions.map((d) => ({
      decisionId: d.id,
      kind: d.kind,
      title: d.title,
      question: d.question,
      createdAt: d.createdAt,
    })),
    lessons: lessonsFor(core, session, [sessionId]),
    playbook: playbookStatus(core, session),
  };
}
