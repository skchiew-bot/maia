/**
 * Live demo launcher — `pnpm --filter @aoc/demo live -- --data-dir <abs dir> [--port 7420] [--reset] [--no-ui]
 * [--relaunch-after <seconds>]`
 *
 * One command for a genuinely live console: seeds the history when the directory is empty (or with --reset),
 * refuses to start unless managed sessions run on claude-sim, starts aocd as a child process, and keeps a fleet of
 * real managed sessions going through POST /api/sessions as the demo Builders (see ./fleet.ts). Ctrl-C stops the
 * running sessions through the API, then the daemon — only processes this launcher started, by PID.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AocConfigSchema } from '@aoc/contracts';
import { daemonEnv } from './daemon-env';
import { DEFAULT_TIMING, FLEET, launchBody, loadFleet, nextAction, saveFleet, type FleetState, type KeeperTiming, type SessionStatus, type SlotSpec } from './fleet';
import { demoLayout, isSeeded, readDemoTokens, resetDemoDir, type DemoLayout, type DemoTokens } from './layout';
import { claudeSimProblem } from './sim-guard';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const HERE = dirname(fileURLToPath(import.meta.url));
const TICK_MS = 10_000;
const RUNNING_STATES = 'launching,running';

interface LiveOptions {
  dataDir: string;
  port: number;
  reset: boolean;
  ui: boolean;
  timing: KeeperTiming;
}

function parseOptions(argv: readonly string[]): LiveOptions {
  const o: LiveOptions = { dataDir: join(REPO, '.aoc/demo'), port: 7420, reset: false, ui: true, timing: { ...DEFAULT_TIMING } };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--') continue;
    else if (a === '--data-dir') o.dataDir = value();
    else if (a === '--port') o.port = Number(value());
    else if (a === '--reset') o.reset = true;
    else if (a === '--no-ui') o.ui = false;
    else if (a === '--relaunch-after') o.timing.relaunchAfterMs = Number(value()) * 1000;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error('--port must be 1-65535');
  if (!Number.isFinite(o.timing.relaunchAfterMs) || o.timing.relaunchAfterMs < 0) throw new Error('--relaunch-after must be a number of seconds');
  return o;
}

const stamp = () => new Date().toTimeString().slice(0, 8);
const say = (line: string) => console.log(`${stamp()}  ${line}`);

function tsxImport(): string {
  return pathToFileURL(createRequire(join(REPO, 'package.json')).resolve('tsx')).href;
}

// ── preparation ───────────────────────────────────────────────────────────────

function prepareDataDir(layout: DemoLayout, reset: boolean): void {
  if (reset) resetDemoDir(layout);
  if (isSeeded(layout)) return;
  if (existsSync(layout.root) && readdirSync(layout.root).length) {
    throw new Error(`${layout.root} is not empty but holds no complete demo; pass an empty directory or add --reset`);
  }
  say(`Seeding ${layout.root} (14 days of history, about 10 s)…`);
  const r = spawnSync(process.execPath, ['--import', tsxImport(), join(HERE, 'seed.ts'), '--data-dir', layout.root], { stdio: 'inherit', cwd: join(REPO, 'packages/demo') });
  if (r.status !== 0) throw new Error(`seeding failed (${r.signal ?? `exit ${r.status}`})`);
}

/** The daemon config, refused unless every managed session runs on claude-sim. */
function checkConfig(layout: DemoLayout): void {
  const parsed = AocConfigSchema.safeParse(JSON.parse(readFileSync(layout.config, 'utf8')));
  if (!parsed.success) throw new Error(`${layout.config} is not a valid aocd config`);
  const problem = claudeSimProblem(parsed.data.supervisor, dirname(layout.config));
  if (problem) throw new Error(problem);
  if (parsed.data.fx.extractor === 'anthropic-sdk') throw new Error('fx.extractor "anthropic-sdk" would call a real model; the demo uses "fake"');
}

/** The source-run daemon serves packages/web/dist; build it once when it is missing. */
function ensureUi(): void {
  const index = join(REPO, 'packages/web/dist/index.html');
  if (existsSync(index)) return;
  say('Building the console UI (one time)…');
  const webRoot = join(REPO, 'packages/web');
  const vite = join(dirname(createRequire(join(webRoot, 'package.json')).resolve('vite/package.json')), 'bin', 'vite.js');
  const r = spawnSync(process.execPath, [vite, 'build'], { cwd: webRoot, stdio: 'inherit' });
  if (r.status !== 0 || !existsSync(index)) say('UI build failed: aocd will serve the API only (run `pnpm build` and restart).');
}

// ── the daemon ────────────────────────────────────────────────────────────────

function startDaemon(layout: DemoLayout, port: number): ChildProcess {
  mkdirSync(layout.logs, { recursive: true });
  const log = openSync(join(layout.logs, 'aocd.log'), 'a');
  // Own process group: a terminal Ctrl-C reaches only the launcher, which stops sessions before the daemon.
  const child = spawn(process.execPath, ['--import', tsxImport(), join(REPO, 'packages/daemon/src/main.ts')], {
    cwd: REPO,
    env: daemonEnv(layout, port),
    stdio: ['ignore', log, log],
    detached: true,
  });
  closeSync(log);
  return child;
}

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

function exited(child: ChildProcess, ms: number): Promise<boolean> {
  if (!alive(child)) return Promise.resolve(true);
  return new Promise((done) => {
    const timer = setTimeout(() => done(!alive(child)), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      done(true);
    });
  });
}

async function waitHealthy(base: string, daemon: ChildProcess, logFile: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (!alive(daemon)) throw new Error(`aocd exited during startup; see ${logFile}`);
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`aocd did not become healthy within 90 s; see ${logFile}`);
}

// ── the API ───────────────────────────────────────────────────────────────────

interface SessionSummary {
  sessionId: string;
  title: string;
  lifecycle: string;
  liveness: { state: string | null; reason: string } | null;
  successorSessionId?: string | null;
}

class Api {
  constructor(private readonly base: string) {}

  async call<T>(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; data: T | null }> {
    const r = await fetch(this.base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let data: T | null = null;
    try {
      data = text ? (JSON.parse(text) as T) : null;
    } catch {
      // non-JSON error page
    }
    return { status: r.status, data };
  }
}

// ── the fleet keeper ──────────────────────────────────────────────────────────

class Keeper {
  private readonly seen = new Map<string, { sessionId: string; lifecycle: string; at: number; liveness: string | null }>();
  private readonly lastError = new Map<string, number>();
  /** Sessions that ended before this launcher started (a previous run) are replaced at once, without the pause. */
  private firstTick = true;

  constructor(
    private readonly api: Api,
    private readonly tokens: DemoTokens,
    private readonly file: string,
    private readonly timing: KeeperTiming,
    private readonly state: FleetState,
  ) {
    for (const slot of FLEET) {
      this.state[slot.key] ??= { sessionId: slot.seeded ? tokens.sessions[slot.seeded] : null, runs: 0 };
    }
  }

  async tick(): Promise<void> {
    for (const slot of FLEET) {
      try {
        await this.step(slot);
      } catch (err) {
        this.complain(slot, `keeper error: ${(err as Error).message}`);
      }
    }
    this.firstTick = false;
    saveFleet(this.file, this.state);
  }

  private async step(slot: SlotSpec): Promise<void> {
    const st = this.state[slot.key]!;
    const s = st.sessionId ? await this.session(st.sessionId) : null;
    const status: SessionStatus | null = s ? { lifecycle: s.lifecycle, successorSessionId: s.successorSessionId ?? null } : null;
    const now = Date.now();
    let mark = this.seen.get(slot.key);
    if (s && (mark?.sessionId !== s.sessionId || mark.lifecycle !== s.lifecycle)) {
      const ranEarlier = this.firstTick && (s.lifecycle === 'ended' || s.lifecycle === 'retired');
      mark = { sessionId: s.sessionId, lifecycle: s.lifecycle, at: ranEarlier ? 0 : now, liveness: mark?.sessionId === s.sessionId ? mark.liveness : null };
      this.seen.set(slot.key, mark);
    }
    if (s && mark && mark.liveness !== (s.liveness?.state ?? s.lifecycle)) {
      mark.liveness = s.liveness?.state ?? s.lifecycle;
      say(`${slot.key.padEnd(9)} ${label(s).padEnd(15)} ${s.title}`);
    }
    const action = nextAction(st, status, mark?.at ?? now, now, { ...this.timing, relaunchAfterMs: this.timing.relaunchAfterMs * (slot.relaunchFactor ?? 1) });
    switch (action.kind) {
      case 'keep':
        return;
      case 'follow':
        say(`${slot.key.padEnd(9)} rolled over to a fresh session ${action.sessionId}`);
        st.sessionId = action.sessionId;
        return;
      case 'replace': {
        const r = await this.api.call('POST', `/api/sessions/${action.stopSessionId}/stop`, this.tokens.tokens[slot.owner].token, { immediate: true, reason: 'live demo: replaced by a fresh run' });
        if (r.status >= 300) return this.complain(slot, `could not stop ${action.stopSessionId}: HTTP ${r.status}`);
        return this.launch(slot);
      }
      case 'launch':
        return this.launch(slot);
    }
  }

  private async launch(slot: SlotSpec): Promise<void> {
    const r = await this.api.call<{ sessionId: string }>('POST', '/api/sessions', this.tokens.tokens[slot.owner].token, launchBody(slot, this.tokens));
    if (r.status !== 201 || !r.data?.sessionId) {
      return this.complain(slot, `launch refused: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
    }
    const st = this.state[slot.key]!;
    st.sessionId = r.data.sessionId;
    st.runs++;
    say(`${slot.key.padEnd(9)} launched        ${slot.title} (${slot.owner}, ${slot.processType}, scenario ${slot.scenario})`);
  }

  private async session(id: string): Promise<SessionSummary | null> {
    const r = await this.api.call<SessionSummary>('GET', `/api/sessions/${id}`, this.tokens.tokens.ceo.token);
    if (r.status === 404) return null;
    if (r.status !== 200 || !r.data) throw new Error(`GET /api/sessions/${id}: HTTP ${r.status}`);
    return r.data;
  }

  /** At most one line per slot per minute: a refusal repeats every tick until its cause is gone. */
  private complain(slot: SlotSpec, msg: string): void {
    const now = Date.now();
    if (now - (this.lastError.get(slot.key) ?? 0) < 60_000) return;
    this.lastError.set(slot.key, now);
    say(`${slot.key.padEnd(9)} ${msg}`);
  }
}

function label(s: SessionSummary): string {
  const state = s.liveness?.state;
  if (state) return state.replace(/_/g, ' ');
  return s.lifecycle === 'ended' ? 'completed' : s.lifecycle;
}

/** Stops every managed session that has (or is about to get) a process; waiting and throttled ones keep. */
async function stopRunningSessions(api: Api, ceo: string): Promise<void> {
  const list = async () => (await api.call<SessionSummary[]>('GET', `/api/sessions?mode=managed&state=${RUNNING_STATES}`, ceo)).data ?? [];
  for (const s of await list()) {
    await api.call('POST', `/api/sessions/${s.sessionId}/stop`, ceo, { immediate: true, reason: 'live demo stopped' }).catch(() => undefined);
  }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && (await list()).length) await new Promise((r) => setTimeout(r, 500));
}

// ── main ──────────────────────────────────────────────────────────────────────

function banner(o: LiveOptions, layout: DemoLayout, tokens: DemoTokens, daemon: ChildProcess): string {
  const slots = FLEET.map((s) => `    ${s.shows.padEnd(34)} ${s.key.padEnd(10)} ${s.title}`).join('\n');
  return [
    '',
    'AOC live demo — every moving mark on the console comes from a real managed session',
    '(supervisor → claude-sim → hooks, AOC MCP server, sidecar). The real claude CLI is never run.',
    '',
    `  Console   http://localhost:${o.port}/`,
    `  Sign in   paste the CEO (Approver) token: ${tokens.tokens.ceo.token}`,
    `  Data      ${layout.root}   (aocd pid ${daemon.pid}, log ${join(layout.logs, 'aocd.log')})`,
    '',
    '  Fleet (relaunched when a run finishes):',
    slots,
    '  Seeded too: a decision waiting on you (answer it and the session resumes), a throttled session,',
    '  a dead docs session (press Restart), an observed developer terminal.',
    '',
    '  Ctrl-C stops the running sessions, then the daemon.',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const o = parseOptions(process.argv.slice(2));
  const layout = demoLayout(o.dataDir);
  prepareDataDir(layout, o.reset);
  checkConfig(layout);
  if (o.ui) ensureUi();
  const tokens = readDemoTokens(layout);
  const base = `http://127.0.0.1:${o.port}`;
  const logFile = join(layout.logs, 'aocd.log');

  const daemon = startDaemon(layout, o.port);
  // The daemon never outlives the launcher, even when the launcher dies on an error.
  process.on('exit', () => {
    if (alive(daemon) && daemon.pid) process.kill(daemon.pid, 'SIGTERM');
  });
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  const api = new Api(base);
  const fleet = loadFleet(layout.fleet);
  const shutdown = async (code: number): Promise<void> => {
    if (stopping) {
      say('Second signal: stopping aocd without waiting for the sessions.');
      if (alive(daemon) && daemon.pid) process.kill(daemon.pid, 'SIGTERM');
      process.exit(1);
    }
    stopping = true;
    if (timer) clearInterval(timer);
    say('Stopping the running sessions, then aocd…');
    if (alive(daemon)) await stopRunningSessions(api, tokens.tokens.ceo.token).catch(() => undefined);
    saveFleet(layout.fleet, fleet);
    if (alive(daemon) && daemon.pid) {
      process.kill(daemon.pid, 'SIGTERM');
      if (!(await exited(daemon, 30_000))) {
        say('aocd did not stop within 30 s; killing it.');
        process.kill(daemon.pid, 'SIGKILL');
        await exited(daemon, 5_000);
      }
    }
    say('Stopped.');
    process.exit(code);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => void shutdown(0));
  daemon.on('exit', (code, signal) => {
    if (stopping) return;
    say(`aocd exited unexpectedly (${signal ?? `exit ${code}`}); see ${logFile}`);
    void shutdown(1);
  });

  await waitHealthy(base, daemon, logFile);
  const keeper = new Keeper(api, tokens, layout.fleet, o.timing, fleet);
  console.log(banner(o, layout, tokens, daemon));
  await keeper.tick();
  timer = setInterval(() => void keeper.tick(), TICK_MS);
}

main().catch((err: unknown) => {
  console.error(`live demo: ${(err as Error).message}`);
  process.exit(1);
});
