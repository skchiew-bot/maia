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
  type GetStatusResult,
  type GitUnknownReason,
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
import type { ManifestRow, PlaybookStepRow, TaskRow } from './read-model';
import { timedOut, valueOr, type GitRead } from './repo-git';
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

/**
 * A handler that needs git asks it first and appends afterwards: nothing is appended, and no state is read for the
 * decision, across an await. So each such handler checks its request twice, with the same function: before git (to
 * refuse early) and again right before the append, because the session did not stand still while git answered.
 */

// ── declare_plan ────────────────────────────────────────────────────────────
function checkDeclarable(core: LedgerCore, sessionId: string, input: DeclarePlanInput) {
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
  return { session, projectId, taskIds, carry };
}

export async function declarePlan(
  core: LedgerCore,
  sessionId: string,
  input: DeclarePlanInput,
): Promise<DeclarePlanLedgerResult> {
  const first = checkDeclarable(core, sessionId, input);
  const repo = await core.repoFor(sessionId, first.projectId);
  const base = repo ? await core.repoGit.snapshot(repo) : null;

  const { session, projectId, taskIds, carry } = checkDeclarable(core, sessionId, input);
  ensureProject(core, projectId);
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
      baseHead: base ? valueOr(base.head, null) : null,
      treeFingerprint: base ? valueOr(base.fingerprint, null) : null,
      ...(base && timedOut(base.head, base.fingerprint) ? { baselineReason: 'git_timeout' as const } : {}),
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

export async function amendPlan(
  core: LedgerCore,
  sessionId: string,
  input: AmendPlanInput,
): Promise<AmendPlanResult> {
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

  // Removing the last open task of a phase completes it (and pins it) just like a close would. The amendment is
  // recorded above, in one step; only the pins wait for git.
  const phasesCompleted: { phaseId: string; pinnedRef: string | null }[] = [];
  for (const p of core.read.phasesOf(sessionId).filter((p) => touched.has(p.phase_id))) {
    const done = await completePhaseIfDone(core, sessionId, manifest.project_id, p.phase_id, e);
    if (done) phasesCompleted.push(done);
  }
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
/** A check git could not finish is unknown, not refuted: unverified, and the reason says so. */
interface Verdict {
  verified: boolean;
  reason?: GitUnknownReason;
}
const VERIFIED: Verdict = { verified: true };
const UNVERIFIED: Verdict = { verified: false };
const UNKNOWN: Verdict = { verified: false, reason: 'git_timeout' };

async function verifyTestFile(
  core: LedgerCore,
  file: string,
  repo: string | null,
  cwd: string | null,
): Promise<Verdict> {
  if (isAbsolute(file)) return existsSync(file) ? VERIFIED : UNVERIFIED;
  const dirs = [cwd, repo].filter((d): d is string => d !== null && existsSync(d));
  // No working copy to check against: plausibility is all that can be verified.
  if (!dirs.length) return VERIFIED;
  if (dirs.some((d) => existsSync(join(d, file)))) return VERIFIED;
  if (!repo) return UNVERIFIED;
  // Test ids are often relative to a package, not the repo root.
  const listed = await core.repoGit.listFiles(repo);
  if (listed.status === 'timeout') return UNKNOWN;
  return listed.status === 'ok' && listed.value.some((p) => p === file || p.endsWith(`/${file}`))
    ? VERIFIED
    : UNVERIFIED;
}

/** Did the plan's baseline go missing because git timed out when it was declared (not for lack of a repo)? */
function baselineTimedOut(core: LedgerCore, sessionId: string): boolean {
  const declared = core.store.list({ sessionId, types: ['plan.declared'], limit: 1 })[0];
  return declared?.meta.baselineReason === 'git_timeout';
}

/**
 * Evidence that needs only git and the file system (§4, R9): a commit must exist in the session's repo and post-date
 * the plan baseline; a test id must be plausible (and its test file must exist when one is named). A diff ref is
 * judged against the working tree after git has answered, see `verifyDiff`.
 */
async function verifyCommitOrTest(
  core: LedgerCore,
  kind: 'commit' | 'test',
  ref: string,
  ctx: { repo: string | null; cwd: string | null; manifest: ManifestRow },
): Promise<Verdict> {
  if (kind === 'test') {
    if (!isPlausibleTestId(ref)) return UNVERIFIED;
    const file = testFileOf(ref);
    return file === null ? VERIFIED : verifyTestFile(core, file, ctx.repo, ctx.cwd);
  }
  if (!ctx.repo) return UNVERIFIED;
  // Without the baseline "already existed when the plan was declared" cannot be told: unknown, not verified.
  if (ctx.manifest.base_head === null && baselineTimedOut(core, ctx.manifest.session_id)) return UNKNOWN;
  const fresh = await core.repoGit.commitIsNew(ctx.repo, ref, ctx.manifest.base_head);
  if (fresh.status === 'timeout') return UNKNOWN;
  return fresh.status === 'ok' && fresh.value ? VERIFIED : UNVERIFIED;
}

/**
 * A diff ref must be present and, in a working copy git can describe, the tree must have changed since the previous
 * close. Without a working copy (or one git will not describe) plausibility is all that can be verified.
 */
function verifyDiff(
  ref: string,
  ctx: {
    repo: string | null;
    fingerprint: GitRead<string | null> | null;
    treeChanged: boolean;
    baselineMissing: boolean;
  },
): Verdict {
  if (isPlaceholderRef(ref)) return UNVERIFIED;
  if (ctx.repo === null || ctx.fingerprint === null) return VERIFIED;
  if (ctx.fingerprint.status === 'timeout') return UNKNOWN;
  if (ctx.fingerprint.status !== 'ok' || ctx.fingerprint.value === null) return VERIFIED;
  if (!ctx.treeChanged && ctx.baselineMissing) return UNKNOWN;
  return ctx.treeChanged ? VERIFIED : UNVERIFIED;
}

function phaseIsDone(core: LedgerCore, sessionId: string, phaseId: string): boolean {
  const phase = core.read.phase(sessionId, phaseId);
  if (!phase || phase.completed_at) return false;
  const live = core.read.tasksOf(sessionId).filter((t) => t.phase_id === phaseId && t.status !== 'removed');
  return live.length > 0 && live.every((t) => t.status === 'done');
}

/**
 * Pins a just-completed phase: annotated tag aoc/<slug>/<phase>/<seq> at HEAD when there is a repo (§8). The pin is
 * read and tagged first; the phase is completed afterwards if it still is complete and nobody else completed it.
 * A caller that has just read HEAD passes it, so the pin costs one more git call, not two.
 */
async function completePhaseIfDone(
  core: LedgerCore,
  sessionId: string,
  projectId: string,
  phaseId: string,
  cause: StoredEvent,
  knownHead?: GitRead<string | null>,
): Promise<{ phaseId: string; pinnedRef: string | null } | null> {
  if (!phaseIsDone(core, sessionId, phaseId)) return null;
  const repo = await core.repoFor(sessionId, projectId);
  let sha: string | null = null;
  let tag: string | null = null;
  if (repo) {
    const head = knownHead ?? (await core.repoGit.head(repo));
    sha = valueOr(head, null);
    if (head.status !== 'ok')
      core.ctx.log.warn('phase not pinned: HEAD unreadable', { projectId, phaseId, git: head.status });
    if (sha) {
      const name = phaseTagName(core.read.project(projectId)?.slug ?? projectId, phaseId, cause.seq);
      const pinned = await core.repoGit.pin(
        repo,
        name,
        sha,
        `AOC phase ${phaseId} complete (project ${projectId}, session ${sessionId}, event ${cause.id})`,
      );
      if (pinned.status === 'ok') tag = name;
      else
        core.ctx.log.warn('phase pin tag failed; pinning the sha only', {
          projectId,
          phaseId,
          git: pinned.status,
        });
    }
  }
  // Another close or amendment may have completed (or reopened) the phase while git worked.
  if (!phaseIsDone(core, sessionId, phaseId)) return null;
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

/** The manifest and the still-open task a close refers to; anything else gets the error a close of it always got. */
function requireOpenTask(
  core: LedgerCore,
  sessionId: string,
  taskId: string,
): { manifest: ManifestRow; task: TaskRow } {
  const manifest = core.read.manifest(sessionId);
  if (!manifest)
    throw new LedgerError(
      409,
      'No plan manifest is declared for this session; call mcp__aoc__declare_plan first.',
    );
  const task = core.read.task(sessionId, taskId);
  if (!task) throw new LedgerError(422, `Task ${taskId} is not declared in this session's manifest.`);
  if (task.status === 'done')
    throw new LedgerError(409, `Task ${taskId} is already done (closed at ${task.done_at}).`);
  if (task.status === 'removed')
    throw new LedgerError(409, `Task ${taskId} was removed from the manifest by an amendment.`);
  if (task.status === 'carried')
    throw new LedgerError(409, `Task ${taskId} was carried over to session ${task.carried_to}.`);
  return { manifest, task };
}

export async function taskDone(
  core: LedgerCore,
  sessionId: string,
  input: TaskDoneInput,
): Promise<TaskDoneResult> {
  const before = {
    session: requireSession(core, sessionId),
    ...requireOpenTask(core, sessionId, input.task_id),
  };
  const { kind, ref, detail } = input.evidence;

  // Every read of the repository, together and first: no hook or other session waits for it.
  const repo = await core.repoFor(sessionId, before.manifest.project_id);
  const [snap, checked] = await Promise.all([
    repo ? core.repoGit.snapshot(repo) : null,
    kind === 'diff'
      ? null
      : verifyCommitOrTest(core, kind, ref, { repo, cwd: before.session.cwd, manifest: before.manifest }),
  ]);

  // Then the decision and the append in one step, on what is true now: this task may have been closed, removed or
  // carried, and file changes may have been reported, while git answered.
  const session = requireSession(core, sessionId);
  const { manifest, task } = requireOpenTask(core, sessionId, input.task_id);
  const projectId = manifest.project_id;
  const state = core.read.sessionState(sessionId);
  const fileChanges = state?.file_changes_since_close ?? 0;
  const fingerprint = snap ? valueOr(snap.fingerprint, null) : null;
  const baseline = state?.last_close_fingerprint ?? manifest.base_fingerprint;
  const treeChanged = fingerprint !== null && baseline !== null && fingerprint !== baseline;
  const verdict =
    checked ??
    verifyDiff(ref, {
      repo,
      fingerprint: snap?.fingerprint ?? null,
      treeChanged,
      baselineMissing: baseline === null && baselineTimedOut(core, sessionId),
    });
  const verified = verdict.verified;
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
      ...(verdict.reason ? { evidenceReason: verdict.reason } : {}),
      flag,
      fileChangesSinceLast: fileChanges,
      headSha: snap ? valueOr(snap.head, null) : null,
      treeFingerprint: fingerprint,
      treeChanged,
    },
    payload: { evidence: { kind, ref, ...(detail !== undefined ? { detail } : {}) } },
    source: 'mcp',
  });
  const phaseCompleted = await completePhaseIfDone(
    core,
    sessionId,
    projectId,
    task.phase_id,
    done,
    snap?.head,
  );
  const p = sessionProgress(core, sessionId)!;
  return {
    ok: true,
    flagged: flag,
    ...(verdict.reason ? { evidenceReason: verdict.reason } : {}),
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
