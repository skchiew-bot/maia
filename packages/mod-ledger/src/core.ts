import type { Actor, GitService, ProcessType, SessionInfo, SessionLifecycle, TaskSize } from '@aoc/contracts';
import type { Clock, EventStore, ModuleContext } from '@aoc/kernel';
import { LedgerReadModel } from './read-model';
import {
  DEFAULT_DRIFT_DEDUP_MS,
  DEFAULT_OVERRUN_BUDGET_MIN,
  DEFAULT_ROLLOVER_CONTEXT_PCT,
  DEFAULT_SCOPE_GROWTH_THRESHOLD,
} from './rules';

/** Options for the ledger module (all optional). */
export interface LedgerModuleOptions {
  /** Drift of the same kind for the same session is recorded at most once per window (default 30 min). */
  driftDedupMs?: number;
  /** Net amendment growth over the declared baseline weight that is scope growth (default 0.3 = 30%). */
  scopeGrowthThreshold?: number;
  /** Overrun budgets per declared size, minutes of session time (default xs 15, s 30, m 60, l 120, xl 240). */
  overrunBudgetMinutes?: Partial<Record<TaskSize, number>>;
  /** Interval of the overrun scan job (default 60 s). */
  overrunScanEveryMs?: number;
  /** Rollover threshold when the registry has no process type (default 70%). */
  defaultRolloverContextPct?: number;
}

export interface ResolvedLedgerOptions {
  driftDedupMs: number;
  scopeGrowthThreshold: number;
  overrunBudgetMinutes: Record<TaskSize, number>;
  overrunScanEveryMs: number;
  defaultRolloverContextPct: number;
}

export function resolveOptions(o: LedgerModuleOptions): ResolvedLedgerOptions {
  return {
    driftDedupMs: o.driftDedupMs ?? DEFAULT_DRIFT_DEDUP_MS,
    scopeGrowthThreshold: o.scopeGrowthThreshold ?? DEFAULT_SCOPE_GROWTH_THRESHOLD,
    overrunBudgetMinutes: { ...DEFAULT_OVERRUN_BUDGET_MIN, ...o.overrunBudgetMinutes },
    overrunScanEveryMs: o.overrunScanEveryMs ?? 60_000,
    defaultRolloverContextPct: o.defaultRolloverContextPct ?? DEFAULT_ROLLOVER_CONTEXT_PCT,
  };
}

export const TERMINAL_LIFECYCLES: ReadonlySet<SessionLifecycle> = new Set<SessionLifecycle>([
  'ended',
  'failed',
  'retired',
]);
export const LEDGER_ACTOR: Actor = { kind: 'system', id: 'ledger' };
export const agentActor = (sessionId: string): Actor => ({ kind: 'agent', id: sessionId });
export const ERASED = '[erased]';

/** Domain error carrying an HTTP status; MCP routes render it as McpErrorResult, API routes as the standard envelope. */
export class LedgerError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Shared state of the module: the context (set at init), the read model and optional collaborator services. */
export class LedgerCore {
  private context: ModuleContext | null = null;
  private model: LedgerReadModel | null = null;

  constructor(readonly opts: ResolvedLedgerOptions) {}

  attach(ctx: ModuleContext): void {
    this.context = ctx;
    this.model = new LedgerReadModel(ctx.db);
  }

  get ctx(): ModuleContext {
    if (!this.context) throw new Error('ledger module is not initialised');
    return this.context;
  }
  get read(): LedgerReadModel {
    if (!this.model) throw new Error('ledger module is not initialised');
    return this.model;
  }
  get store(): EventStore {
    return this.ctx.store;
  }
  get clock(): Clock {
    return this.ctx.clock;
  }
  get git(): GitService {
    return this.ctx.services.get('git');
  }
  service<
    K extends 'sessions' | 'registry' | 'decisions' | 'learning' | 'credits' | 'supervisor' | 'identity',
  >(name: K) {
    return this.ctx.services.maybe(name);
  }

  session(sessionId: string): SessionInfo | null {
    return this.service('sessions')?.get(sessionId) ?? null;
  }

  processType(session: Pick<SessionInfo, 'processType'> | null): ProcessType | null {
    if (!session?.processType) return null;
    return this.service('registry')?.getType(session.processType) ?? null;
  }

  /** Registry decides; without a registry (or an unknown type) a plan is required (§4). */
  requiresPlan(session: SessionInfo): boolean {
    return this.processType(session)?.requiresPlan ?? true;
  }

  /** Is the session still able to hold a writer lock / accumulate session time? Unknown sessions are not. */
  isLive(sessionId: string): boolean {
    const sessions = this.service('sessions');
    if (!sessions) return true;
    const s = sessions.get(sessionId);
    return s !== null && !TERMINAL_LIFECYCLES.has(s.lifecycle);
  }

  /** The git working copy for a session: its cwd if that is a repo, else the project's repo. */
  repoFor(sessionId: string, projectId: string | null): string | null {
    const git = this.git;
    const cwd = this.session(sessionId)?.cwd ?? null;
    if (cwd && git.isRepo(cwd)) return cwd;
    const repoPath = projectId ? (this.read.project(projectId)?.repo_path ?? null) : null;
    return repoPath && git.isRepo(repoPath) ? repoPath : null;
  }

  userName(userId: string | null): string | null {
    if (!userId) return null;
    return this.service('identity')?.getUser(userId)?.name ?? null;
  }
}
