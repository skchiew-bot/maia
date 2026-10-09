import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AOC_SESSION,
  MANAGED_TOKEN,
  deadUrl,
  managedEnv,
  postToolUse,
  preToolUse,
  readSpool,
  runHookBinary,
  startFakeDaemon,
  stop,
  tmp,
  type FakeDaemon,
} from './helpers';

const FAIL_CLOSED =
  'AOC daemon unreachable — managed sessions fail closed (AOC-SPEC-003 §2). Ask the operator.';

let daemon: FakeDaemon | null = null;
afterEach(async () => {
  await daemon?.close();
  daemon = null;
});

describe('managed mode: the daemon decides, the hook relays', () => {
  it('relays a PreToolUse deny (stdout JSON + exit code) and sends a HookIngestRequest', async () => {
    const deny = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Pushing to main needs an approved promotion.',
      },
    };
    daemon = await startFakeDaemon(() => ({ status: 200, json: { exitCode: 0, stdout: deny } }));
    const run = await runHookBinary('PreToolUse', preToolUse(), managedEnv(tmp(), daemon.url));

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(deny);
    expect(run.stderr).toBe('');
    expect(daemon.requests).toHaveLength(1);
    const [req] = daemon.requests;
    expect(req!.method).toBe('POST');
    expect(req!.path).toBe('/ingest/hook');
    expect(req!.headers.authorization).toBe(`Bearer ${MANAGED_TOKEN}`);
    expect(req!.body).toMatchObject({ mode: 'managed', aocSessionId: AOC_SESSION, hook: preToolUse() });
    expect(req!.body.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isNaN(Date.parse(req!.body.sentAt))).toBe(false);
  });

  it('relays as usual when AOC_INTERNAL_LLM is set (it only silences observed hooks)', async () => {
    daemon = await startFakeDaemon(() => ({ status: 200, json: { exitCode: 2, stderr: 'no' } }));
    const run = await runHookBinary(
      'PreToolUse',
      preToolUse(),
      managedEnv(tmp(), daemon.url, { AOC_INTERNAL_LLM: '1' }),
    );
    expect(run).toMatchObject({ code: 2, stderr: 'no' });
    expect(daemon.requests.map((r) => r.body.mode)).toEqual(['managed']);
  });

  it('relays decisions the contract types do not know yet (permissionDecision "defer") verbatim', async () => {
    const defer = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'defer',
        permissionDecisionReason: 'Awaiting the CEO.',
      },
    };
    daemon = await startFakeDaemon(() => ({ status: 200, json: { exitCode: 0, stdout: defer } }));
    const run = await runHookBinary('PreToolUse', preToolUse(), managedEnv(tmp(), daemon.url));
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(defer);
  });

  it('relays a blocking exit 2 with its stderr verbatim', async () => {
    daemon = await startFakeDaemon(() => ({
      status: 200,
      json: { exitCode: 2, stderr: 'Blocked by AOC: declare a plan first.' },
    }));
    const run = await runHookBinary('PreToolUse', preToolUse(), managedEnv(tmp(), daemon.url));
    expect(run).toMatchObject({ code: 2, stdout: '', stderr: 'Blocked by AOC: declare a plan first.' });
  });

  it('keys tool events on tool_use_id: a repeated check reuses its key, PostToolUse gets its own', async () => {
    daemon = await startFakeDaemon();
    const home = tmp();
    await runHookBinary('PreToolUse', preToolUse('toolu_A'), managedEnv(home, daemon.url));
    await runHookBinary('PreToolUse', preToolUse('toolu_A'), managedEnv(home, daemon.url));
    await runHookBinary('PostToolUse', postToolUse('toolu_A'), managedEnv(home, daemon.url));
    await runHookBinary('PreToolUse', preToolUse('toolu_B'), managedEnv(home, daemon.url));
    const [pre1, pre2, post, other] = daemon.requests.map((r) => r.body.idempotencyKey as string);
    expect(pre2).toBe(pre1);
    expect(new Set([pre1, post, other]).size).toBe(3);
  });

  it('fails closed on PreToolUse when the daemon is unreachable (and does not spool the check)', async () => {
    const home = tmp();
    const run = await runHookBinary('PreToolUse', preToolUse(), managedEnv(home, await deadUrl()));
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(FAIL_CLOSED);
    expect(run.stdout).toBe('');
    expect(readSpool(join(home, '.aoc', 'spool', 'managed', AOC_SESSION))).toEqual([]);
  });

  it('fails closed on PreToolUse on a 5xx', async () => {
    daemon = await startFakeDaemon(() => ({ status: 503, json: { error: { message: 'store busy' } } }));
    const run = await runHookBinary('PreToolUse', preToolUse(), managedEnv(tmp(), daemon.url));
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(FAIL_CLOSED);
    expect(run.stderr).toContain('store busy');
  });

  it('fails closed on PreToolUse when the daemon does not answer within 2.5 s', async () => {
    daemon = await startFakeDaemon(() => 'hang');
    const run = await runHookBinary('PreToolUse', preToolUse(), managedEnv(tmp(), daemon.url));
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(FAIL_CLOSED);
    expect(run.stderr).toContain('timeout after 2500 ms');
    expect(run.ms).toBeLessThan(6000);
  });

  it('spools other events when the daemon is down and warns with a systemMessage (exit 0)', async () => {
    const home = tmp();
    const spoolDir = join(home, 'custom-spool');
    const run = await runHookBinary(
      'PostToolUse',
      postToolUse(),
      managedEnv(home, await deadUrl(), { AOC_SPOOL_DIR: spoolDir }),
    );
    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(JSON.parse(run.stdout).systemMessage).toMatch(
      /^AOC daemon unreachable .*the PostToolUse event was spooled to /,
    );
    const items = readSpool(spoolDir);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      path: '/ingest/hook',
      body: { mode: 'managed', aocSessionId: AOC_SESSION, hook: postToolUse() },
    });
  });

  it('replays the spool (default ~/.aoc/spool/managed/<session>) after the next successful non-PreToolUse call', async () => {
    const home = tmp();
    const down = await runHookBinary('PostToolUse', postToolUse(), managedEnv(home, await deadUrl()));
    expect(down.code).toBe(0);
    const spoolDir = join(home, '.aoc', 'spool', 'managed', AOC_SESSION);
    expect(readSpool(spoolDir)).toHaveLength(1);

    daemon = await startFakeDaemon((r) =>
      r.path === '/ingest/spool'
        ? { status: 200, json: { accepted: r.body.items.length, duplicates: 0, rejected: 0 } }
        : { status: 200, json: { exitCode: 0 } },
    );
    const up = await runHookBinary('Stop', stop('/tmp/none.jsonl'), managedEnv(home, daemon.url));
    expect(up).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(daemon.requests.map((r) => r.path)).toEqual(['/ingest/hook', '/ingest/spool']);
    expect(daemon.requests[1]!.headers.authorization).toBe(`Bearer ${MANAGED_TOKEN}`);
    expect(daemon.requests[1]!.body.items).toHaveLength(1);
    expect(daemon.requests[1]!.body.items[0]).toMatchObject({
      path: '/ingest/hook',
      body: { hook: { hook_event_name: 'PostToolUse' } },
    });
    expect(readSpool(spoolDir)).toEqual([]);
  });

  it('keeps each session in its own default spool: a replay never carries another session’s events', async () => {
    // A replay is authorised by one session's token; the daemon rejects any other session's items and the
    // client then drops them, so two managed sessions under one HOME must not share a spool.
    const home = tmp();
    const other = 'ses_01JOTHER000000000000000000';
    const dead = await deadUrl();
    await runHookBinary('PostToolUse', postToolUse('toolu_A'), managedEnv(home, dead));
    await runHookBinary('PostToolUse', postToolUse('toolu_B'), managedEnv(home, dead, { AOC_SESSION_ID: other }));
    expect(readSpool(join(home, '.aoc', 'spool', 'managed', AOC_SESSION))).toHaveLength(1);
    expect(readSpool(join(home, '.aoc', 'spool', 'managed', other))).toHaveLength(1);

    daemon = await startFakeDaemon((r) =>
      r.path === '/ingest/spool'
        ? { status: 200, json: { accepted: r.body.items.length, duplicates: 0, rejected: 0 } }
        : { status: 200, json: { exitCode: 0 } },
    );
    await runHookBinary('Stop', stop('/tmp/none.jsonl'), managedEnv(home, daemon.url));
    const replayed = daemon.requests.filter((r) => r.path === '/ingest/spool').flatMap((r) => r.body.items);
    expect(replayed.map((i: { body: { aocSessionId: string } }) => i.body.aocSessionId)).toEqual([AOC_SESSION]);
    expect(readSpool(join(home, '.aoc', 'spool', 'managed', other))).toHaveLength(1);
  });

  it('fails closed when the daemon rejects the call; other events warn without spooling', async () => {
    daemon = await startFakeDaemon(() => ({ status: 401, json: { error: { message: 'bad ingest token' } } }));
    const home = tmp();
    const pre = await runHookBinary('PreToolUse', preToolUse(), managedEnv(home, daemon.url));
    expect(pre.code).toBe(2);
    expect(pre.stderr).toContain(
      'AOC daemon rejected the PreToolUse hook (HTTP 401) — managed sessions fail closed',
    );
    expect(pre.stderr).toContain('bad ingest token');

    const post = await runHookBinary('PostToolUse', postToolUse(), managedEnv(home, daemon.url));
    expect(post.code).toBe(0);
    expect(JSON.parse(post.stdout).systemMessage).toMatch(
      /rejected the PostToolUse hook \(HTTP 401\).*not recorded/,
    );
    expect(readSpool(join(home, '.aoc', 'spool', 'managed', AOC_SESSION))).toEqual([]);
  });

  it('fails closed on a response it cannot interpret', async () => {
    daemon = await startFakeDaemon(() => ({ status: 200, json: { exitCode: 1 } }));
    const run = await runHookBinary('PreToolUse', preToolUse(), managedEnv(tmp(), daemon.url));
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(
      'AOC daemon returned an invalid hook response — managed sessions fail closed',
    );
  });

  it('fails closed when the managed env is incomplete instead of degrading to observed', async () => {
    daemon = await startFakeDaemon();
    const home = tmp();
    const noSession = await runHookBinary('PreToolUse', preToolUse(), {
      HOME: home,
      AOC_MODE: 'managed',
      AOC_DAEMON_URL: daemon.url,
    });
    expect(noSession.code).toBe(2);
    expect(noSession.stderr).toContain('AOC managed session is misconfigured — managed sessions fail closed');
    expect(noSession.stderr).toContain('AOC_SESSION_ID is not set');
    expect(daemon.requests).toHaveLength(0);

    const noUrl = await runHookBinary('PreToolUse', preToolUse(), {
      HOME: home,
      AOC_MODE: 'managed',
      AOC_SESSION_ID: AOC_SESSION,
    });
    expect(noUrl.code).toBe(2);
    expect(noUrl.stderr).toContain(FAIL_CLOSED);
    expect(noUrl.stderr).toContain('AOC_DAEMON_URL is not set');
  });

  it('fails closed on unreadable hook input', async () => {
    daemon = await startFakeDaemon();
    const run = await runHookBinary('PreToolUse', '{not json', managedEnv(tmp(), daemon.url));
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('AOC hook could not read its input — managed sessions fail closed');
    expect(daemon.requests).toHaveLength(0);
  });
});
