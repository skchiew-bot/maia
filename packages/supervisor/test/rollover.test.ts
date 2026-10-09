import { afterEach, describe, expect, it } from 'vitest';
import type { BroadcastMessage } from '@aoc/kernel';
import { createHarness, type Harness } from './harness';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('context rollover (§5, R16)', () => {
  it('rolls over automatically at a clean boundary: brief, writer handoff, successor, retirement', async () => {
    h = await createHarness();
    const id = await h.launch('[[fake:normal|context=800000]] Big refactor', {
      threadId: 'thr_big',
      phaseId: 'ph_2',
    });
    await h.waitFor(() => h!.events('session.rollover_completed').length === 1, 'rollover');
    const completed = h.events('session.rollover_completed')[0]!;
    const next = String(completed.meta.toSessionId);
    await h.waitLifecycle(next, 'idle');
    expect(h.lifecycle(id)).toBe('retired');

    const started = h.events('session.rollover_started')[0]!;
    expect(started.meta).toEqual({
      threadId: 'thr_big',
      fromSessionId: id,
      contextTokens: 800_012,
      contextPct: 80,
      briefHash: 'b'.repeat(64),
    });
    expect(h.payload(started)).toEqual({ brief: expect.stringContaining('HANDOFF thr_big') });
    expect(completed.meta).toEqual({ threadId: 'thr_big', fromSessionId: id, toSessionId: next });
    expect(h.events('session.turn_ended', id)[0]!.meta.outcome).toBe('rollover');
    expect(h.events('session.ended', id)[0]!.meta.outcome).toBe('retired');

    // strictly sequential: brief → writer released → successor launched → completed → predecessor retired
    const seqOf = (type: string, sessionId?: string) =>
      h!.t.rt.store.list({ types: [type], ...(sessionId ? { sessionId } : {}) })[0]!.seq;
    expect(seqOf('session.rollover_started')).toBeLessThan(seqOf('session.launch_requested', next));
    expect(seqOf('session.launch_requested', next)).toBeLessThan(seqOf('session.rollover_completed'));
    expect(seqOf('session.rollover_completed')).toBeLessThan(seqOf('session.ended', id));
    expect(h.ledger.writerCalls).toEqual([`acquire ${id}`, `release ${id} rollover`, `acquire ${next}`]);

    // the successor continues the same thread with the brief, on the predecessor's owner
    expect(h.events('session.launch_requested', next)[0]!.meta).toMatchObject({
      threadId: 'thr_big',
      parentSessionId: id,
      phaseId: 'ph_2',
      processType: 'feature-build',
      ownerId: h.owner.user.id,
    });
    expect(h.events('session.turn_started', next)[0]!.meta).toMatchObject({ turn: 1, reason: 'rollover' });
    expect(h.file(next, 'system-prompt.md')).toContain('HANDOFF thr_big');
    expect(h.callsFor(next)[0]!.prompt).toContain(`from session ${id}`);
    expect(h.sup.session(next)!.ownerId).toBe(h.owner.user.id);
    expect(h.t.identity!.verifyIngestToken(h.callsFor(id)[0]!.env.AOC_INGEST_TOKEN!)).toBeNull();
  });

  it('rolls over on request through the API when the writer is idle at a boundary', async () => {
    h = await createHarness();
    const id = await h.launch('Work', { threadId: 'thr_m' });
    await h.waitLifecycle(id, 'idle');
    const other = h.t.user('builder', 'Not the owner');
    expect(
      (await h.t.request('POST', '/api/threads/thr_m/rollover', { headers: other.headers })).status,
    ).toBe(403);
    const res = await h.t.json<{ newSessionId: string }>('POST', '/api/threads/thr_m/rollover', {
      headers: h.owner.headers,
    });
    await h.waitLifecycle(res.newSessionId, 'idle');
    expect(h.lifecycle(id)).toBe('retired');
    expect(h.events('session.rollover_started')[0]!.actor).toEqual(h.ownerActor);
    expect(h.events('session.launch_requested', res.newSessionId)[0]!.actor).toEqual({
      kind: 'system',
      id: 'supervisor',
    });
    expect(
      (await h.t.request('POST', '/api/threads/thr_none/rollover', { headers: h.owner.headers })).status,
    ).toBe(404);
  });

  it('refuses when not at a clean task boundary, and never rolls over automatically then', async () => {
    h = await createHarness();
    h.ledger.boundary = { atBoundary: false, reason: 'task t2 in progress', openTasks: 2 };
    const id = await h.launch('[[fake:normal|context=900000]] Work', { threadId: 'thr_r' });
    await h.waitLifecycle(id, 'idle');
    expect(h.events('session.rollover_started')).toEqual([]);

    const res = await h.t.request('POST', '/api/threads/thr_r/rollover', { headers: h.owner.headers });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { code: 'rollover_refused', details: { problems: ['not_at_boundary: task t2 in progress'] } },
    });
    const aborted = h.events('session.rollover_aborted')[0]!;
    expect(aborted.meta).toEqual({ threadId: 'thr_r', fromSessionId: id, reason: 'not_at_boundary' });
    expect(h.payload(aborted)).toEqual({ problems: ['not_at_boundary: task t2 in progress'] });
    expect(h.lifecycle(id)).toBe('idle');
    expect(h.ledger.getThread('thr_r')!.activeWriterSessionId).toBe(id);
  });

  it('refuses while the writer runs or has open decisions, and when the brief fails validation', async () => {
    h = await createHarness();
    const gate = h.gate();
    const id = await h.launch(`[[fake:gated,normal|gate=${gate.path}]] Work`, { threadId: 'thr_q' });
    expect(await h.sup.rollover('thr_q', h.ownerActor)).toEqual({ refused: ['session_running'] });
    h.t.decisions!.request(
      {
        kind: 'agent_decision',
        test: 'ambiguity',
        title: 'Spec',
        question: 'Which reading of the spec?',
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
        subjectType: 'session',
        subjectId: id,
        sessionId: id,
        requesterId: h.owner.user.id,
      },
      { kind: 'agent', id },
    );
    gate.open();
    await h.waitLifecycle(id, 'waiting_decision');
    expect(await h.sup.rollover('thr_q', h.ownerActor)).toEqual({
      refused: ['session_waiting_decision', 'open_decisions'],
    });

    const id2 = await h.launch('Other', { threadId: 'thr_v' });
    await h.waitLifecycle(id2, 'idle');
    h.ledger.briefProblems = ['open decision dec_x is missing from the brief'];
    expect(await h.sup.rollover('thr_v', h.ownerActor)).toEqual({
      refused: ['open decision dec_x is missing from the brief'],
    });
    expect(h.events('session.rollover_aborted').at(-1)!.meta.reason).toBe('brief_invalid');
    expect(h.ledger.writerCalls.filter((c) => c.startsWith('release'))).toEqual([]);
    expect(h.events('session.rollover_aborted').length).toBe(3);
  });

  it('never rolls a risky type over on its own; it asks a human to pick the boundary', async () => {
    h = await createHarness();
    const seen: BroadcastMessage[] = [];
    h.t.rt.broadcaster.subscribe({ role: 'approver', send: (m) => seen.push(m) });
    const id = await h.launch('[[fake:normal|context=900000]] Migrate users', {
      processType: 'migration',
      threadId: 'thr_mig',
    });
    await h.waitLifecycle(id, 'idle');
    expect(h.events('session.rollover_started')).toEqual([]);
    expect(seen.some((m) => m.event === 'notification' && m.data.title.startsWith('Context is large'))).toBe(
      true,
    );
  });
});
