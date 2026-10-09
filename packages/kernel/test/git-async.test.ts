import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitService, initRepo, workingTreeFingerprintOf } from '../src';

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'aoc-git-async-'));
  dirs.push(d);
  return d;
};
const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

let savedPath: string | undefined;
beforeEach(() => {
  savedPath = process.env.PATH;
});
afterEach(() => {
  process.env.PATH = savedPath;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Puts a `git` of your own first on PATH, the way an operator's wrapper or a slow filesystem would. */
function shim(script: string): void {
  const dir = temp();
  const file = join(dir, 'git');
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
  process.env.PATH = `${dir}:${savedPath}`;
}

/** Killed, though possibly not yet reaped: a zombie is not running. */
function dead(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] === 'Z';
  } catch {
    return true;
  }
}

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

describe('GitService.runAsync (aocd runs everything on one thread)', () => {
  it('answers like run, and says it did not time out', async () => {
    const repo = join(temp(), 'repo');
    initRepo(repo);
    const git = createGitService();
    const sync = git.run(repo, ['rev-parse', 'HEAD']);
    const viaAsync = await git.runAsync(repo, ['rev-parse', 'HEAD']);
    expect(viaAsync).toEqual({ ...sync, timedOut: false });
    const bad = await git.runAsync(repo, ['rev-parse', '--verify', '--quiet', 'nope^{commit}']);
    expect(bad).toMatchObject({ code: 1, stdout: '', timedOut: false });
  });

  it('keeps the event loop serving while git runs', async () => {
    const repo = join(temp(), 'repo');
    initRepo(repo);
    shim(`sleep 0.5\nexec ${realGit} "$@"`);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const r = await createGitService().runAsync(repo, ['rev-parse', 'HEAD']);
    clearInterval(timer);
    expect(r.code).toBe(0);
    expect(ticks).toBeGreaterThan(10);
  });

  it('runs git with the allowlisted child environment, like run', async () => {
    const repo = join(temp(), 'repo');
    initRepo(repo);
    const planted = {
      AOC_MASTER_KEY: 'kek-SECRET-1',
      AOC_INGEST_TOKEN: 'ingest-SECRET-3',
      ANTHROPIC_API_KEY: 'sk-ant-SECRET-4',
      GITHUB_TOKEN: 'ghp_SECRET-7',
    };
    const r = await withEnv(planted, () =>
      createGitService().runAsync(repo, ['-c', 'alias.envdump=!env', 'envdump'], {
        env: { GIT_AUTHOR_NAME: 'AOC supervisor' },
      }),
    );
    expect(r.code, r.stderr).toBe(0);
    const seen = Object.fromEntries(
      r.stdout
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    expect(Object.keys(seen).filter((k) => /^(AOC_|ANTHROPIC_|GITHUB_)/.test(k))).toEqual([]);
    for (const secret of Object.values(planted)) expect(r.stdout).not.toContain(secret);
    expect(seen.GIT_TERMINAL_PROMPT).toBe('0');
    expect(seen.GIT_AUTHOR_NAME).toBe('AOC supervisor');
  });

  it('a timeout kills git and whatever it started, and resolves with timedOut and no answer', async () => {
    const pidFile = join(temp(), 'child.pid');
    shim(`sleep 30 &\necho $! > ${pidFile}\nwait`);
    const t0 = Date.now();
    const r = await createGitService().runAsync(temp(), ['status'], { timeoutMs: 300 });
    expect(r).toMatchObject({ code: 124, stdout: '', timedOut: true });
    expect(r.stderr).toMatch(/timed out after 300 ms/);
    expect(Date.now() - t0).toBeLessThan(5_000);
    // Not just the shell: the sleep it started is dead too (it held git's pipes open).
    const pid = Number(readFileSync(pidFile, 'utf8'));
    for (let i = 0; i < 100 && !dead(pid); i++) await new Promise((res) => setTimeout(res, 20));
    expect(dead(pid)).toBe(true);
  });

  it('never rejects: a directory that does not exist is a failed run', async () => {
    const r = await createGitService().runAsync(join(temp(), 'missing'), ['status']);
    expect(r).toMatchObject({ code: 1, stdout: '', timedOut: false });
    expect(r.stderr).not.toBe('');
  });

  it('hashes like the sync reader (baselines already in the log stay comparable)', () => {
    const repo = join(temp(), 'repo');
    const head = initRepo(repo);
    writeFileSync(join(repo, 'new.txt'), 'x\n');
    const git = createGitService();
    const status = git.run(repo, ['status', '--porcelain=v1', '--untracked-files=all']).stdout;
    const diff = git.run(repo, ['diff', 'HEAD', '--no-color']).stdout;
    expect(git.workingTreeFingerprint(repo)).toBe(workingTreeFingerprintOf({ head, status, diff }));
    expect(workingTreeFingerprintOf({ head: null, status: '', diff: '' })).not.toBe(
      workingTreeFingerprintOf({ head, status: '', diff: '' }),
    );
  });
});

/** A script that records that it ran in `marker`. */
function tripwire(path: string, marker: string, name: string): string {
  writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> '${marker}'\nexit 1\n`);
  chmodSync(path, 0o755);
  return path;
}
const raw = (dir: string, ...args: string[]) =>
  execFileSync(realGit, args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();

describe('the async twins keep the kernel git rules (T-2, G-04)', () => {
  it('workingTreeFingerprintAsync is the sync fingerprint, and null where git cannot describe a tree', async () => {
    const git = createGitService();
    const repo = join(temp(), 'repo');
    initRepo(repo, { files: { 'a.txt': 'one\n' } });
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    writeFileSync(join(repo, 'new.txt'), 'x\n');
    const sync = git.workingTreeFingerprint(repo);
    expect(sync).toMatch(/^[0-9a-f]{64}$/);
    expect(await git.workingTreeFingerprintAsync(repo)).toEqual({ fingerprint: sync, timedOut: false });
    expect(await git.workingTreeFingerprintAsync(temp())).toEqual({ fingerprint: null, timedOut: false });

    // No commit yet: still a fingerprint (the status), as before.
    const fresh = join(temp(), 'fresh');
    raw(temp(), 'init', '-q', '-b', 'main', fresh);
    writeFileSync(join(fresh, 'f.txt'), 'x\n');
    const unborn = git.workingTreeFingerprint(fresh);
    expect(unborn).toMatch(/^[0-9a-f]{64}$/);
    expect(await git.workingTreeFingerprintAsync(fresh)).toEqual({ fingerprint: unborn, timedOut: false });
  });

  it('a fingerprint that git did not finish is timedOut, never a hash of half an answer', async () => {
    const repo = join(temp(), 'repo');
    initRepo(repo);
    shim(`sleep 30\nexec ${realGit} "$@"`);
    const t0 = Date.now();
    const r = await createGitService().workingTreeFingerprintAsync(repo, { timeoutMs: 300 });
    expect(r).toEqual({ fingerprint: null, timedOut: true });
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('runs no hook, signing program, filter, fsmonitor or transport the repository configures', async () => {
    const dir = temp();
    const repo = join(dir, 'repo');
    const marker = join(dir, 'MARK');
    const head = initRepo(repo, { files: { 'a.txt': 'one\n' } });
    const hooks = join(dir, 'hooks');
    mkdirSync(hooks);
    tripwire(join(hooks, 'reference-transaction'), marker, 'hook');
    raw(repo, 'config', 'core.hooksPath', hooks);
    raw(repo, 'config', 'core.fsmonitor', tripwire(join(dir, 'fsmonitor'), marker, 'fsmonitor'));
    raw(repo, 'config', 'gpg.program', tripwire(join(dir, 'gpg'), marker, 'gpg'));
    raw(repo, 'config', 'tag.gpgSign', 'true');
    raw(repo, 'config', 'filter.evil.clean', tripwire(join(dir, 'clean'), marker, 'filter'));
    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=evil\n');
    // A partial clone whose remote is a program: a missing object would run it.
    raw(repo, 'config', 'core.repositoryformatversion', '1');
    raw(repo, 'config', 'extensions.partialClone', 'origin');
    raw(repo, 'config', 'remote.origin.url', `ext::${tripwire(join(dir, 'transport'), marker, 'transport')}`);
    raw(repo, 'config', 'remote.origin.promisor', 'true');
    raw(repo, 'config', 'protocol.ext.allow', 'always');
    writeFileSync(join(repo, 'a.txt'), 'two\n');

    const git = createGitService();
    expect((await git.workingTreeFingerprintAsync(repo)).fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((await git.runAsync(repo, ['tag', '-a', 'aoc/pin/1', head, '-m', 'pin'])).code).toBe(0);
    expect((await git.runAsync(repo, ['rev-list', '-n1', `${'1'.repeat(40)}^{commit}`])).code).not.toBe(0);
    expect(existsSync(marker) ? readFileSync(marker, 'utf8') : '').toBe('');

    // Control: plain git trips them.
    const attempt = (fn: () => unknown) => {
      try {
        fn();
      } catch {
        // only the side effects matter
      }
    };
    attempt(() => raw(repo, 'status', '--porcelain'));
    attempt(() => raw(repo, 'tag', '-a', 'control', head, '-m', 'control'));
    attempt(() => raw(repo, '-c', 'tag.gpgSign=false', 'tag', '-a', 'control2', head, '-m', 'control'));
    attempt(() => raw(repo, 'rev-list', '-n1', `${'1'.repeat(40)}^{commit}`));
    const tripped = readFileSync(marker, 'utf8');
    for (const name of ['fsmonitor', 'filter', 'hook', 'transport']) expect(tripped, name).toContain(name);
  });
});

const NOBODY = (() => {
  const line = spawnSync('getent', ['passwd', 'nobody'], { encoding: 'utf8' }).stdout.split('\n')[0] ?? '';
  const [, , uid, gid] = line.split(':');
  return uid && gid ? { uid: Number(uid), gid: Number(gid) } : null;
})();

describe.skipIf(process.getuid?.() !== 0 || !NOBODY)(
  'a repository owned by the session user (G-01, G-04)',
  () => {
    it('is read, async too, as its owner: no dubious-ownership refusal, and what git writes stays the owner’s', async () => {
      const dir = temp();
      chmodSync(dir, 0o755);
      const repo = join(dir, 'repo');
      const head = initRepo(repo, { files: { 'a.txt': 'one\n' } });
      execFileSync('chown', ['-R', `${NOBODY!.uid}:${NOBODY!.gid}`, repo]);
      expect(() => raw(repo, 'rev-parse', 'HEAD')).toThrow(/dubious ownership/);
      const git = createGitService();
      expect(await git.runAsync(repo, ['rev-parse', 'HEAD'])).toMatchObject({ code: 0, stdout: `${head}\n` });
      writeFileSync(join(repo, 'a.txt'), 'two\n');
      const sync = git.workingTreeFingerprint(repo);
      expect(sync).toMatch(/^[0-9a-f]{64}$/);
      expect(await git.workingTreeFingerprintAsync(repo)).toEqual({ fingerprint: sync, timedOut: false });
      expect(await git.runAsync(repo, ['tag', '-a', 'aoc/pin/1', head, '-m', 'pin'])).toMatchObject({
        code: 0,
      });
      expect(statSync(join(repo, '.git', 'refs', 'tags', 'aoc', 'pin', '1')).uid).toBe(NOBODY!.uid);
    });
  },
);
