import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { anchorFileName, restoreBackup, type AnchorRecord } from '../src';
import { GitAnchorProvider } from '../src/anchor/git';
import { Rfc3161AnchorProvider } from '../src/anchor/rfc3161';
import { exec } from '../src/exec';
import { boot, makeSite, nudge, SYSTEM, type Booted, type Site } from './backup-helpers';
import { git } from './helpers';

// Children aocd starts itself (anchor git, openssl) get an allowlisted environment, never aocd's own (G-46, O-13).

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** What aocd's own environment might hold: its secrets, other services' credentials, and git redirections. */
const AOCD_SECRETS: Record<string, string> = {
  AOC_MASTER_KEY: 'kek-SECRET-1',
  AOC_BOOTSTRAP_TOKEN: 'bootstrap-SECRET-2',
  AOC_INGEST_TOKEN: 'ingest-SECRET-3',
  ANTHROPIC_API_KEY: 'sk-ant-SECRET-4',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-SECRET-5',
  GITHUB_TOKEN: 'ghp_SECRET-6',
  GH_TOKEN: 'gh-SECRET-7',
  AWS_SECRET_ACCESS_KEY: 'aws-SECRET-8',
  NPM_TOKEN: 'npm-SECRET-9',
  DEPLOY_KEY: 'deploy-SECRET-10',
  GIT_DIR: '/nonexistent/redirected/.git',
  GIT_WORK_TREE: '/nonexistent/redirected',
};

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** A stand-in for `bin` that records the environment it was started with, then runs the real one. */
function spy(bin: string): { path: string; started(): Record<string, string>[] } {
  const dir = temp('aoc-spy-');
  const dump = join(dir, 'env.dump');
  const path = join(dir, bin);
  writeFileSync(path, `#!/bin/sh\n{ echo '=== start'; env; } >> '${dump}'\nexec ${bin} "$@"\n`);
  chmodSync(path, 0o755);
  return {
    path,
    started: () => readFileSync(dump, 'utf8').split('=== start\n').filter(Boolean).map(parseEnv),
  };
}

/** No AOC_*, no API keys or tokens, no git redirection — and the plain essentials a child needs are there. */
function expectOnlyWhatChildrenNeed(started: Record<string, string>[]): void {
  expect(started.length).toBeGreaterThan(0);
  for (const env of started) {
    expect(Object.keys(env).filter((k) => /^(AOC_|ANTHROPIC_|CLAUDE_CODE_)/.test(k))).toEqual([]);
    for (const k of Object.keys(AOCD_SECRETS)) expect(env, k).not.toHaveProperty(k);
    expect(JSON.stringify(env)).not.toContain('SECRET');
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
  }
}

describe('the anchor git child', () => {
  const record: AnchorRecord = {
    chainId: 'c'.repeat(32),
    seq: 7,
    hash: 'a'.repeat(64),
    anchoredAt: '2026-10-09T02:00:00.000Z',
    previousAnchor: null,
  };

  function anchorSite() {
    const root = temp('aoc-anchor-env-');
    const remote = join(root, 'remote.git');
    mkdirSync(remote);
    git(remote, ['init', '-q', '--bare', '-b', 'main']);
    return { root, remote, repoPath: join(root, 'anchors') };
  }

  it('sees no AOC_*, API keys or tokens while it inits, commits, pushes and fetches', async () => {
    const { remote, repoPath } = anchorSite();
    const spyGit = spy('git');
    const provider = new GitAnchorProvider({ repoPath, remote, gitBin: spyGit.path });
    const created = await withEnv(AOCD_SECRETS, async () => {
      const c = await provider.create(record, anchorFileName(record, 'Asia/Kuala_Lumpur'));
      await provider.list(record.chainId);
      return c;
    });
    expect(created).toMatchObject({ pushed: true });
    const started = spyGit.started();
    expectOnlyWhatChildrenNeed(started);
    expect(started.every((e) => e.GIT_TERMINAL_PROMPT === '0' && e.LC_ALL === 'C')).toBe(true);
  });

  it('gets the signing and push settings it needs: GNUPGHOME as configured, else aocd’s; the ssh command and agent', async () => {
    const { repoPath } = anchorSite();
    const ssh = {
      GIT_SSH_COMMAND: 'ssh -i /keys/anchor -o IdentitiesOnly=yes',
      SSH_AUTH_SOCK: '/run/agent.sock',
    };
    const configured = spy('git');
    const fromEnv = spy('git');
    await withEnv({ ...AOCD_SECRETS, ...ssh, GNUPGHOME: '/home/aoc/.gnupg' }, async () => {
      await new GitAnchorProvider({
        repoPath,
        gitBin: configured.path,
        gnupgHome: '/etc/aoc/anchor-gnupg',
      }).ensureRepo();
      await new GitAnchorProvider({
        repoPath: join(repoPath, '..', 'second'),
        gitBin: fromEnv.path,
      }).ensureRepo();
    });
    for (const e of configured.started()) {
      expect(e).toMatchObject({ ...ssh, GNUPGHOME: '/etc/aoc/anchor-gnupg' });
    }
    for (const e of fromEnv.started()) {
      expect(e).toMatchObject({ ...ssh, GNUPGHOME: '/home/aoc/.gnupg' });
    }
    expectOnlyWhatChildrenNeed([...configured.started(), ...fromEnv.started()]);
  });

  it('is the same when the anchor remote is cloned at restore', async () => {
    const s = makeSite();
    cleanups.push(s.cleanup);
    const spyGit = spy('git');
    const { file } = await seedAndBackup(s);
    rmSync(s.dataDir, { recursive: true, force: true });
    rmSync(s.config.audit.anchorRepoPath, { recursive: true, force: true });

    const report = await withEnv(AOCD_SECRETS, () =>
      restoreBackup({
        file,
        backupKey: s.backupKey,
        kek: s.kek,
        dataDir: s.dataDir,
        anchors: { gitRemote: s.remote },
        requireAnchor: true,
        gitBin: spyGit.path,
      }),
    );
    expect(report).toMatchObject({ ok: true, anchors: { checked: 1, matched: 1 } });
    const started = spyGit.started();
    expect(started.length).toBeGreaterThan(1); // the clone, then the provider's reads
    expectOnlyWhatChildrenNeed(started);
  });
});

describe('the other helpers', () => {
  it('openssl (RFC 3161) sees no AOC_*, API keys or tokens', async () => {
    const dir = temp('aoc-tsr-env-');
    const spyOpenssl = spy('openssl');
    const provider = new Rfc3161AnchorProvider({
      dir,
      tsaUrl: 'http://tsa.invalid/tsr',
      fetch: () => Promise.reject(new Error('offline')),
      opensslBin: spyOpenssl.path,
      maxSkewMs: 60_000,
    });
    const record: AnchorRecord = {
      chainId: 'c'.repeat(32),
      seq: 1,
      hash: 'b'.repeat(64),
      anchoredAt: '2026-10-09T02:00:00.000Z',
      previousAnchor: null,
    };
    await withEnv(AOCD_SECRETS, async () => {
      await expect(provider.create(record, '2026-10-09-1.json')).rejects.toMatchObject({
        reason: 'tsa_unreachable',
      });
    });
    const started = spyOpenssl.started();
    expectOnlyWhatChildrenNeed(started);
    expect(started.every((e) => e.LC_ALL === 'C')).toBe(true);
  });

  it('exec() without an explicit environment starts its child with the allowlist, not process.env', async () => {
    const r = await withEnv(AOCD_SECRETS, () => exec('env', []));
    expect(r.code).toBe(0);
    expectOnlyWhatChildrenNeed([parseEnv(r.stdout.toString('utf8'))]);
  });
});

/** One anchored, backed-up host (what a restore needs); the runtime is stopped afterwards. */
async function seedAndBackup(s: Site): Promise<{ file: string }> {
  const b: Booted = await boot(s);
  const approver = b.user('approver');
  nudge(b, 'ses_env', 'sealed text');
  expect(await b.mod.service().anchorNow(SYSTEM, 'system')).toMatchObject({
    ok: true,
    anchor: { pushed: true },
  });
  const run = await b.json<{ backup: { file: string } }>('POST', '/api/audit/backup', approver.headers);
  await b.close();
  return { file: join(s.backupDir, run.backup.file) };
}
