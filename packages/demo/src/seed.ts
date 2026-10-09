/**
 * Demo history seeder — `pnpm --filter @aoc/demo seed -- --data-dir <abs dir> [--days 14] [--reset]`
 *
 * Builds a realistic, catalog-valid history (users, projects with git repos, sessions with manifests/evidence/
 * usage, decisions, playbooks, credits, FX, error-learning, intake tickets) by driving the REAL runtime with a
 * moving fake clock, so every module's projections, the hash chain and anchors are genuine. Deterministic
 * (seeded PRNG). Never use against a production data dir. Layout of the directory: ./layout.ts.
 *
 * "Now" has one session per liveness state. Working, Thinking and Stalled are queued launches: aocd's supervisor
 * starts them on claude-sim when it boots, so everything they show comes from a real managed process. Waiting on
 * you, Throttled and Dead are seeded states (no process) whose next turn — the decision answer, the limit reset,
 * an operator Restart — runs on claude-sim through the supervisor like any other.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import {
  AocConfigSchema,
  MODEL_ID_BY_TIER,
  TASK_SIZE_WEIGHT,
  defaultConfig,
  newId,
  transcriptPathFor,
  type Actor,
  type TaskSize,
} from '@aoc/contracts';
import { simStatePathFor, type SimState } from '@aoc/claude-sim';
import { AocRuntime, FakeClock, createGitService, createLogger, initRepo, localDate, type AocModule, type AppEnv } from '@aoc/kernel';
import { createAuditModule } from '@aoc/mod-audit';
import { createChangeModule } from '@aoc/mod-change';
import { createCreditsModule } from '@aoc/mod-credits';
import { createDecisionsModule } from '@aoc/mod-decisions';
import { createEvidenceModule } from '@aoc/mod-evidence';
import { createFxModule } from '@aoc/mod-fx';
import { createIdentityModule } from '@aoc/mod-identity';
import { createIntakeModule } from '@aoc/mod-intake';
import { createLearningModule } from '@aoc/mod-learning';
import { createLedgerModule } from '@aoc/mod-ledger';
import { createMeteringModule } from '@aoc/mod-metering';
import { createRegistryModule } from '@aoc/mod-registry';
import { createSessionsModule } from '@aoc/mod-sessions';
import { createTowerModule } from '@aoc/mod-tower';
import { SECRET_ENV, simEnv } from './daemon-env';
import { defaultScenario } from './default-scenario';
import { demoLayout, resetDemoDir, type DemoTokens, type LiveKind } from './layout';
import { PROJECT_FILES } from './repos';
import { simPrompt } from './scenarios';
import { CLAUDE_SIM_BIN } from './sim-guard';

// ── deterministic randomness ──────────────────────────────────────────────────
let seed = 20261009;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const between = (a: number, b: number) => Math.round(a + rnd() * (b - a));

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const repoDir = new URL('../../..', import.meta.url).pathname.replace(/\/+$/, '');
const layout = demoLayout(arg('data-dir', join(repoDir, '.aoc/demo')));
const days = Number(arg('days', '14'));
const TZ = 'Asia/Kuala_Lumpur';

if (process.argv.includes('--reset')) resetDemoDir(layout);
if (existsSync(join(layout.root, 'aoc.db'))) {
  console.error(`${layout.root} holds a demo in the old layout (AOC data at the top level). Re-run with --reset.`);
  process.exit(1);
}
if (existsSync(join(layout.aocData, 'aoc.db'))) {
  console.error(`${layout.root} already has data. Re-run with --reset to rebuild the demo.`);
  process.exit(1);
}
mkdirSync(layout.aocData, { recursive: true });

const now = Date.now();
const clock = new FakeClock(now - days * 86_400_000);
/**
 * The daemon config for this demo (written to <dir>/aoc.config.json). Managed sessions run on claude-sim, never the
 * real `claude` CLI, and LLM-backed jobs use the fake extractor: a demo must not spend plan quota or touch real
 * repositories. aocd runs with ./daemon-env.ts's simEnv (claude-sim settings, allowlisted here); credentials never
 * reach sim sessions.
 */
const demoConfig = {
  dataDir: layout.aocData,
  timezone: TZ,
  registryFile: join(repoDir, 'config/process-types.json'),
  metering: { rateCardFile: join(repoDir, 'config/rate-card.json') },
  compliance: { mappingFile: join(repoDir, 'config/iso42001-mapping.json') },
  fx: { enabled: false, extractor: 'fake' as const },
  audit: { anchorProvider: 'git' as const, anchorRepoPath: join(layout.aocData, 'anchor-repo') },
  supervisor: {
    claudeBin: process.execPath,
    claudeArgsPrefix: [CLAUDE_SIM_BIN],
    workspacesDir: layout.workspaces,
    // Seven demo slots plus rollover successors and resumed seeded sessions run side by side.
    maxConcurrentSessions: 12,
    envAllowlist: [
      ...new Set([
        ...defaultConfig().supervisor.envAllowlist.filter((k) => !SECRET_ENV.has(k)),
        ...Object.keys(simEnv(layout)),
        'CLAUDE_SIM_SPEED',
      ]),
    ],
    credentialProfilesFile: layout.credentialProfiles,
  },
  selfModification: { externalAuditLog: join(layout.aocData, 'selfmod-audit.log') },
  credits: { defaultMonthlyAllocationUsd: 300 },
};
const config = AocConfigSchema.parse(demoConfig);

const modules: AocModule[] = [
  createIdentityModule(),
  createRegistryModule(),
  createSessionsModule({ sweepIntervalMs: 0 }),
  createDecisionsModule(),
  createLedgerModule(),
  createMeteringModule(),
  createFxModule(),
  createCreditsModule(),
  createLearningModule(),
  createChangeModule(),
  createAuditModule(),
  createEvidenceModule(),
  createIntakeModule(),
  createTowerModule(),
];

// 'error': the seeder runs without a supervisor, so intake's "cannot start triage" warning is expected noise.
const rt = await AocRuntime.create({ config, modules, clock, log: createLogger({ level: 'error' }) });
const app = rt.mount(new Hono<AppEnv>());
const store = rt.store;
const registry = rt.services.get('registry');
const sys = (id: string): Actor => ({ kind: 'system', id });
const human = (id: string): Actor => ({ kind: 'human', id });
const agent = (id: string): Actor => ({ kind: 'agent', id });
const at = (ms: number) => clock.set(ms);
const t0 = clock.now();
const DAY = 86_400_000;

// ── users & tokens (through the identity API) ─────────────────────────────────
type PersonKey = keyof DemoTokens['tokens'];
const tokens = {} as Record<PersonKey, { userId: string; role: string; token: string }>;
async function api<T>(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; data: T }> {
  const form = body instanceof FormData;
  const res = await app.request(path, {
    method,
    headers: { ...(form ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

const bootstrapFile = join(layout.aocData, 'bootstrap-token');
let ownerToken = existsSync(bootstrapFile) ? readFileSync(bootstrapFile, 'utf8').trim() : null;
const people: { key: PersonKey; name: string; role: string; complianceLead: boolean }[] = [
  { key: 'ceo', name: 'Chiew Sin Kwang', role: 'approver', complianceLead: false },
  { key: 'aisyah', name: 'Aisyah Rahman', role: 'builder', complianceLead: false },
  { key: 'weijie', name: 'Tan Wei Jie', role: 'builder', complianceLead: false },
  { key: 'priya', name: 'Priya Nair', role: 'builder', complianceLead: true },
  { key: 'daniel', name: 'Daniel Lim', role: 'requester', complianceLead: false },
  { key: 'nur', name: 'Nur Hidayah', role: 'requester', complianceLead: false },
];

for (const p of people) {
  if (p.key === 'ceo' && ownerToken) {
    const me = await api<{ user: { id: string } }>('GET', '/api/auth/me', ownerToken);
    if (me.status === 200) {
      tokens.ceo = { userId: me.data.user.id, role: 'approver', token: ownerToken };
      await api('PATCH', `/api/users/${me.data.user.id}`, ownerToken, { name: p.name });
      continue;
    }
  }
  const created = ownerToken
    ? await api<{ id?: string; user?: { id: string } }>('POST', '/api/users', ownerToken, { name: p.name, role: p.role, ...(p.complianceLead ? { flags: { complianceLead: true } } : {}) })
    : { status: 0, data: {} };
  const userId = created.data?.id ?? created.data?.user?.id;
  if (created.status < 300 && userId) {
    const tok = await api<{ token: string | { token: string } }>('POST', `/api/users/${userId}/tokens`, ownerToken, { label: 'demo' });
    const token = typeof tok.data.token === 'string' ? tok.data.token : tok.data.token.token;
    tokens[p.key] = { userId, role: p.role, token };
  } else {
    throw new Error(`identity API refused user ${p.key}: HTTP ${created.status} ${JSON.stringify(created.data)} (is the bootstrap token present?)`);
  }
  if (p.key === 'ceo') ownerToken = tokens.ceo.token;
}
const U = (k: PersonKey) => tokens[k].userId;
const builders = ['aisyah', 'weijie', 'priya'] as const;

// ── projects with real git repos (phase pins, provenance and evidence need commits) ──
const projects = {
  cx: { id: 'prj_cxcopilot', slug: 'cx-copilot', name: 'CX Copilot', description: 'Agent-assist copilot for the Daythree contact centre' },
  claims: { id: 'prj_claims', slug: 'claims-bot', name: 'Claims Intake Bot', description: 'Insurance claims intake and triage assistant' },
  aoc: { id: 'prj_aoc', slug: 'aoc-platform', name: 'AOC Platform', description: 'This console — features only; the governance core is human-built' },
} as const;
type Project = (typeof projects)[keyof typeof projects];
const allProjects = Object.values(projects);
const repoOf = (p: Project) => join(layout.repos, p.slug);
for (const p of allProjects) {
  initRepo(repoOf(p), { files: PROJECT_FILES[p.slug] });
  store.append({ type: 'project.created', actor: human(U('ceo')), scope: { projectId: p.id }, meta: { projectId: p.id, slug: p.slug }, payload: { name: p.name, description: p.description, repoPath: repoOf(p), defaultBranch: 'main' }, source: 'cli' });
}

// ── FX history: the BNM session rate, live weekdays, inherited weekends ───────
// Each record is the day's BNM 1700 rate (config.fx.session), taken by the daily run at config.fx.runAtLocalTime
// (MYT is UTC+8 all year). BNM publishes it at about 17:40, so a day whose run is still ahead has no record yet.
const fxSession = config.fx.session;
let rate = 4.215;
let lastLive = localDate(t0 - DAY, TZ);
for (let d = 0; d <= days; d++) {
  const date = localDate(t0 + d * DAY, TZ);
  const runAt = Date.parse(`${date}T${config.fx.runAtLocalTime}:00+08:00`);
  if (runAt < t0 || runAt > now) continue;
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  at(runAt);
  if (wd === 0 || wd === 6) {
    store.append({ type: 'fx.rate_recorded', actor: sys('scheduler:fx'), meta: { date, pair: 'USD/MYR', rate, status: 'inherited', sourceDate: lastLive, extractor: 'none', validation: 'not_applicable', reason: 'weekend_or_holiday', session: fxSession }, payload: { notes: 'Weekend — carried forward by design' }, source: 'scheduler' });
  } else {
    rate = Math.round((rate + (rnd() - 0.5) * 0.03) * 10_000) / 10_000;
    lastLive = date;
    store.append({ type: 'fx.rate_recorded', actor: sys('scheduler:fx'), meta: { date, pair: 'USD/MYR', rate, status: 'live', sourceDate: date, extractor: d % 9 === 4 ? 'sonnet' : 'haiku', validation: 'pass', reason: 'fetched', session: fxSession }, payload: { sourceUrl: config.fx.pageUrl, notes: d % 9 === 4 ? 'Haiku output failed self-validation; Sonnet succeeded' : undefined }, source: 'scheduler' });
  }
}

// ── sessions ──────────────────────────────────────────────────────────────────
interface Plan { phases: { id: string; name: string; tasks: { id: string; title: string; size: TaskSize }[] }[] }
const planFor = (kind: string): Plan => {
  const libs: Record<string, Plan> = {
    feature: {
      phases: [
        { id: 'design', name: 'Design', tasks: [{ id: 't1', title: 'Map current flow and data contracts', size: 's' }, { id: 't2', title: 'Write API contract + acceptance tests', size: 'm' }] },
        { id: 'build', name: 'Build', tasks: [{ id: 't3', title: 'Implement service layer', size: 'l' }, { id: 't4', title: 'Wire UI and telemetry events', size: 'm' }, { id: 't5', title: 'Edge cases + error states', size: 's' }] },
        { id: 'verify', name: 'Verify', tasks: [{ id: 't6', title: 'Regression suite green', size: 's' }] },
      ],
    },
    fix: {
      phases: [
        { id: 'reproduce', name: 'Reproduce', tasks: [{ id: 't1', title: 'Failing test reproducing the bug', size: 's' }] },
        { id: 'fix', name: 'Fix', tasks: [{ id: 't2', title: 'Root-cause fix', size: 'm' }, { id: 't3', title: 'Guard + regression test', size: 's' }] },
      ],
    },
    docs: { phases: [{ id: 'docs', name: 'Docs', tasks: [{ id: 't1', title: 'Update runbook', size: 'xs' }, { id: 't2', title: 'Add diagrams', size: 's' }, { id: 't3', title: 'Review links', size: 'xs' }] }] },
  };
  return libs[kind]!;
};

const threads = new Set<string>();
/**
 * Launch request as the supervisor records it: the registry decides model and credential profile (§2.2, §3).
 * `owner` null = launched by intake for a ticket (triage), as mod-intake does.
 */
function requestLaunch(owner: string | null, project: Project, type: string, prompt: string, threadId: string, ticketId: string | null = null) {
  const t = registry.getType(type);
  if (!t) throw new Error(`process type ${type} is not in the registry`);
  const model = MODEL_ID_BY_TIER[registry.modelFor(type)];
  const sessionId = newId('session', clock.now());
  const actor = owner ? human(owner) : sys('intake');
  if (!threads.has(threadId)) {
    threads.add(threadId);
    store.append({ type: 'thread.created', actor, scope: { projectId: project.id, threadId }, meta: { threadId, projectId: project.id }, payload: { title: prompt.split('\n')[0]!.slice(0, 80) }, source: 'api' });
  }
  store.append({
    type: 'session.launch_requested',
    actor,
    scope: { sessionId, projectId: project.id, threadId, ...(ticketId ? { ticketId } : {}) },
    meta: { sessionId, projectId: project.id, threadId, processType: type, model, readOnly: t.readOnly, credentialProfile: t.readOnly ? null : t.credentialProfile, ticketId, parentSessionId: null, phaseId: null },
    payload: { prompt, cwd: repoOf(project) },
    source: 'supervisor',
  });
  return { sessionId, model };
}

interface SimSession { sessionId: string; claude: string; owner: string | null; project: Project; type: string; model: string; plan: Plan; thread: string }
let turnSeq = 0;
function launch(owner: string | null, project: Project, type: string, prompt: string, threadId = `thr_${project.slug}_main`, ticketId: string | null = null): SimSession {
  const { sessionId, model } = requestLaunch(owner, project, type, prompt, threadId, ticketId);
  const claude = randomUUID();
  store.append({ type: 'session.launched', actor: sys('supervisor'), scope: { sessionId }, meta: { sessionId, claudeSessionId: claude, pid: 40000 + ++turnSeq, model, turn: 1 }, payload: { cwd: repoOf(project), argv: [process.execPath, CLAUDE_SIM_BIN, '-p', '@prompt'], transcriptPath: transcriptPathFor(repoOf(project), claude, layout.claudeConfig) }, source: 'supervisor' });
  store.append({ type: 'session.turn_started', actor: sys('supervisor'), scope: { sessionId }, meta: { sessionId, turn: 1, reason: 'launch' }, payload: {}, source: 'supervisor' });
  store.append({ type: 'session.lifecycle_changed', actor: sys('supervisor'), scope: { sessionId }, meta: { sessionId, from: 'launching', to: 'running', reason: 'launched' }, source: 'supervisor' });
  return { sessionId, claude, owner, project, type, model, plan: planFor(type === 'docs' ? 'docs' : type.includes('fix') || type === 'test-repair' ? 'fix' : 'feature'), thread: threadId };
}

/**
 * A launch requested while aocd was down: lifecycle 'launching', no turn yet. The supervisor's startup recovery
 * starts it on claude-sim, so the session's liveness comes from a real process.
 */
function queue(owner: string, project: Project, type: string, prompt: string, threadId: string): string {
  const { sessionId } = requestLaunch(owner, project, type, prompt, threadId);
  store.append({ type: 'session.lifecycle_changed', actor: human(owner), scope: { sessionId, projectId: project.id, threadId }, meta: { sessionId, from: null, to: 'launching', reason: 'launch_requested' }, source: 'supervisor' });
  return sessionId;
}

/** Repo state the ledger diffs `diff` evidence against; recorded for sessions that will work again. */
interface TreeState { head: string | null; fingerprint: string | null }
const git = createGitService();
const treeOf = (p: Project): TreeState => ({ head: git.head(repoOf(p)), fingerprint: git.workingTreeFingerprint(repoOf(p)) });

function declare(s: SimSession, tree?: TreeState) {
  const weight = s.plan.phases.flatMap((p) => p.tasks).reduce((n, t) => n + TASK_SIZE_WEIGHT[t.size], 0);
  store.append({
    type: 'plan.declared',
    actor: agent(s.sessionId),
    scope: { sessionId: s.sessionId, projectId: s.project.id },
    meta: { sessionId: s.sessionId, projectId: s.project.id, threadId: s.thread, manifestVersion: 1, phaseCount: s.plan.phases.length, taskCount: s.plan.phases.flatMap((p) => p.tasks).length, totalWeight: weight, ...(tree ? { baseHead: tree.head, treeFingerprint: tree.fingerprint } : {}), shape: s.plan.phases.map((ph) => ({ id: ph.id, tasks: ph.tasks.map((t) => ({ id: t.id, size: t.size })) })) },
    payload: { summary: `Plan for ${s.project.name}`, phases: s.plan.phases },
    source: 'mcp',
  });
}

const TOOLS = ['Read', 'Read', 'Grep', 'Edit', 'Bash', 'Read', 'Write', 'Bash', 'Glob'];
const READ_ONLY_TOOLS = ['Read', 'Read', 'Grep', 'Glob'];
function tools(s: SimSession, n: number, spanMs: number, palette: readonly string[] = TOOLS) {
  const start = clock.now();
  for (let i = 0; i < n; i++) {
    at(start + Math.round((spanMs * i) / Math.max(1, n)));
    const tool = pick(palette);
    const ok = rnd() > 0.06;
    const file = `src/${pick(['service', 'handler', 'ui', 'schema', 'telemetry'])}.ts`;
    store.append({
      type: 'tool.used',
      actor: agent(s.sessionId),
      scope: { sessionId: s.sessionId, projectId: s.project.id },
      meta: { sessionId: s.sessionId, toolName: tool, fileChanging: ok && (tool === 'Edit' || tool === 'Write'), ok, toolUseId: `toolu_${randomBytes(8).toString('hex')}` },
      payload: { inputSummary: tool === 'Bash' ? '{"command":"pnpm test --filter api"}' : `{"file_path":"${file}"}`, outputSummary: ok ? 'ok' : 'Error: Cannot find module "../config"', filePaths: tool === 'Edit' || tool === 'Write' ? [file] : [] },
      source: 'hook',
    });
  }
  at(start + spanMs);
}

function usage(s: SimSession, messages: number, contextTokens: number) {
  const tier = s.model.includes('opus') ? 1 : s.model.includes('haiku') ? 0.25 : 0.6;
  const ids = Array.from({ length: messages }, () => `msg_${randomBytes(10).toString('hex')}`);
  store.append({
    type: 'usage.recorded',
    actor: agent(s.sessionId),
    scope: { sessionId: s.sessionId, projectId: s.project.id },
    meta: {
      sessionId: s.sessionId,
      model: s.model,
      inputTokens: Math.round(messages * between(2, 40)),
      outputTokens: Math.round(messages * between(400, 2200) * tier),
      cacheReadTokens: Math.round(messages * contextTokens * 0.9),
      cacheWrite5mTokens: Math.round(messages * between(200, 1200)),
      cacheWrite1hTokens: Math.round(messages * between(1000, 6000)),
      messages,
      contextTokens,
      firstAt: new Date(clock.now() - 60_000).toISOString(),
      lastAt: clock.iso(),
    },
    payload: { messageIds: ids },
    source: 'sidecar',
  });
}

function done(s: SimSession, taskId: string, phaseId: string, size: TaskSize, opts: { flag?: 'no_file_change' | null; kind?: 'commit' | 'test' | 'diff'; tree?: TreeState } = {}) {
  const kind = opts.kind ?? pick(['commit', 'test', 'diff'] as const);
  const sha = createHash('sha1').update(`${s.sessionId}${taskId}`).digest('hex');
  store.append({
    type: 'task.done',
    actor: agent(s.sessionId),
    scope: { sessionId: s.sessionId, projectId: s.project.id, taskId },
    meta: { sessionId: s.sessionId, projectId: s.project.id, taskId, phaseId, weight: TASK_SIZE_WEIGHT[size], evidenceKind: kind, evidenceVerified: opts.flag ? false : true, flag: opts.flag ?? null, fileChangesSinceLast: opts.flag ? 0 : between(1, 9), ...(opts.tree ? { headSha: opts.tree.head, treeFingerprint: opts.tree.fingerprint } : {}) },
    payload: { evidence: { kind, ref: kind === 'commit' ? sha : kind === 'test' ? `api/${taskId}.test.ts > passes` : `diff:${sha.slice(0, 12)}` } },
    source: 'mcp',
  });
}

function phaseDone(s: SimSession, phaseId: string) {
  const sha = createHash('sha1').update(`${s.sessionId}:${phaseId}`).digest('hex');
  store.append({ type: 'phase.completed', actor: agent(s.sessionId), scope: { sessionId: s.sessionId, projectId: s.project.id }, meta: { sessionId: s.sessionId, projectId: s.project.id, phaseId, pinnedSha: sha, pinnedTag: `aoc/${s.project.slug}/${phaseId}/${store.head().seq + 1}` }, source: 'mcp' });
}

function end(s: SimSession, outcome: 'completed' | 'failed' = 'completed') {
  store.append({ type: 'session.turn_ended', actor: sys('supervisor'), scope: { sessionId: s.sessionId }, meta: { sessionId: s.sessionId, turn: 1, outcome: outcome === 'completed' ? 'end_turn' : 'crashed', exitCode: outcome === 'completed' ? 0 : 1, durationMs: 1000 }, payload: {}, source: 'supervisor' });
  // As Supervisor.endSession does: the lifecycle change first, so the supervisor's projection sees the session as
  // over (otherwise startup recovery fails every finished history session as process_gone_on_restart).
  store.append({ type: 'session.lifecycle_changed', actor: sys('supervisor'), scope: { sessionId: s.sessionId }, meta: { sessionId: s.sessionId, from: 'running', to: 'ended', reason: outcome }, source: 'supervisor' });
  store.append({ type: 'session.ended', actor: sys('supervisor'), scope: { sessionId: s.sessionId }, meta: { sessionId: s.sessionId, outcome }, source: 'supervisor' });
}

function decision(input: { kind: string; test?: string | null; title: string; question: string; options: { id: string; label: string }[]; rec?: string; context?: string; subjectType: string; subjectId: string; sessionId?: string | null; projectId?: string | null; requesterId: string; eligible?: string[] }) {
  const d = rt.services.get('decisions');
  return d.request(
    {
      kind: input.kind as never,
      test: (input.test ?? null) as never,
      title: input.title,
      question: input.question,
      options: input.options,
      recommendation: input.rec ? { optionId: input.rec, rationale: 'Agent recommendation based on blast radius and reversibility.' } : null,
      context: input.context ?? null,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      sessionId: input.sessionId ?? null,
      projectId: input.projectId ?? null,
      requesterId: input.requesterId,
      eligibleUserIds: input.eligible ?? null,
    },
    input.sessionId ? agent(input.sessionId) : human(input.requesterId),
  );
}

async function resolve_(id: string, option: string, userKey: PersonKey, comment?: string) {
  const d = rt.services.get('decisions');
  const user = rt.services.get('identity').getUser(U(userKey));
  if (!user) return;
  const card = d.get(id);
  if (card?.requiresPasskey) {
    d.resolveByPolicy?.call(d, id, option, human(user.id), comment); // demo only: passkey ceremonies cannot be scripted
  } else {
    await d.resolve(id, { optionId: option, comment: comment ?? null }, user);
  }
  // Reactors (e.g. the registry approving a playbook) record their follow-ups at the fake clock's current time.
  await rt.drain();
}

/** Playbooks distilled from discovery runs; once approved, feature-build and test-repair run on the cheaper model. */
async function approvePlaybooks(): Promise<void> {
  for (const [type, title] of [['feature-build', 'Feature build playbook v1'], ['test-repair', 'Flaky test repair playbook']] as const) {
    const playbookId = newId('playbook', clock.now());
    const dec = decision({ kind: 'playbook_approval', title: `Approve playbook: ${title}`, question: `Bind "${title}" so ${type} runs execute on the cheaper model?`, options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }], rec: 'approve', subjectType: 'playbook', subjectId: playbookId, requesterId: U('priya') });
    store.append({ type: 'playbook.proposed', actor: human(U('priya')), scope: {}, meta: { playbookId, processType: type, sourceSessionId: null, version: 1, stepCount: 4, decisionId: dec.id, method: 'llm' }, payload: { title, steps: [{ id: 's1', title: 'Reproduce / map the change surface' }, { id: 's2', title: 'Write the acceptance test first' }, { id: 's3', title: 'Implement the smallest change' }, { id: 's4', title: 'Run the full suite and close tasks with evidence' }] }, source: 'api' });
    at(clock.now() + 3 * 3600_000);
    await resolve_(dec.id, 'approve', 'ceo', 'Approved for execution runs.');
  }
}

// History: completed sessions spread across the days
const featureTypes = ['discovery', 'feature-build', 'feature-build', 'bug-fix', 'test-repair', 'docs'] as const;
for (let d = 0; d < days; d++) {
  if (d === 5) {
    // The evening before day 5: later feature-build and test-repair runs are routed to the execution model.
    at(t0 + 5 * DAY - 7 * 3600_000);
    await approvePlaybooks();
  }
  const dayStart = t0 + d * DAY + 1.5 * 3600_000; // 09:30 local
  const wd = new Date(`${localDate(dayStart, TZ)}T00:00:00Z`).getUTCDay();
  if (wd === 0 || wd === 6) continue;
  for (let k = 0; k < between(2, 4); k++) {
    at(dayStart + k * 2.2 * 3600_000 + between(0, 1800_000));
    const owner = pick(builders);
    const project = pick(allProjects);
    const type = pick(featureTypes);
    const s = launch(U(owner), project, type, `${pick(['Add', 'Fix', 'Refactor', 'Instrument'])} ${pick(['agent handover summary', 'claims OCR fallback', 'SLA breach alerting', 'queue rebalancer', 'CSAT survey hook', 'PDPA export'])} for ${project.name}`);
    tools(s, between(4, 8), between(60_000, 300_000));
    declare(s);
    let ctx = 24_000;
    for (const ph of s.plan.phases) {
      for (const task of ph.tasks) {
        tools(s, between(6, 22), between(4, 18) * 60_000);
        ctx += between(6_000, 30_000);
        usage(s, between(6, 26), ctx);
        done(s, task.id, ph.id, task.size, { flag: rnd() < 0.05 ? 'no_file_change' : null });
      }
      phaseDone(s, ph.id);
    }
    if (rnd() < 0.25) {
      const test = pick(['irreversible', 'ambiguity'] as const);
      const dec = decision({ kind: 'agent_decision', test, title: 'Pick a persistence strategy', question: 'Event table or document store for the handover summaries?', options: [{ id: 'events', label: 'Append-only event table' }, { id: 'docs', label: 'Document store' }], rec: 'events', subjectType: 'session', subjectId: s.sessionId, sessionId: s.sessionId, projectId: project.id, requesterId: `session:${s.sessionId}` });
      at(clock.now() + between(10, 90) * 60_000);
      // Irreversible choices bounce to the Approver; ambiguity is answered by a Builder (§6).
      await resolve_(dec.id, 'events', test === 'irreversible' ? 'ceo' : pick(builders.filter((b) => b !== owner)), 'Keep it append-only; we need the audit trail.');
    }
    end(s);
  }
}

// ── error learning: classes, occurrences, offences, lessons ──────────────────
const classes = [
  { classId: 'rcc_spec_ambiguity', name: 'Ambiguous acceptance criteria in tickets', dimension: 'spec' },
  { classId: 'rcc_missing_env_guard', name: 'Missing env-var guard in config loader', dimension: 'guardrail' },
  { classId: 'rcc_haiku_sql', name: 'Malformed SQL migrations on the cheap model', dimension: 'model_capability' },
] as const;
for (const c of classes) {
  at(t0 + 2 * DAY);
  store.append({ type: 'rootcause.class_defined', actor: human(U('priya')), scope: {}, meta: { classId: c.classId, dimension: c.dimension }, payload: { name: c.name }, source: 'api' });
  for (let i = 0; i < between(3, 7); i++) {
    at(t0 + between(2, days - 1) * DAY + between(0, 8) * 3600_000);
    const errorId = newId('error', clock.now());
    store.append({
      type: 'error.observed',
      actor: sys('learning'),
      scope: { projectId: pick(allProjects).id },
      meta: { errorId, source: pick(['tool', 'test', 'uat'] as const), sessionId: null, projectId: null, processType: pick(['feature-build', 'test-repair', 'migration']), model: c.dimension === 'model_capability' ? MODEL_ID_BY_TIER.haiku : pick([MODEL_ID_BY_TIER.sonnet, MODEL_ID_BY_TIER.opus]), signature: createHash('sha256').update(c.classId).digest('hex').slice(0, 32), codeArea: 'src/config', priority: rnd() < 0.2 ? 'high' : 'normal', costUsd: Math.round(rnd() * 400) / 100, costMs: between(60_000, 1_800_000) },
      payload: { message: `${c.name} (occurrence ${i + 1})` },
      source: 'system',
    });
    store.append({ type: 'rootcause.assigned', actor: human(U('priya')), scope: {}, meta: { errorId, classId: c.classId, assignedBy: 'human', confidence: 1 }, source: 'api' });
  }
}

// ── credits: allocations ──────────────────────────────────────────────────────
const period = localDate(now, TZ).slice(0, 7);
at(t0 + DAY);
for (const b of builders) store.append({ type: 'credit.allocated', actor: human(U('ceo')), scope: { userId: U(b) }, meta: { userId: U(b), period, amountUsd: 300, allocatedBy: U('ceo') }, source: 'api' });

// ── intake tickets, filed by the requesters through the portal API ────────────
const ticketSpecs = [
  { key: 'receipts', by: 'daniel', project: projects.claims, ago: 2.2 * DAY, severity: 'medium', title: 'Receipt photos come out sideways', description: 'When I photograph a receipt in portrait on my phone and attach it to a claim, the uploaded image shows up rotated 90 degrees. The adjuster asked me to send it again twice.', comment: 'iPhone 15, latest app version.' },
  { key: 'duplicate', by: 'nur', project: projects.claims, ago: 1.4 * DAY, severity: 'high', title: 'My claim was submitted twice', description: 'The app froze after I pressed Submit, so I pressed it again. Now I have two identical claims and two confirmation emails for the same accident.', comment: null },
] as const;
const tickets: DemoTokens['tickets'] = [];
for (const t of ticketSpecs) {
  at(now - t.ago);
  const form = new FormData();
  form.set('title', t.title);
  form.set('description', t.description);
  if (t.comment) form.set('comment', t.comment);
  form.set('severity', t.severity);
  form.set('projectId', t.project.id);
  const r = await api<{ ticketId: string }>('POST', '/portal/api/intakes', tokens[t.by].token, form);
  if (r.status !== 201 || !r.data?.ticketId) throw new Error(`intake refused ticket ${t.key}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
  tickets.push({ ticketId: r.data.ticketId, key: t.key, projectId: t.project.id });
}

// The receipts ticket went through intake triage when it came in (§7): two read-only agents agreed on the root cause,
// so intake's own reconciliation put the fix plan to the Approver. That decision is still open. Approving it starts
// the build on claude-sim, which commits the fix to uat/<ticket> for the requester's UAT, then the go-live gate.
{
  const ticketId = tickets.find((t) => t.key === 'receipts')!.ticketId;
  at(now - 2.2 * DAY + 4 * 60_000);
  const prompt = `You are diagnosing customer ticket ${ticketId} in READ-ONLY mode. Do not modify any file, branch or environment.`;
  const triage = [0.86, 0.81].map((confidence, i) => ({ confidence, s: launch(null, projects.claims, 'bug-triage', prompt, `thr_claims-bot_triage_${i + 1}`, ticketId) }));
  const scope = { ticketId, projectId: projects.claims.id };
  store.append({ type: 'ticket.triage_started', actor: sys('intake'), scope, meta: { ticketId, sessionIds: triage.map((x) => x.s.sessionId), budgetTokens: config.intake.diagnosisBudget.tokens, budgetMinutes: config.intake.diagnosisBudget.minutes }, source: 'intake' });
  store.append({ type: 'ticket.public_status_changed', actor: sys('intake'), scope, meta: { ticketId, publicStatus: 'being_worked_on' }, source: 'intake' });
  for (const { s, confidence } of triage) {
    tools(s, between(8, 14), between(4, 9) * 60_000, READ_ONLY_TOOLS);
    usage(s, between(6, 12), between(60_000, 140_000));
    store.append({
      type: 'ticket.diagnosis_reported',
      actor: agent(s.sessionId),
      scope: { ticketId, sessionId: s.sessionId },
      // As mod-intake records it: the class is agent-written text, so it travels in the erasable body and meta keeps null.
      meta: { ticketId, sessionId: s.sessionId, confidence, rootCauseClass: null },
      payload: {
        rootCauseClass: 'exif-orientation-dropped',
        rootCause: 'normalizeImage() re-encodes uploads and strips all metadata without applying the EXIF orientation tag first, so portrait photos taken on phones are stored rotated 90 degrees.',
        fixPlan: "Apply the EXIF orientation (sharp().rotate()) before stripping metadata in src/uploads/normalize.ts, add a regression test with a rotated receipt, then verify on UAT with the reporter's receipt.",
        affectedAreas: ['src/uploads/normalize.ts', 'test/uploads/normalize.test.ts'],
      },
      source: 'mcp',
      bodyScope: ticketId,
    });
    end(s);
  }
  await rt.drain();
}

// ── "now": one session per liveness state ─────────────────────────────────────
// Waiting on you / Throttled / Dead: seeded states with history. Their next turn runs on claude-sim: the scenario
// marker in each prompt (or the resumable conversation written below for the waiting one) continues the plan.
at(now - 50 * 60_000);
const seeded = {
  waiting: launch(U('aisyah'), projects.claims, 'bug-fix', simPrompt('Fix duplicate claim submissions on retry', 'Mobile retries after a slow response create a second claim (ticket "My claim was submitted twice"). Make submission idempotent and add a regression test.', 'demo-dedupe-resume'), 'thr_claims-bot_dedupe'),
  throttled: launch(U('weijie'), projects.cx, 'feature-build', simPrompt('Real-time CSAT sentiment overlay', 'Show a rolling sentiment colour on the agent desktop while the call is live.', 'demo-csat-resume'), 'thr_cx-copilot_csat'),
  dead: launch(U('priya'), projects.aoc, 'docs', simPrompt('Document the rollback runbook', 'Add the rollback flow diagram and check every link in docs/runbooks/rollback.md.', 'demo-runbook-restart'), 'thr_aoc-platform_rollback-docs'),
};
const seededContext: Record<keyof typeof seeded, number> = { waiting: 0, throttled: 0, dead: 0 };
for (const [k, s] of Object.entries(seeded) as [keyof typeof seeded, SimSession][]) {
  // These sessions work again on claude-sim: their next diff evidence is checked against this baseline.
  const tree = treeOf(s.project);
  tools(s, 5, 120_000);
  declare(s, tree);
  tools(s, between(10, 25), between(10, 25) * 60_000);
  seededContext[k] = between(60_000, 420_000);
  usage(s, between(10, 30), seededContext[k]);
  const t = s.plan.phases[0]!.tasks[0]!;
  done(s, t.id, s.plan.phases[0]!.id, t.size, { kind: 'diff', tree });
}
// Waiting on you: main-branch merge decision (test 1 → Approver)
at(now - 34 * 60_000);
decision({
  kind: 'agent_decision',
  test: 'main',
  title: 'Merge the retry-dedupe fix to main?',
  question: 'The fix for duplicate claim submissions is ready on fix/claims-dedupe with a regression test. Merge to main now or hold for UAT?',
  options: [{ id: 'merge', label: 'Merge to main' }, { id: 'uat', label: 'Hold for UAT first' }],
  rec: 'uat',
  context: '3 files changed, regression test test/claims/dedupe.test.ts passing.',
  subjectType: 'session',
  subjectId: seeded.waiting.sessionId,
  sessionId: seeded.waiting.sessionId,
  projectId: projects.claims.id,
  requesterId: `session:${seeded.waiting.sessionId}`,
});
store.append({ type: 'session.turn_ended', actor: sys('supervisor'), scope: { sessionId: seeded.waiting.sessionId }, meta: { sessionId: seeded.waiting.sessionId, turn: 1, outcome: 'decision', exitCode: 0, durationMs: 1000 }, payload: {}, source: 'supervisor' });
store.append({ type: 'session.lifecycle_changed', actor: sys('supervisor'), scope: { sessionId: seeded.waiting.sessionId }, meta: { sessionId: seeded.waiting.sessionId, from: 'running', to: 'waiting_decision', reason: 'open_decision' }, source: 'supervisor' });
// Throttled: plan limit with a reset time; the supervisor resumes it on claude-sim once the limit resets.
at(now - 22 * 60_000);
store.append({ type: 'throttle.hit', actor: agent(seeded.throttled.sessionId), scope: { sessionId: seeded.throttled.sessionId }, meta: { sessionId: seeded.throttled.sessionId, resetAt: new Date(now + 95 * 60_000).toISOString(), source: 'stream' }, payload: { message: "You've hit your session limit · resets 2:05pm (Asia/Kuala_Lumpur)" }, source: 'supervisor' });
store.append({ type: 'session.turn_ended', actor: sys('supervisor'), scope: { sessionId: seeded.throttled.sessionId }, meta: { sessionId: seeded.throttled.sessionId, turn: 1, outcome: 'throttled', exitCode: 1, durationMs: 1000 }, payload: {}, source: 'supervisor' });
store.append({ type: 'session.lifecycle_changed', actor: sys('supervisor'), scope: { sessionId: seeded.throttled.sessionId }, meta: { sessionId: seeded.throttled.sessionId, from: 'running', to: 'throttled', reason: 'plan_limit' }, source: 'supervisor' });
// Dead: crashed process; Restart starts a fresh conversation from its launch prompt.
at(now - 12 * 60_000);
store.append({ type: 'session.turn_ended', actor: sys('supervisor'), scope: { sessionId: seeded.dead.sessionId }, meta: { sessionId: seeded.dead.sessionId, turn: 1, outcome: 'crashed', exitCode: 143, durationMs: 1000 }, payload: {}, source: 'supervisor' });
store.append({ type: 'session.lifecycle_changed', actor: sys('supervisor'), scope: { sessionId: seeded.dead.sessionId }, meta: { sessionId: seeded.dead.sessionId, from: 'running', to: 'failed', reason: 'exit_143_no_result' }, source: 'supervisor' });

// The waiting session's turn ended on a decision, so the supervisor resumes its conversation (`--resume`) when the
// decision is answered: give claude-sim that conversation (an empty transcript plus the scenario cursor).
{
  const s = seeded.waiting;
  const transcript = transcriptPathFor(realpathSync(repoOf(s.project)), s.claude, layout.claudeConfig);
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, '');
  const iso = new Date(now - 34 * 60_000).toISOString();
  const state: SimState = {
    version: 1,
    sessionId: s.claude,
    scenario: { kind: 'builtin', name: 'demo-dedupe-resume' },
    cursor: 0,
    saved: {},
    context: { cachedPrefix: seededContext.waiting, uncached: 0, lastRequestAt: null },
    idCounter: 0,
    turns: 1,
    createdAt: iso,
    updatedAt: iso,
  };
  const file = simStatePathFor(s.claude, layout.claudeConfig);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

// Working / Thinking / Stalled: queued launches that aocd's supervisor starts on claude-sim at boot.
at(now - 3 * 60_000);
const queued = {
  working: queue(U('aisyah'), projects.cx, 'feature-build', simPrompt('Add supervisor whisper suggestions to the agent desktop', 'Rank reply suggestions by live intent confidence, show at most three cards in the agent panel and emit whisper telemetry.', 'demo-feature-build'), 'thr_cx-copilot_whisper'),
  thinking: queue(U('weijie'), projects.claims, 'discovery', simPrompt('Design an OCR fallback for handwritten claim forms', 'Handwritten claim forms fail the printed-text OCR engine. Find the cheapest safe fallback and prototype it.', 'demo-deep-think'), 'thr_claims-bot_ocr'),
  stalled: queue(U('priya'), projects.cx, 'migration', simPrompt('Migrate interaction history to the partitioned table', 'Move interaction history to monthly partitions without downtime: migration, resumable backfill, dual-write, read switch.', 'demo-stall'), 'thr_cx-copilot_history'),
};

// Observed session (a developer terminal, read-only): its hooks went quiet 12 minutes ago, so it reads Stalled.
at(now - 12 * 60_000);
const obsId = newId('session', clock.now());
store.append({ type: 'session.observed', actor: sys('sessions'), scope: { sessionId: obsId }, meta: { sessionId: obsId, claudeSessionId: randomUUID(), projectId: projects.aoc.id }, payload: { cwd: repoOf(projects.aoc), transcriptPath: '' }, source: 'hook' });

// More open decisions for the inbox
at(now - 3 * 3600_000);
decision({ kind: 'credit_topup', title: 'Top-up request: Tan Wei Jie (+US$100)', question: 'Wei Jie hit the monthly cap after the 25% auto-grant. Approve a US$100 top-up for the CSAT overlay work?', options: [{ id: 'approve', label: 'Approve US$100' }, { id: 'deny', label: 'Deny' }], subjectType: 'credit_request', subjectId: 'tpu_demo1', requesterId: U('weijie') });
at(now - 26 * 3600_000);
decision({ kind: 'lesson_binding', title: 'Bind lesson: guard required env vars', question: 'Bind "Config loaders must fail fast on missing env vars with a named error" for code area src/config?', options: [{ id: 'bind', label: 'Bind lesson' }, { id: 'reject', label: 'Reject' }], rec: 'bind', subjectType: 'lesson', subjectId: 'les_demo1', requesterId: U('priya') });

// Final liveness sweep + anchor + daily close at the real "now"
at(now);
const sessions = rt.services.get('sessions') as unknown as { refreshAll?: () => void };
sessions.refreshAll?.();
await rt.tickJobs().catch((e) => console.warn('jobs:', String(e)));
await rt.drain();

const sessionIds: Record<LiveKind, string> = {
  ...queued,
  waiting: seeded.waiting.sessionId,
  throttled: seeded.throttled.sessionId,
  dead: seeded.dead.sessionId,
  observed: obsId,
};
const out: DemoTokens = {
  dataDir: layout.root,
  console: config.publicUrl,
  tokens,
  sessions: sessionIds,
  tickets,
  projects: { cx: projects.cx.id, claims: projects.claims.id, aoc: projects.aoc.id },
  head: store.head(),
};
writeFileSync(layout.tokens, JSON.stringify(out, null, 2), { mode: 0o600 });
writeFileSync(layout.config, JSON.stringify(demoConfig, null, 2));
// claude-sim's side: the default scenario (intake triage and build of the receipts ticket, rollover successors) and
// the operator settings that let build sessions run the git commands of a UAT branch (nothing else).
mkdirSync(layout.claudeConfig, { recursive: true });
writeFileSync(layout.simDefaultScenario, JSON.stringify(defaultScenario(tickets.find((t) => t.key === 'receipts')!.ticketId), null, 2));
writeFileSync(layout.simSettings, JSON.stringify({ permissions: { allow: ['Bash(git checkout:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git rev-parse:*)'] } }, null, 2));
// Every credential profile the demo can request (the registry's, plus mod-change's promotion profile), each with an
// empty env: never a real credential (the promotion credential stays empty until G-04, credential-isolation runbook).
const profiles = new Set([...registry.listTypes().flatMap((t) => (t.credentialProfile ? [t.credentialProfile] : [])), 'prod-promote']);
writeFileSync(layout.credentialProfiles, JSON.stringify({ profiles: Object.fromEntries([...profiles].map((p) => [p, { env: {} }])) }, null, 2), { mode: 0o600 });
await rt.stop();
const env = Object.entries({ AOC_CONFIG: layout.config, ...simEnv(layout) }).map(([k, v]) => `${k}=${v}`);
console.log(`Seeded ${out.head.seq} events into ${layout.root}`);
console.log(`Tokens: ${layout.tokens} (the "ceo" token signs you in as the Approver)`);
console.log(`Live:  pnpm --filter @aoc/demo live -- --data-dir ${layout.root}`);
console.log(`  or:  ${env.join(' ')} node --import tsx packages/daemon/src/main.ts`);
console.log('       (managed sessions run on claude-sim, never the real claude CLI)');
