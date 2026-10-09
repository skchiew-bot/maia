import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestRuntime, type TestRuntime, type TestUser } from '@aoc/kernel';
import { createSessionsModule, isReadOnlyBash, type SessionsEngine } from '../src';

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

describe('read-only guard on agent-controlled commands', () => {
  it('classifies a command built to backtrack in linear time (it runs on the daemon thread)', () => {
    const started = performance.now();
    expect(isReadOnlyBash('find -'.repeat(20_000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(isReadOnlyBash('find . -name x -exec rm {} +')).toBe(false);
    expect(isReadOnlyBash('rg -n TODO src')).toBe(true);
  });

  it('is one simple command, and none of the listed ones can be made to write a file, run another program or change a branch', () => {
    const writesOrRuns = [
      'ls\nnode -e "require(\'fs\').writeFileSync(\'x\', \'y\')"', // a second command on the next line
      'ls\r\npython3 evil.py',
      'cat <(node evil.js)', // process substitution runs a program
      'git branch -D main',
      'git branch -m old new',
      'git branch feature-x', // creates a branch
      'git diff --output=/tmp/x',
      'git log --output /tmp/x',
      'git show --output=/tmp/x HEAD',
      'rg --pre ./evil.sh foo .', // runs a program over every file it searches
      'rg --pre=./evil.sh foo',
      'rg --hostname-bin ./evil.sh foo',
      'tree -o out.txt',
      'tree -aCo out.txt',
      'file -C -m magic',
      'ls-evil -la', // another program that starts like an inspection command
      'cat.sh README.md',
      'git log-evil', // git runs git-log-evil from the PATH
    ];
    for (const command of writesOrRuns) expect(isReadOnlyBash(command), command).toBe(false);
    const inspection = [
      'git log -5',
      'git log --oneline -n 20',
      'git diff HEAD~1',
      'git show HEAD',
      'git status',
      'git blame README.md',
      'git rev-parse HEAD',
      'git branch',
      'git branch -a',
      'git branch --show-current',
      'git branch -vv',
      'rg -n TODO src',
      'grep -rn "two words" src',
      'ls -la',
      'cat README.md',
      'head -n 20 file.txt',
      'tail -n 5 file.txt',
      'wc -l file.txt',
      'tree -L 2',
      'file image.png',
      'du -sh .',
      'df -h',
      'stat file.txt',
      'pwd',
      'which node',
      'echo hello',
    ];
    for (const command of inspection) expect(isReadOnlyBash(command), command).toBe(true);
  });
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

describe('usage timestamps are bounded by the receipt time and the session (R-08)', () => {
  const batch = (id: string, firstAt: string, lastAt: string) => ({
    model: 'claude-opus-5-5',
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    messageIds: [id],
    firstAt,
    lastAt,
    contextTokens: 0,
  });
  const recorded = (messageId: string) => {
    const e = t.rt.store.list({ types: ['usage.recorded'] }).find((u) => (t.rt.store.readPayload(u) as { messageIds: string[] }).messageIds[0] === messageId)!;
    return { meta: e.meta, payload: t.rt.store.readPayload(e) as Record<string, unknown> };
  };

  it('keeps a client from backdating usage into a closed period or forward-dating it', async () => {
    await setup(); // 2026-10-09T02:00Z
    launch(t.user('builder'));
    t.clock.advance(5 * 60_000);
    await t.json('POST', '/ingest/usage', {
      headers: t.sidecarHeaders('ses_A'),
      body: {
        sessionId: 'ses_A',
        idempotencyKey: 'usage-key-r08',
        batches: [
          batch('m-back', '2026-09-15T02:00:00.000Z', '2026-09-15T02:00:01.000Z'),
          batch('m-fwd', '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z'),
          batch('m-ok', '2026-10-09T10:01:00+08:00', '2026-10-09T02:04:00.000Z'),
        ],
      },
    });
    // backdated: never before the session started; forward-dated: never after receipt
    expect(recorded('m-back').meta).toMatchObject({ firstAt: '2026-10-09T02:00:00.000Z', lastAt: '2026-10-09T02:00:00.000Z' });
    expect(recorded('m-fwd').meta).toMatchObject({ firstAt: '2026-10-09T02:05:00.000Z', lastAt: '2026-10-09T02:05:00.000Z' });
    expect(recorded('m-ok').meta).toMatchObject({ firstAt: '2026-10-09T02:01:00.000Z', lastAt: '2026-10-09T02:04:00.000Z' });
    // what the client claimed stays in the encrypted body for the audit trail
    expect(recorded('m-back').payload.claimed).toEqual({ firstAt: '2026-09-15T02:00:00.000Z', lastAt: '2026-09-15T02:00:01.000Z' });
    expect(recorded('m-ok').payload.claimed).toBeUndefined();
  });

  it('bounds a long-running session by a window before receipt, and refuses non-timestamps', async () => {
    await setup();
    launch(t.user('builder'));
    t.clock.advance(40 * 86_400_000); // the session has run (waited, resumed) for weeks
    const now = t.clock.now();
    await t.json('POST', '/ingest/usage', {
      headers: t.sidecarHeaders('ses_A'),
      body: { sessionId: 'ses_A', idempotencyKey: 'usage-key-r08-long', batches: [batch('m-old', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z')] },
    });
    expect(Date.parse(String(recorded('m-old').meta.lastAt))).toBeGreaterThanOrEqual(now - 3_600_000);
    const bad = await t.request('POST', '/ingest/usage', {
      headers: t.sidecarHeaders('ses_A'),
      body: { sessionId: 'ses_A', idempotencyKey: 'usage-key-r08-bad', batches: [batch('m-bad', 'last tuesday', 'today')] },
    });
    expect(bad.status).toBe(422);
  });
});

describe('observer tokens are rate limited per token (R-13)', () => {
  const observed = (claudeId: string) =>
    hook(null, claudeId, 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/x' }, tool_response: {} }, 'observed');

  it('answers 429 with Retry-After once a token spends its budget, leaving other tokens alone', async () => {
    t = await createTestRuntime({ modules: [createSessionsModule({ sweepIntervalMs: 0, observerLimits: { requestsPerMinute: 60, requestBurst: 3 } })] });
    const a = t.ingestHeaders('observer');
    const b = t.ingestHeaders('observer');
    const claudeId = randomUUID();
    for (let i = 0; i < 3; i++) expect((await t.request('POST', '/ingest/hook', { headers: a, body: observed(claudeId) })).status).toBe(200);
    const limited = await t.request('POST', '/ingest/hook', { headers: a, body: observed(claudeId) });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('1');
    // the other routes an observer token reaches share the budget; spool items count one each
    expect((await t.request('POST', '/ingest/usage', { headers: a, body: { sessionId: claudeId, idempotencyKey: 'usage-key-x', batches: [] } })).status).toBe(429);
    expect((await t.request('POST', '/ingest/spool', { headers: b, body: { items: [1, 2, 3, 4].map(() => ({ path: '/ingest/hook', body: observed(claudeId), queuedAt: t.clock.iso() })) } })).status).toBe(429);
    expect((await t.request('POST', '/ingest/hook', { headers: b, body: observed(claudeId) })).status).toBe(200);
    t.clock.advance(1000); // one request per second refills
    expect((await t.request('POST', '/ingest/hook', { headers: a, body: observed(claudeId) })).status).toBe(200);
  });

  it('caps the observed sessions one token can create', async () => {
    t = await createTestRuntime({ modules: [createSessionsModule({ sweepIntervalMs: 0, observerLimits: { newSessionsPerHour: 2 } })] });
    const a = t.ingestHeaders('observer');
    const [s1, s2, s3] = [randomUUID(), randomUUID(), randomUUID()];
    expect((await t.request('POST', '/ingest/hook', { headers: a, body: observed(s1) })).status).toBe(200);
    expect((await t.request('POST', '/ingest/hook', { headers: a, body: observed(s2) })).status).toBe(200);
    expect((await t.request('POST', '/ingest/hook', { headers: a, body: observed(s3) })).status).toBe(429);
    // sessions it already has keep reporting
    expect((await t.request('POST', '/ingest/hook', { headers: a, body: observed(s1) })).status).toBe(200);
    expect(t.rt.store.list({ types: ['session.observed'] })).toHaveLength(2);
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
    // … which the sidecar's own flush replays
    expect(await t.json('POST', '/ingest/spool', { headers: sidecar, body: { items: spooled } })).toMatchObject({ accepted: 3, rejected: 0 });
    expect(t.rt.store.list({ types: ['usage.recorded', 'throttle.hit'] })).toHaveLength(2);
    expect(engine().signalsOf('ses_A').processAlive).toBe(false);
    // the session token still relays the hook itself
    expect((await t.request('POST', '/ingest/hook', { headers: t.ingestHeaders('ses_A'), body: tool })).status).toBe(200);
    expect(t.rt.store.list({ types: ['tool.used'] })).toHaveLength(1);
  });
});
