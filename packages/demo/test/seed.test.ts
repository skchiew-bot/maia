/**
 * What the seeder leaves behind, read back through the modules' own APIs and the repositories: honest change control,
 * pins that resolve, no event after the seeding instant, tickets in every stage of the funnel, no scenario markers in
 * requester-visible text, and cards that move the real records when they are answered. The seed runs in-process on a
 * fake clock (no daemon, no sessions), so this stays light enough for a shared host.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BreakglassDTO, ChangeRequestDTO, DecisionCard, InternalTicket, LessonDTO, PinListDTO, PromotionDTO, ProvenanceDTO, RollbackDTO, StoredEvent, TowerSnapshot } from '@aoc/contracts';
import { simEnv } from '../src/daemon-env';
import { runSeed, type SeedResult } from '../src/seed/run';
import type { PersonKey, SeedWorld } from '../src/seed/world';
import { removeTree } from './helpers';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A Wednesday, 11:30 in Kuala Lumpur: the scripted history is dated from it, whatever day the suite runs on. */
const WEDNESDAY = Date.parse('2026-10-07T11:30:00+08:00');
/** The Monday morning before it: a weekend sits inside the scripted working days. */
const MONDAY = Date.parse('2026-10-05T08:30:00+08:00');

const dir = mkdtempSync(join(tmpdir(), 'aoc-demo-seedtest-'));
afterAll(() => removeTree(dir));

const git = (repo: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
};

const events = (w: SeedWorld, type: StoredEvent['type']): StoredEvent[] => w.store.list({ types: [type], limit: 100_000 });
const iso = (ms: number) => new Date(ms).toISOString();

describe('the seed on a Wednesday', () => {
  let seeded: SeedResult;
  let w: SeedWorld;
  const get = <T>(path: string, who: PersonKey = 'ceo') => w.ok<T>('GET', path, who);
  const tickets = () => get<InternalTicket[]>('/api/tickets');
  const byKey = async (key: string) => {
    const ref = seeded.tokens.tickets.find((t) => t.key === key);
    if (!ref) throw new Error(`no seeded ticket ${key}`);
    return (await tickets()).find((t) => t.ticketId === ref.ticketId)!;
  };
  const repoOf = (slug: string) => join(seeded.tokens.dataDir, 'repos', slug);

  beforeAll(async () => {
    seeded = await runSeed({ dataDir: join(dir, 'wednesday'), now: WEDNESDAY, keepOpen: true });
    w = seeded.world;
  }, 300_000);
  afterAll(async () => {
    await seeded?.close();
  });

  describe('time', () => {
    it('ends the log at the seeding instant, including the sessions that are "now"', () => {
      expect(seeded.tokens.seededAt).toBe(WEDNESDAY);
      expect(w.store.list({ fromTs: iso(WEDNESDAY + 1), limit: 1 })).toEqual([]);
      expect(w.store.list({ fromTs: iso(WEDNESDAY - 60_000), limit: 1 }).length).toBe(1);
    });

    it('dates no commit, tag or branch of the repositories after it either (service clones included)', () => {
      const clones = join(seeded.tokens.dataDir, 'aoc', 'git');
      const repos = [repoOf('claims-bot'), repoOf('cx-copilot'), repoOf('aoc-platform'), ...(existsSync(clones) ? readdirSync(clones).map((d) => join(clones, d)) : [])];
      expect(repos.length).toBeGreaterThanOrEqual(3);
      for (const repo of repos) {
        const dates = [
          ...git(repo, '--git-dir=' + (existsSync(join(repo, '.git')) ? join(repo, '.git') : repo), 'for-each-ref', '--format=%(creatordate:unix)').out.split('\n'),
          ...git(repo, '--git-dir=' + (existsSync(join(repo, '.git')) ? join(repo, '.git') : repo), 'log', '--all', '--format=%ct').out.split('\n'),
        ]
          .filter(Boolean)
          .map(Number);
        expect(dates.length, repo).toBeGreaterThan(0);
        expect(Math.max(...dates), repo).toBeLessThanOrEqual(WEDNESDAY / 1000);
      }
    });
  });

  describe('repositories', () => {
    it('are left clean and on main', () => {
      for (const slug of ['claims-bot', 'cx-copilot', 'aoc-platform']) {
        const repo = repoOf(slug);
        expect(git(repo, 'status', '--porcelain').out, slug).toBe('');
        expect(git(repo, 'branch', '--show-current').out, slug).toBe('main');
      }
    });

    it('moved main only through the gates: each promotion or rollback starts where the last one ended, and the last ended at main', async () => {
      const promotions = (await get<{ items: PromotionDTO[] }>('/api/promotions')).items.filter((p) => p.status === 'completed');
      const rollbacks = (await get<{ items: RollbackDTO[] }>('/api/rollbacks')).items.filter((r) => r.status === 'executed');
      for (const [slug, project] of [['claims-bot', w.projects.claims], ['cx-copilot', w.projects.cx], ['aoc-platform', w.projects.aoc]] as const) {
        const moves = [
          ...promotions.filter((p) => p.projectId === project.id).map((p) => p.completion!),
          ...rollbacks.filter((r) => r.projectId === project.id).map((r) => r.execution!),
        ].sort((a, b) => a.at.localeCompare(b.at));
        expect(moves.length, slug).toBeGreaterThanOrEqual(1);
        const root = git(repoOf(slug), 'rev-list', '--max-parents=0', 'main').out;
        let at = root;
        for (const m of moves) {
          expect(m.mainShaBefore, `${slug} at ${m.at}`).toBe(at);
          at = m.mainShaAfter;
        }
        expect(git(repoOf(slug), 'rev-parse', 'main').out, slug).toBe(at);
      }
    });
  });

  describe('sessions that work again', () => {
    it('work in workspaces of their own, so the checkouts the gates move stay clean', () => {
      const launches = events(w, 'session.launch_requested');
      for (const kind of ['working', 'thinking', 'stalled', 'throttled', 'dead'] as const) {
        const launch = launches.find((e) => e.meta.sessionId === seeded.tokens.sessions[kind])!;
        const { cwd } = w.store.readPayload(launch) as { cwd: string };
        const project = Object.values(w.projects).find((p) => p.id === launch.meta.projectId)!;
        expect(cwd, kind).toContain(join(w.layout.workspaces, project.id));
        expect(git(cwd, 'status', '--porcelain').out, kind).toBe('');
        expect(git(cwd, 'symbolic-ref', '--quiet', 'HEAD').ok, `${kind} is detached`).toBe(false);
        expect(git(project.repo, 'worktree', 'list', '--porcelain').out, kind).toContain(`worktree ${cwd}`);
      }
    });
  });

  describe('pins', () => {
    it('are real annotated tags on real commits: every phase completion resolves in its project repository', () => {
      const completed = events(w, 'phase.completed');
      expect(completed.length).toBeGreaterThan(40);
      const slugs = new Map(Object.values(w.projects).map((p) => [p.id, p.slug]));
      for (const e of completed) {
        const tag = String(e.meta.pinnedTag);
        const repo = repoOf(slugs.get(String(e.meta.projectId))!);
        expect(git(repo, 'cat-file', '-t', `refs/tags/${tag}`).out, tag).toBe('tag');
        expect(git(repo, 'rev-parse', '--verify', `refs/tags/${tag}^{commit}`).out, tag).toBe(e.meta.pinnedSha);
      }
    });

    it('all resolve as a rollback would resolve them, change pins included', async () => {
      for (const p of Object.values(w.projects)) {
        const list = await get<PinListDTO>(`/api/pins?projectId=${p.id}`);
        expect(list.pins.length, p.slug).toBeGreaterThan(10);
        expect(list.pins.filter((x) => x.problem || x.resolvedSha !== x.sha && x.sha !== null), p.slug).toEqual([]);
        expect(list.pins.some((x) => x.tag?.startsWith('aoc/change/')), p.slug).toBe(true);
      }
    });
  });

  describe('change control', () => {
    let changes: ChangeRequestDTO[];
    beforeAll(async () => {
      changes = (await get<{ items: ChangeRequestDTO[] }>('/api/changes')).items;
    });

    it('has completed records, one awaiting the Approver and one draft', () => {
      const status = (s: string) => changes.filter((c) => c.status === s);
      expect(status('completed').length).toBeGreaterThanOrEqual(4);
      expect(status('submitted')).toHaveLength(1);
      expect(status('draft').length).toBeGreaterThanOrEqual(2); // a draft of the team's, and the open break-glass's post-incident record
      for (const c of status('completed')) {
        expect(c.pinnedTag, c.changeId).toBe(`aoc/change/${c.changeId}`);
        expect(c.pinnedSha, c.changeId).toMatch(/^[0-9a-f]{40}$/);
      }
    });

    it('records four fields drafted by the model and affirmed by different people, one of them a blind confirm', () => {
      const fields = changes.filter((c) => c.status === 'completed').flatMap((c) => c.fields);
      expect(fields.every((f) => f.affirmed)).toBe(true);
      expect(fields.some((f) => f.edited)).toBe(true);
      expect(fields.filter((f) => f.blind)).toHaveLength(1);
      const mixed = changes.filter((c) => c.status === 'completed' && c.fields.length === 4 && new Set(c.fields.map((f) => f.affirmedBy)).size >= 2);
      expect(mixed.length).toBeGreaterThanOrEqual(1);
    });

    it('has a verified-clean rollback awaiting its passkey gate and one executed earlier', async () => {
      const rollbacks = (await get<{ items: RollbackDTO[] }>('/api/rollbacks')).items;
      const executed = rollbacks.filter((r) => r.status === 'executed');
      const waiting = rollbacks.filter((r) => r.status === 'awaiting_approval');
      expect(executed).toHaveLength(1);
      expect(waiting).toHaveLength(1);
      for (const r of [...executed, ...waiting]) {
        // The acceptance suite really ran on the target: its report names the command and counts real tests.
        expect(r.verification?.clean, r.rollbackId).toBe(true);
        expect(r.verification!.testsPassed, r.rollbackId).toBeGreaterThan(0);
        expect(r.verification!.testsFailed, r.rollbackId).toBe(0);
        expect(r.verification!.report, r.rollbackId).toContain('node --test test/acceptance.test.mjs');
      }
      expect(executed[0]!.approval?.passkeyVerified).toBe(true);
      expect(executed[0]!.execution!.mainShaBefore).not.toBe(executed[0]!.execution!.mainShaAfter);
      const card = w.rt.services.get('decisions').get(waiting[0]!.decisionId!)!;
      expect(card).toMatchObject({ kind: 'rollback', status: 'open', requiresPasskey: true });
    });

    it('has a closed break-glass whose post-incident record was filed within 24 hours, and one open inside its window', async () => {
      const glasses = (await get<{ items: BreakglassDTO[] }>('/api/breakglass')).items;
      expect(glasses).toHaveLength(2);
      for (const g of glasses) {
        expect(g.status).toBe('approved');
        expect(g.approval?.passkeyVerified).toBe(true);
        expect(g.promotion).toMatchObject({ status: 'completed', breakglass: true });
        expect(g.overdue).toBe(false);
      }
      const closed = glasses.filter((g) => g.postIncidentStatus === 'completed');
      const open = glasses.filter((g) => g.postIncidentStatus !== 'completed');
      expect(closed).toHaveLength(1);
      expect(open).toHaveLength(1);
      const record = changes.find((c) => c.changeId === closed[0]!.postIncidentChangeId)!;
      expect(Date.parse(record.completedAt!) - Date.parse(closed[0]!.approval!.at)).toBeLessThan(DAY);
      expect(Date.parse(open[0]!.dueAt!)).toBeGreaterThan(WEDNESDAY);
      expect(Date.parse(open[0]!.dueAt!) - WEDNESDAY).toBeLessThanOrEqual(DAY);
    });

    it('has promotions that passed provenance, none refused, and the go-live gates still open', async () => {
      const promotions = (await get<{ items: PromotionDTO[] }>('/api/promotions')).items;
      const completed = promotions.filter((p) => p.status === 'completed');
      expect(completed.length).toBeGreaterThanOrEqual(5);
      expect(completed.filter((p) => p.changeId)).not.toHaveLength(0);
      expect(completed.filter((p) => p.ticketId)).toHaveLength(2);
      expect(completed.filter((p) => p.breakglass)).toHaveLength(2);
      expect(promotions.filter((p) => p.status === 'refused' || p.status === 'failed')).toEqual([]);
      for (const p of completed) expect(p.completion!.mainShaAfter, p.promotionId).toBe(p.fromSha);
      // The ticket whose go-live gate is open: its commits trace to an approved fix plan today.
      const open = promotions.filter((p) => p.status === 'requested');
      expect(open).toHaveLength(1);
      expect(w.rt.services.get('decisions').get(open[0]!.decisionId!)).toMatchObject({ kind: 'go_live', status: 'open', requiresPasskey: true });
      const trace = await get<ProvenanceDTO>(`/api/provenance?projectId=${open[0]!.projectId}&sha=${open[0]!.fromSha}`);
      expect(trace.ok, trace.reasons.join('; ')).toBe(true);
    });

    it('signed its gates with a software passkey that is removed again: the CEO registers a real one in Admin', () => {
      expect(events(w, 'passkey.registered')).toHaveLength(1);
      expect(events(w, 'passkey.removed')).toHaveLength(1);
      expect(events(w, 'passkey.asserted').length).toBeGreaterThanOrEqual(6);
    });

    it('needed no real credential to promote: the supervisor stand-in ran nothing with a credential profile', () => {
      expect(w.supervisor.runs.length).toBeGreaterThan(0);
      expect(w.supervisor.runs.filter((r) => r.credentialProfile !== null)).toEqual([]);
    });
  });

  describe('intake tickets', () => {
    it('are in every stage of the funnel, with diagnoses where the stage implies them', async () => {
      const all = await tickets();
      const stages = new Map<string, InternalTicket[]>();
      for (const t of all) stages.set(t.stage, [...(stages.get(t.stage) ?? []), t]);
      for (const stage of ['received', 'triage', 'awaiting_human', 'fix_plan_gate', 'building', 'uat', 'go_live_gate', 'completed', 'closed']) {
        expect(stages.get(stage)?.length, stage).toBeGreaterThanOrEqual(1);
      }
      expect(new Set(all.map((t) => t.severity))).toEqual(new Set(['critical', 'high', 'medium', 'low']));
      expect(new Set(all.map((t) => t.requesterName))).toEqual(new Set(['Daniel Lim', 'Nur Hidayah']));
      for (const t of all) {
        const reported = t.diagnoses.filter((d) => d.status === 'reported');
        if (['received', 'triage'].includes(t.stage) || t.resolution === 'duplicate') expect(reported, t.title).toEqual([]);
        else expect(reported.length, t.title).toBeGreaterThanOrEqual(2);
      }
      // The agents of the low-confidence ticket really were unsure.
      const unsure = stages.get('awaiting_human')![0]!;
      expect(Math.min(...unsure.diagnoses.map((d) => d.confidence ?? 1))).toBeLessThan(0.6);
    });

    it('has a critical ticket waiting about two days for its requester in UAT, on a branch that exists', async () => {
      const t = await byKey('legacy-policy');
      expect(t).toMatchObject({ stage: 'uat', severity: 'critical', uatRef: `uat/${t.ticketId}` });
      const waited = WEDNESDAY - Date.parse(t.submittedAt);
      expect(waited).toBeGreaterThan(2 * DAY);
      expect(waited).toBeLessThan(2.5 * DAY);
      const repo = repoOf('claims-bot');
      expect(git(repo, 'rev-parse', '--verify', `refs/heads/uat/${t.ticketId}`).ok).toBe(true);
      const trailers = git(repo, 'log', '--format=%B', `main..uat/${t.ticketId}`).out;
      expect(trailers).toContain(`AOC-Ticket: ${t.ticketId}`);
      expect(trailers).toContain(`AOC-Session: ${t.buildSessionId}`);
      // Signing off would request go-live: the build passes provenance already.
      const trace = await get<ProvenanceDTO>(`/api/provenance?projectId=${t.projectId}&sha=${git(repo, 'rev-parse', `uat/${t.ticketId}`).out}`);
      expect(trace.ok, trace.reasons.join('; ')).toBe(true);
    });

    it('has promoted the completed ones: their UAT branches are on main', async () => {
      for (const key of ['claim-total', 'cx-panel']) {
        const t = await byKey(key);
        expect(t).toMatchObject({ stage: 'completed', resolution: 'fixed' });
        const repo = repoOf(key === 'claim-total' ? 'claims-bot' : 'cx-copilot');
        expect(git(repo, 'merge-base', '--is-ancestor', `uat/${t.ticketId}`, 'main').ok, key).toBe(true);
      }
    });

    it('has a build waiting on a decision behind the one in "building"', async () => {
      const t = await byKey('duplicate');
      expect(t.stage).toBe('building');
      const session = w.rt.services.get('sessions').get(t.buildSessionId!)!;
      expect(session.lifecycle).toBe('waiting_decision');
      expect(session.ticketId).toBe(t.ticketId);
      const card = w.rt.services.get('decisions').list({ status: ['open'], sessionId: t.buildSessionId! })[0]!;
      expect(card).toMatchObject({ kind: 'agent_decision', test: 'main' });
    });

    it('shows the Tower a funnel with a bottleneck at UAT, and customers waiting among the attention items', async () => {
      const tower = await get<TowerSnapshot>('/api/tower');
      const stages = Object.fromEntries(tower.flow.ticketFunnel.map((s) => [s.stage, s]));
      for (const stage of ['received', 'triage', 'awaiting_human', 'fix_plan_gate', 'building', 'uat', 'go_live_gate']) expect(stages[stage]!.count, stage).toBe(1);
      expect(stages.completed!.count).toBe(2);
      expect(stages.closed!.count).toBe(2);
      expect(stages.uat).toMatchObject({ bottleneck: true });
      expect(stages.uat!.medianAgeMs).toBeGreaterThan(2 * DAY);
      expect(tower.flow.ticketFunnel.filter((s) => s.bottleneck)).toHaveLength(1);

      const critical = await byKey('legacy-policy');
      const waiting = tower.attention.find((a) => a.kind === 'ticket_waiting');
      expect(waiting, 'a customer waiting').toBeDefined();
      expect(waiting!.severity).toBe('critical');
      expect(waiting!.detail).toContain(critical.ticketId);
      // Ticket gates are on the queue next to the other decisions: the fix plan, the go-live gate, the low-confidence card.
      for (const key of ['receipts', 'wrong-name', 'blank-login']) {
        const ticket = await byKey(key);
        const items = tower.attention.filter((a) => a.kind === 'decision' && a.detail?.includes(ticket.ticketId));
        expect(items, key).toHaveLength(1);
        expect(items[0]!.action.kind, key).toBe('resolve_decision');
      }
    });

    it('carry no claude-sim scenario marker where a requester can read, nor in the prompts intake wrote', async () => {
      const text = (await tickets()).flatMap((t) => [t.title, t.description, t.comment ?? '', ...t.diagnoses.flatMap((d) => [d.rootCause ?? '', d.fixPlan ?? ''])]);
      expect(text.filter((s) => s.includes('[[scenario'))).toEqual([]);
      const launches = events(w, 'session.launch_requested').filter((e) => e.meta.ticketId);
      expect(launches.length).toBeGreaterThanOrEqual(20);
      for (const e of launches) {
        const payload = w.store.readPayload(e) as { prompt?: string } | null;
        expect(payload?.prompt, e.id).not.toContain('[[scenario');
      }
    });
  });

  describe('plans', () => {
    it('declare distinct task ids: no two sessions share one', () => {
      const owners = new Map<string, string>();
      const shared: string[] = [];
      for (const e of events(w, 'plan.declared')) {
        const payload = w.store.readPayload(e) as { phases: { tasks: { id: string }[] }[] } | null;
        for (const task of payload?.phases.flatMap((p) => p.tasks) ?? []) {
          const owner = owners.get(task.id);
          if (owner && owner !== e.meta.sessionId) shared.push(task.id);
          owners.set(task.id, String(e.meta.sessionId));
        }
      }
      expect(owners.size).toBeGreaterThan(150);
      expect(shared).toEqual([]);
    });
  });

  describe('files next to the data', () => {
    it('hold every credential profile with an empty environment, readable by the owner only', () => {
      const file = seeded.world.layout.credentialProfiles;
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const { profiles } = JSON.parse(readFileSync(file, 'utf8')) as { profiles: Record<string, { env: Record<string, string>; push?: unknown; files?: unknown }> };
      const registry = w.rt.services.get('registry');
      const named = new Set([...registry.listTypes().flatMap((t) => (t.credentialProfile ? [t.credentialProfile] : [])), 'prod-promote']);
      expect(new Set(Object.keys(profiles))).toEqual(named);
      for (const [name, p] of Object.entries(profiles)) expect(p, name).toEqual({ env: {} });
    });

    it('need no claude-sim operator settings: builds get their git from the process types', () => {
      expect(Object.keys(simEnv(seeded.world.layout))).not.toContain('CLAUDE_SIM_USER_SETTINGS');
      expect(existsSync(join(seeded.world.layout.claudeConfig, 'settings.json'))).toBe(false);
      const scenario = JSON.parse(readFileSync(seeded.world.layout.simDefaultScenario, 'utf8')) as { steps: unknown[] };
      expect(JSON.stringify(scenario)).not.toContain('[[scenario');
    });
  });

  // These answer cards, so they run last: everything above read the seed as it was left.
  describe('cards answered through their own modules', () => {
    it('denying the credit top-up denies the real request, leaves no alert behind and needs no orphan record', async () => {
      const [request] = (await get<{ requests: { requestId: string; decisionId: string; status: string }[] }>('/api/credits/topup-requests')).requests;
      expect(request).toMatchObject({ status: 'pending' });
      const requested = events(w, 'credit.topup_requested');
      expect(requested).toHaveLength(1);
      expect(requested[0]!.meta).toMatchObject({ requestId: request!.requestId, decisionId: request!.decisionId });
      const before = await get<TowerSnapshot>('/api/tower');
      expect(before.attention.some((a) => a.kind === 'credit_blocked')).toBe(true);

      await w.ok<DecisionCard>('POST', `/api/decisions/${request!.decisionId}/resolve`, 'ceo', { optionId: 'deny' });
      await w.settle();

      expect(events(w, 'credit.topup_denied').map((e) => e.meta.requestId)).toEqual([request!.requestId]);
      const [after] = (await get<{ requests: { status: string }[] }>('/api/credits/topup-requests')).requests;
      expect(after!.status).toBe('denied');
      const tower = await get<TowerSnapshot>('/api/tower');
      expect(tower.attention.some((a) => a.kind === 'credit_blocked')).toBe(false);
    });

    it('binding the lesson binds the real lesson, which the Knowledge page links to', async () => {
      const list = await get<LessonDTO[]>('/api/learning/lessons');
      expect(list).toHaveLength(1);
      const lesson = list[0]!;
      expect(lesson.status).toBe('proposed');
      const card = w.rt.services.get('decisions').get(lesson.decisionId)!;
      expect(card).toMatchObject({ kind: 'lesson_binding', status: 'open', subjectType: 'lesson', subjectId: lesson.lessonId });

      await w.ok<DecisionCard>('POST', `/api/decisions/${lesson.decisionId}/resolve`, 'ceo', { optionId: 'bind' });
      await w.settle();
      const after = await get<LessonDTO[]>('/api/learning/lessons');
      expect(after[0]).toMatchObject({ lessonId: lesson.lessonId, status: 'bound' });
    });
  });
});

describe('the seed on a Monday morning', () => {
  it('completes with the same shape: a weekend inside the scripted working days changes no stage and no gate', async () => {
    const seeded = await runSeed({ dataDir: join(dir, 'monday'), now: MONDAY, keepOpen: true });
    try {
      const w = seeded.world;
      const tickets = await w.ok<InternalTicket[]>('GET', '/api/tickets', 'ceo');
      expect(new Set(tickets.map((t) => t.stage))).toEqual(new Set(['received', 'triage', 'awaiting_human', 'fix_plan_gate', 'building', 'uat', 'go_live_gate', 'completed', 'closed']));
      const changes = (await w.ok<{ items: ChangeRequestDTO[] }>('GET', '/api/changes', 'ceo')).items;
      expect(changes.filter((c) => c.status === 'completed').length).toBeGreaterThanOrEqual(4);
      const rollbacks = (await w.ok<{ items: RollbackDTO[] }>('GET', '/api/rollbacks', 'ceo')).items;
      expect(rollbacks.map((r) => r.status).sort()).toEqual(['awaiting_approval', 'executed']);
      const promotions = (await w.ok<{ items: PromotionDTO[] }>('GET', '/api/promotions', 'ceo')).items;
      expect(promotions.filter((p) => p.status === 'refused' || p.status === 'failed')).toEqual([]);
      expect(w.store.list({ fromTs: iso(MONDAY + 1), limit: 1 })).toEqual([]);
    } finally {
      await seeded.close();
    }
  }, 300_000);
});
