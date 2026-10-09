/**
 * The demo seeder: fourteen days of history written through the real modules by an in-process runtime on a fake clock,
 * so every projection, the hash chain and the anchors are genuine. Deterministic (seeded PRNG), and every event is
 * stamped at or before the seeding instant. The sections of the seed live next to this file:
 *
 *   history.ts   finished sessions with plans, evidence and phase pins (real commits and tags)
 *   change.ts    change control: change requests, rollbacks, break-glass, promotions
 *   tickets.ts   intake tickets in every stage of the funnel
 *   learning.ts  credits, error learning, the lesson and the top-up waiting for the Approver
 *   now.ts       one session per liveness state
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { AocConfigSchema, defaultConfig, newId, type Actor, type LaunchRequest } from '@aoc/contracts';
import { AocRuntime, FakeClock, createLogger, localDate, type AocModule, type AppEnv } from '@aoc/kernel';
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
import { SECRET_ENV, simEnv } from '../daemon-env';
import { defaultScenario } from '../default-scenario';
import { demoLayout, type DemoTokens, type DemoUser, type LiveKind } from '../layout';
import { ACCEPTANCE_COMMAND, PROJECT_FILES } from '../repos';
import { CLAUDE_SIM_BIN } from '../sim-guard';
import { initDemoRepo, type Author } from './git';
import { scheduleChangeControl } from './change';
import { seedHistory } from './history';
import { scheduleAllocations, seedErrorLearning, seedLessonProposal, seedTopupRequest } from './learning';
import { seedNow, writeResumableConversation } from './now';
import { resetRandom, rnd } from './rng';
import { PasskeySigner } from './signer';
import { SessionKit } from './sessions';
import { SeedSupervisor } from './supervisor';
import { scheduleTickets } from './tickets';
import { DAY, HOUR, Timeline, human, setService, sys, type Person, type PersonKey, type SeedWorld } from './world';

const TZ = 'Asia/Kuala_Lumpur';
const IMPORT_AUTHOR: Author = { name: 'Daythree Engineering', email: 'engineering@daythree.example' };
const repoRoot = new URL('../../../..', import.meta.url).pathname.replace(/\/+$/, '');

const PEOPLE: { key: PersonKey; name: string; role: Person['role']; email: string; complianceLead?: boolean }[] = [
  { key: 'ceo', name: 'Chiew Sin Kwang', role: 'approver', email: 'sin.kwang@daythree.example' },
  { key: 'aisyah', name: 'Aisyah Rahman', role: 'builder', email: 'aisyah.rahman@daythree.example' },
  { key: 'weijie', name: 'Tan Wei Jie', role: 'builder', email: 'weijie.tan@daythree.example' },
  { key: 'priya', name: 'Priya Nair', role: 'builder', email: 'priya.nair@daythree.example', complianceLead: true },
  { key: 'daniel', name: 'Daniel Lim', role: 'requester', email: 'daniel.lim@customer.example' },
  { key: 'nur', name: 'Nur Hidayah', role: 'requester', email: 'nur.hidayah@customer.example' },
];

export interface SeedOptions {
  /** The demo directory (see ../layout.ts). It must not hold a demo yet. */
  dataDir: string;
  days?: number;
  /** The seeding instant; every seeded event is at or before it (default: the wall clock now). */
  now?: number;
  /** Keep the runtime open and hand it back (tests); otherwise it is stopped once the directory is written. */
  keepOpen?: boolean;
}

export interface SeedResult {
  tokens: DemoTokens;
  world: SeedWorld;
  /** Stops the runtime (a no-op once `close` ran, or when the seed was not kept open). */
  close(): Promise<void>;
}

/**
 * The daemon config for this demo (written to <dir>/aoc.config.json). Managed sessions run on claude-sim, never the
 * real `claude` CLI, and LLM-backed jobs use the fake extractor: a demo must not spend plan quota or touch real
 * repositories. aocd runs with ../daemon-env.ts's simEnv (claude-sim settings, allowlisted here); credentials never
 * reach sim sessions.
 */
function demoConfig(layout: ReturnType<typeof demoLayout>) {
  return {
    dataDir: layout.aocData,
    timezone: TZ,
    registryFile: join(repoRoot, 'config/process-types.json'),
    metering: { rateCardFile: join(repoRoot, 'config/rate-card.json') },
    compliance: { mappingFile: join(repoRoot, 'config/iso42001-mapping.json') },
    fx: { enabled: false, extractor: 'fake' as const },
    audit: { anchorProvider: 'git' as const, anchorRepoPath: join(layout.aocData, 'anchor-repo') },
    supervisor: {
      claudeBin: process.execPath,
      claudeArgsPrefix: [CLAUDE_SIM_BIN],
      workspacesDir: layout.workspaces,
      // Seven demo slots plus rollover successors, intake sessions and resumed seeded sessions run side by side.
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
}

export async function runSeed(opts: SeedOptions): Promise<SeedResult> {
  resetRandom();
  const layout = demoLayout(opts.dataDir);
  if (existsSync(join(layout.root, 'aoc.db'))) throw new Error(`${layout.root} holds a demo in the old layout (AOC data at the top level). Re-run with --reset.`);
  if (existsSync(join(layout.aocData, 'aoc.db'))) throw new Error(`${layout.root} already has data. Re-run with --reset to rebuild the demo.`);
  mkdirSync(layout.aocData, { recursive: true });

  const days = opts.days ?? 14;
  const now = opts.now ?? Date.now();
  const clock = new FakeClock(now - days * DAY);
  const t0 = clock.now();
  const rawConfig = demoConfig(layout);
  const config = AocConfigSchema.parse(rawConfig);
  const change = createChangeModule();
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
    change,
    createAuditModule(),
    createEvidenceModule(),
    createIntakeModule(),
    createTowerModule(),
  ];
  // 'error': a seeding step that cannot work (e.g. intake without a supervisor) is reported by the step itself.
  const rt = await AocRuntime.create({ config, modules, clock, log: createLogger({ level: 'error' }) });
  const app = rt.mount(new Hono<AppEnv>());
  const store = rt.store;

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

  // ── people (through the identity API) ──────────────────────────────────────────────────────────────────────
  const people = {} as Record<PersonKey, Person>;
  const bootstrapFile = join(layout.aocData, 'bootstrap-token');
  const ownerToken = existsSync(bootstrapFile) ? readFileSync(bootstrapFile, 'utf8').trim() : null;
  if (!ownerToken) throw new Error('the identity module wrote no bootstrap token');
  for (const p of PEOPLE) {
    const author: Author = { name: p.name, email: p.email };
    if (p.key === 'ceo') {
      const me = await api<{ user: { id: string } }>('GET', '/api/auth/me', ownerToken);
      if (me.status !== 200) throw new Error(`the bootstrap token was refused: HTTP ${me.status}`);
      await api('PATCH', `/api/users/${me.data.user.id}`, ownerToken, { name: p.name, email: p.email });
      people.ceo = { key: p.key, userId: me.data.user.id, name: p.name, role: p.role, token: ownerToken, author };
      continue;
    }
    const created = await api<{ user: { id: string } }>('POST', '/api/users', ownerToken, {
      name: p.name,
      role: p.role,
      email: p.email,
      ...(p.complianceLead ? { flags: { complianceLead: true } } : {}),
    });
    if (created.status >= 300) throw new Error(`identity API refused user ${p.key}: HTTP ${created.status} ${JSON.stringify(created.data)}`);
    const minted = await api<{ token: string | { token: string } }>('POST', `/api/users/${created.data.user.id}/tokens`, ownerToken, { label: 'demo' });
    if (minted.status >= 300) throw new Error(`identity API refused a token for ${p.key}: HTTP ${minted.status}`);
    const token = typeof minted.data.token === 'string' ? minted.data.token : minted.data.token.token;
    people[p.key] = { key: p.key, userId: created.data.user.id, name: p.name, role: p.role, token, author };
  }

  // ── projects with real git repositories (phase pins, provenance and evidence need commits) ───────────────────
  const project = (id: string, slug: keyof typeof PROJECT_FILES, name: string, description: string) => ({ id, slug, name, description, repo: join(layout.repos, slug) });
  const projects: SeedWorld['projects'] = {
    cx: project('prj_cxcopilot', 'cx-copilot', 'CX Copilot', 'Agent-assist copilot for the Daythree contact centre'),
    claims: project('prj_claims', 'claims-bot', 'Claims Intake Bot', 'Insurance claims intake and triage assistant'),
    aoc: project('prj_aoc', 'aoc-platform', 'AOC Platform', 'This console — features only; the governance core is human-built'),
  };
  for (const p of Object.values(projects)) {
    initDemoRepo(p.repo, PROJECT_FILES[p.slug as keyof typeof PROJECT_FILES], t0, IMPORT_AUTHOR);
    store.append({
      type: 'project.created',
      actor: human(people.ceo.userId),
      scope: { projectId: p.id },
      meta: { projectId: p.id, slug: p.slug },
      payload: { name: p.name, description: p.description, repoPath: p.repo, defaultBranch: 'main', acceptanceCommand: ACCEPTANCE_COMMAND },
      source: 'cli',
    });
  }

  // ── FX history: the BNM session rate, live weekdays, inherited weekends ────────────────────────────────────
  // Each record is the day's BNM 1700 rate (config.fx.session), taken by the daily run at config.fx.runAtLocalTime
  // (MYT is UTC+8 all year). BNM publishes it at about 17:40, so a day whose run is still ahead has no record yet.
  let rate = 4.215;
  let lastLive = localDate(t0 - DAY, TZ);
  for (let d = 0; d <= days; d++) {
    const date = localDate(t0 + d * DAY, TZ);
    const runAt = Date.parse(`${date}T${config.fx.runAtLocalTime}:00+08:00`);
    if (runAt < t0 || runAt > now) continue;
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    clock.set(runAt);
    if (weekday === 0 || weekday === 6) {
      store.append({ type: 'fx.rate_recorded', actor: sys('scheduler:fx'), meta: { date, pair: 'USD/MYR', rate, status: 'inherited', sourceDate: lastLive, extractor: 'none', validation: 'not_applicable', reason: 'weekend_or_holiday', session: config.fx.session }, payload: { notes: 'Weekend — carried forward by design' }, source: 'scheduler' });
    } else {
      rate = Math.round((rate + (rnd() - 0.5) * 0.03) * 10_000) / 10_000;
      lastLive = date;
      const second = d % 9 === 4;
      store.append({ type: 'fx.rate_recorded', actor: sys('scheduler:fx'), meta: { date, pair: 'USD/MYR', rate, status: 'live', sourceDate: date, extractor: second ? 'sonnet' : 'haiku', validation: 'pass', reason: 'fetched', session: config.fx.session }, payload: { sourceUrl: config.fx.pageUrl, notes: second ? 'Haiku output failed self-validation; Sonnet succeeded' : undefined }, source: 'scheduler' });
    }
  }

  // ── the world the sections share ─────────────────────────────────────────────────────────────────────────
  async function settle(): Promise<void> {
    // Reactors, and the rollback verifications they start in the background, append more events: until the log is still.
    for (let seq = -1; seq !== store.head().seq; ) {
      seq = store.head().seq;
      await rt.drain();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await change.whenIdle();
      await rt.drain();
    }
  }
  const profiles = new Set([...rt.services.get('registry').listTypes().flatMap((t) => (t.credentialProfile ? [t.credentialProfile] : [])), 'prod-promote']);
  const byId = new Map(Object.values(projects).map((p) => [p.id, p]));
  const kit = new SessionKit(() => world);
  const queueLaunch = (req: LaunchRequest, actor: Actor): string => {
    const target = byId.get(req.projectId);
    if (!target) throw new Error(`launch for unknown project ${req.projectId}`);
    return kit.request(actor.kind === 'human' ? actor.id : null, target, req.processType, req.prompt, req.threadId ?? newId('thread', clock.now()), {
      ticketId: req.ticketId,
      changeId: req.changeId,
    }).sessionId;
  };
  const supervisor = new SeedSupervisor(clock, queueLaunch, profiles);
  setService(rt, 'supervisor', supervisor);
  const world: SeedWorld = {
    now,
    t0,
    days,
    tz: TZ,
    layout,
    config,
    rt,
    app,
    store,
    clock,
    change,
    people,
    projects,
    kit,
    signer: new PasskeySigner(() => world),
    supervisor,
    timeline: new Timeline(),
    at: (ms) => clock.set(ms),
    async withoutSupervisor(fn) {
      setService(rt, 'supervisor', null);
      try {
        return await fn();
      } finally {
        setService(rt, 'supervisor', supervisor);
      }
    },
    api,
    async ok<T>(method: string, path: string, who: PersonKey, body?: unknown): Promise<T> {
      const r = await api<T>(method, path, people[who].token, body);
      if (r.status >= 300) throw new Error(`${method} ${path} as ${who}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
      return r.data;
    },
    settle,
  };

  // ── the history, in time order ───────────────────────────────────────────────────────────────────────────
  scheduleAllocations(world);
  seedErrorLearning(world);
  scheduleChangeControl(world);
  const intake = scheduleTickets(world);
  await seedHistory(world);
  // Governed work from the last hour is written around the "now" sessions, which occupy the same hour.
  await world.timeline.runDue(now - HOUR, clock);
  const live = seedNow(world);
  await world.timeline.runDue(Number.POSITIVE_INFINITY, clock);
  if (world.timeline.left.length) throw new Error(`seed steps never ran: ${world.timeline.left.join(', ')}`);
  if (!intake.waiting) throw new Error('the seed left no build waiting on a decision');
  writeResumableConversation(world, intake.waiting);
  await seedLessonProposal(world);
  await seedTopupRequest(world);

  // Final liveness sweep, anchor and daily close at the seeding instant.
  world.at(now);
  (rt.services.get('sessions') as unknown as { refreshAll?: () => void }).refreshAll?.();
  await rt.tickJobs().catch((err: unknown) => console.warn('jobs:', String(err)));
  await settle();
  await world.signer.retire();
  await settle();
  const late = store.list({ fromTs: new Date(now + 1).toISOString(), limit: 5 });
  if (late.length) throw new Error(`events after the seeding instant: ${late.map((e) => `${e.type} at ${e.ts}`).join(', ')}`);

  // ── what aocd and the live launcher need next to the data ─────────────────────────────────────────────────
  const user = (k: PersonKey): DemoUser => ({ userId: people[k].userId, role: people[k].role, token: people[k].token });
  const tokens: DemoTokens = {
    dataDir: layout.root,
    console: config.publicUrl,
    seededAt: now,
    tokens: { ceo: user('ceo'), aisyah: user('aisyah'), weijie: user('weijie'), priya: user('priya'), daniel: user('daniel'), nur: user('nur') },
    sessions: { ...live.ids, waiting: intake.waiting.session.sessionId } satisfies Record<LiveKind, string>,
    tickets: intake.tickets,
    projects: { cx: projects.cx.id, claims: projects.claims.id, aoc: projects.aoc.id },
    head: store.head(),
  };
  writeFileSync(layout.tokens, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  writeFileSync(layout.config, JSON.stringify(rawConfig, null, 2));
  // claude-sim's side: the default scenario (intake triage and builds of the scripted tickets, rollover successors).
  mkdirSync(layout.claudeConfig, { recursive: true });
  const ticket = (key: string) => intake.tickets.find((t) => t.key === key)!.ticketId;
  writeFileSync(layout.simDefaultScenario, JSON.stringify(defaultScenario({ receipts: ticket('receipts'), transferBlank: ticket('transfer-blank') }), null, 2));
  // Every credential profile the demo can request (the registry's, plus mod-change's promotion profile), each with an
  // empty env: never a real credential (the promotion credential stays empty until G-04, credential-isolation runbook).
  writeFileSync(layout.credentialProfiles, JSON.stringify({ profiles: Object.fromEntries([...profiles].map((p) => [p, { env: {} }])) }, null, 2), { mode: 0o600 });
  chmodSync(layout.credentialProfiles, 0o600);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await rt.stop();
  };
  if (!opts.keepOpen) await close();
  return { tokens, world, close };
}

