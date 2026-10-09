/**
 * Real-CLI checks (opt-in, AOC_REAL_CLI=1): the production aocd modules, hook, MCP-server and sidecar binaries against
 * the REAL `claude` CLI (never claude-sim), routed to Haiku by a throwaway process-type registry. Everything lives in
 * temp dirs; the session environment is built from an allowlist, so nothing of the caller's environment but the auth
 * and proxy variables below reaches the CLI. See docs/research/claude-code-integration.md ("Verified against the real CLI").
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DecisionCardView, DecisionListResponse, SessionDetail, StoredEvent } from '@aoc/contracts';
import { defaultConfig } from '@aoc/contracts';
import { serviceRepoPathFor } from '@aoc/supervisor';
import { bin } from '../test/bin';
import { Harness, waitFor, type TestUser } from '../test/harness';
import { E2E_DIR, REPO_ROOT } from '../test/paths';

export const REAL_CLI_ENABLED = process.env.AOC_REAL_CLI === '1';

/**
 * Auth and network variables passed from the caller's environment to the sessions (they are allowlisted on top of the
 * supervisor's default list). Host-managed auth (ANTHROPIC_BASE_URL + CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST) works
 * with a fresh config dir; with OAuth on a workstation set AOC_REAL_CLI_CLAUDE_CONFIG_DIR to the logged-in config dir
 * or export CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY.
 */
export const REAL_CLI_ENV = [
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
] as const;

const TEE_CLAUDE = join(E2E_DIR, 'real-cli', 'claude-tee.mjs');
const TEE_HOOK = join(E2E_DIR, 'real-cli', 'hook-tee.mjs');

type Json = Record<string, unknown>;

export interface RealCliOptions {
  /** Directory that receives the raw stream-json, hook inputs, transcripts and event dumps (default: AOC_REAL_CLI_CAPTURE, else a temp dir). */
  captureDir?: string;
  /** Extra deep-merged config (AocConfigSchema input). */
  config?: Json;
  /** Extra environment for the sessions (must also be allowlisted, see `allow`). */
  env?: Record<string, string>;
  allow?: string[];
  /**
   * A credential profile that may push the given branches through the supervisor's gateway, and the `smoke-push`
   * type that holds it. `env` is the credential aocd alone keeps (a canary in tests: it must never reach a session).
   */
  pushProfile?: { name: string; refs: string[]; env?: Record<string, string> };
}

/**
 * Haiku twins of the production builder and triage types: same permission mode, tool policy and plan rules. With a
 * `pushProfile` name there is a third, `smoke-push`, that holds that credential profile.
 */
export function smokeRegistry(pushProfile?: string): Json {
  const prod = JSON.parse(readFileSync(join(REPO_ROOT, 'config', 'process-types.json'), 'utf8')) as { types: Json[] };
  const twin = (id: string, as: string, name: string): Json => {
    const t = prod.types.find((x) => x.id === id);
    if (!t) throw new Error(`config/process-types.json has no ${id} type`);
    return { ...t, id: as, name, description: `Real-CLI check twin of ${id} on Haiku.`, class: t.class === 'discovery' ? 'execution' : t.class, model: 'haiku', executionModel: null, credentialProfile: null };
  };
  const types = [twin('feature-build', 'smoke', 'Real CLI build'), twin('bug-triage', 'smoke-triage', 'Real CLI triage')];
  if (pushProfile) types.push({ ...twin('feature-build', 'smoke-push', 'Real CLI build with a push profile'), credentialProfile: pushProfile });
  return { version: 'real-cli', types };
}

export function claudeBinary(): string {
  return process.env.AOC_REAL_CLI_CLAUDE ?? 'claude';
}

export interface RealCli {
  h: Harness;
  dev: TestUser;
  ceo: TestUser;
  captureDir: string;
  tmp: string;
  close(): Promise<void>;
}

export async function startRealCli(o: RealCliOptions = {}): Promise<RealCli> {
  const tmp = mkdtempSync(join(tmpdir(), 'aoc-real-cli-'));
  const registryFile = join(tmp, 'process-types.json');
  writeFileSync(registryFile, JSON.stringify(smokeRegistry(o.pushProfile?.name), null, 2));
  const profilesFile = join(tmp, 'credential-profiles.json');
  if (o.pushProfile) {
    const { name, refs, env: credential = {} } = o.pushProfile;
    writeFileSync(profilesFile, JSON.stringify({ profiles: { [name]: { env: credential, push: { refs } } } }), { mode: 0o600 });
  }
  const captureDir = o.captureDir ?? process.env.AOC_REAL_CLI_CAPTURE ?? join(tmp, 'capture');
  mkdirSync(captureDir, { recursive: true });
  const claude = claudeBinary();
  const hook = [process.execPath, bin('aoc-hook')];
  const env: Record<string, string> = {};
  for (const k of REAL_CLI_ENV) if (process.env[k]) env[k] = process.env[k]!;
  Object.assign(env, o.env);
  const configDir = process.env.AOC_REAL_CLI_CLAUDE_CONFIG_DIR;
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  const h = await Harness.start({
    supervisor: 'real',
    simEnv: env,
    config: {
      registryFile,
      supervisor: {
        // The capture wrappers sit between the supervisor and claude / aoc-hook; they pass everything through.
        claudeBin: process.execPath,
        claudeArgsPrefix: [TEE_CLAUDE, '--capture-dir', captureDir, '--claude', claude, '--'],
        hookCommand: [process.execPath, TEE_HOOK, captureDir, ...hook],
        envAllowlist: [...defaultConfig().supervisor.envAllowlist, ...REAL_CLI_ENV, ...(o.allow ?? [])],
        ...(o.pushProfile && { credentialProfilesFile: profilesFile }),
      },
      // The real model is slower than the simulator: keep the liveness windows wide so a thinking turn is not Dead.
      liveness: { workingWindowMs: 10_000, stallAfterMs: 180_000, toolStallAfterMs: 180_000, deadAfterMs: 30_000 },
      ...o.config,
    },
  });
  const dev = await h.user('builder', 'Real CLI Builder');
  const ceo = await h.user('approver', 'Real CLI Approver');
  return {
    h,
    dev,
    ceo,
    captureDir,
    tmp,
    async close() {
      await h.close();
      if (process.env.AOC_REAL_CLI_KEEP !== '1') rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** A tiny project: a README and a `test` script, in a fresh git repo. `testMs` makes the test script take that long. */
export async function tinyProject(r: RealCli, name = 'Tiny', testMs = 0): Promise<{ projectId: string; repo: string }> {
  const { projectId, repo } = await r.h.project(r.dev, name, {
    'README.md': `# ${name}\n\nA tiny project for AOC real-CLI checks.\n`,
    'package.json': JSON.stringify({ name: 'tiny', version: '1.0.0', private: true, scripts: { test: 'node test.js' } }, null, 2) + '\n',
    'test.js': testMs ? `setTimeout(() => console.log('tests pass'), ${testMs});\n` : "console.log('tests pass');\n",
  });
  return { projectId, repo };
}

export async function launch(r: RealCli, processType: string, projectId: string, prompt: string, as: TestUser = r.dev): Promise<string> {
  const res = await r.h.api<{ sessionId: string }>('POST', '/api/sessions', { as, body: { processType, projectId, prompt }, expect: 201 });
  return res.sessionId;
}

export const detail = (r: RealCli, sessionId: string, as: TestUser = r.ceo) => r.h.api<SessionDetail>('GET', `/api/sessions/${sessionId}`, { as });

export function until(r: RealCli, sessionId: string, pred: (d: SessionDetail) => boolean, what: string, timeout = 240_000): Promise<SessionDetail> {
  return waitFor(async () => {
    const d = await detail(r, sessionId);
    return pred(d) && d;
  }, { timeout, interval: 500, what });
}

export function waitUntil<T>(fn: () => T | Promise<T>, what: string, timeout = 240_000) {
  return waitFor(fn, { timeout, interval: 500, what });
}

export const ended = (d: SessionDetail) => d.lifecycle === 'ended' || d.lifecycle === 'failed' || d.lifecycle === 'retired';

export const eventsOf = (r: RealCli, sessionId: string, types?: string[]): StoredEvent[] =>
  r.h.events({ sessionId, ...(types ? { types: types as never } : {}) });

export const payloadOf = (r: RealCli, e: StoredEvent) => r.h.store.readPayload(e) as Record<string, unknown> | null;

export async function openDecisions(r: RealCli, sessionId: string): Promise<DecisionCardView[]> {
  return (await r.h.api<DecisionListResponse>('GET', `/api/decisions?sessionId=${sessionId}&status=open`, { as: r.ceo })).decisions;
}

export async function answer(r: RealCli, card: DecisionCardView, optionId: string, comment?: string): Promise<void> {
  await r.h.api('POST', `/api/decisions/${card.id}/resolve`, { as: r.ceo, body: { optionId, ...(comment ? { comment } : {}) } });
}

/** Git with none of the global or system configuration of the machine running the checks (signing, push negotiation, ...). */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
export const git = (repo: string, ...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: GIT_ENV }).trim();

/** The transcript Claude Code wrote for a session (path recorded by session.launched). */
export function transcriptOf(r: RealCli, sessionId: string): { path: string; lines: Json[] } | null {
  const launched = eventsOf(r, sessionId, ['session.launched'])[0];
  const path = launched ? (payloadOf(r, launched)?.transcriptPath as string | undefined) : undefined;
  if (!path || !existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Json);
  return { path, lines };
}

/** Writes everything worth keeping of a session next to the raw captures: events, operator output, transcript. */
export async function dumpSession(r: RealCli, sessionId: string, label: string): Promise<void> {
  const dir = join(r.captureDir, label);
  mkdirSync(dir, { recursive: true });
  const events = r.h.events({ sessionId }).map((e) => ({ seq: e.seq, type: e.type, actor: e.actor, source: e.source, meta: e.meta, payload: payloadOf(r, e) }));
  writeFileSync(join(dir, 'events.json'), JSON.stringify(events, null, 2));
  const out = await r.h.api('GET', `/api/sessions/${sessionId}/output`, { as: r.dev });
  writeFileSync(join(dir, 'output.json'), JSON.stringify(out, null, 2));
  writeFileSync(join(dir, 'detail.json'), JSON.stringify(await detail(r, sessionId), null, 2));
  const t = transcriptOf(r, sessionId);
  if (t) {
    copyFileSync(t.path, join(dir, 'transcript.jsonl'));
    const subs = join(dirname(t.path), t.path.split('/').pop()!.replace(/\.jsonl$/, ''), 'subagents');
    if (existsSync(subs)) for (const f of readdirSync(subs)) copyFileSync(join(subs, f), join(dir, `subagent-${f}`));
  }
}

// ── what the real CLI and the hooks did, from the capture wrappers ─────────────────────────────────────────────

export interface HookCapture {
  at: string;
  event: string;
  elapsedMs: number;
  exitCode: number | null;
  input: Json;
  stdout: string;
  stderr: string;
}

/** Every hook invocation Claude Code made (hook-tee.mjs), in order. */
export function hooksCaptured(r: RealCli): HookCapture[] {
  const file = join(r.captureDir, 'hooks.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as HookCapture);
}

/** The session's `npm test` is running: Claude Code called PreToolUse for it and has not yet called PostToolUse. */
export const testing = (r0: RealCli, sessionId: string) => () => {
  const claudeId = eventsOf(r0, sessionId, ['session.launched'])[0]?.meta.claudeSessionId;
  const hooks = hooksCaptured(r0).filter((h) => h.input.session_id === claudeId);
  const pre = hooks.findLast((h) => h.event === 'PreToolUse' && h.input.tool_name === 'Bash' && /npm (run )?test|node test\.js/.test(String((h.input.tool_input as { command?: string }).command)));
  return !!pre && !hooks.some((h) => h.event === 'PostToolUse' && h.input.tool_use_id === pre.input.tool_use_id);
};

/** The stream-json lines of each turn of an AOC session, as claude printed them (claude-tee.mjs). */
export function streamsOf(r: RealCli, aocSessionId: string): Json[][] {
  const prefix = `${aocSessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.turn-`;
  return readdirSync(r.captureDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.stream.jsonl'))
    .sort((a, b) => Number(a.slice(prefix.length).split('.')[0]) - Number(b.slice(prefix.length).split('.')[0]))
    .map((f) => readFileSync(join(r.captureDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Json));
}

export const resultsOf = (turns: Json[][]): Json[] => turns.map((t) => t.find((o) => o.type === 'result')).filter((o): o is Json => !!o);

/** tool_use blocks of one turn, in order, with the stream line index (for ordering checks). */
export function toolUses(turn: Json[]): { index: number; name: string; id: string; input: Json }[] {
  const out: { index: number; name: string; id: string; input: Json }[] = [];
  turn.forEach((o, index) => {
    if (o.type !== 'assistant') return;
    for (const b of ((o.message as Json).content as Json[]) ?? []) {
      if (b.type === 'tool_use') out.push({ index, name: b.name as string, id: b.id as string, input: (b.input ?? {}) as Json });
    }
  });
  return out;
}

/**
 * Waits until every finished turn of the session has been reconciled (the supervisor does that once the turn's sidecar
 * has made its last report), then returns the usage the platform recorded, summed over its batches, and the
 * reconciliation status of each turn (the sidecar's figures against claude's own result.modelUsage, G-44).
 */
export async function recordedUsage(
  r: RealCli,
  sessionId: string,
): Promise<{ input: number; output: number; cacheRead: number; cacheWrite: number; messages: number; reconciliation: string[] }> {
  await waitFor(
    () => {
      const turns = eventsOf(r, sessionId, ['session.turn_ended']).length;
      return turns > 0 && eventsOf(r, sessionId, ['usage.reconciled']).length >= turns;
    },
    { timeout: 60_000, what: "every turn's usage to be reconciled (the sidecar's last report)" },
  );
  const batches = eventsOf(r, sessionId, ['usage.recorded']);
  const sum = (k: string) => batches.reduce((n, e) => n + (e.meta[k] as number), 0);
  return {
    input: sum('inputTokens'),
    output: sum('outputTokens'),
    cacheRead: sum('cacheReadTokens'),
    cacheWrite: sum('cacheWrite5mTokens') + sum('cacheWrite1hTokens'),
    messages: sum('messages'),
    reconciliation: eventsOf(r, sessionId, ['usage.reconciled']).map((e) => String(e.meta.status)),
  };
}

/**
 * The push gateway's repository for a project, with `upstream` (a bare repository) as the `origin` the supervisor
 * forwards allowed branches to. The gateway creates this repository at a session's first push, too late to name an
 * upstream, so the test makes it the same way first.
 */
export function addServiceUpstream(r: RealCli, projectId: string, upstream: string): string {
  const repo = serviceRepoPathFor(join(r.h.dataDir, 'git'), projectId);
  mkdirSync(dirname(repo), { recursive: true });
  git(dirname(repo), 'init', '--quiet', '--bare', '--template=', '--initial-branch=aoc-service-clone', repo);
  git(dirname(repo), `--git-dir=${repo}`, 'remote', 'add', 'origin', upstream);
  return repo;
}

/** A bare repository that serves as `origin` of a project repo (the initial commit is pushed to it). */
export function addBareOrigin(repo: string, bare: string): void {
  git(dirname(bare), 'init', '-q', '--bare', '-b', 'main', bare);
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', 'origin', 'main');
}

// ── a run in numbers ─────────────────────────────────────────────────────────────────────────────────────────────

export interface RunReport {
  lifecycle: string;
  /** plan.declared was recorded before the first Bash / file-changing tool call, and no plan-gate denial happened. */
  planFirst: boolean;
  planGateDenials: number;
  tasksDeclared: number;
  tasksDone: number;
  /** Closed with evidence the ledger verified (the flag, e.g. no_file_change for a commit task, is separate). */
  tasksVerified: number;
  flags: (string | null)[];
  turns: number;
  outcomes: string[];
  decisions: number;
  toolDenials: string[];
  /** Sorted names of every tool the model called, as the hooks saw them. */
  tools: string[];
}

export async function reportOf(r: RealCli, sessionId: string): Promise<RunReport> {
  const events = eventsOf(r, sessionId);
  const of = (type: string) => events.filter((e) => e.type === type);
  const plan = of('plan.declared')[0];
  const firstWork = of('tool.used').find((e) => e.meta.toolName === 'Bash' || e.meta.fileChanging === true);
  const denials = of('tool.denied');
  const done = of('task.done');
  return {
    lifecycle: (await detail(r, sessionId)).lifecycle,
    planFirst: !!plan && (!firstWork || plan.seq < firstWork.seq) && !denials.some((e) => e.meta.guard === 'no-manifest'),
    planGateDenials: denials.filter((e) => e.meta.guard === 'no-manifest').length,
    tasksDeclared: plan ? (plan.meta.taskCount as number) : 0,
    tasksDone: done.length,
    tasksVerified: done.filter((e) => e.meta.evidenceVerified === true).length,
    flags: done.map((e) => (e.meta.flag as string | null) ?? null),
    turns: of('session.turn_started').length,
    outcomes: of('session.turn_ended').map((e) => String(e.meta.outcome)),
    decisions: of('decision.requested').length,
    toolDenials: denials.map((e) => `${String(e.meta.toolName)}:${String(e.meta.guard)}`),
    tools: of('tool.used').map((e) => String(e.meta.toolName)).sort(),
  };
}
