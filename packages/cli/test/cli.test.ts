import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VERSION } from '../src/cli';
import { aoc, loggedInHome } from './helpers/cli';
import { startFakeDaemon, type FakeDaemon } from './helpers/fake-daemon';
import { session, snapshot } from './helpers/fixtures';

describe('usage and exit codes', () => {
  it('--help and --version exit 0 on stdout', async () => {
    const help = await aoc(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: aoc');
    expect(help.stdout).toContain('Exit codes: 0 ok · 1 error · 2 usage · 3 auth');
    const v = await aoc(['-V']);
    expect(v).toMatchObject({ code: 0, stdout: `${VERSION}\n` });
  });

  it('subcommand help lists the global --daemon/--token options', async () => {
    const r = await aoc(['run', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--type <processType>');
    expect(r.stdout).toContain('--daemon <url>');
  });

  it('usage errors exit 2: no command, unknown command, unknown option, bad --daemon', async () => {
    const bare = await aoc([]);
    expect(bare.code).toBe(2);
    expect(bare.stderr).toContain('Usage: aoc');
    const unknown = await aoc(['frobnicate']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unknown command 'frobnicate'");
    expect((await aoc(['status', '--frob'])).code).toBe(2);
    const badUrl = await aoc(['status', '--daemon', 'ftp://x']);
    expect(badUrl.code).toBe(2);
    expect(badUrl.stderr).toContain('daemon URL must be http(s)');
  });

  it('an unreachable daemon is exit 1 with a hint', async () => {
    const r = await aoc(['status', '--daemon', 'http://127.0.0.1:1']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('error: cannot reach the AOC daemon at http://127.0.0.1:1');
    expect(r.stderr).toContain('hint: start it with `aoc serve`');
  });
});

describe('daemon responses', () => {
  let d: FakeDaemon;
  beforeEach(async () => {
    d = await startFakeDaemon();
  });
  afterEach(() => d.stop());

  it('refuses to act with a human identity from inside a managed session (exit 3, nothing sent)', async () => {
    const home = loggedInHome(d.url);
    for (const argv of [['decide', 'dec_1', '--option', 'a'], ['token', 'create'], ['status']]) {
      const r = await aoc(argv, { homeDir: home, env: { AOC_SESSION_ID: 'ses_AGENT' } });
      expect(r.code).toBe(3);
      expect(r.stderr).toContain('refusing to run inside a managed AOC session (AOC_SESSION_ID is set)');
    }
    expect(d.requests).toHaveLength(0);
    expect((await aoc(['--help'], { env: { AOC_SESSION_ID: 'ses_AGENT' } })).code).toBe(0);
  });

  it('a non-JSON success body is an error, not a crash', async () => {
    d.on('GET', '/api/console', { body: '<html>console</html>', contentType: 'text/html' });
    const r = await aoc(['status'], { homeDir: loggedInHome(d.url) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unexpected non-JSON response from GET /api/console');
  });

  it('an unexpected JSON shape is reported', async () => {
    d.on('GET', '/api/sessions', { json: { weird: true } });
    const r = await aoc(['sessions'], { homeDir: loggedInHome(d.url) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unexpected sessions response');
  });

  it('error messages from the daemon are sanitised before printing', async () => {
    d.on('GET', '/api/console', {
      status: 500,
      json: { error: { code: 'internal', message: 'boom\u001b[2J\u001b]0;pwned\u0007' } },
    });
    const r = await aoc(['status'], { homeDir: loggedInHome(d.url) });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('error: boom\n');
  });

  it('untrusted session titles cannot inject terminal escapes into tables', async () => {
    d.on('GET', '/api/console', {
      json: snapshot([session({ title: 'ok\u001b[1A\u001b[2Kspoofed\rline' })]),
    });
    const r = await aoc(['status'], { homeDir: loggedInHome(d.url) });
    expect(r.stdout).toContain('okspoofedline');
    expect(r.stdout).not.toMatch(/[\u001b\r]/);
  });
});
