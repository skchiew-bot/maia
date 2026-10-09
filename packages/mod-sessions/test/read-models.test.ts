import { afterEach, describe, expect, it } from 'vitest';
import {
  computeProgress,
  type ConsoleSnapshot,
  type LedgerService,
  type MeteringService,
  type SessionActivityDTO,
  type SessionDetail,
} from '@aoc/contracts';
import { createTestRuntime, type TestRuntime, type TestUser } from '@aoc/kernel';
import { createSessionsModule, SessionsEngine } from '../src';

let t: TestRuntime;
afterEach(async () => t?.close());

const progress = computeProgress(
  [
    { id: 'design', name: 'Design', order: 0 },
    { id: 'build', name: 'Build', order: 1 },
  ],
  [
    { id: 't1', phaseId: 'design', size: 's', status: 'done' },
    { id: 't2', phaseId: 'build', size: 'm', status: 'open' },
  ],
);

const ledger = {
  sessionProgress: () => progress,
  boundaryState: () => ({ atBoundary: true, reason: null, openTasks: 1 }),
} as unknown as LedgerService;

const metering = {
  notionalCostUsd: () => 1.25,
  fxRate: () => ({ rate: 4.2, status: 'live', sourceDate: '2026-10-09' }),
} as unknown as MeteringService;

async function setup() {
  // 02:00Z is 10:00 in Kuala Lumpur, so the local day began at 2026-10-08T16:00Z.
  t = await createTestRuntime({
    modules: [createSessionsModule({ sweepIntervalMs: 0 })],
    services: { ledger, metering },
    now: '2026-10-09T02:00:00.000Z',
  });
}

function launch(owner: TestUser, sid: string, at: string) {
  t.clock.set(Date.parse(at));
  t.rt.store.append({
    type: 'session.launch_requested',
    actor: { kind: 'human', id: owner.user.id },
    scope: { sessionId: sid, projectId: 'prj_1' },
    meta: { sessionId: sid, projectId: 'prj_1', threadId: 'thr_1', processType: 'feature-build', model: 'claude-sonnet-5-5', readOnly: false, credentialProfile: null, ticketId: null, parentSessionId: null, phaseId: null },
    payload: { prompt: `Work on ${sid}`, cwd: '/tmp/repo' },
    source: 'supervisor',
  });
  t.rt.store.append({
    type: 'session.lifecycle_changed',
    actor: { kind: 'system', id: 'supervisor' },
    scope: { sessionId: sid },
    meta: { sessionId: sid, from: 'launching', to: 'running', reason: 'launched' },
    source: 'supervisor',
  });
}

function end(sid: string, at: string, outcome: 'completed' | 'retired' = 'completed') {
  t.clock.set(Date.parse(at));
  t.rt.store.append({ type: 'session.ended', actor: { kind: 'system', id: 'supervisor' }, scope: { sessionId: sid }, meta: { sessionId: sid, outcome }, source: 'supervisor' });
}

function tool(sid: string, at: string) {
  t.clock.set(Date.parse(at));
  t.rt.store.append({
    type: 'tool.used',
    actor: { kind: 'agent', id: sid },
    scope: { sessionId: sid },
    meta: { sessionId: sid, toolName: 'Edit', fileChanging: true, ok: true, toolUseId: null },
    payload: { inputSummary: '{}' },
    source: 'hook',
  });
}

describe('console snapshot', () => {
  it('lists sessions that ended on the local day, with end time, outcome, phase and RM cost', async () => {
    await setup();
    const owner = t.user('builder', 'Aisyah');
    launch(owner, 'ses_yesterday', '2026-10-08T10:00:00.000Z');
    end('ses_yesterday', '2026-10-08T15:30:00.000Z'); // 23:30 local, the day before
    launch(owner, 'ses_morning', '2026-10-08T23:00:00.000Z');
    end('ses_morning', '2026-10-09T00:30:00.000Z', 'retired'); // 08:30 local today
    launch(owner, 'ses_live', '2026-10-09T01:00:00.000Z');
    t.clock.set(Date.parse('2026-10-09T02:00:00.000Z'));

    const snap = await t.json<ConsoleSnapshot>('GET', '/api/console', { headers: owner.headers });
    expect(snap.today).toBe('2026-10-09');
    expect(snap.sessions.map((s) => s.sessionId)).toEqual(['ses_live', 'ses_morning']);
    const ended = snap.sessions[1]!;
    expect(ended).toMatchObject({ lifecycle: 'retired', endedAt: '2026-10-09T00:30:00.000Z', outcome: 'retired' });
    const live = snap.sessions[0]!;
    expect(live).toMatchObject({ endedAt: null, outcome: null });
    expect(live.currentPhase).toEqual({ phaseId: 'build', name: 'Build', index: 2, count: 2 });
    expect(live.progress).toMatchObject({ doneTasks: 1, totalTasks: 2, doneWeight: 2, totalWeight: 5 });
    // No usage today → no cost; the RM figure is still the server's conversion at today's stamped rate.
    expect(live.costTodayUsd).toBe(0);
    expect(live.costTodayRm).toBe(0);
  });
});

describe('session activity', () => {
  it('serves tool calls per minute over the whole session and its throttle episodes', async () => {
    await setup();
    const owner = t.user('builder', 'Aisyah');
    const requester = t.user('requester');
    launch(owner, 'ses_A', '2026-10-09T01:00:00.000Z');
    tool('ses_A', '2026-10-09T01:00:10.000Z');
    tool('ses_A', '2026-10-09T01:00:50.000Z');
    tool('ses_A', '2026-10-09T01:05:00.000Z');
    const headers = t.ingestHeaders('ses_A');
    t.clock.set(Date.parse('2026-10-09T01:10:00.000Z'));
    await t.json('POST', '/ingest/throttle', { headers, body: { sessionId: 'ses_A', resetAt: '2026-10-09T01:30:00.000Z', message: 'limit', source: 'stream' } });
    t.clock.set(Date.parse('2026-10-09T01:30:00.000Z'));
    t.rt.store.append({ type: 'throttle.cleared', actor: { kind: 'system', id: 'supervisor' }, scope: { sessionId: 'ses_A' }, meta: { sessionId: 'ses_A', idleMs: 1_200_000 }, source: 'supervisor' });
    t.clock.set(Date.parse('2026-10-09T01:40:00.000Z'));
    await t.json('POST', '/ingest/throttle', { headers, body: { sessionId: 'ses_A', resetAt: null, message: 'limit again', source: 'stream' } });

    const a = await t.json<SessionActivityDTO>('GET', '/api/sessions/ses_A/activity', { headers: owner.headers });
    expect(a.minutes).toEqual([
      { at: '2026-10-09T01:00:00.000Z', count: 2 },
      { at: '2026-10-09T01:05:00.000Z', count: 1 },
    ]);
    expect(a.totalToolCalls).toBe(3);
    expect(a.throttles).toEqual([
      { startAt: '2026-10-09T01:10:00.000Z', endAt: '2026-10-09T01:30:00.000Z', resetAt: '2026-10-09T01:30:00.000Z', idleMs: 1_200_000 },
      { startAt: '2026-10-09T01:40:00.000Z', endAt: null, resetAt: null, idleMs: null },
    ]);
    expect((await t.request('GET', '/api/sessions/ses_nope/activity', { headers: owner.headers })).status).toBe(404);
    expect((await t.request('GET', '/api/sessions/ses_A/activity', { headers: requester.headers })).status).toBe(403);
  });

  it('keeps the detail view consistent with the summary fields', async () => {
    await setup();
    const owner = t.user('builder', 'Aisyah');
    launch(owner, 'ses_A', '2026-10-09T01:00:00.000Z');
    (t.rt.services.get('sessions') as unknown as SessionsEngine).refresh('ses_A');
    const d = await t.json<SessionDetail>('GET', '/api/sessions/ses_A', { headers: owner.headers });
    expect(d.currentPhase).toMatchObject({ name: 'Build', index: 2 });
    expect(d.endedAt).toBeNull();
    expect(d.actions.rollover).toEqual({ enabled: true, reason: null });
  });
});
