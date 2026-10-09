import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_SESSION,
  OBSERVER_TOKEN,
  assistantMessage,
  deadUrl,
  postToolUse,
  preToolUse,
  readSpool,
  runHookBinary,
  startFakeDaemon,
  stop,
  subagentStop,
  tmp,
  userLine,
  userPromptSubmit,
  writeClientConfig,
  type FakeDaemon,
  type Recorded,
  type Reply,
} from './helpers';

let daemon: FakeDaemon | null = null;
afterEach(async () => {
  await daemon?.close();
  daemon = null;
});

/** A daemon that accepts hooks, usage and spool replays. */
const accepting = (r: Recorded): Reply =>
  r.path === '/ingest/spool'
    ? { status: 200, json: { accepted: r.body.items.length, duplicates: 0, rejected: 0 } }
    : { status: 200, json: { exitCode: 0 } };

const usageRequests = (d: FakeDaemon) => d.requests.filter((r) => r.path === '/ingest/usage');

describe('observed mode: report-only, never blocks', () => {
  it('stays silent and touches nothing without ~/.aoc/client.json', async () => {
    const home = tmp();
    const run = await runHookBinary('PreToolUse', preToolUse(), { HOME: home });
    expect(run).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(existsSync(join(home, '.aoc'))).toBe(false);
  });

  it('never blocks or prints a decision, even when the daemon says deny', async () => {
    daemon = await startFakeDaemon(() => ({
      status: 200,
      json: {
        exitCode: 2,
        stderr: 'denied',
        stdout: {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'no',
          },
        },
      },
    }));
    const run = await runHookBinary('PreToolUse', preToolUse(), {
      HOME: writeClientConfig(tmp(), daemon.url),
    });
    expect(run).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(daemon.requests).toHaveLength(1);
    expect(daemon.requests[0]!.path).toBe('/ingest/hook');
    expect(daemon.requests[0]!.headers.authorization).toBe(`Bearer ${OBSERVER_TOKEN}`);
    expect(daemon.requests[0]!.body).toMatchObject({
      mode: 'observed',
      aocSessionId: null,
      hook: preToolUse(),
    });
  });

  it('reads the client config from AOC_CLIENT_CONFIG when set', async () => {
    daemon = await startFakeDaemon();
    const cfgDir = tmp();
    const cfg = join(cfgDir, 'elsewhere.json');
    writeFileSync(cfg, JSON.stringify({ daemonUrl: daemon.url, observerToken: 'other-token' }));
    const run = await runHookBinary('UserPromptSubmit', userPromptSubmit(), {
      HOME: tmp(),
      AOC_CLIENT_CONFIG: cfg,
    });
    expect(run).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(daemon.requests[0]!.headers.authorization).toBe('Bearer other-token');
  });

  it('stands down inside a managed session, where the managed registration relays', async () => {
    daemon = await startFakeDaemon();
    const home = writeClientConfig(tmp(), daemon.url);
    const run = await runHookBinary('PreToolUse', preToolUse(), {
      HOME: home,
      AOC_HOOK_SCOPE: 'observed',
      AOC_MODE: 'managed',
      AOC_SESSION_ID: 'ses_X',
      AOC_DAEMON_URL: daemon.url,
    });
    expect(run).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(daemon.requests).toHaveLength(0);
  });

  it('buffers locally while the daemon is down, then replays the spool after the next successful call', async () => {
    const home = writeClientConfig(tmp(), await deadUrl());
    const spoolDir = join(home, '.aoc', 'spool', 'observed');
    const down = await runHookBinary('PostToolUse', postToolUse(), { HOME: home });
    expect(down).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(readSpool(spoolDir)).toHaveLength(1);
    expect(readSpool(spoolDir)[0]).toMatchObject({
      path: '/ingest/hook',
      body: { mode: 'observed', hook: postToolUse() },
    });

    daemon = await startFakeDaemon(accepting);
    writeClientConfig(home, daemon.url);
    const up = await runHookBinary('UserPromptSubmit', userPromptSubmit(), { HOME: home });
    expect(up).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(daemon.requests.map((r) => r.path)).toEqual(['/ingest/hook', '/ingest/spool']);
    expect(daemon.requests[1]!.body.items).toHaveLength(1);
    expect(daemon.requests[1]!.body.items[0]).toMatchObject({
      path: '/ingest/hook',
      body: { hook: { hook_event_name: 'PostToolUse' } },
    });
    expect(readSpool(spoolDir)).toEqual([]);
  });

  it('never replays spool-rejected.jsonl, which is kept for inspection', async () => {
    daemon = await startFakeDaemon(accepting);
    const home = writeClientConfig(tmp(), daemon.url);
    const spoolDir = join(home, '.aoc', 'spool', 'observed');
    mkdirSync(spoolDir, { recursive: true });
    const rejected = JSON.stringify({
      path: '/ingest/usage',
      body: {},
      queuedAt: 'x',
      reason: 'rejected_by_daemon',
    });
    writeFileSync(join(spoolDir, 'spool-rejected.jsonl'), `${rejected}\n`);
    await runHookBinary('UserPromptSubmit', userPromptSubmit(), { HOME: home });
    expect(daemon.requests.map((r) => r.path)).toEqual(['/ingest/hook']);
    expect(readFileSync(join(spoolDir, 'spool-rejected.jsonl'), 'utf8')).toBe(`${rejected}\n`);
  });
});

describe('observed mode: transcript usage', () => {
  function transcriptIn(home: string): string {
    const dir = join(home, '.claude', 'projects', '-work-repo');
    mkdirSync(dir, { recursive: true });
    return join(dir, `${CLAUDE_SESSION}.jsonl`);
  }

  it('sends deduped usage on Stop and only new messages afterwards', async () => {
    daemon = await startFakeDaemon(accepting);
    const home = writeClientConfig(tmp(), daemon.url);
    const transcript = transcriptIn(home);
    writeFileSync(
      transcript,
      [
        userLine('Fix the parser', '2026-10-09T01:00:00.000Z'),
        // one API response written as three content-block lines: counted once
        ...assistantMessage(
          'msg_A',
          'claude-opus-5-5',
          { input: 10, output: 50, cacheRead: 100, cacheWrite: 30, split: { m5: 0, h1: 30 } },
          '2026-10-09T01:00:01.000Z',
          3,
        ),
        userLine('tool result', '2026-10-09T01:00:02.000Z'),
        ...assistantMessage(
          'msg_B',
          'claude-opus-5-5',
          { input: 5, output: 20, cacheRead: 200, cacheWrite: 10 },
          '2026-10-09T01:00:03.000Z',
          2,
        ),
        ...assistantMessage('msg_C', 'claude-haiku-5-5', { input: 1, output: 2 }, '2026-10-09T01:00:04.000Z'),
        ...assistantMessage('msg_S', '<synthetic>', {}, '2026-10-09T01:00:05.000Z'),
        JSON.stringify({
          type: 'system',
          subtype: 'stop_hook_summary',
          timestamp: '2026-10-09T01:00:06.000Z',
        }),
      ].join('\n') + '\n',
    );

    const first = await runHookBinary('Stop', stop(transcript), { HOME: home });
    expect(first).toMatchObject({ code: 0, stdout: '', stderr: '' });
    const [usage] = usageRequests(daemon);
    expect(usage!.headers.authorization).toBe(`Bearer ${OBSERVER_TOKEN}`);
    expect(Object.keys(usage!.body).sort()).toEqual(['batches', 'idempotencyKey', 'sessionId']);
    expect(usage!.body.sessionId).toBe(CLAUDE_SESSION);
    expect(usage!.body.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    // contextTokens is the session's latest main-chain message (msg_C), the same for every batch of one read.
    expect(usage!.body.batches).toEqual([
      {
        model: 'claude-opus-5-5',
        inputTokens: 15,
        outputTokens: 70,
        cacheReadTokens: 300,
        cacheWrite5mTokens: 10,
        cacheWrite1hTokens: 30,
        messageIds: ['msg_A', 'msg_B'],
        firstAt: '2026-10-09T01:00:01.000Z',
        lastAt: '2026-10-09T01:00:03.000Z',
        contextTokens: 1,
      },
      {
        model: 'claude-haiku-5-5',
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        messageIds: ['msg_C'],
        firstAt: '2026-10-09T01:00:04.000Z',
        lastAt: '2026-10-09T01:00:04.000Z',
        contextTokens: 1,
      },
    ]);
    const state = JSON.parse(readFileSync(join(home, '.aoc', 'state', `${CLAUDE_SESSION}.json`), 'utf8'));
    expect(state.offset).toBe(readFileSync(transcript).length);

    // Nothing new: the hook event still goes out, no usage request.
    await runHookBinary('Stop', stop(transcript), { HOME: home });
    expect(usageRequests(daemon)).toHaveLength(1);

    // A new message, plus the first line of one still being written (no trailing newline yet).
    const [d1, d2] = assistantMessage(
      'msg_D',
      'claude-opus-5-5',
      { input: 7, output: 3 },
      '2026-10-09T01:01:00.000Z',
      2,
    );
    const [e1] = assistantMessage(
      'msg_E',
      'claude-opus-5-5',
      { input: 9, output: 4 },
      '2026-10-09T01:02:00.000Z',
    );
    appendFileSync(transcript, `${d1}\n${d2}\n${e1}`);
    await runHookBinary('Stop', stop(transcript), { HOME: home });
    expect(usageRequests(daemon)).toHaveLength(2);
    expect(usageRequests(daemon)[1]!.body.batches).toMatchObject([
      { model: 'claude-opus-5-5', inputTokens: 7, outputTokens: 3, messageIds: ['msg_D'] },
    ]);

    appendFileSync(transcript, '\n');
    await runHookBinary(
      'SessionEnd',
      { ...stop(transcript), hook_event_name: 'SessionEnd', reason: 'other' },
      { HOME: home },
    );
    const usages = usageRequests(daemon);
    expect(usages).toHaveLength(3);
    expect(usages[2]!.body.batches).toMatchObject([
      { inputTokens: 9, outputTokens: 4, messageIds: ['msg_E'] },
    ]);
    expect(new Set(usages.map((u) => u.body.idempotencyKey)).size).toBe(3);
  });

  it('also reports usage when the turn ends on an API error (StopFailure)', async () => {
    daemon = await startFakeDaemon(accepting);
    const home = writeClientConfig(tmp(), daemon.url);
    const transcript = transcriptIn(home);
    writeFileSync(
      transcript,
      assistantMessage('msg_A', 'claude-opus-5-5', { input: 3, output: 4 }, '2026-10-09T01:00:00.000Z').join(
        '\n',
      ) + '\n',
    );
    const run = await runHookBinary(
      'StopFailure',
      { ...stop(transcript), hook_event_name: 'StopFailure', error: 'rate_limit' },
      { HOME: home },
    );
    expect(run).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(daemon.requests[0]!.body.hook).toMatchObject({
      hook_event_name: 'StopFailure',
      error: 'rate_limit',
    });
    expect(usageRequests(daemon)[0]!.body.batches).toMatchObject([{ messageIds: ['msg_A'] }]);
  });

  it('reads subagent usage from agent_transcript_path on SubagentStop', async () => {
    daemon = await startFakeDaemon(accepting);
    const home = writeClientConfig(tmp(), daemon.url);
    const transcript = transcriptIn(home);
    writeFileSync(
      transcript,
      assistantMessage(
        'msg_MAIN',
        'claude-opus-5-5',
        { input: 1, output: 1 },
        '2026-10-09T01:00:00.000Z',
      ).join('\n') + '\n',
    );
    const agentDir = join(transcript.replace(/\.jsonl$/, ''), 'subagents');
    mkdirSync(agentDir, { recursive: true });
    const agentTranscript = join(agentDir, 'agent-a3e0385ed503597cc.jsonl');
    writeFileSync(
      agentTranscript,
      assistantMessage(
        'msg_SUB',
        'claude-sonnet-5',
        { input: 40, output: 8 },
        '2026-10-09T01:00:02.000Z',
        2,
      ).join('\n') + '\n',
    );

    const run = await runHookBinary('SubagentStop', subagentStop(transcript, agentTranscript), {
      HOME: home,
    });
    expect(run).toMatchObject({ code: 0, stdout: '', stderr: '' });
    const [usage] = usageRequests(daemon);
    expect(usage!.body.sessionId).toBe(CLAUDE_SESSION);
    expect(usage!.body.batches).toMatchObject([
      { model: 'claude-sonnet-5', inputTokens: 40, outputTokens: 8, messageIds: ['msg_SUB'] },
    ]);
    expect(existsSync(join(home, '.aoc', 'state', `${CLAUDE_SESSION}.agent-a3e0385ed503597cc.json`))).toBe(
      true,
    );

    // The main transcript has its own cursor: Stop still reports the main message.
    await runHookBinary('Stop', stop(transcript), { HOME: home });
    expect(usageRequests(daemon)[1]!.body.batches).toMatchObject([{ messageIds: ['msg_MAIN'] }]);
  });

  it('spools usage alongside the hook event while the daemon is down, then replays both', async () => {
    const home = writeClientConfig(tmp(), await deadUrl());
    const transcript = transcriptIn(home);
    writeFileSync(
      transcript,
      assistantMessage('msg_A', 'claude-opus-5-5', { input: 3, output: 4 }, '2026-10-09T01:00:00.000Z').join(
        '\n',
      ) + '\n',
    );
    const down = await runHookBinary('Stop', stop(transcript), { HOME: home });
    expect(down).toMatchObject({ code: 0, stdout: '', stderr: '' });
    const spooled = readSpool(join(home, '.aoc', 'spool', 'observed'));
    expect(spooled.map((i) => i.path).sort()).toEqual(['/ingest/hook', '/ingest/usage']);
    expect(spooled.find((i) => i.path === '/ingest/usage')!.body).toMatchObject({
      sessionId: CLAUDE_SESSION,
      batches: [{ messageIds: ['msg_A'] }],
    });

    daemon = await startFakeDaemon(accepting);
    writeClientConfig(home, daemon.url);
    await runHookBinary('Stop', stop(transcript), { HOME: home });
    // The cursor advanced when usage was spooled, so the live Stop sends no usage of its own.
    expect(daemon.requests.map((r) => r.path)).toEqual(['/ingest/hook', '/ingest/spool']);
    expect(daemon.requests[1]!.body.items.map((i: { path: string }) => i.path).sort()).toEqual([
      '/ingest/hook',
      '/ingest/usage',
    ]);
  });
});
