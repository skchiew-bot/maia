/**
 * Demo history seeder — `pnpm --filter @aoc/demo seed -- --data-dir <abs dir> [--days 14] [--reset]`
 *
 * Builds a realistic, catalog-valid history (users, projects, sessions with manifests/evidence/usage, decisions,
 * change control, rollbacks, credits, FX, error-learning, playbooks, tickets) by driving the REAL runtime with a
 * moving fake clock, so every module's projections, the hash chain and anchors are genuine. Then start aocd on the
 * same data dir. Deterministic (seeded PRNG). Never use against a production data dir.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';
import { AocConfigSchema, MODEL_ID_BY_TIER, newId, TASK_SIZE_WEIGHT, type Actor, type TaskSize } from '@aoc/contracts';
import { AocRuntime, FakeClock, createLogger, initRepo, localDate, type AocModule, type AppEnv } from '@aoc/kernel';
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

// ── deterministic randomness ──────────────────────────────────────────────────
let seed = 20261009;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const between = (a: number, b: number) => Math.round(a + rnd() * (b - a));

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const repoDir = resolve(new URL('../../..', import.meta.url).pathname);
const dataDir = resolve(arg('data-dir', join(repoDir, '.aoc/demo')));
const days = Number(arg('days', '14'));
const TZ = 'Asia/Kuala_Lumpur';

if (existsSync(dataDir) && process.argv.includes('--reset')) rmSync(dataDir, { recursive: true, force: true });
if (existsSync(join(dataDir, 'aoc.db'))) {
  console.error(`${dataDir} already has data. Re-run with --reset to rebuild the demo.`);
  process.exit(1);
}
mkdirSync(dataDir, { recursive: true });
const repoRoot = join(dataDir, 'repos');

const now = Date.now();
const clock = new FakeClock(now - days * 86_400_000);
/**
 * The daemon config for this demo data dir (written to <dataDir>/aoc.config.json). Managed sessions run on
 * claude-sim, never the real `claude` CLI, and LLM-backed jobs use the fake extractor: clicking Nudge or Restart
 * in a demo must not spend plan quota or touch real repositories.
 */
const demoConfig = {
  dataDir,
  timezone: TZ,
  registryFile: join(repoDir, 'config/process-types.json'),
  metering: { rateCardFile: join(repoDir, 'config/rate-card.json') },
  compliance: { mappingFile: join(repoDir, 'config/iso42001-mapping.json') },
  fx: { enabled: false, extractor: 'fake' as const },
  audit: { anchorProvider: 'git' as const, anchorRepoPath: join(dataDir, 'anchor-repo') },
  supervisor: {
    claudeBin: process.execPath,
    claudeArgsPrefix: [join(repoDir, 'packages/claude-sim/bin/claude-sim.mjs')],
    workspacesDir: join(dataDir, 'workspaces'),
  },
  selfModification: { externalAuditLog: join(dataDir, 'selfmod-audit.log') },
  credits: { defaultMonthlyAllocationUsd: 300 },
};
const config = AocConfigSchema.parse({
  ...demoConfig,
});

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

const rt = await AocRuntime.create({ config, modules, clock, log: createLogger({ level: 'warn' }) });
const app = rt.mount(new Hono<AppEnv>());
const store = rt.store;
const sys = (id: string): Actor => ({ kind: 'system', id });
const human = (id: string): Actor => ({ kind: 'human', id });
const agent = (id: string): Actor => ({ kind: 'agent', id });
const at = (ms: number) => clock.set(ms);
const t0 = clock.now();
const DAY = 86_400_000;

// ── users & tokens (through the identity API when available) ─────────────────
const tokens: Record<string, { userId: string; role: string; token: string }> = {};
async function api<T>(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

const bootstrapFile = join(dataDir, 'bootstrap-token');
let ownerToken = existsSync(bootstrapFile) ? readFileSync(bootstrapFile, 'utf8').trim() : null;
const people = [
  { key: 'ceo', name: 'Chiew Sin Kwang', role: 'approver', complianceLead: false },
  { key: 'aisyah', name: 'Aisyah Rahman', role: 'builder', complianceLead: false },
  { key: 'weijie', name: 'Tan Wei Jie', role: 'builder', complianceLead: false },
  { key: 'priya', name: 'Priya Nair', role: 'builder', complianceLead: true },
  { key: 'daniel', name: 'Daniel Lim', role: 'requester', complianceLead: false },
  { key: 'nur', name: 'Nur Hidayah', role: 'requester', complianceLead: false },
] as const;

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
  if (p.key === 'ceo') ownerToken = tokens.ceo!.token;
}
const U = (k: keyof typeof tokens) => tokens[k]!.userId;
const builders = ['aisyah', 'weijie', 'priya'] as const;

// ── projects with real git repos (phase pins and provenance need commits) ────
const projects = [
  { id: 'prj_cxcopilot', slug: 'cx-copilot', name: 'CX Copilot', description: 'Agent-assist copilot for the Daythree contact centre' },
  { id: 'prj_claims', slug: 'claims-bot', name: 'Claims Intake Bot', description: 'Insurance claims intake and triage assistant' },
  { id: 'prj_aoc', slug: 'aoc-platform', name: 'AOC Platform', description: 'This console — features only; the governance core is human-built' },
];
for (const p of projects) {
  const repo = join(repoRoot, p.slug);
  initRepo(repo, { files: { 'README.md': `# ${p.name}\n`, 'src/index.ts': 'export const ready = true;\n', 'package.json': '{"name":"demo","scripts":{"test":"node -e \\"process.exit(0)\\""}}\n' } });
  store.append({ type: 'project.created', actor: human(U('ceo')), scope: { projectId: p.id }, meta: { projectId: p.id, slug: p.slug }, payload: { name: p.name, description: p.description, repoPath: repo, defaultBranch: 'main' }, source: 'cli' });
}

// ── FX history: live weekdays, inherited weekends ─────────────────────────────
let rate = 4.215;
let lastLive = localDate(t0 - DAY, TZ);
for (let d = 0; d <= days; d++) {
  const ms = t0 + d * DAY;
  const date = localDate(ms, TZ);
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  at(ms + 4.5 * 3600_000); // 12:30 local
  if (wd === 0 || wd === 6) {
    store.append({ type: 'fx.rate_recorded', actor: sys('scheduler:fx'), meta: { date, pair: 'USD/MYR', rate, status: 'inherited', sourceDate: lastLive, extractor: 'none', validation: 'not_applicable', reason: 'weekend_or_holiday' }, payload: { notes: 'Weekend — carried forward by design' }, source: 'scheduler' });
  } else {
    rate = Math.round((rate + (rnd() - 0.5) * 0.03) * 10_000) / 10_000;
    lastLive = date;
    store.append({ type: 'fx.rate_recorded', actor: sys('scheduler:fx'), meta: { date, pair: 'USD/MYR', rate, status: 'live', sourceDate: date, extractor: d % 9 === 4 ? 'sonnet' : 'haiku', validation: 'pass', reason: 'fetched' }, payload: { sourceUrl: config.fx.pageUrl, notes: d % 9 === 4 ? 'Haiku output failed self-validation; Sonnet succeeded' : undefined }, source: 'scheduler' });
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

interface SimSession { sessionId: string; claude: string; owner: string; project: (typeof projects)[number]; type: string; model: string; plan: Plan; thread: string }
let turnSeq = 0;
function launch(owner: string, project: (typeof projects)[number], type: string, prompt: string, extra: { ticketId?: string; readOnly?: boolean } = {}): SimSession {
  const sessionId = newId('session', clock.now());
  const claude = randomUUID();
  const thread = `thr_${project.slug}_main`;
  if (!store.list({ types: ['thread.created'], projectId: project.id, limit: 1 }).length) {
    store.append({ type: 'thread.created', actor: human(owner), scope: { projectId: project.id, threadId: thread }, meta: { threadId: thread, projectId: project.id }, payload: { title: `${project.name} — main thread` }, source: 'api' });
  }
  const tier = type === 'discovery' || type === 'migration' || type === 'bug-triage' ? 'opus' : type === 'docs' || type === 'test-repair' ? 'haiku' : 'sonnet';
  const model = MODEL_ID_BY_TIER[tier];
  store.append({
    type: 'session.launch_requested',
    actor: human(owner),
    scope: { sessionId, projectId: project.id, threadId: thread, ticketId: extra.ticketId },
    meta: { sessionId, projectId: project.id, threadId: thread, processType: type, model, readOnly: !!extra.readOnly, credentialProfile: extra.readOnly ? null : 'git-feature', ticketId: extra.ticketId ?? null, parentSessionId: null, phaseId: null },
    payload: { prompt, cwd: join(repoRoot, project.slug) },
    source: 'supervisor',
  });
  store.append({ type: 'session.launched', actor: sys('supervisor'), scope: { sessionId }, meta: { sessionId, claudeSessionId: claude, pid: 40000 + (++turnSeq), model, turn: 1 }, payload: { cwd: join(repoRoot, project.slug), argv: ['claude', '-p', '…'], transcriptPath: `/home/aoc/.claude/projects/x/${claude}.jsonl` }, source: 'supervisor' });
  store.append({ type: 'session.turn_started', actor: sys('supervisor'), scope: { sessionId }, meta: { sessionId, turn: 1, reason: 'launch' }, payload: {}, source: 'supervisor' });
  store.append({ type: 'session.lifecycle_changed', actor: sys('supervisor'), scope: { sessionId }, meta: { sessionId, from: 'launching', to: 'running', reason: 'launched' }, source: 'supervisor' });
  return { sessionId, claude, owner, project, type, model, plan: planFor(type === 'docs' ? 'docs' : type.includes('fix') || type === 'test-repair' ? 'fix' : 'feature'), thread };
}

function declare(s: SimSession) {
  const weight = s.plan.phases.flatMap((p) => p.tasks).reduce((n, t) => n + TASK_SIZE_WEIGHT[t.size], 0);
  store.append({
    type: 'plan.declared',
    actor: agent(s.sessionId),
    scope: { sessionId: s.sessionId, projectId: s.project.id },
    meta: { sessionId: s.sessionId, projectId: s.project.id, threadId: s.thread, manifestVersion: 1, phaseCount: s.plan.phases.length, taskCount: s.plan.phases.flatMap((p) => p.tasks).length, totalWeight: weight },
    payload: { summary: `Plan for ${s.project.name}`, phases: s.plan.phases },
    source: 'mcp',
  });
}

const TOOLS = ['Read', 'Read', 'Grep', 'Edit', 'Bash', 'Read', 'Write', 'Bash', 'Glob'];
function tools(s: SimSession, n: number, spanMs: number) {
  const start = clock.now();
  for (let i = 0; i < n; i++) {
    at(start + Math.round((spanMs * i) / Math.max(1, n)));
    const tool = pick(TOOLS);
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

function done(s: SimSession, taskId: string, phaseId: string, size: TaskSize, opts: { flag?: 'no_file_change' | null; kind?: 'commit' | 'test' | 'diff' } = {}) {
  const repo = join(repoRoot, s.project.slug);
  const kind = opts.kind ?? pick(['commit', 'test', 'diff'] as const);
  const sha = createHash('sha1').update(`${s.sessionId}${taskId}`).digest('hex');
  store.append({
    type: 'task.done',
    actor: agent(s.sessionId),
    scope: { sessionId: s.sessionId, projectId: s.project.id, taskId },
    meta: { sessionId: s.sessionId, projectId: s.project.id, taskId, phaseId, weight: TASK_SIZE_WEIGHT[size], evidenceKind: kind, evidenceVerified: opts.flag ? false : true, flag: opts.flag ?? null, fileChangesSinceLast: opts.flag ? 0 : between(1, 9) },
    payload: { evidence: { kind, ref: kind === 'commit' ? sha : kind === 'test' ? `api/${taskId}.test.ts > passes` : `diff:${sha.slice(0, 12)}`, detail: repo ? undefined : undefined } },
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

async function resolve_(id: string, option: string, userKey: string, comment?: string) {
  const d = rt.services.get('decisions');
  const user = rt.services.get('identity').getUser(U(userKey));
  if (!user) return;
  const card = d.get(id);
  if (card?.requiresPasskey) {
    d.resolveByPolicy?.call(d, id, option, human(user.id), comment); // demo only: passkey ceremonies cannot be scripted
    return;
  }
  await d.resolve(id, { optionId: option, comment: comment ?? null }, user);
}

// History: completed sessions spread across the days
const featureTypes = ['discovery', 'feature-build', 'feature-build', 'bug-fix', 'test-repair', 'docs'] as const;
for (let d = 0; d < days; d++) {
  const dayStart = t0 + d * DAY + 1.5 * 3600_000; // 09:30 local
  const wd = new Date(`${localDate(dayStart, TZ)}T00:00:00Z`).getUTCDay();
  if (wd === 0 || wd === 6) continue;
  for (let k = 0; k < between(2, 4); k++) {
    at(dayStart + k * 2.2 * 3600_000 + between(0, 1800_000));
    const owner = U(pick(builders));
    const project = pick(projects);
    const type = pick(featureTypes);
    const s = launch(owner, project, type, `${pick(['Add', 'Fix', 'Refactor', 'Instrument'])} ${pick(['agent handover summary', 'claims OCR fallback', 'SLA breach alerting', 'queue rebalancer', 'CSAT survey hook', 'PDPA export'])} for ${project.name}`);
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
      await resolve_(dec.id, 'events', test === 'irreversible' ? 'ceo' : pick(builders.filter((b) => U(b) !== owner)), 'Keep it append-only; we need the audit trail.');
    }
    end(s);
  }
}

// ── registry: playbooks distilled from discovery runs ────────────────────────
at(t0 + 5 * DAY);
for (const [type, title] of [['feature-build', 'Feature build playbook v1'], ['test-repair', 'Flaky test repair playbook']] as const) {
  const playbookId = newId('playbook', clock.now());
  const dec = decision({ kind: 'playbook_approval', title: `Approve playbook: ${title}`, question: `Bind "${title}" so ${type} runs execute on the cheaper model?`, options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }], rec: 'approve', subjectType: 'playbook', subjectId: playbookId, requesterId: U('priya') });
  store.append({ type: 'playbook.proposed', actor: human(U('priya')), scope: {}, meta: { playbookId, processType: type, sourceSessionId: null, version: 1, stepCount: 4, decisionId: dec.id, method: 'llm' }, payload: { title, steps: [{ id: 's1', title: 'Reproduce / map the change surface' }, { id: 's2', title: 'Write the acceptance test first' }, { id: 's3', title: 'Implement the smallest change' }, { id: 's4', title: 'Run the full suite and close tasks with evidence' }] }, source: 'api' });
  at(clock.now() + 3 * 3600_000);
  await resolve_(dec.id, 'approve', 'ceo', 'Approved for execution runs.');
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
      scope: { projectId: pick(projects).id },
      meta: { errorId, source: pick(['tool', 'test', 'uat'] as const), sessionId: null, projectId: null, processType: pick(['feature-build', 'test-repair', 'migration']), model: c.dimension === 'model_capability' ? MODEL_ID_BY_TIER.haiku : pick([MODEL_ID_BY_TIER.sonnet, MODEL_ID_BY_TIER.opus]), signature: createHash('sha256').update(c.classId).digest('hex').slice(0, 32), codeArea: 'src/config', priority: rnd() < 0.2 ? 'high' : 'normal', costUsd: Math.round(rnd() * 400) / 100, costMs: between(60_000, 1_800_000) },
      payload: { message: `${c.name} (occurrence ${i + 1})` },
      source: 'system',
    });
    store.append({ type: 'rootcause.assigned', actor: human(U('priya')), scope: {}, meta: { errorId, classId: c.classId, assignedBy: 'human', confidence: 1 }, source: 'api' });
  }
}

// ── credits: allocations, an auto-grant, a pending top-up ────────────────────
const period = localDate(now, TZ).slice(0, 7);
at(t0 + DAY);
for (const b of builders) store.append({ type: 'credit.allocated', actor: human(U('ceo')), scope: { userId: U(b) }, meta: { userId: U(b), period, amountUsd: 300, allocatedBy: U('ceo') }, source: 'api' });

// ── live sessions "now": one per liveness state ──────────────────────────────
at(now - 50 * 60_000);
const live: Record<string, SimSession> = {};
const mk = (key: string, owner: string, project: (typeof projects)[number], type: string, prompt: string) => (live[key] = launch(owner, project, type, prompt));
mk('working', U('aisyah'), projects[0], 'feature-build', 'Add supervisor whisper suggestions to the agent desktop');
mk('thinking', U('weijie'), projects[1], 'discovery', 'Design OCR fallback for handwritten claim forms');
mk('stalled', U('priya'), projects[0], 'migration', 'Migrate interaction history to the partitioned table');
mk('waiting', U('aisyah'), projects[1], 'bug-fix', 'Fix duplicate claim submissions on retry');
mk('throttled', U('weijie'), projects[0], 'feature-build', 'Real-time CSAT sentiment overlay');
mk('dead', U('priya'), projects[2], 'docs', 'Document the rollback runbook');
for (const s of Object.values(live)) {
  tools(s, 5, 120_000);
  declare(s);
  tools(s, between(10, 25), between(10, 25) * 60_000);
  usage(s, between(10, 30), between(60_000, 420_000));
  const t = s.plan.phases[0]!.tasks[0]!;
  done(s, t.id, s.plan.phases[0]!.id, t.size);
}
// Waiting on you: main-branch merge decision (test 1 → Approver)
at(now - 34 * 60_000);
const mainDecision = decision({
  kind: 'agent_decision',
  test: 'main',
  title: 'Merge the retry-dedupe fix to main?',
  question: 'The fix for duplicate claim submissions is ready on fix/claims-dedupe with a regression test. Merge to main now or hold for UAT?',
  options: [{ id: 'merge', label: 'Merge to main' }, { id: 'uat', label: 'Hold for UAT first' }],
  rec: 'uat',
  context: '3 files changed, regression test api/claims.dedupe.test.ts passing.',
  subjectType: 'session',
  subjectId: live.waiting!.sessionId,
  sessionId: live.waiting!.sessionId,
  projectId: projects[1].id,
  requesterId: `session:${live.waiting!.sessionId}`,
});
store.append({ type: 'session.turn_ended', actor: sys('supervisor'), scope: { sessionId: live.waiting!.sessionId }, meta: { sessionId: live.waiting!.sessionId, turn: 1, outcome: 'decision', exitCode: 0, durationMs: 1000 }, payload: {}, source: 'supervisor' });
store.append({ type: 'session.lifecycle_changed', actor: sys('supervisor'), scope: { sessionId: live.waiting!.sessionId }, meta: { sessionId: live.waiting!.sessionId, from: 'running', to: 'waiting_decision', reason: 'open_decision' }, source: 'supervisor' });
// Throttled: plan limit with a reset time
at(now - 22 * 60_000);
store.append({ type: 'throttle.hit', actor: agent(live.throttled!.sessionId), scope: { sessionId: live.throttled!.sessionId }, meta: { sessionId: live.throttled!.sessionId, resetAt: new Date(now + 95 * 60_000).toISOString(), source: 'stream' }, payload: { message: "You've hit your session limit · resets 2:05pm (Asia/Kuala_Lumpur)" }, source: 'supervisor' });
store.append({ type: 'session.lifecycle_changed', actor: sys('supervisor'), scope: { sessionId: live.throttled!.sessionId }, meta: { sessionId: live.throttled!.sessionId, from: 'running', to: 'throttled', reason: 'plan_limit' }, source: 'supervisor' });
// Dead: crashed process
at(now - 12 * 60_000);
store.append({ type: 'session.turn_ended', actor: sys('supervisor'), scope: { sessionId: live.dead!.sessionId }, meta: { sessionId: live.dead!.sessionId, turn: 1, outcome: 'crashed', exitCode: 143, durationMs: 1000 }, payload: {}, source: 'supervisor' });
store.append({ type: 'session.lifecycle_changed', actor: sys('supervisor'), scope: { sessionId: live.dead!.sessionId }, meta: { sessionId: live.dead!.sessionId, from: 'running', to: 'failed', reason: 'exit_143_no_result' }, source: 'supervisor' });

// More open decisions for the inbox
at(now - 3 * 3600_000);
decision({ kind: 'credit_topup', title: 'Top-up request: Tan Wei Jie (+US$100)', question: 'Wei Jie hit the monthly cap after the 25% auto-grant. Approve a US$100 top-up for the CSAT overlay work?', options: [{ id: 'approve', label: 'Approve US$100' }, { id: 'deny', label: 'Deny' }], subjectType: 'credit_request', subjectId: 'tpu_demo1', requesterId: U('weijie') });
at(now - 26 * 3600_000);
decision({ kind: 'lesson_binding', title: 'Bind lesson: guard required env vars', question: 'Bind "Config loaders must fail fast on missing env vars with a named error" for code area src/config?', options: [{ id: 'bind', label: 'Bind lesson' }, { id: 'reject', label: 'Reject' }], rec: 'bind', subjectType: 'lesson', subjectId: 'les_demo1', requesterId: U('priya') });

// Observed session (developer terminal, read-only)
at(now - 8 * 60_000);
const obsId = newId('session', clock.now());
store.append({ type: 'session.observed', actor: sys('sessions'), scope: { sessionId: obsId }, meta: { sessionId: obsId, claudeSessionId: randomUUID(), projectId: projects[2].id }, payload: { cwd: join(repoRoot, 'aoc-platform'), transcriptPath: '' }, source: 'hook' });

// Final liveness sweep + anchor + daily close at the real "now"
at(now);
const sessions = rt.services.get('sessions') as unknown as { refreshAll?: () => void };
sessions.refreshAll?.();
await rt.tickJobs().catch((e) => console.warn('jobs:', String(e)));
await rt.drain();

// Per-session ingest tokens so the demo pulse can keep live sessions genuinely alive through the real ingest API.
const identity = rt.services.get('identity');
const liveTokens = Object.fromEntries(
  Object.entries(live).map(([k, s]) => [k, { sessionId: s.sessionId, claudeSessionId: s.claude, token: identity.issueIngestToken(s.sessionId, sys('demo')) }]),
);
const out = {
  dataDir,
  console: config.publicUrl,
  live: liveTokens,
  tokens: Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, { userId: v.userId, role: v.role, token: v.token }])),
  head: store.head(),
};
writeFileSync(join(dataDir, 'demo-tokens.json'), JSON.stringify(out, null, 2), { mode: 0o600 });
writeFileSync(join(dataDir, 'aoc.config.json'), JSON.stringify(demoConfig, null, 2));
await rt.stop();
console.log(`Seeded ${out.head.seq} events into ${dataDir}`);
console.log(`Tokens: ${join(dataDir, 'demo-tokens.json')} (CEO token logs you in as the Approver)`);
console.log(`Run:   AOC_CONFIG=${join(dataDir, 'aoc.config.json')} node --import tsx packages/daemon/src/main.ts`);
console.log('       (the config runs managed sessions on claude-sim, never the real claude CLI)');
