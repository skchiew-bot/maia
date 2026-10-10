import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConsoleSnapshot, HookIngestResponse, ProcessEventRequest, SessionDetail, SessionSummary } from '@aoc/contracts';
import { createTestRuntime, type AocModule, type TestRuntime, type TestUser } from '@aoc/kernel';
import { createSessionsModule, isReadOnlyBash, SessionsEngine } from '../src';

const CLAUDE_A = '11111111-1111-4111-8111-111111111111';
let t: TestRuntime;
afterEach(async () => t?.close());

async function setup(extraModules: AocModule[] = []) {
  t = await createTestRuntime({ modules: [createSessionsModule({ sweepIntervalMs: 0 }), ...extraModules] });
  return t;
}

function engine(): SessionsEngine {
  return t.rt.services.get('sessions') as unknown as SessionsEngine;
}

function launch(owner: TestUser, sid = 'ses_A', extra: Record<string, unknown> = {}, claudeId = CLAUDE_A) {
  const s = t.rt.store;
  s.append({
    type: 'session.launch_requested',
    actor: { kind: 'human', id: owner.user.id },
    scope: { sessionId: sid, projectId: 'prj_1' },
    meta: { sessionId: sid, projectId: 'prj_1', threadId: 'thr_1', processType: 'discovery', model: 'claude-opus-5-5', readOnly: false, credentialProfile: null, ticketId: null, parentSessionId: null, phaseId: null, ...extra } as never,
    payload: { prompt: 'Build the claims intake parser\nwith tests', cwd: '/tmp/repo' },
    source: 'supervisor',
  });
  s.append({
    type: 'session.launched',
    actor: { kind: 'system', id: 'supervisor' },
    scope: { sessionId: sid },
    meta: { sessionId: sid, claudeSessionId: claudeId, pid: 4242, model: 'claude-opus-5-5', turn: 1 },
    payload: { cwd: '/tmp/repo', argv: [], transcriptPath: '/tmp/t.jsonl' },
    source: 'supervisor',
  });
  s.append({
    type: 'session.lifecycle_changed',
    actor: { kind: 'system', id: 'supervisor' },
    scope: { sessionId: sid },
    meta: { sessionId: sid, from: 'launching', to: 'running', reason: 'launched' },
    source: 'supervisor',
  });
}

const hook = (sid: string | null, claudeId: string, event: string, extra: Record<string, unknown> = {}, mode: 'managed' | 'observed' = 'managed') => ({
  mode,
  aocSessionId: sid,
  hook: { session_id: claudeId, transcript_path: '/tmp/t.jsonl', cwd: '/tmp/repo', hook_event_name: event, ...extra },
  sentAt: '2026-10-09T02:00:00.000Z',
  idempotencyKey: `key-${randomUUID()}`,
});

const livenessChanges = (sid: string) =>
  t.rt.store.list({ types: ['session.liveness_changed'], sessionId: sid }).map((e) => (e.meta as { to: string | null }).to);

describe('session owner', () => {
  it('is the owner recorded at launch; launches logged before ownerId existed keep the old inference', async () => {
    await setup();
    const owner = t.user('builder');
    const other = t.user('builder');
    launch(owner, 'ses_old'); // legacy: the launching human
    const asSupervisor = (sid: string, meta: Record<string, unknown>) =>
      t.rt.store.append({
        type: 'session.launch_requested',
        actor: { kind: 'system', id: 'supervisor' },
        scope: { sessionId: sid, projectId: 'prj_1' },
        meta: { sessionId: sid, projectId: 'prj_1', threadId: 'thr_1', processType: 'discovery', model: 'claude-opus-5-5', readOnly: false, credentialProfile: null, ticketId: null, parentSessionId: null, phaseId: null, ...meta } as never,
        payload: { prompt: 'Continue', cwd: '/tmp/repo' },
        source: 'supervisor',
      });
    asSupervisor('ses_succ', { parentSessionId: 'ses_old' }); // legacy: the parent's owner
    asSupervisor('ses_triage', { parentSessionId: 'ses_old', ownerId: null }); // recorded: nobody
    asSupervisor('ses_rec', { ownerId: other.user.id }); // recorded
    const owners = () => ['ses_old', 'ses_succ', 'ses_triage', 'ses_rec'].map((id) => engine().get(id)?.ownerId);
    expect(owners()).toEqual([owner.user.id, owner.user.id, null, other.user.id]);
    t.rt.store.rebuildProjections(['sessions']);
    expect(owners()).toEqual([owner.user.id, owner.user.id, null, other.user.id]);
  });
});

describe('liveness engine (§4)', () => {
  it('derives states from instrumented events and chains only changes', async () => {
    await setup();
    const owner = t.user('builder');
    launch(owner);
    const e = engine();
    const now = () => t.clock.now();
    for (let i = 0; i < 10; i++) {
      t.clock.advance(5000);
      e.heartbeat('ses_A', now(), true, 4242);
    }
    expect(livenessChanges('ses_A')).toEqual(['thinking']);
    e.toolStarted('ses_A', now());
    expect(engine().row('ses_A')!.liveness).toBe('working');
    e.toolFinished('ses_A', now());
    t.clock.advance(60_000);
    e.heartbeat('ses_A', now(), true, 4242);
    expect(engine().row('ses_A')!.liveness).toBe('thinking');
    t.clock.advance(9 * 60_000);
    e.heartbeat('ses_A', now(), true, 4242);
    expect(engine().row('ses_A')!.liveness).toBe('thinking'); // under the 10-minute stall threshold
    t.clock.advance(2 * 60_000);
    e.heartbeat('ses_A', now(), true, 4242);
    expect(engine().row('ses_A')!.liveness).toBe('stalled');
    t.clock.advance(60_000);
    e.refresh('ses_A');
    expect(engine().row('ses_A')!.liveness).toBe('dead');
    // a decision outranks Dead (waiting costs nothing; the process has exited cleanly)
    t.decisions!.request(
      { kind: 'agent_decision', test: 'main', title: 'Merge?', question: 'Merge to main?', options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'No' }], subjectType: 'session', subjectId: 'ses_A', sessionId: 'ses_A', requesterId: owner.user.id },
      { kind: 'agent', id: 'ses_A' },
    );
    e.refresh('ses_A');
    expect(engine().row('ses_A')!.liveness).toBe('waiting_on_you');
    expect(livenessChanges('ses_A')).toEqual(['thinking', 'working', 'thinking', 'stalled', 'dead', 'waiting_on_you']);
  });

  it('an expired card no longer keeps the session Waiting on you (G-33)', async () => {
    await setup();
    const owner = t.user('builder');
    launch(owner);
    const e = engine();
    e.heartbeat('ses_A', t.clock.now(), true, 4242);
    const card = t.decisions!.request(
      { kind: 'agent_decision', test: 'ambiguity', title: 'Which?', question: 'Which parser?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], subjectType: 'session', subjectId: 'ses_A', sessionId: 'ses_A', requesterId: 'session:ses_A' },
      { kind: 'agent', id: 'ses_A' },
    );
    e.refresh('ses_A');
    expect(e.row('ses_A')!.liveness).toBe('waiting_on_you');
    t.clock.advance(5000);
    t.rt.store.append({
      type: 'decision.expired',
      actor: { kind: 'system', id: 'decisions' },
      scope: { decisionId: card.id, sessionId: 'ses_A' },
      meta: { decisionId: card.id, ageMs: 5000 },
      source: 'system',
    });
    e.heartbeat('ses_A', t.clock.now(), true, 4242);
    expect(e.openDecisionCount('ses_A')).toBe(0);
    expect(e.row('ses_A')!.liveness).toBe('thinking');
    t.rt.store.rebuildProjections(['sessions']);
    expect(e.openDecisionCount('ses_A')).toBe(0);
  });
});

describe('hook ingest', () => {
  it('fails closed for unknown managed sessions and never blocks observed ones', async () => {
    await setup([
      {
        name: 'deny-all',
        guards: [{ name: 'deny-bash', order: 1, evaluate: (c) => (c.toolName === 'Bash' ? { decision: 'deny', guard: 'deny-bash', reason: 'no bash' } : null) }],
      },
    ]);
    const unknown = await t.json<HookIngestResponse>('POST', '/ingest/hook', { headers: t.ingestHeaders('system'), body: hook('ses_nope', CLAUDE_A, 'PreToolUse', { tool_name: 'Read', tool_input: {} }) });
    expect(unknown.exitCode).toBe(2);

    const obsHeaders = t.ingestHeaders('observer');
    const claudeObs = randomUUID();
    const r1 = await t.json<HookIngestResponse>('POST', '/ingest/hook', { headers: obsHeaders, body: hook(null, claudeObs, 'SessionStart', { source: 'startup' }, 'observed') });
    expect(r1).toEqual({ exitCode: 0 });
    const r2 = await t.json<HookIngestResponse>('POST', '/ingest/hook', { headers: obsHeaders, body: hook(null, claudeObs, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }, 'observed') });
    expect(r2).toEqual({ exitCode: 0 });
    const obs = engine().byClaudeSessionId(claudeObs)!;
    expect(obs.mode).toBe('observed');
    expect(t.rt.store.list({ types: ['tool.denied'] })).toHaveLength(0);
    // observer token cannot pose as managed
    const res = await t.request('POST', '/ingest/hook', { headers: obsHeaders, body: hook('ses_A', CLAUDE_A, 'PreToolUse', { tool_name: 'Read', tool_input: {} }) });
    expect(res.status).toBe(403);
  });

  it('turns a guard denial into tool.denied + decision card + blocked, and relays a deny to Claude', async () => {
    await setup([
      {
        name: 'protected',
        guards: [
          {
            name: 'protected-op',
            order: 30,
            evaluate: (c) =>
              c.toolName === 'Bash' && String(c.toolInput.command).includes('git push origin main')
                ? {
                    decision: 'deny',
                    guard: 'protected-op',
                    reason: 'Pushing to main requires approval',
                    blockReason: 'protected_operation',
                    raiseDecision: { kind: 'protected_operation', test: 'main', title: 'Push to main', question: 'Allow push to main?', options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }], subjectType: 'session', subjectId: c.session.sessionId },
                  }
                : null,
          },
        ],
      },
    ]);
    const owner = t.user('builder');
    launch(owner);
    const headers = t.ingestHeaders('ses_A');
    const res = await t.json<HookIngestResponse>('POST', '/ingest/hook', { headers, body: hook('ses_A', CLAUDE_A, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git push origin main' } }) });
    expect(res.exitCode).toBe(0);
    expect(res.stdout?.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(JSON.stringify(res.stdout)).toMatch(/END YOUR TURN/);
    const denied = t.rt.store.list({ types: ['tool.denied'] })[0]!;
    expect(denied.meta).toMatchObject({ guard: 'protected-op', decision: 'deny' });
    const card = t.decisions!.list({ sessionId: 'ses_A' })[0]!;
    expect(card.requiredRole).toBe('approver');
    expect(card.requesterId).toBe('session:ses_A');
    expect(t.rt.store.list({ types: ['session.blocked'] })[0]!.meta).toMatchObject({ reason: 'protected_operation' });
    expect(engine().row('ses_A')!.liveness).toBe('waiting_on_you');
    // allowed tool → working; PostToolUse → tool.used with fileChanging
    await t.json('POST', '/ingest/hook', { headers, body: hook('ses_A', CLAUDE_A, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/tmp/repo/a.ts' } }) });
    await t.json('POST', '/ingest/hook', { headers, body: hook('ses_A', CLAUDE_A, 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/tmp/repo/a.ts' }, tool_response: { ok: true } }) });
    const used = t.rt.store.list({ types: ['tool.used'] })[0]!;
    expect(used.meta).toMatchObject({ toolName: 'Edit', fileChanging: true, ok: true });
    expect(t.rt.store.readPayload(used)).toMatchObject({ filePaths: ['/tmp/repo/a.ts'] });
  });

  it('records a permission request Claude Code refuses in print mode as tool.denied, once, never for an observed session (G-53)', async () => {
    await setup();
    const owner = t.user('builder');
    launch(owner);
    const headers = t.ingestHeaders('ses_A');
    const body = hook('ses_A', CLAUDE_A, 'PermissionRequest', {
      tool_name: 'Bash',
      tool_input: { command: 'git push origin feature/x' },
      permission_mode: 'acceptEdits',
      permission_suggestions: [],
    });
    expect(await t.json<HookIngestResponse>('POST', '/ingest/hook', { headers, body })).toEqual({ exitCode: 0 });
    await t.json('POST', '/ingest/hook', { headers, body }); // a retried delivery
    const denied = t.rt.store.list({ types: ['tool.denied'] });
    expect(denied).toHaveLength(1);
    expect(denied[0]!.meta).toEqual({ sessionId: 'ses_A', toolName: 'Bash', guard: 'permission-mode', decision: 'deny', decisionId: null });
    // The command is in the encrypted body, never in the chained meta.
    expect(JSON.stringify(denied[0]!.meta)).not.toContain('git push');
    expect(t.rt.store.readPayload(denied[0]!)).toMatchObject({
      inputSummary: '{"command":"git push origin feature/x"}',
      reason: expect.stringContaining('permission mode acceptEdits'),
    });

    // In an interactive (observed) session a person may still approve it: nothing is recorded.
    const claudeObs = randomUUID();
    await t.json('POST', '/ingest/hook', { headers: t.ingestHeaders('observer'), body: hook(null, claudeObs, 'SessionStart', { source: 'startup' }, 'observed') });
    await t.json('POST', '/ingest/hook', {
      headers: t.ingestHeaders('observer'),
      body: hook(null, claudeObs, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' }, permission_suggestions: [] }, 'observed'),
    });
    expect(t.rt.store.list({ types: ['tool.denied'] })).toHaveLength(1);
  });

  it('records a prompt relayed by a managed session\'s hook as the agent\'s claim, not a supervisor fact (O-4, G-47)', async () => {
    await setup();
    const owner = t.user('builder');
    launch(owner);
    await t.json('POST', '/ingest/hook', {
      headers: t.ingestHeaders('ses_A'),
      body: hook('ses_A', CLAUDE_A, 'UserPromptSubmit', { prompt: 'Add the CSV importer' }),
    });
    const [prompt] = t.rt.store.list({ types: ['prompt.submitted'] });
    expect(prompt).toMatchObject({
      actor: { kind: 'agent', id: 'ses_A' },
      source: 'hook',
      meta: { sessionId: 'ses_A', origin: 'supervisor' },
    });
    expect(t.rt.store.readPayload(prompt!)).toEqual({ text: 'Add the CSV importer' });
  });

  it('scopes session tokens to their own session', async () => {
    await setup();
    const owner = t.user('builder');
    launch(owner, 'ses_A');
    launch(owner, 'ses_B', {}, randomUUID());
    const res = await t.request('POST', '/ingest/hook', { headers: t.ingestHeaders('ses_A'), body: hook('ses_B', CLAUDE_A, 'PostToolUse', { tool_name: 'Read', tool_input: {}, tool_response: {} }) });
    expect(res.status).toBe(403);
    const hb = await t.request('POST', '/ingest/heartbeat', { headers: t.sidecarHeaders('ses_A'), body: { sessionId: 'ses_B', pid: 1, alive: true, at: t.clock.iso(), transcriptBytes: 0, lastTranscriptWriteAt: null } });
    expect(hb.status).toBe(403);
  });

  it('replays spooled observed events idempotently', async () => {
    await setup();
    const claudeObs = randomUUID();
    const item = { path: '/ingest/hook', body: hook(null, claudeObs, 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/x' }, tool_response: {} }, 'observed'), queuedAt: t.clock.iso() };
    const headers = t.ingestHeaders('observer');
    expect(await t.json('POST', '/ingest/spool', { headers, body: { items: [item, item] } })).toEqual({ accepted: 1, duplicates: 1, rejected: 0 });
    expect(await t.json('POST', '/ingest/spool', { headers, body: { items: [item] } })).toEqual({ accepted: 0, duplicates: 1, rejected: 0 });
    expect(t.rt.store.list({ types: ['tool.used'] })).toHaveLength(1);
  });

  it('replays everything clients spool: observed usage, and the sidecar’s usage, throttle and process exit', async () => {
    // Regression: only /ingest/hook items were replayed; the rest were counted rejected and the client then
    // deleted them, so usage and throttles that happened during an outage were lost.
    await setup();
    const owner = t.user('builder');
    launch(owner);
    const usage = (sessionId: string, ids: string[], key: string) => ({
      path: '/ingest/usage',
      queuedAt: t.clock.iso(),
      body: {
        sessionId,
        idempotencyKey: key,
        batches: [{ model: 'claude-opus-5-5', inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, messageIds: ids, firstAt: t.clock.iso(), lastAt: t.clock.iso(), contextTokens: 900 }],
      },
    });
    const sidecar = t.sidecarHeaders('ses_A');
    const items = [
      usage('ses_A', ['m1'], 'sidecar-usage-1'),
      { path: '/ingest/throttle', queuedAt: t.clock.iso(), body: { sessionId: 'ses_A', resetAt: '2026-10-09T07:00:00.000Z', message: "You've hit your session limit · resets 3pm (Asia/Kuala_Lumpur)", source: 'transcript' } },
      { path: '/ingest/process', queuedAt: t.clock.iso(), body: { sessionId: 'ses_A', event: 'exited', exitCode: null, signal: null, at: t.clock.iso() } },
    ];
    expect(await t.json('POST', '/ingest/spool', { headers: sidecar, body: { items } })).toEqual({ accepted: 3, duplicates: 0, rejected: 0 });
    expect(t.rt.store.list({ types: ['usage.recorded'], sessionId: 'ses_A' })).toHaveLength(1);
    expect(t.rt.store.list({ types: ['throttle.hit'], sessionId: 'ses_A' })[0]!.meta).toMatchObject({ resetAt: '2026-10-09T07:00:00.000Z', source: 'transcript' });
    expect(engine().signalsOf('ses_A').processAlive).toBe(false);
    // A second replay of the same items changes nothing.
    expect(await t.json('POST', '/ingest/spool', { headers: sidecar, body: { items: items.slice(0, 2) } })).toEqual({ accepted: 0, duplicates: 2, rejected: 0 });
    expect(t.rt.store.list({ types: ['usage.recorded', 'throttle.hit'], sessionId: 'ses_A' })).toHaveLength(2);
    // A sidecar token never replays another session's items.
    expect(await t.json('POST', '/ingest/spool', { headers: sidecar, body: { items: [usage('ses_B', ['m9'], 'other-session')] } })).toEqual({ accepted: 0, duplicates: 0, rejected: 1 });

    // Observed hooks spool usage keyed by the claude session id, replayed with the observer token.
    const claudeObs = randomUUID();
    const observer = t.ingestHeaders('observer');
    await t.json('POST', '/ingest/hook', { headers: observer, body: hook(null, claudeObs, 'SessionStart', { source: 'startup' }, 'observed') });
    const obs = engine().byClaudeSessionId(claudeObs)!;
    expect(await t.json('POST', '/ingest/spool', { headers: observer, body: { items: [usage(claudeObs, ['o1'], 'observed-usage-1')] } })).toEqual({ accepted: 1, duplicates: 0, rejected: 0 });
    expect(t.rt.store.list({ types: ['usage.recorded'], sessionId: obs.sessionId })[0]!.source).toBe('hook');
    // Observer tokens cannot replay a managed session's process exit …
    expect(await t.json('POST', '/ingest/spool', { headers: observer, body: { items: [items[2]] } })).toEqual({ accepted: 0, duplicates: 0, rejected: 1 });
    // … nor usage or a throttle addressed to a managed session by its claude session id.
    const forged = [
      usage(CLAUDE_A, ['f1'], 'forged-usage'),
      { path: '/ingest/throttle', queuedAt: t.clock.iso(), body: { sessionId: CLAUDE_A, resetAt: null, message: 'x', source: 'transcript' } },
    ];
    expect(await t.json('POST', '/ingest/spool', { headers: observer, body: { items: forged } })).toEqual({ accepted: 0, duplicates: 0, rejected: 2 });
    expect(t.rt.store.list({ types: ['usage.recorded', 'throttle.hit'], sessionId: 'ses_A' })).toHaveLength(2);
    // Replayed usage gets the same session-bound, hashed idempotency key as live usage: no client text is chained.
    const replayed = t.rt.store.list({ types: ['usage.recorded'] });
    expect(replayed.map((e) => e.idempotencyKey).every((k) => !!k && !k.includes('sidecar-usage') && !k.includes('observed-usage'))).toBe(true);
  });
});

describe('per-turn sidecars', () => {
  it("ignores heartbeats and exit reports about an earlier turn's process", async () => {
    // Regression (found by e2e): the supervisor starts a sidecar per turn and stops the old one after a grace;
    // the previous turn's sidecar noticed its pid had died seconds into the next turn, and its report marked the
    // running session Dead.
    await setup();
    const owner = t.user('builder');
    launch(owner); // turn 1: pid 4242
    const headers = t.sidecarHeaders('ses_A');
    const heartbeat = (pid: number, alive: boolean) =>
      t.json('POST', '/ingest/heartbeat', { headers, body: { sessionId: 'ses_A', pid, alive, at: t.clock.iso(), transcriptBytes: 0, lastTranscriptWriteAt: null } });
    const exited = (pid: number) => {
      const body: ProcessEventRequest = { sessionId: 'ses_A', event: 'exited', exitCode: 0, signal: null, at: t.clock.iso(), pid };
      return t.json('POST', '/ingest/process', { headers, body });
    };
    await heartbeat(4242, true);
    expect(engine().row('ses_A')!.liveness).toBe('thinking');
    t.rt.store.append({
      type: 'session.launched',
      actor: { kind: 'system', id: 'supervisor' },
      scope: { sessionId: 'ses_A' },
      meta: { sessionId: 'ses_A', claudeSessionId: CLAUDE_A, pid: 5151, model: 'claude-opus-5-5', turn: 2 },
      payload: { cwd: '/tmp/repo', argv: [], transcriptPath: '/tmp/t.jsonl' },
      source: 'supervisor',
    });
    await heartbeat(4242, false);
    await exited(4242);
    expect(engine().row('ses_A')!.liveness).toBe('thinking');
    // The current process's own sidecar still counts.
    await heartbeat(5151, true);
    await exited(5151);
    expect(engine().row('ses_A')!.liveness).toBe('dead');
  });

  it('takes an exit report that names no process (absent or null pid) as the current one, and refuses a pid that is not a whole number', async () => {
    await setup();
    const owner = t.user('builder');
    launch(owner);
    const headers = t.sidecarHeaders('ses_A');
    const report = (more: Partial<ProcessEventRequest> | { pid: string }) => ({
      sessionId: 'ses_A', event: 'exited' as const, exitCode: 0, signal: null, at: t.clock.iso(), ...more,
    });
    const send = (body: object) => t.request('POST', '/ingest/process', { headers, body });
    expect((await send(report({ pid: '4242' }))).status).toBe(422);
    expect((await send(report({ pid: 42.5 }))).status).toBe(422);
    expect(engine().row('ses_A')!.liveness).not.toBe('dead');

    expect((await send(report({ pid: null }))).status).toBe(200);
    expect(engine().row('ses_A')!.liveness).toBe('dead');

    t.rt.store.append({
      type: 'session.turn_started',
      actor: { kind: 'system', id: 'supervisor' },
      scope: { sessionId: 'ses_A' },
      meta: { sessionId: 'ses_A', turn: 2, reason: 'resume' },
      payload: { injectedText: 'go on' },
      source: 'supervisor',
    });
    t.rt.store.append({
      type: 'session.launched',
      actor: { kind: 'system', id: 'supervisor' },
      scope: { sessionId: 'ses_A' },
      meta: { sessionId: 'ses_A', claudeSessionId: CLAUDE_A, pid: 5151, model: 'claude-opus-5-5', turn: 2 },
      payload: { cwd: '/tmp/repo', argv: [], transcriptPath: '/tmp/t.jsonl' },
      source: 'supervisor',
    });
    await t.json('POST', '/ingest/heartbeat', { headers, body: { sessionId: 'ses_A', pid: 5151, alive: true, at: t.clock.iso(), transcriptBytes: 0, lastTranscriptWriteAt: null } });
    expect(engine().row('ses_A')!.liveness).not.toBe('dead');
    expect((await send(report({}))).status).toBe(200); // no pid at all (an older sidecar, a spooled report)
    expect(engine().row('ses_A')!.liveness).toBe('dead');
  });
});

describe('usage + throttle ingest', () => {
  it('dedupes usage by message id across batches and tracks context', async () => {
    await setup();
    const owner = t.user('builder');
    launch(owner);
    const headers = t.sidecarHeaders('ses_A');
    const batch = (ids: string[], ctx: number) => ({ model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 20, cacheReadTokens: 1000, cacheWrite5mTokens: 5, cacheWrite1hTokens: 0, messageIds: ids, firstAt: t.clock.iso(), lastAt: t.clock.iso(), contextTokens: ctx });
    const r1 = await t.json<{ recorded: number }>('POST', '/ingest/usage', { headers, body: { sessionId: 'ses_A', idempotencyKey: 'usage-key-1', batches: [batch(['m1', 'm2'], 50_000)] } });
    const r2 = await t.json<{ recorded: number; skipped: number }>('POST', '/ingest/usage', { headers, body: { sessionId: 'ses_A', idempotencyKey: 'usage-key-2', batches: [batch(['m1', 'm2'], 50_000), batch(['m3'], 120_000)] } });
    expect(r1.recorded).toBe(1);
    expect(r2).toMatchObject({ recorded: 1, skipped: 1 });
    expect(engine().contextTokens('ses_A')).toBe(120_000);
    // A batch without a main-chain message (a subagent transcript on its own) reports 0: the last size stands.
    await t.json('POST', '/ingest/usage', { headers, body: { sessionId: 'ses_A', idempotencyKey: 'usage-key-3', batches: [batch(['sub1'], 0)] } });
    expect(engine().contextTokens('ses_A')).toBe(120_000);
    // throttle: one event per episode
    await t.json('POST', '/ingest/throttle', { headers, body: { sessionId: 'ses_A', resetAt: '2026-10-09T05:00:00.000Z', message: 'Claude AI usage limit reached|1791522000', source: 'transcript' } });
    await t.json('POST', '/ingest/throttle', { headers, body: { sessionId: 'ses_A', resetAt: '2026-10-09T05:00:00.000Z', message: 'again', source: 'transcript' } });
    expect(t.rt.store.list({ types: ['throttle.hit'] })).toHaveLength(1);
    expect(engine().row('ses_A')!.liveness).toBe('throttled');
  });
});

describe('read-only guard', () => {
  it('allows inspection and blocks writes in read-only sessions', async () => {
    await setup();
    const owner = t.user('builder');
    launch(owner, 'ses_T', { readOnly: true, processType: 'bug-triage' });
    const headers = t.ingestHeaders('ses_T');
    const pre = (tool: string, input: Record<string, unknown>) => t.json<HookIngestResponse>('POST', '/ingest/hook', { headers, body: hook('ses_T', CLAUDE_A, 'PreToolUse', { tool_name: tool, tool_input: input }) });
    expect((await pre('Read', { file_path: '/a' })).stdout).toBeUndefined();
    expect((await pre('Bash', { command: 'git log -5' })).stdout).toBeUndefined();
    expect((await pre('Write', { file_path: '/a' })).stdout?.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
    expect((await pre('Bash', { command: 'echo x > /etc/passwd' })).stdout?.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
    expect(isReadOnlyBash('find . -name x -delete')).toBe(false);
    expect(isReadOnlyBash('rg TODO src')).toBe(true);
  });
});

describe('read APIs', () => {
  it('serves console snapshot, summaries and details with operator actions', async () => {
    await setup();
    const owner = t.user('builder', 'Aisyah');
    const other = t.user('builder', 'Wei Jie');
    const requester = t.user('requester');
    launch(owner);
    const e = engine();
    e.toolStarted('ses_A', t.clock.now());
    e.toolFinished('ses_A', t.clock.now());
    const snap = await t.json<ConsoleSnapshot>('GET', '/api/console', { headers: owner.headers });
    expect(snap.kpis.activeSessions).toBe(1);
    expect(snap.sessions[0]!.apm.points).toHaveLength(30);
    expect(snap.sessions[0]!.ownerName).toBe('Aisyah');
    expect(snap.sessions[0]!.title).toBe('Build the claims intake parser');
    const list = await t.json<SessionSummary[]>('GET', '/api/sessions?state=running', { headers: owner.headers });
    expect(list).toHaveLength(1);
    const mine = await t.json<SessionDetail>('GET', '/api/sessions/ses_A', { headers: owner.headers });
    expect(mine.actions.stop.enabled).toBe(true);
    const theirs = await t.json<SessionDetail>('GET', '/api/sessions/ses_A', { headers: other.headers });
    expect(theirs.actions.stop.enabled).toBe(false);
    expect((await t.request('GET', '/api/console', { headers: requester.headers })).status).toBe(403);
    const events = await t.json<{ type: string; hash: string }[]>('GET', '/api/sessions/ses_A/events', { headers: owner.headers });
    expect(events[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
