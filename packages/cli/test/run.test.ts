import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aoc, loggedInHome, TOKEN } from './helpers/cli';
import { startFakeDaemon, type FakeDaemon } from './helpers/fake-daemon';
import { detail } from './helpers/fixtures';

// Any process creation anywhere in the CLI's module graph would hit these spies.
const cp = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  exec: vi.fn(),
  execSync: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  fork: vi.fn(),
}));
vi.mock('node:child_process', () => ({ ...cp, default: cp }));

let d: FakeDaemon;
let home: string;
beforeEach(async () => {
  d = await startFakeDaemon();
  home = loggedInHome(d.url);
  d.on('POST', '/api/sessions', { status: 201, json: { sessionId: 'ses_NEW', model: 'claude-opus-5-5' } });
});
afterEach(() => d.stop());

describe('aoc run', () => {
  it('POSTs exactly the LaunchRequest fields and prints the session id + console URL', async () => {
    const r = await aoc(
      [
        'run',
        '--type',
        'feature-build',
        '--project',
        'prj_1',
        '--phase',
        'ph_2',
        '--thread',
        'thr_1',
        '--cwd',
        'sub/dir',
        'fix',
        'the',
        'login',
      ],
      { homeDir: home, cwd: '/work/repo' },
    );
    expect(r.code).toBe(0);
    const [req] = d.calls('POST', '/api/sessions');
    expect(req!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req!.headers['content-type']).toBe('application/json');
    expect(req!.body).toEqual({
      processType: 'feature-build',
      projectId: 'prj_1',
      phaseId: 'ph_2',
      threadId: 'thr_1',
      cwd: '/work/repo/sub/dir',
      prompt: 'fix the login',
    });
    expect(r.stdout).toContain('Launched ses_NEW (feature-build on claude-opus-5-5, project prj_1)');
    expect(r.stdout).toContain(`Console: ${d.url}/sessions/ses_NEW`);
  });

  it('sends nulls for omitted optional fields and never forwards the shell environment', async () => {
    const env = {
      AOC_TOKEN: TOKEN,
      AOC_DAEMON_URL: d.url,
      GITHUB_TOKEN: 'ghp_secret',
      AWS_SECRET_ACCESS_KEY: 'aws_secret',
    };
    const r = await aoc(['run', '--type', 'discovery', '--project', 'prj_1', 'go'], { env });
    expect(r.code).toBe(0);
    const [req] = d.calls('POST', '/api/sessions');
    expect(req!.body).toEqual({
      processType: 'discovery',
      projectId: 'prj_1',
      phaseId: null,
      threadId: null,
      cwd: null,
      prompt: 'go',
    });
    expect(JSON.stringify(req)).not.toMatch(/ghp_secret|aws_secret/);
  });

  it('reads the prompt from stdin with "-"', async () => {
    const r = await aoc(['run', '--type', 'discovery', '--project', 'prj_1', '-'], {
      homeDir: home,
      readStdin: async () => 'long prompt\nfrom a file\n',
    });
    expect(r.code).toBe(0);
    expect((d.calls('POST', '/api/sessions')[0]!.body as { prompt: string }).prompt).toBe(
      'long prompt\nfrom a file',
    );
  });

  it('exits 2 on missing --type or prompt, without calling the daemon', async () => {
    expect((await aoc(['run', '--project', 'prj_1', 'x'], { homeDir: home })).code).toBe(2);
    expect((await aoc(['run', '--type', 'discovery', '--project', 'prj_1'], { homeDir: home })).code).toBe(2);
    expect(d.requests).toHaveLength(0);
  });

  it('prints validation details from the daemon and exits 1', async () => {
    d.on('POST', '/api/sessions', {
      status: 422,
      json: {
        error: {
          code: 'invalid',
          message: 'Validation failed',
          details: [{ path: 'processType', message: 'unknown process type "nope"' }],
        },
      },
    });
    const r = await aoc(['run', '--type', 'nope', '--project', 'prj_1', 'x'], { homeDir: home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('error: Validation failed');
    expect(r.stderr).toContain('  - processType: unknown process type "nope"');
  });

  it('--json prints the launch result with the console URL', async () => {
    const r = await aoc(['run', '--json', '--type', 'discovery', '--project', 'prj_1', 'x'], {
      homeDir: home,
    });
    expect(JSON.parse(r.stdout)).toMatchObject({
      sessionId: 'ses_NEW',
      consoleUrl: `${d.url}/sessions/ses_NEW`,
    });
  });
});

describe('aoc run --follow', () => {
  const working = detail({ sessionId: 'ses_NEW' });
  const thinking = detail({
    sessionId: 'ses_NEW',
    liveness: { state: 'thinking', reason: 'streaming', since: '2026-10-09T09:59:00.000Z' },
  });
  const waiting = detail({
    sessionId: 'ses_NEW',
    lifecycle: 'waiting_decision',
    liveness: { state: 'waiting_on_you', reason: 'open_decision', since: '2026-10-09T10:00:00.000Z' },
    openDecision: { decisionId: 'dec_9', kind: 'agent_decision', createdAt: '2026-10-09T10:00:00.000Z' },
  });
  const out1 = { at: '2026-10-09T09:59:01.000Z', kind: 'assistant_text', text: 'Reading the code\u001b[2J' };
  const out2 = { at: '2026-10-09T09:59:02.000Z', kind: 'tool_use', toolName: 'Read', text: 'src/login.ts' };
  const out3 = { at: '2026-10-09T09:59:03.000Z', kind: 'assistant_text', text: 'Need a decision.' };

  it('polls session + output until it waits on you, printing liveness as symbol + word and each item once', async () => {
    d.on('GET', '/api/sessions/ses_NEW', { json: thinking }, { json: working }, { json: waiting });
    d.on(
      'GET',
      '/api/sessions/ses_NEW/output',
      { json: [out1] },
      { json: { items: [out1, out2] } },
      { json: [out1, out2, out3] },
    );
    const sleeps: number[] = [];
    const r = await aoc(['run', '--follow', '--type', 'discovery', '--project', 'prj_1', 'go'], {
      homeDir: home,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(r.code).toBe(0);
    expect(d.calls('GET', '/api/sessions/ses_NEW')).toHaveLength(3);
    expect(sleeps).toEqual([2000, 2000]);
    const out = r.stdout;
    expect(out.match(/Reading the code/g)).toHaveLength(1);
    expect(out).not.toContain('\u001b');
    expect(out).toContain('  → Read src/login.ts');
    expect(out).toContain('── ◌ Thinking (streaming)');
    expect(out).toContain('── ▶ Working (recent_tool)');
    expect(out).toContain('── ◆ Waiting on you (open_decision)');
    expect(out).toContain('aoc decide dec_9 --option <optionId>');
    expect(out.indexOf('Reading the code')).toBeLessThan(out.indexOf('Need a decision.'));
  });

  it('exits 1 when the session fails or dies, with a restart hint', async () => {
    d.on('GET', '/api/sessions/ses_NEW', {
      json: detail({
        sessionId: 'ses_NEW',
        lifecycle: 'failed',
        liveness: { state: 'dead', reason: 'process_failed', since: '' },
      }),
    });
    d.on('GET', '/api/sessions/ses_NEW/output', { json: [] });
    const r = await aoc(['run', '--follow', '--type', 'discovery', '--project', 'prj_1', 'go'], {
      homeDir: home,
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('── ✕ Dead (process_failed)');
    expect(r.stdout).toContain('aoc restart ses_NEW');
  });

  it('stops at throttled and at ended with exit 0', async () => {
    d.on('GET', '/api/sessions/ses_NEW', {
      json: detail({
        sessionId: 'ses_NEW',
        lifecycle: 'throttled',
        liveness: { state: 'throttled', reason: 'plan_limit', since: '' },
        throttledUntil: '2026-10-09T12:00:00Z',
      }),
    });
    d.on('GET', '/api/sessions/ses_NEW/output', { json: [] });
    const t = await aoc(['run', '--follow', '--type', 'discovery', '--project', 'prj_1', 'go'], {
      homeDir: home,
    });
    expect(t.code).toBe(0);
    expect(t.stdout).toContain('‖ Throttled');
    expect(t.stdout).toContain('until 2026-10-09T12:00:00Z');

    d.on('GET', '/api/sessions/ses_NEW', {
      json: detail({ sessionId: 'ses_NEW', lifecycle: 'ended', liveness: null }),
    });
    const e = await aoc(['run', '--follow', '--type', 'discovery', '--project', 'prj_1', 'go'], {
      homeDir: home,
    });
    expect(e.code).toBe(0);
    expect(e.stdout).toContain('── ○ Ended');
  });

  it('--follow --json emits NDJSON events', async () => {
    d.on('GET', '/api/sessions/ses_NEW', { json: waiting });
    d.on('GET', '/api/sessions/ses_NEW/output', { json: [out3] });
    const r = await aoc(['run', '--follow', '--json', '--type', 'discovery', '--project', 'prj_1', 'go'], {
      homeDir: home,
    });
    const events = r.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { event: string });
    expect(events.map((e) => e.event)).toEqual(['launched', 'output', 'state', 'end']);
    expect(events[3]).toMatchObject({ outcome: 'waiting_on_you', exitCode: 0 });
  });

  it('never spawns a process — not claude, not anything (credential isolation)', async () => {
    d.on('GET', '/api/sessions/ses_NEW', { json: waiting });
    d.on('GET', '/api/sessions/ses_NEW/output', { json: [] });
    const r = await aoc(['run', '--follow', '--type', 'discovery', '--project', 'prj_1', 'go'], {
      homeDir: home,
    });
    expect(r.code).toBe(0);
    expect(r.deps.spawn).not.toHaveBeenCalled();
    expect(r.deps.git).not.toHaveBeenCalled();
    for (const fn of Object.values(cp)) expect(fn).not.toHaveBeenCalled();
  });
});

/** Value (non-type) relative imports + bare specifiers of a TS module. */
function imports(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const specs: string[] = [];
  for (const m of src.matchAll(/^(import|export)\s+(type\s+)?[^;]*?\sfrom\s+'([^']+)'/gm))
    if (!m[2]) specs.push(m[3]!);
  for (const m of src.matchAll(/^import\s+'([^']+)'/gm)) specs.push(m[1]!);
  for (const m of src.matchAll(/import\(\s*'([^']+)'\s*\)/g)) specs.push(m[1]!);
  return specs;
}

function moduleGraph(entry: string): { files: Set<string>; external: Set<string> } {
  const files = new Set<string>();
  const external = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of imports(file)) {
      if (!spec.startsWith('.')) {
        external.add(spec);
        continue;
      }
      const base = resolve(dirname(file), spec);
      const target = [`${base}.ts`, join(base, 'index.ts')].find((p) => existsSync(p));
      if (target) queue.push(target);
    }
  }
  return { files, external };
}

describe('run never reaches process creation (static)', () => {
  it('the run command module graph imports neither child_process nor the process-spawning deps', () => {
    const { files, external } = moduleGraph(resolve(__dirname, '../src/commands/run.ts'));
    expect(files.size).toBeGreaterThan(3);
    expect([...external].filter((s) => /child_process/.test(s))).toEqual([]);
    expect([...files].map((f) => f.replace(/.*\/src\//, 'src/'))).not.toContain('src/deps.ts');
  });
});
