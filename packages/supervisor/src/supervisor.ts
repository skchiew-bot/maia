/**
 * The launcher/supervisor (§2, §3, §5): runs managed `claude -p` turns, decides what happens when a turn ends,
 * resumes sessions with injected text (decision answers, top-ups, throttle resets, operator prompts) and rolls a
 * thread over to a fresh session at a clean boundary. Waiting never keeps a process alive (§2.3).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  AOC_ENV,
  AOC_MCP_SERVER_NAME,
  MODEL_CONTEXT_TOKENS,
  MODEL_ID_BY_TIER,
  claudeConfigDir,
  modelTierOf,
  newId,
  transcriptPathFor,
  type Actor,
  type DecisionCard,
  type EventType,
  type HandoffBrief,
  type LaunchRequest,
  type LessonInfo,
  type MetaOf,
  type ProcessType,
  type Scope,
  type SessionLifecycle,
  type SessionOutputItem,
  type StoredEvent,
  type SupervisorService,
} from '@aoc/contracts';
import { HttpError, type Logger, type ModuleContext, type NewEvent } from '@aoc/kernel';
import {
  MAX_ARG_BYTES,
  buildClaudeArgs,
  buildHookSettings,
  buildMcpConfig,
  buildSessionEnv,
  readCredentialProfile,
  redactArgv,
  toolPolicy,
} from './launch-config';
import { processMatches, runCommand, signalProcess, signalTree } from './process-utils';
import { SupervisorView, TERMINAL_LIFECYCLES, type SupervisedSession } from './projection';
import {
  CONTINUE_TEXT,
  DECISION_FOLLOWUP_TEXT,
  MAX_LESSONS,
  RESTART_TEXT,
  THROTTLE_RESET_TEXT,
  TOPUP_TEXT,
  buildSystemPrompt,
  decisionAnswersText,
  nudgeText,
  rolloverPrompt,
} from './prompts';
import { RegistryAccess } from './registry-access';
import { RingBuffer } from './ring-buffer';
import { clip, readStreamLine, type OutputDraft, type StreamFacts } from './stream';
import {
  isLegacyLimitResult,
  isLimitNotice,
  parseResetAt,
  strongestSignal,
  type ThrottleSignal,
} from './throttle';

export interface SupervisorModuleOptions {
  /** Per-session directories (default `<dataDir>/sessions`; a temp dir when the store is in memory). */
  sessionsDir?: string;
  /** Registry file used when mod-registry is not loaded (default `config.registryFile`). */
  registryFile?: string;
  /** SIGINT → SIGKILL grace when a turn is interrupted (default 10 s). */
  interruptGraceMs?: number;
  /** Retry delay for a usage limit whose reset time is unknown (default 30 min). */
  throttleFallbackMs?: number;
  /** Output items kept per session for GET /api/sessions/:id/output (default 500). */
  outputBufferSize?: number;
  /** The aocd environment the allowlist reads from (default `process.env`). */
  env?: Record<string, string | undefined>;
}

const zIdent = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/, 'ids are 1-64 letters, digits, . _ : -');
export const LaunchRequestSchema = z.object({
  processType: z.string().min(1).max(64),
  projectId: zIdent,
  threadId: zIdent.nullish(),
  phaseId: zIdent.nullish(),
  prompt: z.string().trim().min(1).max(100_000),
  cwd: z.string().min(1).max(4096).nullish(),
  ticketId: zIdent.nullish(),
  changeId: zIdent.nullish(),
  parentSessionId: zIdent.nullish(),
  brief: z.string().max(200_000).nullish(),
});
/** The HTTP launch body: briefs and lineage only come from the supervisor's own rollover. */
export const LaunchBodySchema = LaunchRequestSchema.omit({ brief: true, parentSessionId: true }).strict();

type TurnReason = MetaOf<'session.turn_started'>['reason'];
type TurnOutcome = MetaOf<'session.turn_ended'>['outcome'];
type EndOutcome = MetaOf<'session.ended'>['outcome'];
type ResumeReason = Parameters<SupervisorService['resume']>[2];
type RolloverResult = { newSessionId: string; started: Promise<void> } | { refused: string[] };
type ContextInfo = { contextTokens: number; contextPct: number };

const SYSTEM: Actor = { kind: 'system', id: 'supervisor' };
const CLOSE_GRACE_MS = 2_000;
const SIDECAR_GRACE_MS = 5_000;
const MAX_BUFFERED_SESSIONS = 256;
/** Turn outcomes that prove the model answered, so the conversation exists even when its transcript is not found. */
const ANSWERED_OUTCOMES = new Set(['end_turn', 'decision', 'credit_cap', 'stop_requested', 'rollover']);
/** Decision kinds that only make sense for the session that raised them (withdrawn when it is stopped). */
const SESSION_DECISION_KINDS = new Set(['agent_decision', 'protected_operation']);

const RESUMABLE_FROM: Record<ResumeReason, readonly SessionLifecycle[]> = {
  decision_answered: ['waiting_decision', 'idle'],
  topup: ['blocked'],
  throttle_reset: ['throttled'],
  operator_prompt: ['idle'],
  continue: ['idle'],
};

interface TurnRequest {
  sessionId: string;
  reason: TurnReason;
  /** Prompt of the turn; decision answers not yet delivered are prepended when it starts. */
  text: string;
  actor: Actor;
  causationId?: string;
  /** Follow-ups of a session that already held a slot jump the launch queue. */
  priority?: boolean;
}

type Interrupt =
  | { kind: 'nudge'; text: string; actor: Actor }
  | { kind: 'restart'; actor: Actor }
  | { kind: 'stop'; actor: Actor }
  | { kind: 'abort'; reason: string };

interface LiveTurn {
  req: TurnRequest;
  sessionId: string;
  turn: number;
  child: ChildProcess | null;
  pid: number | null;
  started: boolean;
  startedAt: number;
  startSeq: number;
  stdoutRest: string;
  stderrRest: string;
  result: StreamFacts['result'];
  signals: ThrottleSignal[];
  contextTokens: number;
  interrupt: Interrupt | null;
  killTimer: NodeJS.Timeout | null;
  sidecar: ChildProcess | null;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  settled: boolean;
  closed: Promise<void>;
  markClosed: () => void;
}

interface SpawnPlan {
  cwd: string;
  env: Record<string, string>;
  args: string[];
  prompt: string;
  claudeSessionId: string;
  transcriptPath: string;
  token: string;
  dir: string;
}

export class Supervisor implements SupervisorService {
  private readonly view: SupervisorView;
  private readonly registry: RegistryAccess;
  private readonly log: Logger;
  private readonly running = new Map<string, LiveTurn>();
  private readonly queue: TurnRequest[] = [];
  private readonly outputs = new Map<string, RingBuffer<SessionOutputItem>>();
  private readonly tokens = new Map<string, string>();
  private readonly claudeIds = new Map<string, string>();
  private readonly conversations = new Set<string>();
  private readonly lastContext = new Map<string, number>();
  /** Sessions being rolled over right now: no turns for them, and they no longer count as their thread's writer. */
  private readonly rollingOver = new Set<string>();
  private readonly sidecars = new Set<ChildProcess>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly warned = new Set<string>();
  private readonly sessionsRoot: string;
  private readonly ownsSessionsRoot: boolean;
  private stopping = false;

  constructor(
    private readonly ctx: ModuleContext,
    private readonly opts: SupervisorModuleOptions = {},
  ) {
    this.view = new SupervisorView(ctx.db);
    this.registry = new RegistryAccess(ctx, opts.registryFile ?? ctx.config.registryFile);
    this.log = ctx.log.child({ module: 'supervisor' });
    this.ownsSessionsRoot = !opts.sessionsDir && ctx.dataDir === ':memory:';
    this.sessionsRoot = opts.sessionsDir
      ? resolve(opts.sessionsDir)
      : this.ownsSessionsRoot
        ? mkdtempSync(join(tmpdir(), 'aoc-sessions-'))
        : resolve(ctx.dataDir, 'sessions');
  }

  // ── SupervisorService ─────────────────────────────────────────────────────

  async launch(req: LaunchRequest, actor: Actor): Promise<{ sessionId: string }> {
    const { sessionId, started } = this.launchNow(req, actor, {});
    await started;
    return { sessionId };
  }

  async resume(sessionId: string, injectedText: string, reason: ResumeReason, actor: Actor): Promise<void> {
    checkText(injectedText);
    const s = this.mustGet(sessionId);
    if (!RESUMABLE_FROM[reason].includes(s.lifecycle)) {
      throw new HttpError(
        409,
        'not_resumable',
        `A ${reason} turn cannot start while the session is ${s.lifecycle}`,
      );
    }
    if (s.lifecycle === 'blocked' && s.lifecycleReason === 'credit_cap') this.recheckCredits(s, actor);
    await this.requestTurn({ sessionId, reason, text: injectedText, actor });
  }

  async nudge(sessionId: string, text: string, actor: Actor): Promise<void> {
    checkText(text);
    const s = this.mustGet(sessionId);
    assertNotEnded(s);
    const live = this.running.get(sessionId);
    if (live) {
      assertNotStopping(live);
      this.appendNudged(s, text, actor);
      live.interrupt = { kind: 'nudge', text, actor };
      this.signalInterrupt(live);
      return;
    }
    if (s.lifecycle !== 'idle')
      throw new HttpError(409, 'not_nudgeable', `Nothing to nudge: the session is ${s.lifecycle}`);
    const started = this.requestTurn({ sessionId, reason: 'nudge', text: nudgeText(text), actor });
    this.appendNudged(s, text, actor);
    await started;
  }

  async restart(sessionId: string, actor: Actor): Promise<void> {
    const s = this.mustGet(sessionId);
    assertNotEnded(s);
    const live = this.running.get(sessionId);
    if (live) {
      assertNotStopping(live);
      this.appendRestarted(s, actor);
      live.interrupt = { kind: 'restart', actor };
      this.signalInterrupt(live);
      return;
    }
    if (!['failed', 'idle', 'running'].includes(s.lifecycle)) {
      throw new HttpError(
        409,
        'not_restartable',
        `Restart is for dead, stalled or idle sessions (this one is ${s.lifecycle})`,
      );
    }
    const started = this.requestTurn({ sessionId, reason: 'restart', text: RESTART_TEXT, actor });
    this.appendRestarted(s, actor);
    await started;
  }

  async stop(sessionId: string, immediate: boolean, actor: Actor, reason?: string): Promise<void> {
    const s = this.mustGet(sessionId);
    if (TERMINAL_LIFECYCLES.includes(s.lifecycle)) return;
    this.ctx.store.append(
      ev({
        type: 'session.stop_requested',
        actor,
        scope: scopeOf(s),
        meta: { sessionId, immediate },
        payload: reason ? { reason } : {},
        source: 'supervisor',
      }),
    );
    const live = this.running.get(sessionId);
    if (live) {
      // Without `immediate`, task_done answers stop_requested and the turn ends at the next task boundary.
      if (immediate) {
        live.interrupt = { kind: 'stop', actor };
        this.signalInterrupt(live);
      }
      return;
    }
    this.removeQueued(sessionId);
    this.endSession(sessionId, 'abandoned', 'stopped', actor);
  }

  async rollover(threadId: string, actor: Actor): Promise<{ newSessionId: string } | { refused: string[] }> {
    const s = this.writerOf(threadId);
    if (!s) return { refused: ['no_active_writer_session'] };
    const tokens =
      this.lastContext.get(s.sessionId) ??
      this.ctx.services.maybe('sessions')?.contextTokens(s.sessionId) ??
      0;
    const r = this.rolloverNow(
      s,
      actor,
      { contextTokens: tokens, contextPct: contextPct(tokens, s.model) },
      'manual',
    );
    if ('refused' in r) return r;
    await r.started.catch((err) =>
      this.log.warn('rollover successor did not start', { sessionId: r.newSessionId, err: String(err) }),
    );
    return { newSessionId: r.newSessionId };
  }

  isRunning(sessionId: string): boolean {
    const live = this.running.get(sessionId);
    return !!live && live.started && !live.exit;
  }

  stopRequested(sessionId: string): boolean {
    const s = this.view.get(sessionId);
    return !!s && s.stopRequested && !TERMINAL_LIFECYCLES.includes(s.lifecycle);
  }

  /** Supervisor-controlled environment (rollback verification, promotion). No route or agent path reaches it. */
  async runIsolated(input: {
    cwd: string;
    command: string[];
    credentialProfile: string | null;
    timeoutMs: number;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const sup = this.ctx.config.supervisor;
    let credentials: Record<string, string> | null = null;
    if (input.credentialProfile) {
      if (!sup.credentialProfilesFile) {
        throw new Error(
          `credential profile "${input.credentialProfile}" requested but supervisor.credentialProfilesFile is not configured`,
        );
      }
      credentials = readCredentialProfile(resolve(sup.credentialProfilesFile), input.credentialProfile);
    }
    const env = buildSessionEnv({
      source: this.sourceEnv(),
      allowlist: sup.envAllowlist,
      credentials,
      readOnly: false,
      aoc: {},
      timezone: this.ctx.config.timezone,
    });
    return runCommand({ cwd: input.cwd, command: input.command, env, timeoutMs: input.timeoutMs });
  }

  // ── read side (routes) ────────────────────────────────────────────────────

  session(sessionId: string): SupervisedSession | null {
    return this.view.get(sessionId);
  }

  /** The thread's current writer session: the ledger's record first, then the supervisor's own. */
  writerOf(threadId: string): SupervisedSession | null {
    const id = this.ledger()?.getThread(threadId)?.activeWriterSessionId;
    return (id ? this.view.get(id) : null) ?? this.view.writerOf(threadId);
  }

  /** Recent output of a managed session (oldest first); null for sessions the supervisor does not manage. */
  output(sessionId: string): SessionOutputItem[] | null {
    const buf = this.outputs.get(sessionId);
    if (buf) return buf.toArray();
    return this.view.get(sessionId) ? [] : null;
  }

  // ── reactors, job, startup, shutdown ──────────────────────────────────────

  /** decision.resolved / decision.withdrawn → resume a session waiting on it once nothing is open any more. */
  async onDecisionSettled(e: StoredEvent): Promise<void> {
    await afterCaller();
    const card = this.ctx.services.maybe('decisions')?.get(String(e.meta.decisionId)) ?? null;
    const sessionId = card?.sessionId ?? e.scope.sessionId ?? null;
    const s = sessionId ? this.view.get(sessionId) : null;
    if (!s || s.lifecycle !== 'waiting_decision' || this.busy(s.sessionId)) return;
    if (this.openDecisions(s.sessionId).length) return;
    if (this.ctx.store.findByCausation(e.id, 'session.turn_started').length) return;
    await this.startTurnSafely({
      sessionId: s.sessionId,
      reason: 'decision_answered',
      text: DECISION_FOLLOWUP_TEXT,
      actor: SYSTEM,
      causationId: e.id,
    });
  }

  /** credit.topup_granted → resume that user's sessions blocked on the credit cap. */
  async onTopupGranted(e: StoredEvent): Promise<void> {
    await afterCaller();
    const userId = String(e.meta.userId);
    const resumed = new Set(
      this.ctx.store.findByCausation(e.id, 'session.turn_started').map((t) => String(t.meta.sessionId)),
    );
    for (const s of this.view.byLifecycle(['blocked'])) {
      if (
        s.ownerId !== userId ||
        s.lifecycleReason !== 'credit_cap' ||
        resumed.has(s.sessionId) ||
        this.busy(s.sessionId)
      )
        continue;
      try {
        this.recheckCredits(s, SYSTEM);
      } catch (err) {
        this.log.warn('top-up did not lift the credit cap', { sessionId: s.sessionId, err: String(err) });
        continue;
      }
      await this.startTurnSafely({
        sessionId: s.sessionId,
        reason: 'topup',
        text: TOPUP_TEXT,
        actor: SYSTEM,
        causationId: e.id,
      });
    }
  }

  /** Every 30 s: resume throttled sessions whose plan limit has reset, recording the idle time (§10). */
  async throttleTick(): Promise<void> {
    const now = this.ctx.clock.now();
    for (const s of this.view.byLifecycle(['throttled'])) {
      if (this.busy(s.sessionId)) continue;
      if (s.throttledAt) {
        const fallback = this.opts.throttleFallbackMs ?? 30 * 60_000;
        const due = s.throttleResetAt ? Date.parse(s.throttleResetAt) : Date.parse(s.throttledAt) + fallback;
        if (now < due) continue;
        this.ctx.store.append(
          ev({
            type: 'throttle.cleared',
            actor: SYSTEM,
            scope: scopeOf(s),
            meta: { sessionId: s.sessionId, idleMs: Math.max(0, now - Date.parse(s.throttledAt)) },
            source: 'supervisor',
          }),
        );
      }
      await this.startTurnSafely({
        sessionId: s.sessionId,
        reason: 'throttle_reset',
        text: THROTTLE_RESET_TEXT,
        actor: SYSTEM,
      });
    }
  }

  /**
   * Startup recovery: a session recorded as running whose process is gone is Dead (restartable); an orphan that
   * outlived the previous daemon cannot be supervised, so it is interrupted and also marked Dead. Queued launches
   * start again; waiting, throttled and blocked sessions stay as they are (resumable after a reboot, §2.3).
   */
  async recover(): Promise<void> {
    const now = this.ctx.clock.now();
    for (const s of this.view.byLifecycle(['launching', 'running'])) {
      if (s.lifecycle === 'launching' && s.turn === 0) {
        const prompt = this.launchPrompt(s.sessionId);
        if (prompt === null) {
          this.failSession(s.sessionId, 'launch_prompt_unavailable', SYSTEM);
          continue;
        }
        const successor =
          s.parentSessionId !== null && this.view.get(s.parentSessionId)?.successorSessionId === s.sessionId;
        await this.startTurnSafely({
          sessionId: s.sessionId,
          reason: successor ? 'rollover' : 'launch',
          text: prompt,
          actor: SYSTEM,
        });
        continue;
      }
      const orphan = s.pid !== null && s.claudeSessionId !== null && processMatches(s.pid, s.claudeSessionId);
      if (orphan) this.interruptOrphan(s.pid!, s.claudeSessionId!);
      if (s.turn > s.lastEndedTurn) {
        this.ctx.store.append(
          ev({
            type: 'session.turn_ended',
            actor: SYSTEM,
            scope: scopeOf(s),
            meta: {
              sessionId: s.sessionId,
              turn: s.turn,
              outcome: 'crashed',
              exitCode: null,
              durationMs: s.turnStartedAt ? Math.max(0, now - Date.parse(s.turnStartedAt)) : 0,
            },
            payload: {},
            source: 'supervisor',
          }),
        );
      }
      this.failSession(s.sessionId, orphan ? 'orphaned_on_restart' : 'process_gone_on_restart', SYSTEM);
    }
    // A decision answered just before a crash: deliver it now instead of waiting forever.
    if (!this.ctx.services.maybe('decisions')) return;
    for (const s of this.view.byLifecycle(['waiting_decision'])) {
      if (this.openDecisions(s.sessionId).length || !this.pendingAnswers(s).length) continue;
      await this.startTurnSafely({
        sessionId: s.sessionId,
        reason: 'decision_answered',
        text: DECISION_FOLLOWUP_TEXT,
        actor: SYSTEM,
      });
    }
  }

  /** Daemon shutdown: interrupt running turns; the next start marks them Dead. Nothing is appended. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.queue.length = 0;
    for (const t of this.timers) clearTimeout(t);
    const lives = [...this.running.values()].filter((l) => l.started && !l.exit);
    for (const l of lives) signalProcess(l.pid!, 'SIGINT');
    await settleWithin(lives, 2_000);
    for (const l of lives) if (!l.exit) signalTree(l.pid!, 'SIGKILL');
    await settleWithin(lives, 1_000);
    for (const sc of this.sidecars) sc.kill('SIGTERM');
    if (this.ownsSessionsRoot) rmSync(this.sessionsRoot, { recursive: true, force: true });
  }

  // ── launch ────────────────────────────────────────────────────────────────

  /** Synchronous up to the spawn (so a rollover can never interleave two writers); `started` settles after it. */
  private launchNow(
    req: LaunchRequest,
    actor: Actor,
    o: { reason?: TurnReason; causationId?: string; priority?: boolean },
  ): { sessionId: string; started: Promise<void> } {
    const parsed = LaunchRequestSchema.safeParse(req);
    if (!parsed.success) {
      const details = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      throw new HttpError(422, 'invalid', 'Invalid launch request', details);
    }
    const r = parsed.data;
    checkText(r.prompt);
    this.assertConfigured();
    if (!this.ctx.services.maybe('identity')) {
      throw new HttpError(
        503,
        'identity_unavailable',
        'Managed sessions need the identity service (per-session ingest tokens)',
      );
    }
    const type = this.registry.getType(r.processType);
    if (!type)
      throw new HttpError(
        422,
        'unknown_process_type',
        `Unknown process type "${r.processType}": types come from the fixed registry`,
      );
    const model = MODEL_ID_BY_TIER[this.registry.modelFor(type)];
    if (!type.readOnly && type.credentialProfile) this.credentialsFor(type.credentialProfile);
    const ledger = this.ledger();
    const thread = ledger
      ? ledger.ensureThread(
          { projectId: r.projectId, threadId: r.threadId ?? null, title: firstLine(r.prompt) },
          actor,
        )
      : { threadId: r.threadId ?? newId('thread', this.ctx.clock.now()), projectId: r.projectId };
    if (thread.projectId !== r.projectId)
      throw new HttpError(
        422,
        'thread_project_mismatch',
        `Thread ${thread.threadId} belongs to another project`,
      );
    const cwd = this.resolveCwd(r.cwd ?? null, r.projectId);
    const sessionId = newId('session', this.ctx.clock.now());
    if (!type.readOnly) {
      const w = this.acquireWriter(thread.threadId, sessionId, actor);
      if (!w.ok) throw writerLocked(thread.threadId, w.holder);
    }
    const scope: Scope = {
      sessionId,
      projectId: r.projectId,
      threadId: thread.threadId,
      ...(r.ticketId ? { ticketId: r.ticketId } : {}),
    };
    // Recorded, not inferred by readers: the launching human, or a rollover successor's predecessor's owner.
    const ownerId = r.parentSessionId
      ? (this.view.get(r.parentSessionId)?.ownerId ?? null)
      : actor.kind === 'human'
        ? actor.id
        : null;
    try {
      this.ctx.store.appendMany([
        ev({
          type: 'session.launch_requested',
          actor,
          scope,
          meta: {
            sessionId,
            projectId: r.projectId,
            threadId: thread.threadId,
            processType: type.id,
            model,
            readOnly: type.readOnly,
            credentialProfile: type.readOnly ? null : type.credentialProfile,
            ticketId: r.ticketId ?? null,
            parentSessionId: r.parentSessionId ?? null,
            phaseId: r.phaseId ?? null,
            ownerId,
            changeId: r.changeId ?? null,
          },
          payload: { prompt: r.prompt, cwd },
          source: 'supervisor',
          causationId: o.causationId,
        }),
        ev({
          type: 'session.lifecycle_changed',
          actor,
          scope,
          meta: { sessionId, from: null, to: 'launching', reason: 'launch_requested' },
          source: 'supervisor',
        }),
      ]);
    } catch (err) {
      if (!type.readOnly) ledger?.releaseWriter(thread.threadId, sessionId, 'failed', actor);
      throw err;
    }
    try {
      const s = this.mustGet(sessionId);
      this.claudeIds.set(sessionId, randomUUID());
      this.tokenFor(sessionId, actor);
      this.writeSystemPrompt(s, type, r.brief ?? null, actor);
      const boundary = this.ctx.services.maybe('credits')?.checkBoundary(sessionId, null, actor);
      if (boundary && !boundary.continue && boundary.reason === 'credit_cap') {
        this.setLifecycle(sessionId, 'blocked', 'credit_cap', actor);
        return { sessionId, started: Promise.resolve() };
      }
      const reason = o.reason ?? (r.brief ? 'rollover' : 'launch');
      const started = this.requestTurn({
        sessionId,
        reason,
        text: r.prompt,
        actor,
        causationId: o.causationId,
        priority: o.priority,
      });
      return { sessionId, started };
    } catch (err) {
      this.failSession(sessionId, err instanceof HttpError ? err.code : 'launch_setup_failed', actor);
      throw err;
    }
  }

  private assertConfigured(): void {
    const sup = this.ctx.config.supervisor;
    const missing = [
      !sup.mcpCommand.length ? 'supervisor.mcpCommand' : null,
      !sup.hookCommand.length ? 'supervisor.hookCommand' : null,
    ].filter(Boolean);
    if (missing.length) {
      throw new HttpError(
        503,
        'supervisor_not_configured',
        `Managed sessions need ${missing.join(' and ')} (the AOC MCP server and hooks)`,
      );
    }
  }

  private resolveCwd(requested: string | null, projectId: string): string {
    if (requested) {
      if (!isAbsolute(requested) || !isDirectory(requested))
        throw new HttpError(422, 'invalid_cwd', 'cwd must be an existing absolute directory');
      return resolve(requested);
    }
    const repo = this.ledger()?.projectRepoPath(projectId);
    if (repo) {
      if (!isDirectory(repo))
        throw new HttpError(
          422,
          'project_repo_missing',
          `The repository of project ${projectId} is not on this host`,
        );
      return resolve(repo);
    }
    const dir = resolve(this.ctx.config.supervisor.workspacesDir, projectId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** The appended system prompt is fixed at launch (Claude Code snapshots it per conversation) and reused on resume. */
  private writeSystemPrompt(
    s: SupervisedSession,
    type: ProcessType,
    brief: string | null,
    actor: Actor | null,
  ): string {
    const learning = this.ctx.services.maybe('learning');
    let lessons: LessonInfo[] = [];
    try {
      lessons = (learning?.lessonsForScope({ processType: type.id }) ?? []).slice(0, MAX_LESSONS);
    } catch (err) {
      this.log.warn('lessons unavailable', { sessionId: s.sessionId, err: String(err) });
    }
    const text = buildSystemPrompt({
      sessionId: s.sessionId,
      projectId: s.projectId,
      threadId: s.threadId,
      phaseId: s.phaseId,
      ticketId: s.ticketId,
      type,
      lessons,
      playbook: this.registry.activePlaybook(type.id),
      brief: brief ? { fromSessionId: s.parentSessionId, text: brief } : null,
    });
    writePrivate(join(this.ensureSessionDir(s.sessionId), 'system-prompt.md'), text);
    if (actor && learning && lessons.length) {
      try {
        learning.recordLessonsApplied(
          lessons.map((l) => l.lessonId),
          s.sessionId,
          actor,
        );
      } catch (err) {
        this.log.warn('could not record applied lessons', { sessionId: s.sessionId, err: String(err) });
      }
    }
    return text;
  }

  // ── turns ─────────────────────────────────────────────────────────────────

  /** Validates and reserves synchronously (a slot or a queue place), so concurrent callers can never double-start. */
  private requestTurn(req: TurnRequest): Promise<void> {
    const s = this.mustGet(req.sessionId);
    assertNotEnded(s);
    if (this.rollingOver.has(s.sessionId))
      throw new HttpError(409, 'rollover_in_progress', 'The session is being rolled over');
    if (this.busy(s.sessionId))
      throw new HttpError(409, 'turn_pending', 'A turn is already running or queued for this session');
    if (!s.readOnly) {
      const w = this.acquireWriter(s.threadId, s.sessionId, req.actor);
      if (!w.ok) throw writerLocked(s.threadId, w.holder);
    }
    if (this.running.size >= this.ctx.config.supervisor.maxConcurrentSessions) {
      if (req.priority) this.queue.unshift(req);
      else this.queue.push(req);
      this.log.info('turn queued', { sessionId: s.sessionId, reason: req.reason, queued: this.queue.length });
      return Promise.resolve();
    }
    return this.spawnTurn(this.reserve(req, s));
  }

  /** For callers that must not throw (reactors, jobs, recovery, follow-ups). */
  private startTurnSafely(req: TurnRequest): Promise<void> {
    try {
      return this.requestTurn(req).catch((err) =>
        this.log.warn('turn did not start', {
          sessionId: req.sessionId,
          reason: req.reason,
          err: String(err),
        }),
      );
    } catch (err) {
      this.log.warn('turn refused', { sessionId: req.sessionId, reason: req.reason, err: String(err) });
      return Promise.resolve();
    }
  }

  private reserve(req: TurnRequest, s: SupervisedSession): LiveTurn {
    let markClosed: () => void = () => {};
    const closed = new Promise<void>((r) => (markClosed = r));
    const live: LiveTurn = {
      req,
      sessionId: s.sessionId,
      turn: s.turn + 1,
      child: null,
      pid: null,
      started: false,
      startedAt: 0,
      startSeq: 0,
      stdoutRest: '',
      stderrRest: '',
      result: null,
      signals: [],
      contextTokens: 0,
      interrupt: null,
      killTimer: null,
      sidecar: null,
      exit: null,
      settled: false,
      closed,
      markClosed,
    };
    this.running.set(s.sessionId, live);
    return live;
  }

  private pump(): void {
    const max = this.ctx.config.supervisor.maxConcurrentSessions;
    while (!this.stopping && this.queue.length && this.running.size < max) {
      const req = this.queue.shift()!;
      const s = this.view.get(req.sessionId);
      if (!s || TERMINAL_LIFECYCLES.includes(s.lifecycle) || this.running.has(req.sessionId)) continue;
      // The thread may have changed hands while this turn waited for a slot.
      if (!s.readOnly && !this.acquireWriter(s.threadId, s.sessionId, req.actor).ok) {
        this.log.warn('queued turn dropped: its thread has another writer', { sessionId: s.sessionId });
        continue;
      }
      this.spawnTurn(this.reserve(req, s)).catch((err) =>
        this.log.warn('queued turn did not start', { sessionId: req.sessionId, err: String(err) }),
      );
    }
  }

  private async spawnTurn(live: LiveTurn): Promise<void> {
    const req = live.req;
    const s = this.mustGet(req.sessionId);
    const sup = this.ctx.config.supervisor;
    let plan: SpawnPlan;
    let child: ChildProcess;
    try {
      plan = this.planTurn(s, req);
      child = spawn(sup.claudeBin, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      this.abandonReservation(live, err instanceof HttpError ? err.code : 'turn_setup_failed', req.actor);
      throw err;
    }
    live.child = child;
    this.wire(live, child);
    try {
      await new Promise<void>((ok, fail) => {
        child.once('spawn', ok);
        child.once('error', fail);
      });
    } catch (err) {
      this.abandonReservation(live, 'spawn_failed', req.actor);
      throw new HttpError(502, 'spawn_failed', `Could not start ${sup.claudeBin}: ${(err as Error).message}`);
    }
    if (this.stopping) {
      signalTree(child.pid!, 'SIGKILL');
      return;
    }
    live.pid = child.pid!;
    live.started = true;
    live.startedAt = this.ctx.clock.now();
    const fresh = this.mustGet(s.sessionId);
    const scope = scopeOf(fresh);
    const events: NewEvent[] = [
      ev({
        type: 'session.turn_started',
        actor: req.actor,
        scope,
        meta: { sessionId: fresh.sessionId, turn: live.turn, reason: req.reason },
        payload: { injectedText: plan.prompt },
        source: 'supervisor',
        causationId: req.causationId,
      }),
      ev({
        type: 'session.launched',
        actor: SYSTEM,
        scope,
        meta: {
          sessionId: fresh.sessionId,
          claudeSessionId: plan.claudeSessionId,
          pid: live.pid,
          model: fresh.model,
          turn: live.turn,
        },
        payload: {
          cwd: plan.cwd,
          argv: redactArgv([sup.claudeBin, ...plan.args]),
          transcriptPath: plan.transcriptPath,
        },
        source: 'supervisor',
      }),
    ];
    if (fresh.lifecycle !== 'running')
      events.push(this.lifecycleEvent(fresh, 'running', req.reason, req.actor));
    live.startSeq = this.ctx.store.appendMany(events)[0]!.seq;
    this.liveness()?.recordProcess(fresh.sessionId, true, live.pid);
    this.liveness()?.refresh(fresh.sessionId);
    this.pushOutput(fresh.sessionId, { kind: 'user_prompt', text: clip(plan.prompt) });
    this.startSidecar(live, plan);
    // Values never reach the log: only variable names.
    this.log.info('turn started', {
      sessionId: fresh.sessionId,
      turn: live.turn,
      reason: req.reason,
      pid: live.pid,
      envKeys: Object.keys(plan.env).sort(),
    });
    if (live.interrupt) this.signalInterrupt(live);
  }

  private abandonReservation(live: LiveTurn, reason: string, actor: Actor): void {
    if (this.running.get(live.sessionId) === live) this.running.delete(live.sessionId);
    live.settled = true;
    live.markClosed();
    this.failSession(live.sessionId, reason, actor);
    this.pump();
  }

  /** Everything a turn is started with. Settings and MCP config are passed again on every resume (they are per process). */
  private planTurn(s: SupervisedSession, req: TurnRequest): SpawnPlan {
    const type = this.registry.getType(s.processType);
    if (!type)
      throw new HttpError(
        410,
        'process_type_removed',
        `Process type ${s.processType} is no longer in the registry`,
      );
    const sup = this.ctx.config.supervisor;
    const cwd = s.cwd ?? this.resolveCwd(null, s.projectId);
    const token = this.tokenFor(s.sessionId, req.actor);
    const dir = this.ensureSessionDir(s.sessionId);
    const aoc: Record<string, string> = {
      [AOC_ENV.sessionId]: s.sessionId,
      [AOC_ENV.daemonUrl]: this.ctx.config.publicUrl,
      [AOC_ENV.ingestToken]: token,
      [AOC_ENV.projectId]: s.projectId,
      [AOC_ENV.threadId]: s.threadId,
      [AOC_ENV.processType]: s.processType,
      [AOC_ENV.mode]: 'managed',
      [AOC_ENV.readOnly]: s.readOnly ? '1' : '0',
      // Provenance trailers for this session's commits (git prepare-commit-msg): ids only, never credentials.
      ...(s.changeId ? { [AOC_ENV.changeId]: s.changeId } : {}),
      ...(s.ticketId ? { [AOC_ENV.ticketId]: s.ticketId } : {}),
    };
    const credentials =
      s.readOnly || !type.credentialProfile ? null : this.credentialsFor(type.credentialProfile);
    const env = buildSessionEnv({
      source: this.sourceEnv(),
      allowlist: sup.envAllowlist,
      credentials,
      readOnly: s.readOnly,
      aoc,
      timezone: this.ctx.config.timezone,
    });
    const mcpPath = join(dir, 'mcp.json');
    const settingsPath = join(dir, 'settings.json');
    const promptPath = join(dir, 'system-prompt.md');
    writePrivate(mcpPath, JSON.stringify(buildMcpConfig(sup.mcpCommand, aoc), null, 2));
    writePrivate(settingsPath, JSON.stringify(buildHookSettings(sup.hookCommand), null, 2));
    const systemPrompt = existsSync(promptPath)
      ? readFileSync(promptPath, 'utf8')
      : this.writeSystemPrompt(s, type, null, null);
    const claudeSessionId = s.claudeSessionId ?? this.claudeIds.get(s.sessionId) ?? randomUUID();
    this.claudeIds.set(s.sessionId, claudeSessionId);
    // Claude Code names the transcript after its process cwd, which is the physical path (symlinks resolved).
    const transcriptPath = transcriptPathFor(
      realpathOr(cwd),
      claudeSessionId,
      claudeConfigDir(env, homedir()),
    );
    const resume = this.conversationExists(s, transcriptPath);
    const prompt = this.turnPrompt(s, req, resume);
    const args = buildClaudeArgs({
      model: s.model,
      mcpConfigPath: mcpPath,
      settingsPath,
      permissionMode: type.permissionMode,
      systemPrompt,
      ...toolPolicy(type),
      claudeSessionId,
      resume,
      prompt,
    });
    return {
      cwd,
      env,
      args: [...sup.claudeArgsPrefix, ...args],
      prompt,
      claudeSessionId,
      transcriptPath,
      token,
      dir,
    };
  }

  /**
   * A conversation that never started cannot be resumed: its first real turn replays the launch prompt. Every turn
   * carries the answers of decisions settled since the previous turn started (exactly-once delivery).
   */
  private turnPrompt(s: SupervisedSession, req: TurnRequest, resume: boolean): string {
    let base = req.text;
    if (!resume && req.reason !== 'launch' && req.reason !== 'rollover') {
      const original = this.launchPrompt(s.sessionId);
      if (original === null)
        throw new HttpError(
          410,
          'launch_prompt_unavailable',
          'The launch prompt of this never-started session was erased',
        );
      base = original;
    }
    const answers = this.pendingAnswers(s);
    const text = answers.length ? `${decisionAnswersText(answers)}\n\n${base}` : base;
    checkText(text);
    return text;
  }

  private conversationExists(s: SupervisedSession, transcriptPath: string): boolean {
    if (s.turn === 0) return false;
    return (
      this.conversations.has(s.sessionId) ||
      existsSync(transcriptPath) ||
      (s.lastOutcome !== null && ANSWERED_OUTCOMES.has(s.lastOutcome))
    );
  }

  private wire(live: LiveTurn, child: ChildProcess): void {
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      live.stdoutRest = eachLine(live.stdoutRest + chunk, (l) => this.onStdoutLine(live, l));
    });
    child.stderr!.on('data', (chunk: string) => {
      live.stderrRest = eachLine(live.stderrRest + chunk, (l) => this.onStderrLine(live, l));
    });
    child.on('error', (err) =>
      this.log.warn('claude process error', { sessionId: live.sessionId, err: err.message }),
    );
    child.on('exit', (code, signal) => {
      live.exit ??= { code, signal };
      // Grandchildren (background shells) can hold the pipes open: do not wait for 'close' forever.
      this.later(() => this.settle(live), CLOSE_GRACE_MS);
    });
    child.on('close', (code, signal) => {
      live.exit ??= { code, signal };
      this.settle(live);
    });
  }

  private onStdoutLine(live: LiveTurn, line: string): void {
    if (!line.trim()) return;
    const id = live.sessionId;
    // While the model generates, stdout is the only activity signal (stream deltas, thinking tokens, status).
    this.liveness()?.recordActivity(id, 'stream', this.ctx.clock.now());
    const f = readStreamLine(line);
    for (const item of f.items) this.pushOutput(id, item);
    if (f.conversation) this.conversations.add(id);
    if (f.contextTokens !== null) {
      live.contextTokens = f.contextTokens;
      this.lastContext.set(id, f.contextTokens);
    }
    if (f.init) this.checkInit(live, f.init);
    if (f.rateLimit?.status === 'rejected') {
      live.signals.push({
        rank: 1,
        resetAt: f.rateLimit.resetsAtMs,
        message: `usage limit reached (${f.rateLimit.window ?? 'unknown window'})`,
        source: 'stream',
      });
    }
    if (f.result) {
      live.result = f.result;
      const { text, isError, apiErrorStatus } = f.result;
      if (apiErrorStatus === 429)
        live.signals.push({
          rank: 3,
          resetAt: this.resetAt(text),
          message: text || 'API rate limit (HTTP 429)',
          source: 'stream',
        });
      if (isError ? isLimitNotice(text) : isLegacyLimitResult(text))
        live.signals.push({ rank: 4, resetAt: this.resetAt(text), message: text, source: 'stream' });
    }
    if (f.cliText && isLimitNotice(f.cliText))
      live.signals.push({ rank: 4, resetAt: this.resetAt(f.cliText), message: f.cliText, source: 'stream' });
  }

  private onStderrLine(live: LiveTurn, line: string): void {
    if (!line.trim()) return;
    this.pushOutput(live.sessionId, { kind: 'system', text: clip(`stderr: ${line}`) });
    if (isLimitNotice(line))
      live.signals.push({ rank: 4, resetAt: this.resetAt(line), message: line, source: 'exit' });
  }

  /** Fail loudly: a managed session without the AOC MCP server cannot declare plans, close tasks or ask (research §2.5). */
  private checkInit(live: LiveTurn, init: NonNullable<StreamFacts['init']>): void {
    const aoc = init.mcpServers.find((m) => m.name === AOC_MCP_SERVER_NAME);
    if (aoc?.status === 'connected') return;
    const status = aoc?.status ?? 'missing';
    this.pushOutput(live.sessionId, {
      kind: 'system',
      text: `AOC MCP server ${status}: aborting this managed session`,
    });
    this.log.error('aoc mcp server not connected; aborting the turn', { sessionId: live.sessionId, status });
    if (live.interrupt?.kind !== 'stop') live.interrupt = { kind: 'abort', reason: 'mcp_unavailable' };
    this.signalInterrupt(live);
  }

  /** SIGINT lets Claude Code end the turn itself (tool children, SessionEnd hooks); SIGKILL the group after the grace. */
  private signalInterrupt(live: LiveTurn): void {
    if (!live.started || live.pid === null || live.exit || live.killTimer) return;
    const pid = live.pid;
    signalProcess(pid, 'SIGINT');
    live.killTimer = this.later(() => {
      if (!live.exit) signalTree(pid, 'SIGKILL');
    }, this.opts.interruptGraceMs ?? 10_000);
  }

  private settle(live: LiveTurn): void {
    if (live.settled) return;
    live.settled = true;
    if (live.killTimer) clearTimeout(live.killTimer);
    if (live.stdoutRest) this.onStdoutLine(live, live.stdoutRest);
    if (live.stderrRest) this.onStderrLine(live, live.stderrRest);
    live.stdoutRest = live.stderrRest = '';
    live.child?.stdout?.destroy();
    live.child?.stderr?.destroy();
    if (this.running.get(live.sessionId) === live) this.running.delete(live.sessionId);
    const sidecar = live.sidecar;
    if (sidecar) this.later(() => sidecar.exitCode === null && sidecar.kill('SIGTERM'), SIDECAR_GRACE_MS);
    live.markClosed();
    if (this.stopping) return;
    this.liveness()?.recordProcess(live.sessionId, false, null);
    try {
      this.finishTurn(live);
    } catch (err) {
      this.log.error('turn end handling failed', { sessionId: live.sessionId, err: String(err) });
      try {
        this.failSession(live.sessionId, 'turn_end_failed', SYSTEM);
      } catch {
        // The store is unusable; the next start marks the session Dead.
      }
    }
    this.pump();
  }

  /**
   * Turn end (§2.3, §4, §5, §10). Operator interrupts first, then in order: open decision → Waiting on you;
   * plan limit → Throttled (resumed at reset); credit cap reached → blocked; stop requested → ended; rollover due
   * → successor; plan complete → ended; crash → Dead; else deliver late answers / auto-continue / idle.
   */
  private finishTurn(live: LiveTurn): void {
    const id = live.sessionId;
    let s = this.mustGet(id);
    if (TERMINAL_LIFECYCLES.includes(s.lifecycle)) return;
    const type = this.registry.getType(s.processType);
    const code = live.exit?.code ?? null;
    const signal = live.exit?.signal ?? null;
    let ended = false;
    const turnEnded = (outcome: TurnOutcome) => {
      if (ended) return;
      ended = true;
      const resultText = live.result?.text;
      this.ctx.store.append(
        ev({
          type: 'session.turn_ended',
          actor: SYSTEM,
          scope: scopeOf(s),
          meta: {
            sessionId: id,
            turn: live.turn,
            outcome,
            exitCode: code,
            durationMs: Math.max(0, this.ctx.clock.now() - live.startedAt),
          },
          payload: resultText ? { resultText: clip(resultText, 8000) } : {},
          source: 'supervisor',
        }),
      );
    };

    const intr = live.interrupt;
    if (intr?.kind === 'stop') {
      turnEnded('interrupted');
      this.endSession(id, 'killed', 'stopped', intr.actor);
      return;
    }
    if (intr?.kind === 'abort') {
      turnEnded('error');
      this.failSession(id, intr.reason, SYSTEM);
      return;
    }
    if (intr?.kind === 'nudge') {
      turnEnded('interrupted');
      this.followUp({ sessionId: id, reason: 'nudge', text: nudgeText(intr.text), actor: intr.actor });
      return;
    }
    if (intr?.kind === 'restart') {
      turnEnded('interrupted');
      this.followUp({ sessionId: id, reason: 'restart', text: RESTART_TEXT, actor: intr.actor });
      return;
    }

    if (this.openDecisions(id).length) {
      turnEnded('decision');
      this.setLifecycle(id, 'waiting_decision', 'open_decision', SYSTEM);
      return;
    }
    const throttle = this.throttleOf(live);
    if (throttle) {
      this.recordThrottle(s, live, throttle);
      turnEnded('throttled');
      this.setLifecycle(id, 'throttled', 'plan_limit', SYSTEM);
      return;
    }
    if (this.capReachedSince(id, live.startSeq)) {
      turnEnded('credit_cap');
      this.setLifecycle(id, 'blocked', 'credit_cap', SYSTEM);
      return;
    }
    if (s.stopRequested) {
      turnEnded('stop_requested');
      this.endSession(id, 'abandoned', 'stop_requested', SYSTEM);
      return;
    }
    const complete = this.planComplete(s, type, live);
    const due = complete ? null : this.autoRolloverDue(s, type, live);
    if (due) {
      turnEnded('rollover');
      const r = this.rolloverNow(s, SYSTEM, due, 'auto');
      if (!('refused' in r)) {
        r.started.catch((err) =>
          this.log.warn('rollover successor did not start', { sessionId: r.newSessionId, err: String(err) }),
        );
        return;
      }
      s = this.mustGet(id);
    }
    if (complete) {
      turnEnded('end_turn');
      this.endSession(id, 'completed', 'plan_complete', SYSTEM);
      return;
    }
    if (code !== 0 && !live.result) {
      turnEnded('crashed');
      this.failSession(id, signal ? `killed_${signal.toLowerCase()}` : `exit_${code ?? 'unknown'}`, SYSTEM);
      return;
    }
    turnEnded(live.result?.isError ? 'error' : 'end_turn');
    // An answer that arrived while the turn was still running is delivered now, not lost to an idle session.
    if (this.pendingAnswers(s).length) {
      this.followUp({
        sessionId: id,
        reason: 'decision_answered',
        text: DECISION_FOLLOWUP_TEXT,
        actor: SYSTEM,
      });
      return;
    }
    if (s.autoContinues < this.ctx.config.supervisor.autoContinueLimit) {
      this.followUp({ sessionId: id, reason: 'continue', text: CONTINUE_TEXT, actor: SYSTEM });
      return;
    }
    this.setLifecycle(id, 'idle', 'turn_ended', SYSTEM);
    this.ctx.notify({
      kind: 'session.attention',
      title: 'Session is waiting on you',
      audience: ['approver', 'builder'],
      severity: 'warn',
      link: `/sessions/${id}`,
      refs: { sessionId: id },
    });
  }

  /** The next turn of a session whose process just exited: it keeps its slot. */
  private followUp(req: TurnRequest): void {
    void this.startTurnSafely({ ...req, priority: true }).then(() => {
      const s = this.view.get(req.sessionId);
      // Refused (e.g. writer lost): the session must not look like it is still running.
      if (s?.lifecycle === 'running' && !this.busy(req.sessionId))
        this.setLifecycle(req.sessionId, 'idle', 'follow_up_refused', SYSTEM);
    });
  }

  private throttleOf(live: LiveTurn): ThrottleSignal | null {
    const signals = [...live.signals];
    // Ingested by hooks (StopFailure rate_limit) or the sidecar; ignored when the turn itself succeeded.
    if (!live.result || live.result.isError) {
      const hit = this.eventsSince('throttle.hit', live.startSeq, live.sessionId).find(
        (e) => e.source !== 'supervisor',
      );
      if (hit) {
        const at = typeof hit.meta.resetAt === 'string' ? Date.parse(hit.meta.resetAt) : null;
        signals.push({
          rank: 2,
          resetAt: at,
          message: 'plan limit reported by hook or sidecar',
          source: hit.meta.source as ThrottleSignal['source'],
        });
      }
    }
    return strongestSignal(signals);
  }

  /** One throttle.hit per episode; a second one only to add a reset time the first did not have. */
  private recordThrottle(s: SupervisedSession, live: LiveTurn, t: ThrottleSignal): void {
    const prior = this.eventsSince('throttle.hit', live.startSeq, s.sessionId);
    if (prior.length && (t.resetAt === null || prior.some((e) => e.meta.resetAt !== null))) return;
    this.ctx.store.append(
      ev({
        type: 'throttle.hit',
        actor: SYSTEM,
        scope: scopeOf(s),
        meta: {
          sessionId: s.sessionId,
          resetAt: t.resetAt === null ? null : new Date(t.resetAt).toISOString(),
          source: t.source,
        },
        payload: { message: clip(t.message, 500) },
        source: 'supervisor',
        idempotencyKey: `supervisor:throttle:${s.sessionId}:${live.turn}`,
      }),
    );
  }

  private capReachedSince(sessionId: string, seq: number): boolean {
    return this.eventsSince('credit.cap_reached', seq, sessionId).length > 0;
  }

  private eventsSince(type: EventType, seq: number, sessionId: string): StoredEvent[] {
    return this.ctx.store
      .list({ types: [type], fromSeq: seq + 1, limit: 10_000 })
      .filter((e) => e.meta.sessionId === sessionId);
  }

  private planComplete(s: SupervisedSession, type: ProcessType | null, live: LiveTurn): boolean {
    const ledger = this.ledger();
    const p = ledger?.sessionProgress(s.sessionId);
    if (p && p.totalTasks > 0 && p.pct >= 100) return true;
    // Types that need no plan (e.g. rollback verification) are done when a turn succeeds.
    return (
      !!type &&
      !type.requiresPlan &&
      !(ledger?.hasManifest(s.sessionId) ?? false) &&
      live.exit?.code === 0 &&
      !!live.result &&
      !live.result.isError
    );
  }

  private resetAt(text: string): number | null {
    return parseResetAt(text, this.ctx.clock.now(), this.ctx.config.timezone);
  }

  // ── rollover (§5, R16) ────────────────────────────────────────────────────

  private autoRolloverDue(
    s: SupervisedSession,
    type: ProcessType | null,
    live: LiveTurn,
  ): ContextInfo | null {
    if (!type || s.readOnly) return null;
    const tokens = live.contextTokens || this.ctx.services.maybe('sessions')?.contextTokens(s.sessionId) || 0;
    const pct = contextPct(tokens, s.model);
    if (pct < type.rolloverContextPct) return null;
    if (type.risky) {
      // Risky types never roll over on their own; a human picks the boundary.
      if (!this.warned.has(`risky:${s.sessionId}`)) {
        this.warned.add(`risky:${s.sessionId}`);
        this.ctx.notify({
          kind: 'session.attention',
          title: 'Context is large: roll over at a clean boundary',
          audience: ['approver', 'builder'],
          severity: 'warn',
          link: `/sessions/${s.sessionId}`,
          refs: { sessionId: s.sessionId, threadId: s.threadId },
        });
      }
      return null;
    }
    if (!this.ledger()?.boundaryState(s.sessionId).atBoundary) return null;
    return { contextTokens: tokens, contextPct: pct };
  }

  private rolloverProblems(s: SupervisedSession, mode: 'auto' | 'manual'): string[] {
    const ledger = this.ledger();
    if (!ledger) return ['ledger_unavailable'];
    const problems: string[] = [];
    if (s.readOnly) problems.push('read_only_session');
    if (this.rollingOver.has(s.sessionId)) problems.push('rollover_in_progress');
    if (this.busy(s.sessionId)) problems.push('session_running');
    if (!['running', 'idle', 'blocked', 'throttled', 'failed'].includes(s.lifecycle))
      problems.push(`session_${s.lifecycle}`);
    if (this.openDecisions(s.sessionId).length) problems.push('open_decisions');
    const type = this.registry.getType(s.processType);
    if (!type) problems.push('process_type_removed');
    if (type?.risky && mode === 'auto') problems.push('risky_type');
    const b = ledger.boundaryState(s.sessionId);
    if (!b.atBoundary) problems.push(`not_at_boundary${b.reason ? `: ${b.reason}` : ''}`);
    return problems;
  }

  /**
   * Sequential handoff, never two writers: brief validated → rollover_started → writer released → successor
   * launched on the same thread with the brief → rollover_completed → predecessor retired.
   */
  private rolloverNow(
    s: SupervisedSession,
    actor: Actor,
    info: ContextInfo,
    mode: 'auto' | 'manual',
  ): RolloverResult {
    const problems = this.rolloverProblems(s, mode);
    if (problems.length) return this.abortRollover(s, problems, actor);
    const ledger = this.ledger()!;
    let brief: HandoffBrief;
    try {
      brief = ledger.buildHandoffBrief(s.threadId, s.sessionId);
    } catch (err) {
      return this.abortRollover(s, [`brief_failed: ${(err as Error).message}`], actor);
    }
    const check = ledger.validateBrief(brief);
    if (!check.ok)
      return this.abortRollover(
        s,
        check.problems.length ? check.problems : ['brief_invalid'],
        actor,
        'brief_invalid',
      );
    this.rollingOver.add(s.sessionId);
    try {
      const startedEvent = this.ctx.store.append(
        ev({
          type: 'session.rollover_started',
          actor,
          scope: scopeOf(s),
          meta: {
            threadId: s.threadId,
            fromSessionId: s.sessionId,
            contextTokens: info.contextTokens,
            contextPct: info.contextPct,
            briefHash: brief.hash,
          },
          payload: { brief: brief.text },
          source: 'supervisor',
        }),
      );
      this.releaseWriter(s, 'rollover', actor);
      let next: { sessionId: string; started: Promise<void> };
      try {
        // Launched on the predecessor's behalf, so the successor keeps its owner (§6 attribution).
        next = this.launchNow(
          {
            processType: s.processType,
            projectId: s.projectId,
            threadId: s.threadId,
            phaseId: s.phaseId,
            prompt: rolloverPrompt(s.sessionId, s.threadId),
            cwd: s.cwd,
            ticketId: s.ticketId,
            parentSessionId: s.sessionId,
            brief: brief.text,
          },
          SYSTEM,
          { reason: 'rollover', causationId: startedEvent.id, priority: true },
        );
      } catch (err) {
        // The predecessor stays in charge of its thread.
        this.acquireWriter(s.threadId, s.sessionId, actor);
        return this.abortRollover(
          s,
          [`successor_launch_failed: ${(err as Error).message}`],
          actor,
          'successor_launch_failed',
        );
      }
      this.ctx.store.append(
        ev({
          type: 'session.rollover_completed',
          actor,
          scope: scopeOf(s),
          meta: { threadId: s.threadId, fromSessionId: s.sessionId, toSessionId: next.sessionId },
          source: 'supervisor',
          causationId: startedEvent.id,
        }),
      );
      this.endSession(s.sessionId, 'retired', 'rollover', actor);
      return { newSessionId: next.sessionId, started: next.started };
    } finally {
      this.rollingOver.delete(s.sessionId);
    }
  }

  private abortRollover(
    s: SupervisedSession,
    problems: string[],
    actor: Actor,
    reason?: string,
  ): { refused: string[] } {
    this.ctx.store.append(
      ev({
        type: 'session.rollover_aborted',
        actor,
        scope: scopeOf(s),
        meta: {
          threadId: s.threadId,
          fromSessionId: s.sessionId,
          reason: label(reason ?? problems[0]!.split(':')[0]!),
        },
        payload: { problems },
        source: 'supervisor',
      }),
    );
    return { refused: problems };
  }

  // ── session state ─────────────────────────────────────────────────────────

  private lifecycleEvent(
    s: SupervisedSession,
    to: SessionLifecycle,
    reason: string,
    actor: Actor,
  ): NewEvent<'session.lifecycle_changed'> {
    return ev({
      type: 'session.lifecycle_changed',
      actor,
      scope: scopeOf(s),
      meta: { sessionId: s.sessionId, from: s.lifecycle, to, reason: label(reason) },
      source: 'supervisor',
    });
  }

  private setLifecycle(sessionId: string, to: SessionLifecycle, reason: string, actor: Actor): void {
    const s = this.view.get(sessionId);
    if (!s || s.lifecycle === to) return;
    this.ctx.store.append(this.lifecycleEvent(s, to, reason, actor));
    this.liveness()?.refresh(sessionId);
  }

  private endSession(sessionId: string, outcome: EndOutcome, reason: string, actor: Actor): void {
    const s = this.view.get(sessionId);
    if (!s || TERMINAL_LIFECYCLES.includes(s.lifecycle)) return;
    this.ctx.store.appendMany([
      this.lifecycleEvent(s, outcome === 'retired' ? 'retired' : 'ended', reason, actor),
      ev({
        type: 'session.ended',
        actor,
        scope: scopeOf(s),
        meta: { sessionId, outcome },
        source: 'supervisor',
      }),
    ]);
    if (!s.readOnly)
      this.releaseWriter(
        s,
        outcome === 'completed' ? 'ended' : outcome === 'retired' ? 'rollover' : 'stopped',
        actor,
      );
    this.revokeToken(sessionId, actor);
    if (outcome === 'abandoned' || outcome === 'killed') this.withdrawSessionDecisions(s, actor);
    this.removeQueued(sessionId);
    this.liveness()?.refresh(sessionId);
  }

  /** Dead: restartable (the transcript stays resumable), so the ingest token is kept. */
  private failSession(sessionId: string, reason: string, actor: Actor): void {
    const s = this.view.get(sessionId);
    if (!s || TERMINAL_LIFECYCLES.includes(s.lifecycle) || s.lifecycle === 'failed') return;
    this.setLifecycle(sessionId, 'failed', reason, actor);
    if (!s.readOnly) this.releaseWriter(s, 'failed', actor);
    this.removeQueued(sessionId);
    this.ctx.notify({
      kind: 'session.attention',
      title: 'Managed session died',
      audience: ['approver', 'builder'],
      severity: 'danger',
      link: `/sessions/${sessionId}`,
      refs: { sessionId },
    });
  }

  private withdrawSessionDecisions(s: SupervisedSession, actor: Actor): void {
    const decisions = this.ctx.services.maybe('decisions');
    for (const c of this.openDecisions(s.sessionId)) {
      if (!SESSION_DECISION_KINDS.has(c.kind)) continue;
      try {
        decisions?.withdraw(c.id, 'session_ended', actor);
      } catch (err) {
        this.log.warn('could not withdraw decision', { decisionId: c.id, err: String(err) });
      }
    }
  }

  private appendNudged(s: SupervisedSession, text: string, actor: Actor): void {
    this.ctx.store.append(
      ev({
        type: 'session.nudged',
        actor,
        scope: scopeOf(s),
        meta: { sessionId: s.sessionId },
        payload: { text },
        source: 'supervisor',
      }),
    );
  }

  private appendRestarted(s: SupervisedSession, actor: Actor): void {
    this.ctx.store.append(
      ev({
        type: 'session.restarted',
        actor,
        scope: scopeOf(s),
        meta: { sessionId: s.sessionId },
        source: 'supervisor',
      }),
    );
  }

  // ── writer lock (§5: one active writer per thread) ────────────────────────

  private acquireWriter(
    threadId: string,
    sessionId: string,
    actor: Actor,
  ): { ok: true } | { ok: false; holder: string | null } {
    const other = this.view.otherWriters(threadId, sessionId).find((o) => !this.rollingOver.has(o.sessionId));
    if (other) return { ok: false, holder: other.sessionId };
    const ledger = this.ledger();
    if (!ledger || ledger.getThread(threadId)?.activeWriterSessionId === sessionId) return { ok: true };
    if (ledger.acquireWriter(threadId, sessionId, actor)) return { ok: true };
    return { ok: false, holder: ledger.getThread(threadId)?.activeWriterSessionId ?? null };
  }

  private releaseWriter(
    s: SupervisedSession,
    reason: 'ended' | 'rollover' | 'failed' | 'stopped',
    actor: Actor,
  ): void {
    const ledger = this.ledger();
    if (ledger?.getThread(s.threadId)?.activeWriterSessionId === s.sessionId)
      ledger.releaseWriter(s.threadId, s.sessionId, reason, actor);
  }

  // ── decisions & credits ───────────────────────────────────────────────────

  private openDecisions(sessionId: string): DecisionCard[] {
    return this.ctx.services.maybe('decisions')?.list({ sessionId, status: ['open'] }) ?? [];
  }

  /** Decisions of the session settled after its last turn started: not yet delivered to the agent. */
  private pendingAnswers(s: SupervisedSession): DecisionCard[] {
    const decisions = this.ctx.services.maybe('decisions');
    if (!decisions) return [];
    return decisions
      .list({ sessionId: s.sessionId, status: ['resolved', 'withdrawn'] })
      .filter(
        (c) =>
          (this.ctx.store.list({
            decisionId: c.id,
            types: ['decision.resolved', 'decision.withdrawn'],
            order: 'desc',
            limit: 1,
          })[0]?.seq ?? 0) > s.turnStartedSeq,
      );
  }

  private recheckCredits(s: SupervisedSession, actor: Actor): void {
    const b = this.ctx.services.maybe('credits')?.checkBoundary(s.sessionId, null, actor);
    if (b && !b.continue && b.reason === 'credit_cap')
      throw new HttpError(409, 'credit_cap', 'The credit cap is still reached: a top-up is needed');
  }

  // ── environment, files, helpers ───────────────────────────────────────────

  private credentialsFor(profile: string): Record<string, string> | null {
    const file = this.ctx.config.supervisor.credentialProfilesFile;
    if (!file) {
      this.warnOnce(
        'no-credential-profiles',
        'supervisor.credentialProfilesFile is not configured: sessions run without credential profiles',
      );
      return null;
    }
    try {
      return readCredentialProfile(resolve(file), profile);
    } catch (err) {
      throw new HttpError(500, 'credential_profile_unavailable', (err as Error).message);
    }
  }

  private tokenFor(sessionId: string, actor: Actor): string {
    const known = this.tokens.get(sessionId);
    if (known) return known;
    const identity = this.ctx.services.maybe('identity');
    if (!identity)
      throw new HttpError(
        503,
        'identity_unavailable',
        'Managed sessions need the identity service (per-session ingest tokens)',
      );
    const token = identity.issueIngestToken(sessionId, actor);
    this.tokens.set(sessionId, token);
    return token;
  }

  private revokeToken(sessionId: string, actor: Actor): void {
    this.tokens.delete(sessionId);
    this.ctx.services.maybe('identity')?.revokeIngestTokensFor(sessionId, actor);
  }

  private startSidecar(live: LiveTurn, plan: SpawnPlan): void {
    const sup = this.ctx.config.supervisor;
    const [bin, ...pre] = sup.sidecarCommand;
    if (!bin || live.pid === null) return;
    const args = [
      ...pre,
      '--session',
      live.sessionId,
      '--pid',
      String(live.pid),
      '--transcript',
      plan.transcriptPath,
      '--daemon',
      this.ctx.config.publicUrl,
    ];
    args.push('--state-dir', join(plan.dir, 'sidecar'));
    // The ingest token travels in the env, not argv: a command line is readable by every local user.
    const env = buildSessionEnv({
      source: this.sourceEnv(),
      allowlist: sup.envAllowlist,
      credentials: null,
      readOnly: true,
      aoc: { [AOC_ENV.ingestToken]: plan.token, [AOC_ENV.daemonUrl]: this.ctx.config.publicUrl },
      timezone: this.ctx.config.timezone,
    });
    try {
      const child = spawn(bin, args, { env, stdio: 'ignore' });
      child.on('error', (err) =>
        this.log.warn('sidecar failed', { sessionId: live.sessionId, err: err.message }),
      );
      child.on('exit', () => this.sidecars.delete(child));
      this.sidecars.add(child);
      live.sidecar = child;
    } catch (err) {
      this.log.warn('sidecar failed to start', { sessionId: live.sessionId, err: String(err) });
    }
  }

  private interruptOrphan(pid: number, claudeSessionId: string): void {
    signalProcess(pid, 'SIGINT');
    this.later(() => {
      // Re-verify: after the grace the pid may belong to someone else.
      if (processMatches(pid, claudeSessionId)) signalTree(pid, 'SIGKILL');
    }, this.opts.interruptGraceMs ?? 10_000);
  }

  private pushOutput(sessionId: string, item: OutputDraft): void {
    let buf = this.outputs.get(sessionId);
    if (!buf) {
      buf = new RingBuffer<SessionOutputItem>(this.opts.outputBufferSize ?? 500);
      this.outputs.set(sessionId, buf);
      for (const id of this.outputs.keys()) {
        if (this.outputs.size <= MAX_BUFFERED_SESSIONS) break;
        if (!this.running.has(id)) this.outputs.delete(id);
      }
    }
    buf.push({ at: this.ctx.clock.iso(), ...item });
  }

  private launchPrompt(sessionId: string): string | null {
    const e = this.ctx.store.list({ sessionId, types: ['session.launch_requested'], limit: 1 })[0];
    const p = e ? this.ctx.store.readPayload(e) : null;
    return p && typeof p === 'object' && !Array.isArray(p) && typeof p.prompt === 'string' ? p.prompt : null;
  }

  private ensureSessionDir(sessionId: string): string {
    const dir = join(this.sessionsRoot, sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private busy(sessionId: string): boolean {
    return this.running.has(sessionId) || this.queue.some((q) => q.sessionId === sessionId);
  }

  private removeQueued(sessionId: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--)
      if (this.queue[i]!.sessionId === sessionId) this.queue.splice(i, 1);
  }

  private mustGet(sessionId: string): SupervisedSession {
    const s = this.view.get(sessionId);
    if (!s) throw new HttpError(404, 'not_found', `No managed session ${sessionId}`);
    return s;
  }

  private ledger() {
    return this.ctx.services.maybe('ledger');
  }

  private liveness() {
    return this.ctx.services.maybe('liveness');
  }

  private sourceEnv(): Record<string, string | undefined> {
    return this.opts.env ?? process.env;
  }

  private later(fn: () => void, ms: number): NodeJS.Timeout {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    t.unref();
    this.timers.add(t);
    return t;
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log.warn(msg);
  }
}

function ev<T extends EventType>(e: NewEvent<T>): NewEvent<T> {
  return e;
}

/**
 * Reactors start synchronously inside the emitting module's append(): yield once so that module has finished
 * updating its own state (e.g. a decision card's status) before the supervisor reads it through the service.
 */
function afterCaller(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function scopeOf(s: SupervisedSession): Scope {
  return {
    sessionId: s.sessionId,
    projectId: s.projectId,
    threadId: s.threadId,
    ...(s.ticketId ? { ticketId: s.ticketId } : {}),
  };
}

function checkText(text: string): void {
  if (!text.trim()) throw new HttpError(422, 'invalid', 'Text must not be empty');
  if (Buffer.byteLength(text) > MAX_ARG_BYTES)
    throw new HttpError(413, 'prompt_too_large', `Text exceeds ${MAX_ARG_BYTES} bytes`);
}

function assertNotEnded(s: SupervisedSession): void {
  if (TERMINAL_LIFECYCLES.includes(s.lifecycle))
    throw new HttpError(409, 'session_ended', `Session ${s.sessionId} has ${s.lifecycle}`);
}

function assertNotStopping(live: LiveTurn): void {
  if (live.interrupt?.kind === 'stop' || live.interrupt?.kind === 'abort')
    throw new HttpError(409, 'stopping', 'The session is already stopping');
}

function writerLocked(threadId: string, holder: string | null): HttpError {
  return new HttpError(
    409,
    'writer_locked',
    `Thread ${threadId} already has an active writer session${holder ? ` (${holder})` : ''}`,
    {
      threadId,
      holderSessionId: holder,
    },
  );
}

function contextPct(tokens: number, model: string): number {
  const tier = modelTierOf(model);
  const window = (tier === 'unknown' ? undefined : MODEL_CONTEXT_TOKENS[tier]) ?? 1_000_000;
  return Math.round((tokens / window) * 1000) / 10;
}

function eachLine(buffer: string, fn: (line: string) => void): string {
  let rest = buffer;
  for (let i = rest.indexOf('\n'); i >= 0; i = rest.indexOf('\n')) {
    fn(rest.slice(0, i));
    rest = rest.slice(i + 1);
  }
  return rest;
}

function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim()) ?? 'Thread').trim().slice(0, 80);
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function writePrivate(path: string, data: string): void {
  writeFileSync(path, data, { mode: 0o600 });
}

function label(reason: string): string {
  return reason.replace(/[^a-z0-9_.:/-]/gi, '_').slice(0, 80) || 'unknown';
}

function settleWithin(lives: LiveTurn[], ms: number): Promise<void> {
  return Promise.race([
    Promise.all(lives.map((l) => l.closed)).then(() => undefined),
    new Promise<void>((r) => setTimeout(r, ms).unref()),
  ]);
}
