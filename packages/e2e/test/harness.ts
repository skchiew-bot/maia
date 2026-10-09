/**
 * E2E harness: the real aocd composition root (`createAocServer` from @aoc/daemon) with the production module
 * list (`createDefaultModules`), served over real HTTP (@hono/node-server on port 0) with the real clock and an
 * on-disk data dir, so the daemon can be stopped and restarted under running sessions.
 *
 * Production modules that have not landed are stood in for, and `standIns` says which:
 * - identity → `HarnessIdentity` (DevIdentityService whose users and tokens survive a daemon restart). Switch to
 *   the real identity routes once mod-identity lands.
 * - supervisor → `StubSupervisor`: appends the supervisor's launch events exactly as the supervisor would and
 *   issues the session ingest token; the test drives the "claude process" itself (see claude.ts).
 * - other placeholders (e.g. change, audit) are left out until they land.
 * - the `protected-op` guard: no landed module turns `git push origin main` into a decision card yet, so a
 *   contract stand-in is registered until a composed module provides a guard of that name.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import {
  AocConfigSchema,
  MODEL_ID_BY_TIER,
  newId,
  transcriptPathFor,
  type Actor,
  type AocConfig,
  type AuthContext,
  type IdentityService,
  type IngestPrincipal,
  type LaunchRequest,
  type Permission,
  type PreToolGuard,
  type Role,
  type StoredEvent,
  type SupervisorService,
  type User,
} from '@aoc/contracts';
import { createAocServer, createDefaultModules, type AocServer } from '@aoc/daemon';
import {
  createLogger,
  DevIdentityService,
  FakeLlm,
  initRepo,
  silentLogger,
  systemClock,
  type AocModule,
  type EventStore,
  type ListQuery,
  type ModuleContext,
} from '@aoc/kernel';
import { createSessionsModule } from '@aoc/mod-sessions';
import { REPO_ROOT } from './paths';

// ── small utilities ───────────────────────────────────────────────────────────

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until `fn` returns a truthy value (or stops throwing); fails with the last value seen. */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  opts: { timeout?: number; interval?: number; what?: string } = {},
): Promise<NonNullable<T>> {
  const deadline = Date.now() + (opts.timeout ?? 10_000);
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
      last = v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) {
      const shown = last instanceof Error ? last.message : JSON.stringify(last);
      throw new Error(`timed out waiting for ${opts.what ?? 'condition'} (last: ${shown?.slice(0, 600)})`);
    }
    await sleep(opts.interval ?? 50);
  }
}

type Json = Record<string, unknown>;
function deepMerge(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)
        ? deepMerge(b as Json, v as Json)
        : v;
  }
  return out;
}

const SUPERVISOR: Actor = { kind: 'system', id: 'supervisor' };

// ── identity stand-in ─────────────────────────────────────────────────────────

export interface TestUser {
  user: User;
  token: string;
  headers: Record<string, string>;
}

/**
 * DevIdentityService (kernel test kit) kept outside the runtime, so users, bearer tokens and session ingest
 * tokens stay valid across a daemon restart; `user.created` goes to whichever store is attached.
 */
export class HarnessIdentity implements IdentityService {
  private readonly dev = new DevIdentityService(null);
  private store: EventStore | null = null;

  attach(store: EventStore): void {
    this.store = store;
  }

  createUser(role: Role, name?: string, opts: { complianceLead?: boolean } = {}): TestUser {
    if (!this.store) throw new Error('identity is not attached to a running daemon');
    const { user, token } = this.dev.createUser({ role, name, complianceLead: opts.complianceLead });
    this.store.append({
      type: 'user.created',
      actor: { kind: 'system', id: 'dev-identity' },
      scope: { userId: user.id },
      meta: { userId: user.id, role, complianceLead: user.flags.complianceLead ?? false },
      payload: { name: user.name },
      source: 'system',
    });
    return { user, token, headers: { authorization: `Bearer ${token}` } };
  }
  issueObserverToken(): string {
    return this.dev.issueObserverToken();
  }
  authenticate(token: string): AuthContext | null {
    return this.dev.authenticate(token);
  }
  getUser(id: string): User | null {
    return this.dev.getUser(id);
  }
  listUsers(): User[] {
    return this.dev.listUsers();
  }
  can(user: User, perm: Permission): boolean {
    return this.dev.can(user, perm);
  }
  issueIngestToken(sessionId: string, actor: Actor): string {
    return this.dev.issueIngestToken(sessionId, actor);
  }
  revokeIngestTokensFor(sessionId: string): void {
    this.dev.revokeIngestTokensFor(sessionId);
  }
  verifyIngestToken(token: string): IngestPrincipal | null {
    return this.dev.verifyIngestToken(token);
  }
  verifyDecisionPasskey(input: { userId: string; decisionId: string; optionId: string; assertion: unknown }): Promise<boolean> {
    return this.dev.verifyDecisionPasskey(input);
  }
}

// ── supervisor stand-in ───────────────────────────────────────────────────────

export interface LaunchedSession {
  sessionId: string;
  claudeSessionId: string;
  projectId: string;
  threadId: string;
  processType: string;
  model: string;
  readOnly: boolean;
  ticketId: string | null;
  cwd: string;
  transcriptPath: string;
  prompt: string;
  /** The session's ingest token (the supervisor hands it to hooks, MCP server and sidecar). */
  token: string;
  /** pid of the stand-in "claude" process (a sleeper) the sidecar watches. */
  pid: number;
  claude: ChildProcess;
}

/**
 * Contract stand-in for the supervisor (SupervisorService). launch() records exactly what the supervisor
 * records — thread ensured, writer lock, session.launch_requested → session.launched → lifecycle running →
 * turn 1 — and starts a sleeper process standing in for `claude`, whose pid the sidecar watches.
 */
export class StubSupervisor implements SupervisorService {
  readonly sessions = new Map<string, LaunchedSession>();
  readonly calls: { method: string; sessionId: string | null; args: unknown[] }[] = [];
  private ctx: ModuleContext | null = null;
  private readonly launchWaiters: ((s: LaunchedSession) => void)[] = [];

  constructor(
    private readonly identity: HarnessIdentity,
    private readonly claudeConfigDir: string,
  ) {}

  attach(ctx: ModuleContext): void {
    this.ctx = ctx;
  }

  private get c(): ModuleContext {
    if (!this.ctx) throw new Error('supervisor stand-in used before the daemon started');
    return this.ctx;
  }

  async launch(req: LaunchRequest, actor: Actor): Promise<{ sessionId: string }> {
    const ctx = this.c;
    const registry = ctx.services.get('registry');
    const type = registry.getType(req.processType);
    if (!type) throw new Error(`unknown process type ${req.processType}`);
    const ledger = ctx.services.get('ledger');
    const thread = ledger.ensureThread({ projectId: req.projectId, threadId: req.threadId ?? null }, actor);
    const sessionId = newId('session', ctx.clock.now());
    const model = MODEL_ID_BY_TIER[registry.modelFor(req.processType)];
    const cwd = req.cwd ?? ledger.projectRepoPath(req.projectId) ?? ctx.config.supervisor.workspacesDir;
    const scope = { sessionId, projectId: req.projectId, threadId: thread.threadId, ticketId: req.ticketId ?? undefined };
    ctx.store.append({
      type: 'session.launch_requested',
      actor,
      scope,
      meta: {
        sessionId,
        projectId: req.projectId,
        threadId: thread.threadId,
        processType: type.id,
        model,
        readOnly: type.readOnly,
        credentialProfile: type.readOnly ? null : type.credentialProfile,
        ticketId: req.ticketId ?? null,
        parentSessionId: req.parentSessionId ?? null,
        phaseId: req.phaseId ?? null,
      },
      payload: { prompt: req.prompt, cwd },
      source: 'supervisor',
    });
    // One active writer per thread (§5); read-only triage runs in parallel without the lock.
    if (!type.readOnly && !ledger.acquireWriter(thread.threadId, sessionId, SUPERVISOR)) {
      throw new Error(`thread ${thread.threadId} already has an active writer`);
    }
    const token = this.identity.issueIngestToken(sessionId, SUPERVISOR);
    const claude = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    if (!claude.pid) throw new Error('could not start the stand-in claude process');
    const claudeSessionId = randomUUID();
    const transcriptPath = transcriptPathFor(cwd, claudeSessionId, this.claudeConfigDir);
    ctx.store.append({
      type: 'session.launched',
      actor: SUPERVISOR,
      scope,
      meta: { sessionId, claudeSessionId, pid: claude.pid, model, turn: 1 },
      payload: {
        cwd,
        argv: ['-p', '--session-id', claudeSessionId, '--output-format', 'stream-json', '--verbose', '--model', model],
        transcriptPath,
      },
      source: 'supervisor',
    });
    ctx.store.append({
      type: 'session.lifecycle_changed',
      actor: SUPERVISOR,
      scope,
      meta: { sessionId, from: 'launching', to: 'running', reason: 'launched' },
      source: 'supervisor',
    });
    ctx.store.append({
      type: 'session.turn_started',
      actor: SUPERVISOR,
      scope,
      meta: { sessionId, turn: 1, reason: 'launch' },
      payload: {},
      source: 'supervisor',
    });
    const launched: LaunchedSession = {
      sessionId,
      claudeSessionId,
      projectId: req.projectId,
      threadId: thread.threadId,
      processType: type.id,
      model,
      readOnly: type.readOnly,
      ticketId: req.ticketId ?? null,
      cwd,
      transcriptPath,
      prompt: req.prompt,
      token,
      pid: claude.pid,
      claude,
    };
    this.sessions.set(sessionId, launched);
    for (const w of this.launchWaiters.splice(0)) w(launched);
    this.calls.push({ method: 'launch', sessionId, args: [req, actor] });
    return { sessionId };
  }

  /** Resolves with the next launch (e.g. one a reactor makes in response to an intake). */
  nextLaunch(): Promise<LaunchedSession> {
    return new Promise((resolve) => this.launchWaiters.push(resolve));
  }

  /** What the supervisor records when the claude process of a turn exits and the session is finished. */
  endSession(sessionId: string, outcome: 'completed' | 'failed' | 'killed' = 'completed'): void {
    const ctx = this.c;
    const s = this.sessions.get(sessionId);
    const scope = { sessionId, projectId: s?.projectId };
    ctx.store.append({
      type: 'session.turn_ended',
      actor: SUPERVISOR,
      scope,
      meta: { sessionId, turn: 1, outcome: outcome === 'completed' ? 'end_turn' : 'crashed', exitCode: outcome === 'completed' ? 0 : null, durationMs: 1000 },
      payload: {},
      source: 'supervisor',
    });
    ctx.store.append({ type: 'session.ended', actor: SUPERVISOR, scope, meta: { sessionId, outcome }, source: 'supervisor' });
    this.identity.revokeIngestTokensFor(sessionId);
  }

  private record(method: string, sessionId: string | null, args: unknown[]): void {
    this.calls.push({ method, sessionId, args });
  }
  async resume(sessionId: string, ...args: unknown[]): Promise<void> {
    this.record('resume', sessionId, args);
  }
  async nudge(sessionId: string, ...args: unknown[]): Promise<void> {
    this.record('nudge', sessionId, args);
  }
  async restart(sessionId: string, ...args: unknown[]): Promise<void> {
    this.record('restart', sessionId, args);
  }
  async stop(sessionId: string, ...args: unknown[]): Promise<void> {
    this.record('stop', sessionId, args);
  }
  async rollover(threadId: string): Promise<{ refused: string[] }> {
    this.record('rollover', null, [threadId]);
    return { refused: ['supervisor stand-in does not roll over'] };
  }
  isRunning(sessionId: string): boolean {
    return this.c.services.get('sessions').get(sessionId)?.lifecycle === 'running';
  }
  stopRequested(): boolean {
    return false;
  }
  async runIsolated(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    throw new Error('runIsolated is not available in the supervisor stand-in');
  }

  killAll(): void {
    for (const s of this.sessions.values()) if (s.claude.exitCode === null) s.claude.kill('SIGKILL');
  }
}

// ── protected-op guard stand-in ───────────────────────────────────────────────

const PROTECTED = ['main', 'master', 'production'];

/** Destination branch of a `git push` that targets a protected branch, or null. */
export function protectedPushTarget(command: string): string | null {
  const m = command.match(/\bgit\s+push\b([^;&|]*)/);
  if (!m) return null;
  const args = m[1]!.trim().split(/\s+/).filter((a) => a && !a.startsWith('-'));
  for (const refspec of args.slice(1)) {
    const dst = (refspec.includes(':') ? refspec.split(':')[1]! : refspec).replace(/^\+/, '').replace(/^refs\/heads\//, '');
    if (PROTECTED.includes(dst) || dst.startsWith('release/')) return dst;
  }
  return null;
}

export const protectedOpGuard: PreToolGuard = {
  name: 'protected-op',
  order: 30,
  evaluate(ctx) {
    if (ctx.toolName !== 'Bash') return null;
    const target = protectedPushTarget(String(ctx.toolInput.command ?? ''));
    if (!target) return null;
    return {
      decision: 'deny',
      guard: 'protected-op',
      blockReason: 'protected_operation',
      reason: `Pushing to ${target} is a protected operation (AOC-SPEC-003 §2.4, test 1).`,
      raiseDecision: {
        kind: 'protected_operation',
        test: 'main',
        title: `Push to ${target}`,
        question: `Allow this session to push to ${target}?`,
        options: [
          { id: 'approve', label: 'Approve the push' },
          { id: 'reject', label: 'Reject' },
        ],
        subjectType: 'session',
        subjectId: ctx.session.sessionId,
      },
    };
  },
};

// ── the harness ───────────────────────────────────────────────────────────────

export interface HarnessOptions {
  /** Deep-merged into the e2e config (AocConfigSchema input). */
  config?: Json;
}

const isPlaceholder = (m: AocModule) => Object.keys(m).every((k) => k === 'name');

export class Harness {
  readonly root: string;
  readonly dataDir: string;
  /** HOME of every spawned helper: observed client config, default spools, sidecar state. */
  readonly homeDir: string;
  readonly claudeConfigDir: string;
  readonly config: AocConfig;
  readonly identity: HarnessIdentity;
  readonly supervisor: StubSupervisor;
  readonly llm = new FakeLlm();
  /** Production modules not composed for real (stood in or not landed yet). */
  standIns: string[] = [];
  /** Real production modules in the composition. */
  composed: string[] = [];
  port = 0;
  private readonly masterKey = randomBytes(32);
  private server: Server | null = null;
  private current: AocServer | null = null;
  private readonly children = new Set<ChildProcess>();

  private constructor(opts: HarnessOptions) {
    this.root = mkdtempSync(join(tmpdir(), 'aoc-e2e-'));
    this.dataDir = join(this.root, 'data');
    this.homeDir = join(this.root, 'home');
    this.claudeConfigDir = join(this.root, 'claude-config');
    mkdirSync(this.homeDir, { recursive: true });
    mkdirSync(this.claudeConfigDir, { recursive: true });
    this.config = AocConfigSchema.parse(
      deepMerge(
        {
          dataDir: this.dataDir,
          host: '127.0.0.1',
          port: 0,
          timezone: 'Asia/Kuala_Lumpur',
          registryFile: join(REPO_ROOT, 'config', 'process-types.json'),
          // Real clock: short enough to observe transitions, long enough not to flap under load.
          liveness: { workingWindowMs: 5_000, stallAfterMs: 120_000, toolStallAfterMs: 120_000, deadAfterMs: 15_000 },
          supervisor: { workspacesDir: join(this.root, 'workspaces') },
          metering: { rateCardFile: join(REPO_ROOT, 'config', 'rate-card.json') },
          fx: { extractor: 'fake' },
          audit: { anchorRepoPath: join(this.root, 'anchor-repo') },
          selfModification: { externalAuditLog: join(this.root, 'selfmod-audit.log') },
          compliance: { mappingFile: join(REPO_ROOT, 'config', 'iso42001-mapping.json') },
          intake: { triageAgents: 1 },
        },
        opts.config ?? {},
      ),
    );
    this.identity = new HarnessIdentity();
    this.supervisor = new StubSupervisor(this.identity, this.claudeConfigDir);
  }

  static async start(opts: HarnessOptions = {}): Promise<Harness> {
    const h = new Harness(opts);
    await h.boot();
    return h;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  get aoc(): AocServer {
    if (!this.current) throw new Error('daemon is stopped');
    return this.current;
  }
  get store(): EventStore {
    return this.aoc.runtime.store;
  }
  get running(): boolean {
    return this.current !== null;
  }

  /** Fresh module instances each boot (modules hold per-runtime state); stand-ins wrap the long-lived objects. */
  private compose(): AocModule[] {
    const identity = this.identity;
    const supervisor = this.supervisor;
    const modules: AocModule[] = [];
    const standIns: string[] = [];
    const composed: string[] = [];
    for (const m of createDefaultModules()) {
      if (m.name === 'identity') {
        standIns.push('identity');
        modules.push({ name: 'identity', init: (ctx) => (identity.attach(ctx.store), ctx.services.provide('identity', identity)) });
      } else if (m.name === 'supervisor') {
        standIns.push('supervisor');
        modules.push({ name: 'supervisor', init: (ctx) => (supervisor.attach(ctx), ctx.services.provide('supervisor', supervisor)) });
      } else if (isPlaceholder(m)) {
        standIns.push(m.name);
      } else {
        composed.push(m.name);
        // Same module, faster liveness sweep (the production default is 5 s).
        modules.push(m.name === 'sessions' ? createSessionsModule({ sweepIntervalMs: 250 }) : m);
      }
    }
    if (!modules.some((m) => m.guards?.some((g) => g.name === 'protected-op'))) {
      standIns.push('guard:protected-op');
      modules.push({ name: 'e2e-protected-op', guards: [protectedOpGuard] });
    }
    this.standIns = standIns;
    this.composed = composed;
    return modules;
  }

  private async boot(): Promise<void> {
    const log = process.env.AOC_E2E_LOG ? createLogger({ level: 'debug' }) : silentLogger;
    const aoc = await createAocServer(this.config, {
      log,
      clock: systemClock,
      masterKey: this.masterKey,
      modules: this.compose(),
      llm: this.llm,
      webDir: null,
    });
    const server = await new Promise<Server>((resolve, reject) => {
      const s = serve({ fetch: aoc.app.fetch, hostname: '127.0.0.1', port: this.port }, () => resolve(s as Server));
      s.once('error', reject);
    });
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
    this.current = aoc;
  }

  /** Take the daemon down (port closed, runtime stopped, DB closed) — hooks now see ECONNREFUSED. */
  async stop(): Promise<void> {
    const server = this.server;
    const aoc = this.current;
    this.server = null;
    this.current = null;
    if (server) {
      aoc?.closeStreams();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
    await aoc?.close();
  }

  /** Same port, same data dir, same KEK, same identities: what a restarted aocd looks like to its clients. */
  async restart(): Promise<void> {
    if (this.current) await this.stop();
    await this.boot();
  }

  async close(): Promise<void> {
    for (const c of this.children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    this.supervisor.killAll();
    await this.stop();
    rmSync(this.root, { recursive: true, force: true });
  }

  /** Track a helper process so close() never leaks it. */
  track(child: ChildProcess): ChildProcess {
    this.children.add(child);
    child.once('exit', () => this.children.delete(child));
    return child;
  }

  async drain(): Promise<void> {
    await this.aoc.runtime.drain();
  }

  // ── identities ─────────────────────────────────────────────────────────────
  user(role: Role, name?: string, opts: { complianceLead?: boolean } = {}): TestUser {
    return this.identity.createUser(role, name, opts);
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────
  async request(method: string, path: string, opts: { as?: TestUser; headers?: Record<string, string>; body?: unknown } = {}): Promise<Response> {
    const headers: Record<string, string> = { ...opts.as?.headers, ...opts.headers };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    return fetch(this.url + path, { method, headers, body });
  }

  /** JSON request that must answer `expect` (default 200/201). */
  async api<T = any>(method: string, path: string, opts: { as?: TestUser; headers?: Record<string, string>; body?: unknown; expect?: number } = {}): Promise<T> {
    const res = await this.request(method, path, opts);
    const text = await res.text();
    const ok = opts.expect !== undefined ? res.status === opts.expect : res.status === 200 || res.status === 201;
    if (!ok) throw new Error(`${method} ${path} → ${res.status} (expected ${opts.expect ?? '200/201'}): ${text.slice(0, 800)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  // ── domain setup through the real surfaces ─────────────────────────────────
  /** A project created through the ledger API, backed by a fresh git repo. */
  async project(as: TestUser, name: string, files?: Record<string, string>): Promise<{ projectId: string; repo: string; slug: string }> {
    const repo = join(this.root, 'repos', `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomBytes(3).toString('hex')}`);
    initRepo(repo, { files: files ?? { 'README.md': `# ${name}\n`, 'src/claims.ts': 'export const claims = [];\n' } });
    const p = await this.api<{ projectId: string; slug: string }>('POST', '/api/projects', { as, body: { name, repoPath: repo, defaultBranch: 'main' } });
    return { projectId: p.projectId, repo, slug: p.slug };
  }

  /** Launch a managed session as the supervisor would (owner = the launching user). */
  async launch(owner: TestUser | Actor, req: Partial<LaunchRequest> & { projectId: string }): Promise<LaunchedSession> {
    const actor: Actor = 'user' in owner ? { kind: 'human', id: owner.user.id } : owner;
    const { sessionId } = await this.supervisor.launch(
      { processType: 'discovery', prompt: 'Build the claims intake parser with tests.', ...req },
      actor,
    );
    return this.supervisor.sessions.get(sessionId)!;
  }

  events(q: ListQuery = {}): StoredEvent[] {
    return this.store.list({ limit: 100_000, ...q });
  }
}
