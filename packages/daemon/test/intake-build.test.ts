/**
 * The user path through aocd's own module order, with the real ledger and intake modules (and the real decision
 * engine) and stand-ins only for the supervisor and change control: no process runs, the repository is real.
 *
 * The regression this guards: in aocd the ledger is registered before intake, so when a build session ends the
 * ledger's reactor has already appended `thread.writer_released` with the same cause by the time intake's reactor
 * runs. A guard of the form "an event with this cause exists, so intake already reacted" then skipped intake's work
 * and every intake build stalled after `ticket.build_started`. mod-intake's own tests never loaded another module's
 * reactor ahead of intake.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  newId,
  type Actor,
  type ChangeService,
  type InternalTicket,
  type LaunchRequest,
  type PublicTicket,
  type StoredEvent,
  type SupervisorService,
} from '@aoc/contracts';
import { createGitService, initRepo, type AocModule, type ModuleContext } from '@aoc/kernel';
import { createDefaultModules } from '../src/modules';
import { bootTestServer, removeTempDirs, type TestServer } from './helpers';

const git = createGitService();
const SYSTEM: Actor = { kind: 'system', id: 'test' };
const servers: TestServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const t of servers.splice(0)) await t.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  removeTempDirs();
});

/** What the supervisor does for the ledger and the log at a launch; no process is started. */
function standIns(): AocModule {
  return {
    name: 'stand-ins',
    init(ctx: ModuleContext) {
      const supervisor: Partial<SupervisorService> = {
        async launch(req: LaunchRequest, actor: Actor) {
          const ledger = ctx.services.get('ledger');
          const thread = ledger.ensureThread({ projectId: req.projectId, threadId: req.threadId ?? null, title: 'Fix the ticket' }, actor);
          const sessionId = newId('session', ctx.clock.now());
          const readOnly = req.processType === 'bug-triage';
          if (!readOnly && !ledger.acquireWriter(thread.threadId, sessionId, actor)) throw new Error('the thread has another writer');
          ctx.store.append({
            type: 'session.launch_requested',
            actor,
            scope: { sessionId, projectId: req.projectId, threadId: thread.threadId, ...(req.ticketId ? { ticketId: req.ticketId } : {}) },
            meta: {
              sessionId,
              projectId: req.projectId,
              threadId: thread.threadId,
              processType: req.processType,
              model: 'claude-opus-5-5',
              readOnly,
              credentialProfile: readOnly ? null : 'uat-deploy',
              ticketId: req.ticketId ?? null,
              parentSessionId: null,
              phaseId: null,
            },
            payload: { prompt: req.prompt, cwd: '/tmp/repo' },
            source: 'supervisor',
          });
          return { sessionId };
        },
        async stop() {},
      };
      const change: Partial<ChangeService> = {
        async requestPromotion(input, actor) {
          const promotionId = newId('promotion', ctx.clock.now());
          ctx.store.append({
            type: 'promotion.requested',
            actor,
            scope: { projectId: input.projectId },
            meta: { promotionId, projectId: input.projectId, fromRef: input.fromRef, fromSha: 'abcdef1', targetBranch: 'main', ticketId: input.ticketId ?? null, changeId: null },
            source: 'api',
          });
          return { promotionId, decisionId: 'dec_x', refused: null };
        },
      };
      ctx.services.provide('supervisor', supervisor as SupervisorService);
      ctx.services.provide('change', change as ChangeService);
    },
  };
}

/** aocd's order for the modules this path needs: decisions, then ledger, then intake. */
const daemonOrder = () => createDefaultModules().filter((m) => ['decisions', 'ledger', 'intake'].includes(m.name));

async function boot() {
  const repo = mkdtempSync(join(tmpdir(), 'aocd-intake-repo-'));
  dirs.push(repo);
  initRepo(repo);
  const t = await bootTestServer({ modules: [standIns(), ...daemonOrder()], config: { intake: { triageAgents: 1 } } });
  servers.push(t);
  const events = (type: string): StoredEvent[] => t.aoc.runtime.store.list({ types: [type] });
  t.aoc.runtime.store.append({
    type: 'project.created',
    actor: SYSTEM,
    scope: { projectId: 'prj_claims' },
    meta: { projectId: 'prj_claims', slug: 'claims' },
    payload: { name: 'Claims', repoPath: repo, defaultBranch: 'main' },
    source: 'system',
  });
  const approver = t.identity.createUser({ role: 'approver', name: 'CEO' });
  const requester = t.identity.createUser({ role: 'requester', name: 'Nur' });
  const headers = (token: string) => ({ authorization: `Bearer ${token}` });
  const decisions = () => t.aoc.runtime.services.get('decisions');
  const drain = () => t.aoc.runtime.drain();

  /** A ticket from submission to a running build: triage reports, the Approver approves the fix plan. */
  async function toBuild(): Promise<{ ticketId: string; build: { sessionId: string } }> {
    const form = new FormData();
    form.set('title', 'Receipt photos come out sideways');
    form.set('description', 'The uploaded receipt is rotated 90 degrees on my phone.');
    form.set('severity', 'medium');
    const res = await t.request('/portal/api/intakes', { method: 'POST', headers: headers(requester.token), body: form });
    expect(res.status).toBe(201);
    const { ticketId } = (await res.json()) as PublicTicket;
    await drain();
    const triage = events('session.launch_requested').find((e) => e.meta.ticketId === ticketId && e.meta.readOnly === true)!;
    const sessionId = String(triage.meta.sessionId);
    const report = await t.request('/ingest/mcp/report_diagnosis', {
      method: 'POST',
      headers: { ...headers(t.identity.issueIngestToken(sessionId, SYSTEM)), 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, input: { root_cause: 'EXIF orientation is dropped', confidence: 0.9, fix_plan: 'Apply the orientation', root_cause_class: 'exif' } }),
    });
    expect(report.status).toBe(200);
    await drain();
    const fixPlan = decisions().list({ subjectId: ticketId, kind: ['fix_plan'], status: ['open'] })[0]!;
    await decisions().resolve(fixPlan.id, { optionId: 'approve' }, approver.user);
    await drain();
    const build = events('session.launch_requested').find((e) => e.meta.ticketId === ticketId && e.meta.readOnly === false)!;
    return { ticketId, build: { sessionId: String(build.meta.sessionId) } };
  }

  /** The supervisor's record that a build session finished. */
  const endBuild = (sessionId: string): StoredEvent =>
    t.aoc.runtime.store.append({ type: 'session.ended', actor: { kind: 'system', id: 'supervisor' }, scope: { sessionId }, meta: { sessionId, outcome: 'completed' }, source: 'supervisor' });

  const ticket = async (ticketId: string) => (await (await t.request(`/api/tickets/${ticketId}`, { headers: headers(approver.token) })).json()) as InternalTicket;
  return { t, repo, events, toBuild, endBuild, drain, ticket, decisions, headers, requester, approver };
}

describe('a ticket through aocd’s own module order (ledger before intake)', () => {
  it('a finished build reaches UAT although the ledger released the thread’s writer first', async () => {
    const d = await boot();
    const { ticketId, build } = await d.toBuild();
    // The build session holds the thread: the ledger will release it when the session ends.
    expect(d.events('thread.writer_acquired').map((e) => e.meta.sessionId)).toEqual([build.sessionId]);

    git.createBranch(d.repo, `uat/${ticketId}`, 'HEAD'); // what the build's push to the UAT branch leaves behind
    const ended = d.endBuild(build.sessionId);
    await d.drain();

    // The ledger reacted first: its follow-up carries the same cause as the event intake reacts to.
    const byLedger = d.t.aoc.runtime.store.findByCausation(ended.id, 'thread.writer_released');
    expect(byLedger.map((e) => e.meta.sessionId)).toEqual([build.sessionId]);
    expect(d.events('ticket.uat_ready').map((e) => e.meta)).toEqual([
      expect.objectContaining({ ticketId, uatRef: `uat/${ticketId}`, uatSha: git.revParse(d.repo, `uat/${ticketId}`) }),
    ]);
    expect(d.decisions().list({ subjectId: ticketId, kind: ['uat_signoff'], status: ['open'] })).toHaveLength(1);
    expect(await d.ticket(ticketId)).toMatchObject({ stage: 'uat', publicStatus: 'ready_for_testing', buildSessionId: build.sessionId });
  });

  it('a build that never pushed the UAT branch is escalated, once, although the ledger reacted first', async () => {
    const d = await boot();
    const { ticketId, build } = await d.toBuild();
    d.endBuild(build.sessionId);
    await d.drain();

    expect(d.events('thread.writer_released')).toHaveLength(1);
    expect(d.events('ticket.uat_ready')).toEqual([]);
    expect(d.events('ticket.escalated_to_human').map((e) => e.meta)).toEqual([expect.objectContaining({ ticketId, reason: 'uat_build_missing' })]);
    expect(await d.ticket(ticketId)).toMatchObject({ stage: 'awaiting_human' });
  });
});
