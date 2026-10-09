import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aoc, loggedInHome, TOKEN } from './helpers/cli';
import { startFakeDaemon, type FakeDaemon } from './helpers/fake-daemon';
import { detail, progress, session, snapshot } from './helpers/fixtures';

let d: FakeDaemon;
let home: string;
beforeEach(async () => {
  d = await startFakeDaemon();
  home = loggedInHome(d.url);
});
afterEach(() => d.stop());

const waiting = session({
  sessionId: 'ses_W',
  title: 'Migrate users',
  phaseName: null,
  phaseId: null,
  lifecycle: 'waiting_decision',
  liveness: { state: 'waiting_on_you', reason: 'open_decision', since: '2026-10-09T09:46:00.000Z' },
  openDecision: { decisionId: 'dec_1', kind: 'agent_decision', createdAt: '2026-10-09T09:46:00.000Z' },
  model: 'claude-sonnet-5-5',
  processType: 'migration',
  progress: progress({ doneTasks: 1, totalTasks: 4 }),
  contextPct: 7,
});

describe('aoc status', () => {
  it('prints the KPI line and one row per session, attention first, liveness as symbol + word', async () => {
    d.on('GET', '/api/console', { json: snapshot([session(), waiting]) });
    const r = await aoc(['status'], { homeDir: home });
    expect(r.code).toBe(0);
    expect(d.calls('GET', '/api/console')[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines[0]).toBe(
      '2 active · 1 waiting on you (oldest 14m) · 0 throttled (0s idle today) · 7 tasks done today (86% with evidence) · notional API-equivalent $12.35 / RM 57.10 today',
    );
    expect(lines[2]).toMatch(/^ID\s+NAME\s+PROJECT·PHASE\s+TYPE\/MODEL\s+LIVENESS\s+TASKS\s+CTX\s+DECISION$/);
    expect(lines[3]).toMatch(
      /^ses_W\s+Migrate users\s+Alpha\s+migration\/sonnet\s+◆ Waiting on you\s+1\/4\s+7%\s+14m$/,
    );
    expect(lines[4]).toMatch(
      /^ses_A\s+Fix login\s+Alpha·Build\s+feature-build\/opus\s+▶ Working\s+3\/8\s+42%\s+—$/,
    );
  });

  it('--json passes the snapshot through', async () => {
    const snap = snapshot([session()]);
    d.on('GET', '/api/console', { json: snap });
    const r = await aoc(['status', '--json'], { homeDir: home });
    expect(JSON.parse(r.stdout)).toEqual(snap);
  });

  it('maps 401 to exit 3 and 403 to exit 3', async () => {
    d.on('GET', '/api/console', {
      status: 401,
      json: { error: { code: 'unauthenticated', message: 'Sign in required' } },
    });
    const r = await aoc(['status'], { homeDir: home });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('not authenticated: Sign in required');
    d.on('GET', '/api/console', {
      status: 403,
      json: { error: { code: 'forbidden', message: 'Missing permission session.view' } },
    });
    expect((await aoc(['status'], { homeDir: home })).code).toBe(3);
  });
});

describe('aoc sessions', () => {
  it('passes --project/--state as query parameters and filters locally too', async () => {
    d.on('GET', '/api/sessions', {
      json: { sessions: [session(), waiting, session({ sessionId: 'ses_X', projectId: 'prj_2' })] },
    });
    const r = await aoc(['sessions', '--project', 'prj_1', '--state', 'waiting'], { homeDir: home });
    expect(r.code).toBe(0);
    expect(d.calls('GET', '/api/sessions')[0]!.query).toEqual({ projectId: 'prj_1', state: 'waiting' });
    expect(r.stdout).toContain('ses_W');
    expect(r.stdout).not.toContain('ses_A');
    expect(r.stdout).not.toContain('ses_X');
    expect(r.stdout).toMatch(
      /ses_W\s+Migrate users\s+Alpha\s+migration\/sonnet\s+waiting_decision\s+◆ Waiting on you\s+1\/4\s+1h ago/,
    );
  });

  it('rejects an unknown --state with exit 2', async () => {
    const r = await aoc(['sessions', '--state', 'sleepy'], { homeDir: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('sleepy');
    expect(d.requests).toHaveLength(0);
  });

  it('active means not ended/failed/retired', async () => {
    d.on('GET', '/api/sessions', {
      json: [session(), session({ sessionId: 'ses_E', lifecycle: 'ended', liveness: null })],
    });
    const r = await aoc(['sessions', '--state', 'active', '--json'], { homeDir: home });
    expect((JSON.parse(r.stdout) as { sessionId: string }[]).map((s) => s.sessionId)).toEqual(['ses_A']);
  });
});

describe('aoc session <id>', () => {
  it('shows the detail block, token table and allowed actions', async () => {
    d.on('GET', '/api/sessions/ses_A', { json: detail() });
    const r = await aoc(['session', 'ses_A'], { homeDir: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Liveness\s+▶ Working — recent_tool, since 2m/);
    expect(r.stdout).toMatch(/Progress\s+\[#####-----\] 45\.0% · 3\/8 tasks/);
    expect(r.stdout).toMatch(/ETA\s+hidden until 3 tasks are done/);
    expect(r.stdout).toMatch(/Context\s+420,000 \/ 1,000,000 tokens \(42%\)/);
    expect(r.stdout).toMatch(/Cost today\s+\$1\.50 notional \(API-equivalent, not a bill\)/);
    expect(r.stdout).toMatch(/claude-opus-5-5\s+1,200\s+300\s+5,000\s+100\s+\$0\.42/);
    expect(r.stdout).toMatch(/restart\s+no — process is running/);
    const consoleLine = r.stdout.split('\n').find((l) => l.startsWith('Console'));
    expect(consoleLine?.replace(/^Console\s+/, '')).toBe(`${d.url}/sessions/ses_A`);
  });

  it('a missing session is exit 1 with the daemon message', async () => {
    d.on('GET', '/api/sessions/ses_none', {
      status: 404,
      json: { error: { code: 'not_found', message: 'Unknown session ses_none' } },
    });
    const r = await aoc(['session', 'ses_none'], { homeDir: home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('error: Unknown session ses_none');
  });

  it('encodes ids as one path segment and rejects dot-segments', async () => {
    await aoc(['session', '../users'], { homeDir: home });
    expect(d.requests[0]!.path).toBe('/api/sessions/..%2Fusers');
    const dots = await aoc(['stop', '..'], { homeDir: home });
    expect(dots.code).toBe(2);
    expect(d.requests).toHaveLength(1);
  });
});

describe('operator actions', () => {
  it('prompt and nudge POST the text', async () => {
    d.on('POST', '/api/sessions/ses_A/prompt', { json: { ok: true } });
    d.on('POST', '/api/sessions/ses_A/nudge', { json: { ok: true } });
    expect((await aoc(['prompt', 'ses_A', 'add', 'tests'], { homeDir: home })).code).toBe(0);
    expect((await aoc(['nudge', 'ses_A', 'wrap up now'], { homeDir: home })).stdout).toContain(
      'Nudged ses_A',
    );
    expect(d.calls('POST', '/api/sessions/ses_A/prompt')[0]!.body).toEqual({ text: 'add tests' });
    expect(d.calls('POST', '/api/sessions/ses_A/nudge')[0]!.body).toEqual({ text: 'wrap up now' });
    expect(d.calls('POST', '/api/sessions/ses_A/nudge')[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('empty text is a usage error', async () => {
    expect((await aoc(['prompt', 'ses_A', '   '], { homeDir: home })).code).toBe(2);
    expect(d.requests).toHaveLength(0);
  });

  it('restart and stop (boundary vs --now)', async () => {
    d.on('POST', '/api/sessions/ses_A/restart', { json: {} });
    d.on('POST', '/api/sessions/ses_A/stop', { json: {} });
    expect((await aoc(['restart', 'ses_A'], { homeDir: home })).code).toBe(0);
    const soft = await aoc(['stop', 'ses_A'], { homeDir: home });
    const hard = await aoc(['stop', 'ses_A', '--now', '--reason', 'wrong branch'], { homeDir: home });
    expect(soft.stdout).toContain('next task boundary');
    expect(hard.stdout).toContain('Stopping ses_A now');
    const stops = d.calls('POST', '/api/sessions/ses_A/stop').map((c) => c.body);
    expect(stops).toEqual([{ immediate: false }, { immediate: true, reason: 'wrong branch' }]);
    expect(d.calls('POST', '/api/sessions/ses_A/restart')[0]!.body).toEqual({});
  });

  it('rollover prints the successor, and a refusal exits 1 with reasons', async () => {
    d.on(
      'POST',
      '/api/threads/thr_1/rollover',
      { json: { newSessionId: 'ses_NEXT' } },
      { json: { refused: ['task t3 is half-done', 'open decision dec_2'] } },
    );
    const ok = await aoc(['rollover', 'thr_1'], { homeDir: home });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('Rolled over thr_1 → ses_NEXT');
    const refused = await aoc(['rollover', 'thr_1'], { homeDir: home });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('rollover of thr_1 refused');
    expect(refused.stderr).toContain('  - task t3 is half-done');
  });
});
