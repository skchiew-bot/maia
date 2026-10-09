import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderDoctor } from '../src/commands/doctor';
import type { GitRunner } from '../src/deps';
import {
  deploySecretEnvNames,
  gitCredentialHelpers,
  helperName,
  prePushPath,
  runDoctor,
  sshPrivateKeyNames,
  verdictOf,
  type DaemonProbe,
  type DoctorFs,
  type DoctorInput,
} from '../src/doctor';
import { mergeObservedHooks } from '../src/observed-hooks';
import { aoc, loggedInHome, tempDir, TOKEN, writeClientConfig } from './helpers/cli';
import { startFakeDaemon, type FakeDaemon } from './helpers/fake-daemon';
import { user } from './helpers/fixtures';

// ── an in-memory filesystem ──────────────────────────────────────────────────
type Entry = { content: string; mode?: number };
function memFs(files: Record<string, Entry>): DoctorFs {
  const isDir = (p: string) => Object.keys(files).some((f) => f.startsWith(p.endsWith('/') ? p : `${p}/`));
  return {
    exists: (p) => p in files || isDir(p),
    isFile: (p) => p in files,
    readdir: (p) => [
      ...new Set(
        Object.keys(files)
          .filter((f) => dirname(f) === p)
          .map((f) => f.slice(p.length + 1)),
      ),
    ],
    readHead: (p, n) => (p in files ? files[p]!.content.slice(0, n) : null),
    readText: (p) => (p in files ? files[p]!.content : null),
    mode: (p) => (p in files ? (files[p]!.mode ?? 0o644) : isDir(p) ? 0o755 : null),
  };
}

const HOME = '/home/dev';
const REPO = '/home/dev/proj';
const SETTINGS = `${HOME}/.claude/settings.json`;
const CONFIG = `${HOME}/.aoc/client.json`;
const GUARD = '#!/bin/sh\n# aoc:pre-push-guard — managed by AOC\nexec aoc-guard "$@"\n';
const okProbe: DaemonProbe = {
  reachable: true,
  status: 200,
  user: { id: 'usr_1', name: 'Alice', role: 'builder' },
  error: null,
};

function fakeGit(
  over: Partial<Record<'helpers' | 'prePush', { code: number; stdout: string }>> = {},
): GitRunner {
  return (args) => {
    if (args[0] === 'config') return over.helpers ?? { code: 1, stdout: '' };
    if (args[0] === 'rev-parse') return over.prePush ?? { code: 0, stdout: '.git/hooks/pre-push\n' };
    return { code: 1, stdout: '' };
  };
}

const installedSettings = JSON.stringify(mergeObservedHooks({}, 'node /opt/aoc-hook.mjs').settings);

function input(over: Partial<DoctorInput> = {}, files: Record<string, Entry> = {}): DoctorInput {
  return {
    env: { PATH: '/usr/bin', HOME },
    homeDir: HOME,
    cwd: REPO,
    platform: 'linux',
    fs: memFs({
      [CONFIG]: { content: '{}', mode: 0o600 },
      [SETTINGS]: { content: installedSettings },
      [`${REPO}/.git/hooks/pre-push`]: { content: GUARD, mode: 0o755 },
      ...files,
    }),
    git: fakeGit(),
    daemonUrl: 'http://127.0.0.1:7420',
    tokenPresent: true,
    probe: async () => okProbe,
    configPath: CONFIG,
    observerTokenPresent: true,
    settingsPath: SETTINGS,
    ...over,
  };
}

const statusOf = async (i: DoctorInput) =>
  Object.fromEntries((await runDoctor(i)).checks.map((c) => [c.id, c.status]));

describe('deploy-grade secrets in the shell env', () => {
  it('matches the listed names and globs (case-insensitive), ignoring empty values', () => {
    const env = {
      GH_TOKEN: 'x',
      GITHUB_TOKEN: 'x',
      GITLAB_TOKEN: 'x',
      AWS_ACCESS_KEY_ID: 'x',
      AWS_SECRET_ACCESS_KEY: 'x',
      AZURE_CLIENT_SECRET: 'x',
      GOOGLE_APPLICATION_CREDENTIALS: '/k.json',
      PROD_DEPLOY_KEY: 'x',
      NPM_TOKEN: 'x',
      VERCEL_TOKEN: 'x',
      FLY_API_TOKEN: 'x',
      KUBECONFIG: '/k',
      npm_token: 'x',
      EMPTY_DEPLOY_X: '',
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'x',
      DEPLOYMENT: 'x',
    };
    expect(deploySecretEnvNames(env)).toEqual([
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AZURE_CLIENT_SECRET',
      'FLY_API_TOKEN',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GITLAB_TOKEN',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'KUBECONFIG',
      'NPM_TOKEN',
      'PROD_DEPLOY_KEY',
      'VERCEL_TOKEN',
      'npm_token',
    ]);
  });
});

describe('ssh private keys', () => {
  it('finds keys by header or id_* name and skips public keys, known_hosts and config', () => {
    const fs = memFs({
      [`${HOME}/.ssh/id_ed25519`]: { content: '-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETKEYMATERIAL' },
      [`${HOME}/.ssh/id_ed25519.pub`]: { content: 'ssh-ed25519 AAAA' },
      [`${HOME}/.ssh/deploy_prod`]: { content: '-----BEGIN RSA PRIVATE KEY-----\nMORESECRET' },
      [`${HOME}/.ssh/id_unreadable`]: { content: '' },
      [`${HOME}/.ssh/work.ppk`]: { content: 'PuTTY-User-Key-File-3: ssh-rsa' },
      [`${HOME}/.ssh/known_hosts`]: { content: 'github.com ssh-ed25519' },
      [`${HOME}/.ssh/config`]: { content: 'Host *' },
      [`${HOME}/.ssh/notes.txt`]: { content: 'hello' },
    });
    expect(sshPrivateKeyNames(`${HOME}/.ssh`, fs)).toEqual([
      'deploy_prod',
      'id_ed25519',
      'id_unreadable',
      'work.ppk',
    ]);
  });
});

describe('git credential helpers', () => {
  it('never echoes an inline helper (it may embed a secret)', () => {
    expect(helperName('!f() { echo password=ghp_SECRET; }; f')).toBe('inline shell helper');
    expect(helperName('!/usr/bin/gh auth git-credential')).toBe('gh auth git-credential');
    expect(helperName('store --file /home/dev/.creds')).toBe('store');
    expect(helperName('/usr/local/bin/git-credential-manager')).toBe('git-credential-manager');
  });

  it('parses scoped output, falls back for old git, and reports git missing', () => {
    const out =
      'global\tcredential.helper osxkeychain\nlocal\tcredential.https://x.example.helper !f() { echo password=S3CRET; }; f\nglobal\tcredential.helper \n';
    expect(gitCredentialHelpers(() => ({ code: 0, stdout: out }), REPO)).toEqual({
      helpers: ['osxkeychain (global)', 'inline shell helper (local)'],
      gitAvailable: true,
    });
    const calls: string[][] = [];
    const old: GitRunner = (args) => {
      calls.push(args);
      return args.includes('--show-scope')
        ? { code: 129, stdout: '' }
        : { code: 0, stdout: 'credential.helper store\n' };
    };
    expect(gitCredentialHelpers(old, REPO).helpers).toEqual(['store']);
    expect(calls).toHaveLength(2);
    expect(gitCredentialHelpers(() => ({ code: 127, stdout: '' }), REPO)).toEqual({
      helpers: [],
      gitAvailable: false,
    });
  });
});

describe('pre-push guard location', () => {
  it('uses git rev-parse --git-path (worktrees, core.hooksPath) relative to cwd', () => {
    expect(
      prePushPath(fakeGit({ prePush: { code: 0, stdout: '/elsewhere/hooks/pre-push\n' } }), REPO, memFs({})),
    ).toBe('/elsewhere/hooks/pre-push');
    expect(prePushPath(fakeGit(), `${REPO}/src`, memFs({}))).toBe(`${REPO}/src/.git/hooks/pre-push`);
    expect(prePushPath(fakeGit({ prePush: { code: 128, stdout: '' } }), '/tmp', memFs({}))).toBeNull();
  });

  it('walks up to .git (following worktree gitdir + commondir) when git is not installed', () => {
    const noGit: GitRunner = () => ({ code: 127, stdout: '' });
    expect(prePushPath(noGit, `${REPO}/a/b`, memFs({ [`${REPO}/.git/HEAD`]: { content: 'ref' } }))).toBe(
      `${REPO}/.git/hooks/pre-push`,
    );
    const wt = memFs({
      '/wt/.git': { content: 'gitdir: /main/.git/worktrees/wt\n' },
      '/main/.git/worktrees/wt/commondir': { content: '../..\n' },
    });
    expect(prePushPath(noGit, '/wt/pkg', wt)).toBe('/main/.git/hooks/pre-push');
  });
});

describe('runDoctor', () => {
  it('passes when everything is in place', async () => {
    const r = await runDoctor(input());
    expect(r.checks.map((c) => [c.id, c.status])).toEqual([
      ['daemon', 'pass'],
      ['auth', 'pass'],
      ['config-perms', 'pass'],
      ['observed-hooks', 'pass'],
      ['env-secrets', 'pass'],
      ['ssh-keys', 'pass'],
      ['git-credentials', 'pass'],
      ['pre-push', 'pass'],
    ]);
    expect(r.verdict).toBe('pass');
    expect(r.runbook).toBe('docs/runbooks/credential-isolation.md');
  });

  it('warns on held credentials, naming them but never printing values or key material', async () => {
    const env = { HOME, GITHUB_TOKEN: 'ghp_SUPERSECRET', AWS_SECRET_ACCESS_KEY: 'AKIA/SECRET+VALUE' };
    const files = {
      [`${HOME}/.ssh/id_rsa`]: { content: '-----BEGIN OPENSSH PRIVATE KEY-----\nKEYMATERIAL' },
      [`${HOME}/.git-credentials`]: { content: 'https://u:pw@x' },
    };
    const git = fakeGit({
      helpers: { code: 0, stdout: 'global\tcredential.helper !f() { echo password=HELPERSECRET; }; f\n' },
    });
    const r = await runDoctor(input({ env, git }, files));
    const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    expect(byId['env-secrets']).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN'),
    });
    expect(byId['ssh-keys']).toMatchObject({ status: 'warn', detail: expect.stringContaining('id_rsa') });
    expect(byId['git-credentials']!.detail).toContain('inline shell helper (global)');
    expect(byId['git-credentials']!.detail).toContain(`${HOME}/.git-credentials`);
    expect(r.verdict).toBe('warn');
    const rendered = renderDoctor(r.checks, r.verdict, r.runbook) + JSON.stringify(r);
    for (const secret of ['ghp_SUPERSECRET', 'AKIA/SECRET+VALUE', 'KEYMATERIAL', 'HELPERSECRET', 'u:pw'])
      expect(rendered).not.toContain(secret);
  });

  it('fails when the daemon is unreachable or the token is missing/rejected', async () => {
    const down: DaemonProbe = { reachable: false, status: null, user: null, error: 'ECONNREFUSED' };
    expect(await statusOf(input({ probe: async () => down }))).toMatchObject({
      daemon: 'fail',
      auth: 'skip',
    });
    expect(await statusOf(input({ tokenPresent: false }))).toMatchObject({ daemon: 'pass', auth: 'fail' });
    const rejected: DaemonProbe = { reachable: true, status: 401, user: null, error: 'Sign in required' };
    const r = await runDoctor(input({ probe: async () => rejected }));
    expect(r.checks.find((c) => c.id === 'auth')!.status).toBe('fail');
    expect(r.verdict).toBe('fail');
  });

  it('checks the client config is private', async () => {
    expect((await statusOf(input({}, { [CONFIG]: { content: '{}', mode: 0o644 } })))['config-perms']).toBe(
      'warn',
    );
    expect((await statusOf(input({ configPath: `${HOME}/.aoc/none.json` })))['config-perms']).toBe('skip');
  });

  it('reports observed hooks missing, partial, or without an observer token', async () => {
    expect((await statusOf(input({ settingsPath: '/nope.json' })))['observed-hooks']).toBe('warn');
    const partial = JSON.stringify(mergeObservedHooks({}, 'x', ['PreToolUse']).settings);
    const p = await runDoctor(input({}, { [SETTINGS]: { content: partial } }));
    expect(p.checks.find((c) => c.id === 'observed-hooks')!.detail).toContain(
      'missing for SessionStart, UserPromptSubmit, PostToolUse',
    );
    const noToken = await runDoctor(input({ observerTokenPresent: false }));
    expect(noToken.checks.find((c) => c.id === 'observed-hooks')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('no observer token'),
    });
  });

  it('distinguishes the AOC pre-push guard from a foreign, missing or non-executable hook', async () => {
    const hook = `${REPO}/.git/hooks/pre-push`;
    expect(
      (await statusOf(input({}, { [hook]: { content: '#!/bin/sh\nnpm test\n', mode: 0o755 } })))['pre-push'],
    ).toBe('warn');
    expect((await statusOf(input({}, { [hook]: { content: GUARD, mode: 0o644 } })))['pre-push']).toBe('warn');
    expect(
      (await statusOf(input({ git: fakeGit({ prePush: { code: 0, stdout: '.git/hooks/none' } }) })))[
        'pre-push'
      ],
    ).toBe('warn');
    expect(
      (await statusOf(input({ git: fakeGit({ prePush: { code: 128, stdout: '' } }) })))['pre-push'],
    ).toBe('skip');
  });

  it('verdictOf: any fail → fail, else any warn → warn, skips do not count', () => {
    const c = (status: 'pass' | 'warn' | 'fail' | 'skip') => ({ id: status, label: '', status, detail: '' });
    expect(verdictOf([c('pass'), c('skip')])).toBe('pass');
    expect(verdictOf([c('pass'), c('warn'), c('skip')])).toBe('warn');
    expect(verdictOf([c('warn'), c('fail')])).toBe('fail');
  });
});

describe('aoc doctor (command)', () => {
  let d: FakeDaemon;
  beforeEach(async () => {
    d = await startFakeDaemon();
    d.on('GET', '/api/auth/me', (req) =>
      req.headers.authorization === `Bearer ${TOKEN}`
        ? { json: user() }
        : { status: 401, json: { error: { message: 'no' } } },
    );
  });
  afterEach(() => d.stop());

  it('prints a pass/warn/fail table, the verdict and the runbook; warnings alone exit 0', async () => {
    const home = loggedInHome(d.url);
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh', 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\nTOPSECRETKEY');
    const repo = tempDir();
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(repo, '.git', 'hooks', 'pre-push'), GUARD);
    chmodSync(join(repo, '.git', 'hooks', 'pre-push'), 0o755);
    const git: GitRunner = (args) =>
      args[0] === 'rev-parse' ? { code: 0, stdout: '.git/hooks/pre-push\n' } : { code: 1, stdout: '' };

    const r = await aoc(['doctor'], { homeDir: home, cwd: repo, git, env: { NPM_TOKEN: 'npm_SECRETVALUE' } });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^STATUS\s+CHECK\s+DETAIL/);
    expect(r.stdout).toMatch(/PASS\s+Daemon reachable/);
    expect(r.stdout).toMatch(/PASS\s+Logged in\s+as Alice \(builder\)/);
    expect(r.stdout).toMatch(/WARN\s+Observed-session hooks\s+not installed/);
    expect(r.stdout).toMatch(/WARN\s+No deploy secrets in shell env\s+NPM_TOKEN set/);
    expect(r.stdout).toMatch(/WARN\s+No private keys in ~\/\.ssh\s+id_ed25519/);
    expect(r.stdout).toMatch(/PASS\s+Repo pre-push is the AOC guard/);
    expect(r.stdout).toContain('Verdict: WARN (0 failed, 3 warnings, 5 passed)');
    expect(r.stdout).toContain('Credential-isolation runbook: docs/runbooks/credential-isolation.md');
    expect(r.stdout + r.stderr).not.toMatch(/npm_SECRETVALUE|TOPSECRETKEY/);
  });

  it('exits 1 on FAIL (daemon down) and supports --json', async () => {
    const home = tempDir();
    writeClientConfig(home, { daemonUrl: 'http://127.0.0.1:1', token: TOKEN });
    const r = await aoc(['doctor', '--json'], { homeDir: home });
    expect(r.code).toBe(1);
    const body = JSON.parse(r.stdout) as { verdict: string; checks: { id: string; status: string }[] };
    expect(body.verdict).toBe('fail');
    expect(body.checks.find((c) => c.id === 'daemon')!.status).toBe('fail');
  });
});
