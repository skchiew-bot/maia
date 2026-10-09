import { afterEach, describe, expect, it } from 'vitest';
import type { DecisionRequestInput, SessionOutputItem } from '@aoc/contracts';
import { CONTINUE_TEXT, RESTART_TEXT, THROTTLE_RESET_TEXT } from '../src/prompts';
import { createHarness, type Harness } from './harness';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const decisionFor = (
  h: Harness,
  sessionId: string,
  over: Partial<DecisionRequestInput> = {},
): DecisionRequestInput => ({
  kind: 'agent_decision',
  test: 'irreversible',
  title: 'Password hashing',
  question: 'Which password hash should the login use?',
  options: [
    { id: 'argon2', label: 'Argon2id' },
    { id: 'bcrypt', label: 'bcrypt' },
  ],
  recommendation: { optionId: 'argon2', rationale: 'Current OWASP advice' },
  subjectType: 'session',
  subjectId: sessionId,
  sessionId,
  projectId: 'prj_demo',
  requesterId: h.owner.user.id,
  ...over,
});

const processesOf = (h: Harness, sessionId: string) =>
  h.liveness.processes.filter((p) => p.sessionId === sessionId).map((p) => [p.alive, p.lifecycle]);

describe('turn end: decisions (§2.3)', () => {
  it('waits on an open decision with no process alive, then resumes with the injected answer', async () => {
    h = await createHarness();
    const gate = h.gate();
    const id = await h.launch(`[[fake:gated,normal|gate=${gate.path}]] Add login`);
    const card = h.t.decisions!.request(decisionFor(h, id), { kind: 'agent', id });
    gate.open();
    await h.waitLifecycle(id, 'waiting_decision');
    expect(h.events('session.turn_ended', id)[0]!.meta).toMatchObject({
      turn: 1,
      outcome: 'decision',
      exitCode: 0,
    });
    expect(h.sup.isRunning(id)).toBe(false);

    const approver = h.t.user('approver');
    await h.t.decisions!.resolve(
      card.id,
      { optionId: 'argon2', comment: 'Use the OWASP parameters.' },
      approver.user,
    );
    await h.waitLifecycle(id, 'idle');
    const [first, second] = h.callsFor(id);
    expect(second!.uuid).toBe(first!.uuid);
    expect(second!.argv).toContain('--resume');
    expect(second!.argv).not.toContain('--session-id');
    expect(second!.prompt).toContain(`Decision ${card.id} answered: Argon2id. Use the OWASP parameters.`);
    const resumed = h.events('session.turn_started', id)[1]!;
    expect(resumed.meta).toMatchObject({ turn: 2, reason: 'decision_answered' });
    expect(resumed.causationId).toBe(h.events('decision.resolved')[0]!.id);
    // idempotent: redelivering the reaction does not start another turn
    await h.sup.onDecisionSettled(h.events('decision.resolved')[0]!);
    expect(h.callsFor(id).length).toBe(2);
    // each exit is reported only once the turn's outcome is recorded: liveness never sees a running session without
    // a process, which it would chain as a transient Dead
    expect(processesOf(h, id)).toEqual([
      [true, 'running'],
      [false, 'waiting_decision'],
      [true, 'running'],
      [false, 'idle'],
    ]);
  });

  it('waits for every open decision, and resumes on a withdrawal too', async () => {
    h = await createHarness();
    const gate = h.gate();
    const id = await h.launch(`[[fake:gated,normal|gate=${gate.path}]] Migrate`);
    const one = h.t.decisions!.request(decisionFor(h, id), { kind: 'agent', id });
    const two = h.t.decisions!.request(
      decisionFor(h, id, { title: 'Drop column', question: 'Drop the legacy column now?' }),
      { kind: 'agent', id },
    );
    gate.open();
    await h.waitLifecycle(id, 'waiting_decision');
    const approver = h.t.user('approver');
    await h.t.decisions!.resolve(one.id, { optionId: 'bcrypt' }, approver.user);
    await h.t.drain();
    expect(h.lifecycle(id)).toBe('waiting_decision');
    h.t.decisions!.withdraw(two.id, 'superseded', { kind: 'human', id: approver.user.id });
    await h.waitLifecycle(id, 'idle');
    const prompt = h.callsFor(id)[1]!.prompt;
    expect(prompt).toContain(`Decision ${one.id} answered: bcrypt.`);
    expect(prompt).toContain(`Decision ${two.id} was withdrawn; do not wait for it.`);
  });

  it('delivers an answer that arrived while the turn was still running', async () => {
    h = await createHarness();
    const gate = h.gate();
    const id = await h.launch(`[[fake:gated,normal|gate=${gate.path}]] Work`);
    const card = h.t.decisions!.request(decisionFor(h, id), { kind: 'agent', id });
    await h.t.decisions!.resolve(card.id, { optionId: 'argon2' }, h.t.user('approver').user);
    gate.open();
    await h.waitLifecycle(id, 'idle');
    expect(h.events('session.turn_started', id)[1]!.meta).toMatchObject({ reason: 'decision_answered' });
    expect(h.callsFor(id)[1]!.prompt).toContain(`Decision ${card.id} answered: Argon2id.`);
    expect(h.callsFor(id).length).toBe(2);
  });
});

describe('turn end: throttling (§4, §10)', () => {
  it('detects a usage limit, waits without a process and resumes at the reset with the idle time', async () => {
    h = await createHarness();
    const reset = Math.floor(h.t.clock.now() / 1000) + 3600;
    const id = await h.launch(`[[fake:usage_limit,normal|reset=${reset}]] Long task`);
    await h.waitLifecycle(id, 'throttled');
    expect(h.events('throttle.hit', id).map((e) => e.meta)).toEqual([
      { sessionId: id, resetAt: new Date(reset * 1000).toISOString(), source: 'stream' },
    ]);
    expect(h.events('session.turn_ended', id)[0]!.meta).toMatchObject({ outcome: 'throttled', exitCode: 1 });

    await h.t.rt.runJob('supervisor.throttle_resume');
    expect(h.lifecycle(id)).toBe('throttled');
    h.t.clock.advance(3600_000 + 5_000);
    await h.t.rt.runJob('supervisor.throttle_resume');
    await h.waitLifecycle(id, 'idle');
    expect(h.events('throttle.cleared', id).map((e) => e.meta)).toEqual([
      { sessionId: id, idleMs: 3605_000 },
    ]);
    expect(h.events('session.turn_started', id)[1]!.meta).toMatchObject({ reason: 'throttle_reset' });
    expect(h.callsFor(id)[1]!.prompt).toBe(THROTTLE_RESET_TEXT);
  });

  it('prefers the rate_limit_event reset over the text notice', async () => {
    h = await createHarness();
    const reset = Math.floor(h.t.clock.now() / 1000) + 7200;
    const id = await h.launch(`[[fake:rate_limited|reset=${reset}]] Task`);
    await h.waitLifecycle(id, 'throttled');
    expect(h.events('throttle.hit', id)[0]!.meta.resetAt).toBe(new Date(reset * 1000).toISOString());
  });

  it('counts a hook-reported limit (StopFailure) for a failed turn, but not for a successful one', async () => {
    h = await createHarness();
    const hookHit = (id: string) =>
      h!.t.rt.store.append({
        type: 'throttle.hit',
        actor: { kind: 'agent', id },
        scope: { sessionId: id },
        meta: { sessionId: id, resetAt: null, source: 'exit' },
        payload: { message: 'API Error: Rate limit reached' },
        source: 'hook',
      });
    const g1 = h.gate();
    const failed = await h.launch(`[[fake:gated|gate=${g1.path}|end=crash]] Task`, { threadId: 'thr_1' });
    await h.waitFor(() => h!.callsFor(failed).length === 1, 'turn running');
    hookHit(failed);
    g1.open();
    await h.waitLifecycle(failed, 'throttled'); // not Dead: the limit explains the exit
    expect(h.events('throttle.hit', failed).length).toBe(1); // no duplicate for the same episode

    const g2 = h.gate();
    const ok = await h.launch(`[[fake:gated|gate=${g2.path}]] Task`, { threadId: 'thr_2' });
    await h.waitFor(() => h!.callsFor(ok).length === 1, 'turn running');
    hookHit(ok);
    g2.open();
    await h.waitLifecycle(ok, 'idle');
    expect(h.events('session.turn_ended', ok)[0]!.meta.outcome).toBe('end_turn');
  });
});

describe('turn end: crash, auto-continue, completion, credit cap', () => {
  it('marks a crash Dead and restarts it from the transcript', async () => {
    h = await createHarness();
    const id = await h.launch('[[fake:crash,normal]] Job');
    await h.waitLifecycle(id, 'failed');
    expect(h.events('session.turn_ended', id)[0]!.meta).toMatchObject({ outcome: 'crashed', exitCode: 1 });
    expect(h.events('session.lifecycle_changed', id).at(-1)!.meta).toMatchObject({
      to: 'failed',
      reason: 'exit_1',
    });
    expect(h.ledger.writerCalls).toContain(`release ${id} failed`);
    expect(h.sup.output(id)!.some((i) => i.text.includes('stderr: fatal: simulated crash'))).toBe(true);

    await h.sup.restart(id, h.ownerActor);
    await h.waitLifecycle(id, 'idle');
    expect(h.events('session.restarted', id).length).toBe(1);
    const second = h.callsFor(id)[1]!;
    expect(second.argv).toContain('--resume');
    expect(second.prompt).toBe(RESTART_TEXT);
    expect(h.ledger.writerCalls.filter((c) => c === `acquire ${id}`).length).toBe(2);
  });

  it('marks a launch whose claude cannot start Dead; its restart replays the launch prompt as a new conversation', async () => {
    h = await createHarness();
    const bin = h.t.config.supervisor.claudeBin;
    h.t.config.supervisor.claudeBin = '/nonexistent/claude';
    await expect(h.launch('First prompt')).rejects.toMatchObject({ status: 502, code: 'spawn_failed' });
    const id = String(h.events('session.launch_requested')[0]!.meta.sessionId);
    expect(h.lifecycle(id)).toBe('failed');
    expect(h.events('session.turn_started', id)).toEqual([]);
    h.t.config.supervisor.claudeBin = bin;
    await h.sup.restart(id, h.ownerActor);
    await h.waitLifecycle(id, 'idle');
    const call = h.callsFor(id)[0]!;
    expect(call.argv).toContain('--session-id');
    expect(call.prompt).toBe('First prompt');
    expect(h.events('session.turn_started', id)[0]!.meta).toMatchObject({ turn: 1, reason: 'restart' });
  });

  it('auto-continues up to the limit, then waits on the operator', async () => {
    h = await createHarness({ supervisor: { autoContinueLimit: 2 } });
    const id = await h.launch('Plan with work left');
    await h.waitLifecycle(id, 'idle');
    expect(h.events('session.turn_started', id).map((e) => e.meta.reason)).toEqual([
      'launch',
      'continue',
      'continue',
    ]);
    expect(
      h
        .callsFor(id)
        .map((c) => c.prompt)
        .slice(1),
    ).toEqual([CONTINUE_TEXT, CONTINUE_TEXT]);
    expect(h.events('session.lifecycle_changed', id).at(-1)!.meta).toMatchObject({
      from: 'running',
      to: 'idle',
      reason: 'turn_ended',
    });
    // a follow-up turn already holds the session, so its predecessor's exit is not reported over it
    expect(processesOf(h, id)).toEqual([
      [true, 'running'],
      [true, 'running'],
      [true, 'running'],
      [false, 'idle'],
    ]);

    await h.sup.resume(id, 'Also add a logout button', 'operator_prompt', h.ownerActor);
    await h.waitFor(() => h!.callsFor(id).length === 6, 'operator turn and two more continues');
    await h.waitLifecycle(id, 'idle');
  });

  it('ends a completed plan, releases the writer and revokes the ingest token', async () => {
    h = await createHarness({ supervisor: { autoContinueLimit: 1 } });
    h.ledger.defaultPct = 100;
    const id = await h.launch('Finish');
    await h.waitLifecycle(id, 'ended');
    expect(h.events('session.ended', id)[0]!.meta).toEqual({ sessionId: id, outcome: 'completed' });
    expect(h.ledger.writerCalls).toContain(`release ${id} ended`);
    await h.waitRevoked(h.callsFor(id)[0]!.env.AOC_INGEST_TOKEN!);
    expect(h.callsFor(id).length).toBe(1);
  });

  it('stops the sidecar as soon as its turn ends, and revokes its token once that last report is in', async () => {
    h = await createHarness({ sidecarHold: true, supervisor: { autoContinueLimit: 1 } });
    h.ledger.defaultPct = 100;
    const id = await h.launch('Finish');
    await h.waitLifecycle(id, 'ended');
    const ended = Date.now();
    // the session token dies with the session; the sidecar is told to report what is left at once, not after the grace
    expect(h.t.identity!.verifyIngestToken(h.callsFor(id)[0]!.env.AOC_INGEST_TOKEN!)).toBeNull();
    await h.waitFor(() => h!.sidecarSignals().length === 1, 'sidecar stopped', 3_000);
    expect(h.sidecarSignals()[0]!.at - ended).toBeLessThan(2_000);
    const sidecarToken = h.sidecarCalls()[0]!.env.AOC_INGEST_TOKEN!;
    // … with its token still valid while it does
    expect(h.t.identity!.verifyIngestToken(sidecarToken)).toMatchObject({ kind: 'sidecar', sessionId: id });
    h.releaseSidecars();
    await h.waitFor(() => h!.t.identity!.verifyIngestToken(sidecarToken) === null, 'sidecar token revoked');
  });

  it("keeps an ended session's sidecar token valid until its sidecar has made the final usage flush", async () => {
    h = await createHarness({ supervisor: { autoContinueLimit: 1 }, module: { sidecarGraceMs: 1_000 }, env: { FAKE_SIDECAR_LINGER: '1' } });
    h.ledger.defaultPct = 100;
    const id = await h.launch('Finish');
    await h.waitLifecycle(id, 'ended');
    // The session token is in the model's environment: it dies with the session (G-44).
    expect(h.t.identity!.verifyIngestToken(h.callsFor(id)[0]!.env.AOC_INGEST_TOKEN!)).toBeNull();
    const token = h.sidecarCalls()[0]!.env.AOC_INGEST_TOKEN!;
    // The sidecar reports the last turn's usage only after claude has exited: refusing it would lose that usage.
    expect(h.t.identity!.verifyIngestToken(token)).toMatchObject({ kind: 'sidecar', sessionId: id });
    // This sidecar never announced it handles SIGTERM, so it gets it after the grace.
    await h.waitFor(() => h!.sidecarCalls().some((c) => 'sigterm' in c), 'the sidecar to be sent SIGTERM after the grace');
    await h.waitRevoked(token);
  });

  it('blocks when the credit cap is reached during a turn and resumes on a top-up', async () => {
    h = await createHarness();
    const gate = h.gate();
    const id = await h.launch(`[[fake:gated,normal|gate=${gate.path}]] Spend`);
    h.t.rt.store.append({
      type: 'credit.cap_reached',
      actor: { kind: 'system', id: 'credits' },
      meta: { userId: h.owner.user.id, sessionId: id, taskId: 't1', balanceUsd: 0, period: '2026-10' },
      source: 'system',
    });
    gate.open();
    await h.waitLifecycle(id, 'blocked');
    expect(h.events('session.turn_ended', id)[0]!.meta.outcome).toBe('credit_cap');
    // an operator prompt cannot bypass the cap
    await expect(h.sup.resume(id, 'keep going', 'operator_prompt', h.ownerActor)).rejects.toMatchObject({
      status: 409,
    });
    h.credits.next = { continue: false, reason: 'credit_cap', instruction: 'still capped' };
    await expect(h.sup.resume(id, 'go', 'topup', h.ownerActor)).rejects.toMatchObject({
      status: 409,
      code: 'credit_cap',
    });
    h.credits.next = { continue: true };
    h.t.rt.store.append({
      type: 'credit.topup_granted',
      actor: { kind: 'human', id: 'usr_ceo' },
      meta: {
        requestId: 'tpu_1',
        userId: h.owner.user.id,
        amountUsd: 50,
        approverId: 'usr_ceo',
        balanceBefore: 0,
        balanceAfter: 50,
        decisionId: 'dec_t',
      },
      source: 'api',
    });
    await h.waitLifecycle(id, 'idle');
    expect(h.events('session.turn_started', id)[1]!.meta).toMatchObject({ reason: 'topup' });
    expect(h.callsFor(id)[1]!.argv).toContain('--resume');
  });

  it('aborts a session whose AOC MCP server did not connect (fail loudly)', async () => {
    h = await createHarness();
    const id = await h.launch('[[fake:hang|mcp=failed]] Task');
    await h.waitLifecycle(id, 'failed');
    expect(h.events('session.lifecycle_changed', id).at(-1)!.meta).toMatchObject({
      to: 'failed',
      reason: 'mcp_unavailable',
    });
    expect(h.events('session.turn_ended', id)[0]!.meta.outcome).toBe('error');
    expect(h.sup.output(id)!.some((i) => i.text.includes('AOC MCP server failed'))).toBe(true);
  });
});

describe('operator controls (§2.3: nudge = end turn, resume with operator text)', () => {
  it('nudge interrupts a hanging turn with SIGINT and resumes with the operator text', async () => {
    h = await createHarness();
    const id = await h.launch('[[fake:hang,normal]] Slow work');
    await h.waitFor(() => h!.callsFor(id).length === 1, 'turn running');
    expect(h.sup.isRunning(id)).toBe(true);
    await h.sup.nudge(id, 'Check the README first', h.ownerActor);
    await h.waitLifecycle(id, 'idle');
    expect(h.payload(h.events('session.nudged', id)[0]!)).toEqual({ text: 'Check the README first' });
    expect(h.events('session.turn_ended', id)[0]!.meta).toMatchObject({
      outcome: 'interrupted',
      exitCode: 130,
    });
    expect(h.events('session.turn_started', id)[1]!.meta).toMatchObject({ reason: 'nudge' });
    expect(h.callsFor(id)[1]!.prompt).toContain('Check the README first');
  });

  it('escalates to SIGKILL when the turn ignores SIGINT', async () => {
    h = await createHarness({ module: { interruptGraceMs: 200 } });
    const id = await h.launch('[[fake:hang_hard,normal]] Stuck');
    await h.waitFor(() => h!.callsFor(id).length === 1, 'turn running');
    await h.sup.nudge(id, 'Try again', h.ownerActor);
    await h.waitLifecycle(id, 'idle');
    expect(h.events('session.turn_ended', id)[0]!.meta).toMatchObject({
      outcome: 'interrupted',
      exitCode: null,
    });
  });

  it('stop without immediate ends the session at the next task boundary', async () => {
    h = await createHarness({ supervisor: { autoContinueLimit: 3 } });
    const gate = h.gate();
    const id = await h.launch(`[[fake:gated,normal|gate=${gate.path}]] Work`);
    await h.sup.stop(id, false, h.ownerActor, 'Out of time');
    expect(h.sup.stopRequested(id)).toBe(true);
    expect(h.sup.isRunning(id)).toBe(true);
    const token =
      h.callsFor(id)[0]?.env.AOC_INGEST_TOKEN ??
      JSON.parse(h.file(id, 'mcp.json')).mcpServers.aoc.env.AOC_INGEST_TOKEN;
    gate.open();
    await h.waitLifecycle(id, 'ended');
    expect(h.events('session.turn_ended', id)[0]!.meta.outcome).toBe('stop_requested');
    expect(h.events('session.ended', id)[0]!.meta.outcome).toBe('abandoned');
    expect(h.ledger.writerCalls).toContain(`release ${id} stopped`);
    await h.waitRevoked(token);
    expect(h.callsFor(id).length).toBe(1);
    expect(h.sup.stopRequested(id)).toBe(false);
  });

  it('immediate stop kills a running turn; stopping an idle session ends it at once', async () => {
    h = await createHarness();
    const a = await h.launch('[[fake:hang]] A', { threadId: 'thr_a' });
    await h.waitFor(() => h!.callsFor(a).length === 1, 'turn running');
    await h.sup.stop(a, true, h.ownerActor);
    await h.waitLifecycle(a, 'ended');
    expect(h.events('session.ended', a)[0]!.meta.outcome).toBe('killed');
    expect(h.events('session.turn_ended', a)[0]!.meta.outcome).toBe('interrupted');

    const b = await h.launch('B', { threadId: 'thr_b' });
    await h.waitLifecycle(b, 'idle');
    await h.sup.stop(b, false, h.ownerActor);
    expect(h.lifecycle(b)).toBe('ended');
    await expect(h.sup.nudge(b, 'hello', h.ownerActor)).rejects.toMatchObject({
      status: 409,
      code: 'session_ended',
    });
  });
});

describe('operator output (GET /api/sessions/:id/output)', () => {
  it('keeps the last 500 items of the stream', async () => {
    h = await createHarness();
    const id = await h.launch('[[fake:chatty|count=600]] Talk');
    await h.waitLifecycle(id, 'idle');
    const res = await h.t.json<{ sessionId: string; items: SessionOutputItem[] }>(
      'GET',
      `/api/sessions/${id}/output`,
      { headers: h.owner.headers },
    );
    expect(res.items.length).toBe(500);
    expect(res.items.at(-1)).toMatchObject({ kind: 'result', text: 'chatty done' });
    expect(res.items.at(-2)).toMatchObject({ kind: 'assistant_text', text: 'line 599' });
  });

  it('renders prompts, assistant text, tool calls, tool results and results', async () => {
    h = await createHarness();
    const id = await h.launch('Read the readme');
    await h.waitLifecycle(id, 'idle');
    const items = h.sup.output(id)!;
    expect(items[0]).toMatchObject({ kind: 'user_prompt', text: 'Read the readme' });
    expect(items.map((i) => i.kind)).toEqual(
      expect.arrayContaining(['system', 'assistant_text', 'tool_use', 'tool_result', 'result']),
    );
    expect(items.find((i) => i.kind === 'tool_use')).toMatchObject({ toolName: 'Read', text: 'README.md' });
    expect(
      (await h.t.request('GET', '/api/sessions/ses_nope/output', { headers: h.owner.headers })).status,
    ).toBe(404);
    expect(
      (await h.t.request('GET', `/api/sessions/${id}/output`, { headers: h.t.user('requester').headers }))
        .status,
    ).toBe(403);
  });
});
