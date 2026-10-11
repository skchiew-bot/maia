/**
 * E2E harness: the real aocd composition root (`createAocServer` from @aoc/daemon) with the production module list
 * (`createDefaultModules`), served over real HTTP (@hono/node-server) with an on-disk data dir, so the daemon can
 * be stopped and restarted under running sessions. Identities are real (mod-identity): the bootstrap Approver
 * creates every other user and token through the API.
 *
 * Two ways to run managed sessions:
 * - `supervisor: 'real'`: mod-supervisor spawns claude-sim (never the real claude CLI) with the real hook, MCP
 *   server and sidecar entries, exactly as in production.
 * - `supervisor: 'stub'` (default): `StubSupervisor` records the launch events the supervisor would and issues the
 *   session's ingest token; the test then plays the claude process itself (claude.ts drives the real binaries).
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
  defaultConfig,
  newId,
  transcriptPathFor,
  type Actor,
  type AocConfig,
  type IdentityUserDto,
  type IssuedTokenDto,
  type LaunchRequest,
  type Role,
  type StoredEvent,
  type SupervisorService,
} from '@aoc/contracts';
import { createAocServer, createDefaultModules, type AocServer } from '@aoc/daemon';
import {
  createLogger,
  FakeLlm,
  initRepo,
  silentLogger,
  type AocModule,
  type Clock,
  type EventStore,
  type ListQuery,
  type ModuleContext,
} from '@aoc/kernel';
import { createIdentityModule } from '@aoc/mod-identity';
import { createSessionsModule } from '@aoc/mod-sessions';
import { createSupervisorModule } from '@aoc/supervisor';
import { bin } from './bin';
import { REPO_ROOT } from './paths';

// ── small utilities ───────────────────────────────────────────────────────────

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Truthy<T> = Exclude<T, false | 0 | '' | null | undefined>;

/** Poll until `fn` returns a truthy value (or stops throwing); fails with the last value seen. */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  opts: { timeout?: number; interval?: number; what?: string } = {},
): Promise<Truthy<T>> {
  const deadline = Date.now() + (opts.timeout ?? 10_000);
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as Truthy<T>;
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

/** The real clock, plus an offset the test can move forward (e.g. past a plan-limit reset) without waiting. */
export class OffsetClock implements Clock {
  offsetMs = 0;
  now(): number {
    return Date.now() + this.offsetMs;
  }
  iso(): string {
    return new Date(this.now()).toISOString();
  }
  advance(ms: number): void {
    this.offsetMs += ms;
  }
}

const SUPERVISOR: Actor = { kind: 'system', id: 'supervisor' };

export interface TestUser {
  user: IdentityUserDto;
  token: string;
  headers: Record<string, string>;
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
  /** The session's ingest token (the supervisor hands it to hooks and the MCP server, in the claude env). */
  token: string;
  /** The session's sidecar token (the supervisor hands it to the sidecar only, G-44). */
  sidecarToken: string;
  /** pid of the stand-in "claude" process (a sleeper) the sidecar watches. */
  pid: number;
  claude: ChildProcess;
}

/**
 * The supervisor's launch bookkeeping without its process management (SupervisorService), for scenarios in which
 * the test plays the claude process itself: thread ensured, writer lock, session.launch_requested → launched →
 * running → turn 1, a real ingest token, and a sleeper standing in for `claude` whose pid the sidecar watches.
 */
export class StubSupervisor implements SupervisorService {
  readonly sessions = new Map<string, LaunchedSession>();
  readonly calls: { method: string; sessionId: string | null; args: unknown[] }[] = [];
  private ctx: ModuleContext | null = null;
  private readonly launchWaiters: ((s: LaunchedSession) => void)[] = [];

  constructor(private readonly claudeConfigDir: string) {}

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
    const token = ctx.services.get('identity').issueIngestToken(sessionId, SUPERVISOR);
    const sidecarToken = ctx.services.get('identity').issueSidecarToken(sessionId, SUPERVISOR);
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
      sidecarToken,
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
    ctx.services.get('identity').revokeIngestTokensFor(sessionId, SUPERVISOR);
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

// ── the harness ───────────────────────────────────────────────────────────────

export interface HarnessOptions {
  /** Deep-merged into the e2e config (AocConfigSchema input). */
  config?: Json;
  /** 'real': mod-supervisor runs claude-sim; 'stub' (default): the test plays the claude process. */
  supervisor?: 'stub' | 'real';
  /** Extra environment for claude-sim sessions (real supervisor), e.g. CLAUDE_SIM_SCENARIO. */
  simEnv?: Record<string, string>;
}

/** claude-sim knobs the supervisor's env allowlist must let through (everything else is dropped, §3). */
const SIM_ENV_KEYS = ['CLAUDE_SIM_SPEED', 'CLAUDE_SIM_SCENARIO', 'CLAUDE_SIM_EXEC', 'CLAUDE_SIM_DEBUG'];

export class Harness {
  readonly root: string;
  readonly dataDir: string;
  /** HOME of every spawned helper: observed client config, default spools, sidecar state. */
  readonly homeDir: string;
  readonly claudeConfigDir: string;
  readonly clock = new OffsetClock();
  readonly llm = new FakeLlm();
  readonly supervisorMode: 'stub' | 'real';
  readonly stub: StubSupervisor;
  config!: AocConfig;
  /** The bootstrap Approver ("Owner"), who creates every other user. */
  owner!: TestUser;
  port = 0;
  private readonly bootstrapToken = `aoc_u_${randomBytes(24).toString('hex')}`;
  private readonly masterKey = randomBytes(32);
  private server: Server | null = null;
  private current: AocServer | null = null;
  private readonly children = new Set<ChildProcess>();

  private constructor(private readonly opts: HarnessOptions) {
    this.root = mkdtempSync(join(tmpdir(), 'aoc-e2e-'));
    this.dataDir = join(this.root, 'data');
    this.homeDir = join(this.root, 'home');
    this.claudeConfigDir = join(this.root, 'claude-config');
    mkdirSync(this.homeDir, { recursive: true });
    mkdirSync(this.claudeConfigDir, { recursive: true });
    this.supervisorMode = opts.supervisor ?? 'stub';
    this.stub = new StubSupervisor(this.claudeConfigDir);
  }

  static async start(opts: HarnessOptions = {}): Promise<Harness> {
    const h = new Harness(opts);
    // Bind first: the supervisor hands sessions the daemon URL (config.publicUrl) and the port is random.
    await h.listen();
    h.config = h.buildConfig();
    await h.boot();
    const me = await h.api<{ user: IdentityUserDto }>('GET', '/api/auth/me', { headers: { authorization: `Bearer ${h.bootstrapToken}` } });
    h.owner = { user: me.user, token: h.bootstrapToken, headers: { authorization: `Bearer ${h.bootstrapToken}` } };
    return h;
  }

  private buildConfig(): AocConfig {
    const url = `http://127.0.0.1:${this.port}`;
    return AocConfigSchema.parse(
      deepMerge(
        {
          dataDir: this.dataDir,
          host: '127.0.0.1',
          port: this.port,
          publicUrl: url,
          timezone: 'Asia/Kuala_Lumpur',
          registryFile: join(REPO_ROOT, 'config', 'process-types.json'),
          // Real clock: short enough to observe transitions, long enough not to flap under load.
          liveness: { workingWindowMs: 5_000, stallAfterMs: 120_000, toolStallAfterMs: 120_000, deadAfterMs: 15_000 },
          supervisor: {
            workspacesDir: join(this.root, 'workspaces'),
            claudeBin: process.execPath,
            claudeArgsPrefix: [bin('claude-sim')],
            hookCommand: [process.execPath, bin('aoc-hook')],
            mcpCommand: [process.execPath, bin('aoc-mcp')],
            sidecarCommand: [process.execPath, bin('aoc-sidecar')],
            envAllowlist: [...defaultConfig().supervisor.envAllowlist, ...SIM_ENV_KEYS],
          },
          metering: { rateCardFile: join(REPO_ROOT, 'config', 'rate-card.json') },
          fx: { extractor: 'fake' },
          audit: { anchorRepoPath: join(this.root, 'anchor-repo') },
          selfModification: { externalAuditLog: join(this.root, 'selfmod-audit.log') },
          compliance: { mappingFile: join(REPO_ROOT, 'config', 'iso42001-mapping.json') },
          identity: { origin: url, rpId: '127.0.0.1' },
          intake: { triageAgents: 1 },
        },
        this.opts.config ?? {},
      ),
    );
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

  /** The env the real supervisor reads its allowlist from: what claude-sim, hooks, MCP server and sidecar inherit. */
  private supervisorEnv(): Record<string, string> {
    return {
      PATH: process.env.PATH ?? '',
      HOME: this.homeDir,
      CLAUDE_CONFIG_DIR: this.claudeConfigDir,
      // Scenario durations at 2% of real time; bash steps marked exec run for real (git commits as evidence).
      CLAUDE_SIM_SPEED: '0.02',
      CLAUDE_SIM_EXEC: '1',
      ...this.opts.simEnv,
    };
  }

  /** Fresh module instances each boot (modules hold per-runtime state): the production list, with test wiring. */
  private compose(): AocModule[] {
    const stub = this.stub;
    return createDefaultModules().map((m) => {
      switch (m.name) {
        case 'identity':
          return createIdentityModule({ env: { AOC_BOOTSTRAP_TOKEN: this.bootstrapToken } });
        case 'sessions':
          // Same module, faster liveness sweep (the production default is 5 s).
          return createSessionsModule({ sweepIntervalMs: 250 });
        case 'supervisor':
          return this.supervisorMode === 'real'
            ? createSupervisorModule({ env: this.supervisorEnv(), sessionsDir: join(this.root, 'sessions'), interruptGraceMs: 3_000 })
            : { name: 'supervisor', init: (ctx: ModuleContext) => (stub.attach(ctx), ctx.services.provide('supervisor', stub)) };
        default:
          return m;
      }
    });
  }

  /** Same port on every (re)start, so the URL the sessions were given stays valid. */
  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = serve(
        {
          fetch: (req, env) => (this.current ? this.current.app.fetch(req, env) : new Response(null, { status: 503 })),
          hostname: '127.0.0.1',
          port: this.port,
        },
        (info: AddressInfo) => {
          this.port = info.port;
          resolve();
        },
      ) as Server;
      s.once('error', reject);
      this.server = s;
    });
  }

  private async boot(): Promise<void> {
    const log = process.env.AOC_E2E_LOG ? createLogger({ level: 'debug' }) : silentLogger;
    this.current = await createAocServer(this.config, {
      log,
      clock: this.clock,
      masterKey: this.masterKey,
      modules: this.compose(),
      llm: this.llm,
      webDir: null,
    });
  }

  /** Take the daemon down (port closed, runtime stopped, DB closed) — clients now see ECONNREFUSED. */
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

  /** Same port, data dir, KEK and config: what a restarted aocd looks like to its clients. */
  async restart(): Promise<void> {
    if (this.current || this.server) await this.stop();
    await this.listen();
    await this.boot();
  }

  async close(): Promise<void> {
    for (const c of this.children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    this.stub.killAll();
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

  // ── identities (mod-identity routes) ───────────────────────────────────────
  async user(role: Role, name?: string, opts: { complianceLead?: boolean } = {}): Promise<TestUser> {
    const created = await this.api<{ user: IdentityUserDto }>('POST', '/api/users', {
      as: this.owner,
      body: { role, name: name ?? `${role} user`, ...(opts.complianceLead ? { flags: { complianceLead: true } } : {}) },
    });
    const issued = await this.api<IssuedTokenDto>('POST', `/api/users/${created.user.id}/tokens`, { as: this.owner, body: { label: 'e2e' } });
    return { user: created.user, token: issued.token, headers: { authorization: `Bearer ${issued.token}` } };
  }

  /** An observer token for one developer (O-6): the owner's unless another user is named. */
  async observerToken(forUser?: TestUser): Promise<string> {
    const userId = (forUser ?? this.owner).user.id;
    return (await this.api<IssuedTokenDto>('POST', '/api/tokens/observer', { as: this.owner, body: { label: 'e2e observer', userId } })).token;
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

  /** Stub supervisor: launch a managed session as the supervisor would (owner = the launching user). */
  async launch(owner: TestUser | Actor, req: Partial<LaunchRequest> & { projectId: string }): Promise<LaunchedSession> {
    const actor: Actor = 'user' in owner ? { kind: 'human', id: owner.user.id } : owner;
    const { sessionId } = await this.stub.launch({ processType: 'discovery', prompt: 'Build the claims intake parser with tests.', ...req }, actor);
    return this.stub.sessions.get(sessionId)!;
  }

  events(q: ListQuery = {}): StoredEvent[] {
    return this.store.list({ limit: 100_000, ...q });
  }
}
