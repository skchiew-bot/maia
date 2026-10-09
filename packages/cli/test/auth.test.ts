import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DAEMON_URL, resolveTarget } from '../src/config';
import { aoc, loggedInHome, tempDir, TOKEN, writeClientConfig } from './helpers/cli';
import { startFakeDaemon, type FakeDaemon } from './helpers/fake-daemon';
import { user } from './helpers/fixtures';

let d: FakeDaemon;
beforeEach(async () => {
  d = await startFakeDaemon();
  d.on('GET', '/api/auth/me', (req) =>
    req.headers.authorization === `Bearer ${TOKEN}`
      ? { json: { user: user(), tokenId: 'tok_1', method: 'bearer' } }
      : { status: 401, json: { error: { code: 'unauthenticated', message: 'Sign in required' } } },
  );
});
afterEach(() => d.stop());

const readConfig = (home: string) =>
  JSON.parse(readFileSync(join(home, '.aoc', 'client.json'), 'utf8')) as Record<string, string>;

describe('resolveTarget', () => {
  const file = { daemonUrl: 'http://file:1', token: 'f' };
  it('prefers flag > env > config > default', () => {
    expect(
      resolveTarget({
        flagDaemon: 'http://flag:1',
        flagToken: 'x',
        env: { AOC_DAEMON_URL: 'http://env:1', AOC_TOKEN: 'e' },
        file,
      }),
    ).toMatchObject({
      daemonUrl: 'http://flag:1',
      token: 'x',
      daemonSource: 'flag',
      tokenSource: 'flag',
    });
    expect(resolveTarget({ env: { AOC_DAEMON_URL: 'http://env:1/', AOC_TOKEN: 'e' }, file })).toMatchObject({
      daemonUrl: 'http://env:1',
      token: 'e',
      tokenSource: 'env',
    });
    expect(resolveTarget({ env: {}, file })).toMatchObject({
      daemonUrl: 'http://file:1',
      token: 'f',
      tokenSource: 'config',
    });
    expect(resolveTarget({ env: {}, file: null })).toEqual({
      daemonUrl: DEFAULT_DAEMON_URL,
      token: null,
      daemonSource: 'default',
      tokenSource: 'none',
    });
  });
});

describe('aoc login', () => {
  it('verifies the token via GET /api/auth/me and stores daemon + token in a 0600 file', async () => {
    const home = tempDir();
    writeClientConfig(home, { daemonUrl: 'http://old:1', observerToken: 'obs_keep' });
    const r = await aoc(['login', '--token', TOKEN, '--daemon', d.url], { homeDir: home });
    expect(r.code).toBe(0);
    expect(d.calls('GET', '/api/auth/me')[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(readConfig(home)).toEqual({ daemonUrl: d.url, token: TOKEN, observerToken: 'obs_keep' });
    expect(statSync(join(home, '.aoc', 'client.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, '.aoc')).mode & 0o777).toBe(0o700);
    expect(r.stdout).toContain('as Alice (builder, usr_1)');
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  it('reads the token from stdin with --token -', async () => {
    const home = tempDir();
    const r = await aoc(['login', '--token', '-', '--daemon', d.url], {
      homeDir: home,
      readStdin: async () => `${TOKEN}\n`,
    });
    expect(r.code).toBe(0);
    expect(readConfig(home).token).toBe(TOKEN);
  });

  it('exits 3 and stores nothing when the daemon rejects the token', async () => {
    const home = tempDir();
    const r = await aoc(['login', '--token', 'wrong', '--daemon', d.url], { homeDir: home });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('token rejected');
    expect(() => readConfig(home)).toThrow();
  });

  it('exits 2 without a token and 1 when the daemon is unreachable', async () => {
    expect((await aoc(['login', '--daemon', d.url])).code).toBe(2);
    const r = await aoc(['login', '--token', TOKEN, '--daemon', 'http://127.0.0.1:1']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('cannot reach the AOC daemon at http://127.0.0.1:1');
    expect(r.stderr).toContain('hint: start it with `aoc serve`');
  });

  it('warns before sending a token over plain HTTP to a non-loopback host', async () => {
    const r = await aoc(['login', '--token', TOKEN, '--daemon', 'http://192.0.2.1:9'], {
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    expect(r.stderr).toContain('plain HTTP on a non-loopback host');
  });
});

describe('aoc logout / whoami', () => {
  it('logout removes the CLI token but keeps the daemon URL and observer token', async () => {
    const home = tempDir();
    writeClientConfig(home, { daemonUrl: d.url, token: TOKEN, observerToken: 'obs' });
    const r = await aoc(['logout'], { homeDir: home });
    expect(r.code).toBe(0);
    expect(readConfig(home)).toEqual({ daemonUrl: d.url, observerToken: 'obs' });
    expect((await aoc(['logout'], { homeDir: home })).stdout).toContain('Not logged in');
  });

  it('whoami shows the user behind the stored token', async () => {
    const r = await aoc(['whoami'], { homeDir: loggedInHome(d.url) });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/User\s+Alice \(usr_1\)/);
    expect(r.stdout).toMatch(/Role\s+builder/);
    expect(r.stdout).not.toContain(TOKEN);
  });

  it('whoami --json', async () => {
    const r = await aoc(['whoami', '--json'], { homeDir: loggedInHome(d.url) });
    expect(JSON.parse(r.stdout)).toMatchObject({
      user: { id: 'usr_1' },
      daemonUrl: d.url,
      tokenSource: 'config',
    });
  });

  it('whoami exits 3 without a token, before any request', async () => {
    const r = await aoc(['whoami', '--daemon', d.url]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('not logged in');
    expect(d.requests).toHaveLength(0);
  });

  it('flags and env override the config file', async () => {
    const home = tempDir();
    writeClientConfig(home, { daemonUrl: 'http://127.0.0.1:1', token: 'stale' });
    expect((await aoc(['whoami', '--daemon', d.url, '--token', TOKEN], { homeDir: home })).code).toBe(0);
    expect(
      (await aoc(['whoami'], { homeDir: home, env: { AOC_DAEMON_URL: d.url, AOC_TOKEN: TOKEN } })).code,
    ).toBe(0);
    expect(d.calls('GET', '/api/auth/me').every((c) => c.headers.authorization === `Bearer ${TOKEN}`)).toBe(
      true,
    );
  });

  it('a rejected token maps to exit 3 with a login hint', async () => {
    const r = await aoc(['whoami', '--daemon', d.url, '--token', 'bad']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('hint: run `aoc login --token <token>`');
  });
});
