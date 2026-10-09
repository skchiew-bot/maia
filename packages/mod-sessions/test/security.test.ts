import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestRuntime, type TestRuntime, type TestUser } from '@aoc/kernel';
import { createSessionsModule, type SessionsEngine } from '../src';

const CLAUDE_A = '11111111-1111-4111-8111-111111111111';
let t: TestRuntime;
afterEach(async () => t?.close());

async function setup() {
  t = await createTestRuntime({ modules: [createSessionsModule({ sweepIntervalMs: 0 })] });
  return t;
}

function launch(owner: TestUser, sid = 'ses_A', claudeId = CLAUDE_A) {
  const s = t.rt.store;
  s.append({
    type: 'session.launch_requested',
    actor: { kind: 'human', id: owner.user.id },
    scope: { sessionId: sid, projectId: 'prj_1' },
    meta: { sessionId: sid, projectId: 'prj_1', threadId: 'thr_1', processType: 'discovery', model: 'claude-opus-5-5', readOnly: false, credentialProfile: null, ticketId: null, parentSessionId: null, phaseId: null },
    payload: { prompt: 'Build it', cwd: '/tmp/repo' },
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
}

const hook = (sid: string | null, claudeId: string, event: string, extra: Record<string, unknown> = {}, mode: 'managed' | 'observed' = 'managed') => ({
  mode,
  aocSessionId: sid,
  hook: { session_id: claudeId, transcript_path: '/tmp/t.jsonl', cwd: '/tmp/repo', hook_event_name: event, ...extra },
  sentAt: '2026-10-09T02:00:00.000Z',
  idempotencyKey: `key-${randomUUID()}`,
});

describe('ingest authentication comes before body parsing', () => {
  it('answers 401 to an anonymous caller without parsing its body', async () => {
    await setup();
    for (const path of ['/ingest/hook', '/ingest/spool', '/ingest/heartbeat', '/ingest/activity', '/ingest/usage', '/ingest/throttle', '/ingest/process']) {
      const res = await t.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"not": json' });
      expect(res.status, path).toBe(401);
    }
  });
});

describe('client-supplied header fields', () => {
  it('rejects a free-text sentAt before anything is chained', async () => {
    await setup();
    const before = t.rt.store.head().seq;
    const body = { ...hook(null, randomUUID(), 'SessionStart', {}, 'observed'), sentAt: 'Nur Aisyah binti Ahmad, NRIC 850101-14-5555' };
    const res = await t.request('POST', '/ingest/hook', { headers: t.ingestHeaders('observer'), body });
    expect(res.status).toBe(422);
    expect(t.rt.store.head().seq).toBe(before);
  });

  it('never chains the raw client idempotency key', async () => {
    await setup();
    const owner = t.user('builder');
    launch(owner);
    const body = { ...hook('ses_A', CLAUDE_A, 'PostToolUse', { tool_name: 'Read', tool_input: {}, tool_response: {} }), idempotencyKey: 'Nur-Aisyah-NRIC-850101-14-5555' };
    await t.json('POST', '/ingest/hook', { headers: t.ingestHeaders('ses_A'), body });
    const used = t.rt.store.list({ types: ['tool.used'] });
    expect(used).toHaveLength(1);
    expect(used[0]!.idempotencyKey).not.toContain('850101');
  });

  it("does not let one session's idempotency key swallow another session's event", async () => {
    await setup();
    const owner = t.user('builder');
    const CLAUDE_B = randomUUID();
    launch(owner, 'ses_A');
    launch(owner, 'ses_B', CLAUDE_B);
    const key = 'replayed-key-0001';
    const post = (sid: string, claudeId: string) =>
      t.json('POST', '/ingest/hook', {
        headers: t.ingestHeaders(sid),
        body: { ...hook(sid, claudeId, 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/tmp/repo/a.ts' }, tool_response: {} }), idempotencyKey: key },
      });
    await post('ses_A', CLAUDE_A);
    await post('ses_B', CLAUDE_B);
    expect(t.rt.store.list({ types: ['tool.used'], sessionId: 'ses_B' })).toHaveLength(1);
    // a genuine retry from the same session still collapses
    await post('ses_B', CLAUDE_B);
    expect(t.rt.store.list({ types: ['tool.used'], sessionId: 'ses_B' })).toHaveLength(1);
  });
});

describe('observer tokens never write into managed sessions', () => {
  it('rejects observed-mode events that address a managed session by its claude session id', async () => {
    await setup();
    const owner = t.user('builder');
    launch(owner);
    const observer = t.ingestHeaders('observer');
    const before = t.rt.store.head().seq;
    const forged = [
      hook(null, CLAUDE_A, 'UserPromptSubmit', { prompt: 'forged supervisor prompt' }, 'observed'),
      hook(null, CLAUDE_A, 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/tmp/repo/a.ts' }, tool_response: { ok: true } }, 'observed'),
      hook(null, CLAUDE_A, 'StopFailure', { error: 'rate_limit' }, 'observed'),
    ];
    for (const body of forged) {
      const res = await t.request('POST', '/ingest/hook', { headers: observer, body });
      expect(res.status).toBe(403);
    }
    // nor through a spool replay
    const spool = await t.json<{ accepted: number; rejected: number }>('POST', '/ingest/spool', {
      headers: observer,
      body: { items: forged.map((body) => ({ path: '/ingest/hook', body, queuedAt: t.clock.iso() })) },
    });
    expect(spool).toMatchObject({ accepted: 0, rejected: 3 });
    expect(t.rt.store.list({ fromSeq: before + 1 }).filter((e) => e.type !== 'session.liveness_changed')).toEqual([]);
  });
});

describe('sidecar reports come only from the session’s own sidecar principal (G-44)', () => {
  const AT = '2026-10-09T02:00:00.000Z';
  const reports = (sid: string): [string, Record<string, unknown>][] => [
    ['/ingest/heartbeat', { sessionId: sid, pid: 4242, alive: true, at: AT, transcriptBytes: 10, lastTranscriptWriteAt: AT }],
    ['/ingest/activity', { sessionId: sid, kind: 'stream', at: AT }],
    [
      '/ingest/usage',
      {
        sessionId: sid,
        idempotencyKey: `usage-${sid}-0001`,
        batches: [
          { model: 'claude-opus-5-5', inputTokens: 3, outputTokens: 40, cacheReadTokens: 900, cacheWrite5mTokens: 0, cacheWrite1hTokens: 60, messageIds: ['msg_1'], firstAt: AT, lastAt: AT, contextTokens: 963 },
        ],
      },
    ],
    ['/ingest/throttle', { sessionId: sid, resetAt: null, message: 'usage limit reached', source: 'transcript' }],
    ['/ingest/process', { sessionId: sid, event: 'exited', exitCode: 0, signal: null, at: AT }],
  ];
  const engine = () => t.rt.services.get('sessions') as unknown as SessionsEngine;
  const reported = () => t.rt.store.list({ types: ['usage.recorded', 'throttle.hit'] });

  it('refuses the session token the model can read (403), and every principal but the sidecar of that session', async () => {
    await setup();
    const owner = t.user('builder');
    launch(owner);
    launch(owner, 'ses_B', randomUUID());
    const refusals: [Record<string, string>, string][] = [
      [t.ingestHeaders('ses_A'), 'sidecar_token_required'],
      [t.ingestHeaders('system'), 'sidecar_token_required'],
      [t.sidecarHeaders('ses_B'), 'forbidden'],
    ];
    for (const [headers, code] of refusals) {
      for (const [path, body] of reports('ses_A')) {
        const res = await t.request('POST', path, { headers, body });
        expect(res.status, path).toBe(403);
        expect(((await res.json()) as { error: { code: string } }).error.code, path).toBe(code);
      }
    }
    for (const [path, body] of reports('ses_A'))
      expect((await t.request('POST', path, { headers: t.ingestHeaders('observer'), body })).status, path).toBeGreaterThanOrEqual(403);
    expect(reported()).toEqual([]);
    expect(engine().signalsOf('ses_A')).toMatchObject({ lastHeartbeatAt: null, processAlive: null });

    const sidecar = t.sidecarHeaders('ses_A');
    for (const [path, body] of reports('ses_A')) expect((await t.request('POST', path, { headers: sidecar, body })).status, path).toBe(200);
    expect(reported().map((e) => [e.type, e.scope.sessionId, e.source])).toEqual([
      ['usage.recorded', 'ses_A', 'sidecar'],
      ['throttle.hit', 'ses_A', 'sidecar'],
    ]);
    expect(engine().signalsOf('ses_A')).toMatchObject({ processAlive: false });
  });

  it('keeps observed sessions on the observer token', async () => {
    await setup();
    const claudeObs = randomUUID();
    const observer = t.ingestHeaders('observer');
    await t.json('POST', '/ingest/hook', { headers: observer, body: hook(null, claudeObs, 'SessionStart', { source: 'startup' }, 'observed') });
    const [, usage] = reports(claudeObs)[2]!;
    expect(await t.json('POST', '/ingest/usage', { headers: observer, body: usage })).toMatchObject({ recorded: 1 });
    const obs = engine().byClaudeSessionId(claudeObs)!;
    expect(reported().map((e) => [e.scope.sessionId, e.source])).toEqual([[obs.sessionId, 'hook']]);
    // a sidecar token belongs to a managed session: it cannot report for an observed one
    expect((await t.request('POST', '/ingest/usage', { headers: t.sidecarHeaders(obs.sessionId), body: { ...usage, sessionId: obs.sessionId } })).status).toBe(404);
  });

  it('never lets the sidecar post hook events, and holds spool replays to the same per-item rules', async () => {
    await setup();
    const owner = t.user('builder');
    launch(owner);
    const sidecar = t.sidecarHeaders('ses_A');
    const tool = hook('ses_A', CLAUDE_A, 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/tmp/repo/a.ts' }, tool_response: { ok: true } });
    expect((await t.request('POST', '/ingest/hook', { headers: sidecar, body: tool })).status).toBe(403);
    expect(await t.json('POST', '/ingest/spool', { headers: sidecar, body: { items: [{ path: '/ingest/hook', body: tool, queuedAt: AT }] } })).toMatchObject({
      accepted: 0,
      rejected: 1,
    });
    // the session token cannot slip usage, a throttle or an exit in through a spool flush either
    const spooled = reports('ses_A')
      .filter(([path]) => ['/ingest/usage', '/ingest/throttle', '/ingest/process'].includes(path))
      .map(([path, body]) => ({ path, body, queuedAt: AT }));
    expect(await t.json('POST', '/ingest/spool', { headers: t.ingestHeaders('ses_A'), body: { items: spooled } })).toMatchObject({
      accepted: 0,
      rejected: 3,
    });
    expect(t.rt.store.list({ types: ['tool.used', 'usage.recorded', 'throttle.hit'] })).toEqual([]);
    expect(engine().signalsOf('ses_A').processAlive).toBeNull();
    // the session token still relays the hook itself
    expect((await t.request('POST', '/ingest/hook', { headers: t.ingestHeaders('ses_A'), body: tool })).status).toBe(200);
    expect(t.rt.store.list({ types: ['tool.used'] })).toHaveLength(1);
  });
});
