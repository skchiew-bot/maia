import type { Actor, HandoffBrief, LedgerService, Progress, ThreadInfo } from '@aoc/contracts';
import { buildHandoffBrief, validateBrief } from './brief';
import type { LedgerCore } from './core';
import { boundaryState } from './mcp-handlers';
import { acquireWriter, ensureThread, releaseWriter, threadInfo } from './projects';
import { projectProgress, sessionProgress } from './views';

/** The `ledger` service other modules (supervisor, sessions, web) depend on. */
export class LedgerServiceImpl implements LedgerService {
  constructor(private readonly core: LedgerCore) {}

  hasManifest(sessionId: string): boolean {
    return this.core.read.hasManifest(sessionId);
  }
  boundaryState(sessionId: string): { atBoundary: boolean; reason: string | null; openTasks: number } {
    return boundaryState(this.core, sessionId);
  }
  sessionProgress(sessionId: string): Progress | null {
    return sessionProgress(this.core, sessionId);
  }
  projectProgress(projectId: string): Progress | null {
    return projectProgress(this.core, projectId);
  }
  getThread(threadId: string): ThreadInfo | null {
    const t = this.core.read.thread(threadId);
    return t ? threadInfo(t) : null;
  }
  ensureThread(
    input: { projectId: string; threadId?: string | null; title?: string },
    actor: Actor,
  ): ThreadInfo {
    return ensureThread(this.core, input, actor);
  }
  acquireWriter(threadId: string, sessionId: string, actor: Actor): boolean {
    return acquireWriter(this.core, threadId, sessionId, actor);
  }
  releaseWriter(
    threadId: string,
    sessionId: string,
    reason: 'ended' | 'rollover' | 'failed' | 'stopped',
    actor: Actor,
  ): void {
    releaseWriter(this.core, threadId, sessionId, reason, actor);
  }
  buildHandoffBrief(threadId: string, fromSessionId: string): HandoffBrief {
    return buildHandoffBrief(this.core, threadId, fromSessionId);
  }
  validateBrief(brief: HandoffBrief): { ok: boolean; problems: string[] } {
    return validateBrief(this.core, brief);
  }
  projectRepoPath(projectId: string): string | null {
    return this.core.read.project(projectId)?.repo_path ?? null;
  }
}
