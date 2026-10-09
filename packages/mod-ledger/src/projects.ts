/** Projects (the unit of work, §1), durable threads, the single-writer lock (§5) and enhancements. */
import {
  newId,
  type Actor,
  type EnhancementDTO,
  type EventSource,
  type MetaOf,
  type SessionLifecycle,
  type ThreadInfo,
} from '@aoc/contracts';
import type { Reactor } from '@aoc/kernel';
import { ERASED, LEDGER_ACTOR, LedgerError, type LedgerCore } from './core';
import type { ProjectRow, ThreadRow } from './read-model';
import { slugify } from './rules';

type ReleaseReason = 'ended' | 'rollover' | 'failed' | 'stopped';

export interface ProjectInput {
  name: string;
  description?: string;
  repoPath?: string;
  defaultBranch?: string;
}

function sourceOf(actor: Actor): EventSource {
  return actor.kind === 'human' ? 'api' : 'system';
}

function uniqueSlug(core: LedgerCore, base: string): string {
  if (!core.read.slugTaken(base)) return base;
  for (let i = 2; ; i++) {
    const s = `${base}-${i}`;
    if (!core.read.slugTaken(s)) return s;
  }
}

export function createProject(
  core: LedgerCore,
  input: ProjectInput & { projectId?: string },
  actor: Actor,
): ProjectRow {
  const projectId = input.projectId ?? newId('project', core.clock.now());
  if (core.read.project(projectId)) throw new LedgerError(409, `Project ${projectId} already exists`);
  const slug = uniqueSlug(core, slugify(input.name));
  core.store.append({
    type: 'project.created',
    actor,
    scope: { projectId },
    meta: { projectId, slug },
    payload: {
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.repoPath !== undefined ? { repoPath: input.repoPath } : {}),
      ...(input.defaultBranch !== undefined ? { defaultBranch: input.defaultBranch } : {}),
    },
    source: sourceOf(actor),
  });
  return core.read.project(projectId)!;
}

export function updateProject(
  core: LedgerCore,
  projectId: string,
  patch: Partial<ProjectInput>,
  actor: Actor,
): ProjectRow {
  if (!core.read.project(projectId)) throw new LedgerError(404, `Unknown project ${projectId}`);
  const payload: Partial<ProjectInput> = {};
  for (const k of ['name', 'description', 'repoPath', 'defaultBranch'] as const)
    if (patch[k] !== undefined) payload[k] = patch[k];
  if (!Object.keys(payload).length) throw new LedgerError(422, 'Nothing to update');
  core.store.append({
    type: 'project.updated',
    actor,
    scope: { projectId },
    meta: { projectId },
    payload,
    source: sourceOf(actor),
  });
  return core.read.project(projectId)!;
}

/** Projects referenced before anyone created them (supervisor launch, a declared plan) are created on first use. */
export function ensureProject(core: LedgerCore, projectId: string, actor: Actor = LEDGER_ACTOR): ProjectRow {
  return core.read.project(projectId) ?? createProject(core, { projectId, name: projectId }, actor);
}

export function createThread(
  core: LedgerCore,
  projectId: string,
  title: string,
  actor: Actor,
  threadId?: string,
): ThreadRow {
  if (!core.read.project(projectId)) throw new LedgerError(404, `Unknown project ${projectId}`);
  const id = threadId ?? newId('thread', core.clock.now());
  if (core.read.thread(id)) throw new LedgerError(409, `Thread ${id} already exists`);
  core.store.append({
    type: 'thread.created',
    actor,
    scope: { projectId, threadId: id },
    meta: { threadId: id, projectId },
    payload: { title },
    source: sourceOf(actor),
  });
  return core.read.thread(id)!;
}

export function threadInfo(t: ThreadRow): ThreadInfo {
  return {
    threadId: t.thread_id,
    projectId: t.project_id,
    title: t.title ?? ERASED,
    activeWriterSessionId: t.writer_session_id,
  };
}

/** Existing thread (must belong to the project), or a new one; without a threadId a new line of work starts. */
export function ensureThread(
  core: LedgerCore,
  input: { projectId: string; threadId?: string | null; title?: string },
  actor: Actor,
): ThreadInfo {
  if (input.threadId) {
    const existing = core.read.thread(input.threadId);
    if (existing) {
      if (existing.project_id !== input.projectId) {
        throw new LedgerError(
          409,
          `Thread ${input.threadId} belongs to project ${existing.project_id}, not ${input.projectId}`,
        );
      }
      return threadInfo(existing);
    }
  }
  ensureProject(core, input.projectId, actor);
  const title = input.title ?? `Thread ${core.read.threadsOf(input.projectId).length + 1}`;
  return threadInfo(createThread(core, input.projectId, title, actor, input.threadId ?? undefined));
}

const RELEASE_REASON_BY_LIFECYCLE: Partial<Record<SessionLifecycle, ReleaseReason>> = {
  ended: 'ended',
  failed: 'failed',
  retired: 'rollover',
};

/**
 * Single active writer per thread (§5). A holder whose session ended, failed or retired (or that the
 * session directory no longer knows) is stale: it is released (audited, stale=true) and the lock moves on.
 */
export function acquireWriter(core: LedgerCore, threadId: string, sessionId: string, actor: Actor): boolean {
  const thread = core.read.thread(threadId);
  if (!thread) throw new LedgerError(404, `Unknown thread ${threadId}`);
  const holder = thread.writer_session_id;
  if (holder === sessionId) return true;
  if (holder) {
    if (core.isLive(holder)) return false;
    const lifecycle = core.session(holder)?.lifecycle;
    const reason = (lifecycle && RELEASE_REASON_BY_LIFECYCLE[lifecycle]) ?? 'ended';
    releaseWriter(core, threadId, holder, reason, actor, { stale: true });
  }
  core.store.append({
    type: 'thread.writer_acquired',
    actor,
    scope: { projectId: thread.project_id, threadId, sessionId },
    meta: { threadId, sessionId },
    source: sourceOf(actor),
  });
  return true;
}

/** Idempotent: only the current holder can release. */
export function releaseWriter(
  core: LedgerCore,
  threadId: string,
  sessionId: string,
  reason: ReleaseReason,
  actor: Actor,
  opts: { stale?: boolean; causationId?: string } = {},
): void {
  const thread = core.read.thread(threadId);
  if (!thread || thread.writer_session_id !== sessionId) return;
  core.store.append({
    type: 'thread.writer_released',
    actor,
    scope: { projectId: thread.project_id, threadId, sessionId },
    meta: { threadId, sessionId, reason, ...(opts.stale ? { stale: true } : {}) },
    source: sourceOf(actor),
    causationId: opts.causationId,
  });
}

const RELEASE_REASON_BY_OUTCOME: Record<MetaOf<'session.ended'>['outcome'], ReleaseReason> = {
  completed: 'ended',
  failed: 'failed',
  killed: 'stopped',
  retired: 'rollover',
  abandoned: 'stopped',
};

/** A session that ends keeps no thread locked (the supervisor normally releases first; this is the backstop). */
export function createWriterReleaseReactor(core: LedgerCore): Reactor {
  return {
    name: 'ledger.release-writers',
    handles: ['session.ended'],
    react(e) {
      const m = e.meta as MetaOf<'session.ended'>;
      for (const t of core.read.threadsHeldBy(m.sessionId)) {
        releaseWriter(core, t.thread_id, m.sessionId, RELEASE_REASON_BY_OUTCOME[m.outcome], LEDGER_ACTOR, {
          causationId: e.id,
        });
      }
    },
  };
}

/** Enhancements beyond the original plan are first-class build activity (§1). */
export function recordEnhancement(
  core: LedgerCore,
  projectId: string,
  input: { title: string; detail?: string; sessionId?: string; changeId?: string },
  actor: Actor,
): EnhancementDTO {
  if (!core.read.project(projectId)) throw new LedgerError(404, `Unknown project ${projectId}`);
  if (input.sessionId) {
    const owner =
      core.session(input.sessionId)?.projectId ?? core.read.manifest(input.sessionId)?.project_id ?? null;
    if (!owner) throw new LedgerError(422, `Unknown session ${input.sessionId}`);
    if (owner !== projectId)
      throw new LedgerError(422, `Session ${input.sessionId} belongs to project ${owner}`);
  }
  const e = core.store.append({
    type: 'enhancement.recorded',
    actor,
    scope: {
      projectId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.changeId ? { changeId: input.changeId } : {}),
    },
    meta: { projectId, sessionId: input.sessionId ?? null, changeId: input.changeId ?? null },
    payload: { title: input.title, ...(input.detail !== undefined ? { detail: input.detail } : {}) },
    source: sourceOf(actor),
  });
  return {
    eventId: e.id,
    projectId,
    sessionId: input.sessionId ?? null,
    changeId: input.changeId ?? null,
    at: e.ts,
    by: actor.id,
    title: input.title,
    detail: input.detail ?? null,
  };
}

/**
 * The sequential sessions of a thread, oldest first: its writer history, or (when the writer lock was never
 * used) the sessions that declared a manifest in it; plus `extra`. Parallel read-only sessions are excluded.
 */
export function threadSessionIds(core: LedgerCore, threadId: string, extra?: string | null): string[] {
  const writers = core.read.writers(threadId).map((w) => w.session_id);
  const base = writers.length ? writers : core.read.manifestsOfThread(threadId).map((m) => m.session_id);
  return [...new Set([...base, ...(extra ? [extra] : [])])];
}
