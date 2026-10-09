import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConsoleSnapshot, HookIngestResponse, SessionDetail, SessionSummary } from '@aoc/contracts';
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

  it('scopes session tokens to their own session', async () => {
    await setup();
    const owner = t.user('builder');
    launch(owner, 'ses_A');
    launch(owner, 'ses_B', {}, randomUUID());
    const res = await t.request('POST', '/ingest/hook', { headers: t.ingestHeaders('ses_A'), body: hook('ses_B', CLAUDE_A, 'PostToolUse', { tool_name: 'Read', tool_input: {}, tool_response: {} }) });
    expect(res.status).toBe(403);
    const hb = await t.request('POST', '/ingest/heartbeat', { headers: t.ingestHeaders('ses_A'), body: { sessionId: 'ses_B', pid: 1, alive: true, at: t.clock.iso(), transcriptBytes: 0, lastTranscriptWriteAt: null } });
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
