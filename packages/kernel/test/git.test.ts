import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GIT_SERVICE_ENV,
  createGitService,
  gitOwnerOf,
  initRepo,
  runServiceGit,
  serviceGitEnv,
  uploadPackFor,
} from '../src';

const temps: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Plain git for the test's own setup (the "agent" side), with no host config. */
const raw = (dir: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();

const attempt = (fn: () => unknown) => {
  try {
    fn();
  } catch {
    // the control commands may fail; only their side effects matter
  }
};

/** A script that records that it ran (and with which argv) in `marker`. */
function tripwire(path: string, marker: string, name: string): string {
  writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> '${marker}'\nexit 0\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('kernel git service: nothing an agent planted in a repository runs (T-2, G-04)', () => {
  it('ignores planted hooks, core.hooksPath, fsmonitor, signing/verification programs, filters and diff drivers', () => {
    const dir = temp('aoc-git-planted-');
    const repo = join(dir, 'repo');
    const marker = join(dir, 'MARK');
    initRepo(repo, { files: { 'a.txt': 'one\n', 'b.bin': 'blob\n' } });
    // A commit carrying a (fake) signature, so log.showSignature would hand it to gpg.program.
    const head = raw(repo, 'rev-parse', 'HEAD');
    const body = raw(repo, 'cat-file', 'commit', head).replace(
      /^(committer .*)$/m,
      '$1\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----',
    );
    writeFileSync(join(dir, 'signed'), `${body}\n`);
    const signed = raw(repo, 'hash-object', '-t', 'commit', '-w', join(dir, 'signed'));
    raw(repo, 'update-ref', 'refs/heads/signed', signed);
    const hooks = join(dir, 'hooks');
    mkdirSync(hooks);
    for (const h of ['reference-transaction', 'post-checkout', 'post-commit', 'pre-auto-gc', 'post-index-change']) {
      tripwire(join(repo, '.git', 'hooks', h), marker, `hook:${h}`);
      tripwire(join(hooks, h), marker, `hooksPath:${h}`);
    }
    raw(repo, 'config', 'core.hooksPath', hooks);
    raw(repo, 'config', 'core.fsmonitor', tripwire(join(dir, 'fsmonitor'), marker, 'fsmonitor'));
    raw(repo, 'config', 'gpg.program', tripwire(join(dir, 'gpg'), marker, 'gpg'));
    raw(repo, 'config', 'tag.gpgSign', 'true');
    raw(repo, 'config', 'log.showSignature', 'true');
    raw(repo, 'config', 'filter.evil=x.clean', tripwire(join(dir, 'clean'), marker, 'filter-clean'));
    raw(repo, 'config', 'filter.evil=x.process', tripwire(join(dir, 'process'), marker, 'filter-process'));
    raw(repo, 'config', 'filter.evil=x.required', 'true');
    raw(repo, 'config', 'diff.external', tripwire(join(dir, 'extdiff'), marker, 'diff-external'));
    raw(repo, 'config', 'diff.bin.textconv', tripwire(join(dir, 'textconv'), marker, 'textconv'));
    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=evil=x\n*.bin diff=bin\n');

    rmSync(marker, { force: true });
    const git = createGitService();
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    writeFileSync(join(repo, 'b.bin'), 'changed\n');
    expect(git.workingTreeFingerprint(repo)).toMatch(/^[0-9a-f]{64}$/);
    expect(git.log(repo, 'refs/heads/signed', 5).map((c) => c.sha)).toEqual([signed]);
    expect(git.run(repo, ['log', '-1', '--format=%H %G?', 'refs/heads/signed']).code).toBe(0);
    git.tag(repo, 'aoc/pin/1', head, 'pin');
    git.createBranch(repo, 'aoc/branch', head);
    expect(git.revParse(repo, 'refs/tags/aoc/pin/1')).toBe(head);
    expect(git.revParse(repo, 'refs/heads/aoc/branch')).toBe(head);
    expect(raw(repo, 'cat-file', '-p', 'refs/tags/aoc/pin/1')).not.toContain('BEGIN PGP');
    expect(existsSync(marker) ? readFileSync(marker, 'utf8') : '').toBe('');

    // Control: the same operations through plain git do trip every planted program.
    attempt(() => raw(repo, 'status', '--porcelain'));
    attempt(() => raw(repo, 'diff', 'HEAD', '--', 'b.bin'));
    attempt(() => raw(repo, 'diff', '--no-ext-diff', 'HEAD', '--', 'b.bin'));
    attempt(() => raw(repo, 'log', '-1', '--format=%G?', 'refs/heads/signed'));
    attempt(() => raw(repo, 'tag', '-a', 'control', head, '-m', 'control'));
    attempt(() => raw(repo, '-c', 'tag.gpgSign=false', 'tag', '-a', 'control', head, '-m', 'control'));
    const tripped = readFileSync(marker, 'utf8');
    for (const name of ['fsmonitor', 'filter-', 'diff-external', 'textconv', 'gpg', 'hooksPath:reference-transaction'])
      expect(tripped, name).toContain(name);
  });

  it('opens no transport: a crafted partial clone cannot lazy-fetch through a planted uploadpack', () => {
    const dir = temp('aoc-git-promisor-');
    const repo = join(dir, 'repo');
    const marker = join(dir, 'MARK');
    initRepo(repo, { files: { 'a.txt': 'one\n' } });
    const blob = raw(repo, 'rev-parse', 'HEAD:a.txt');
    raw(repo, 'config', 'core.repositoryformatversion', '1');
    raw(repo, 'config', 'extensions.partialClone', 'origin');
    raw(repo, 'config', 'remote.origin.url', join(dir, 'elsewhere'));
    raw(repo, 'config', 'remote.origin.promisor', 'true');
    raw(repo, 'config', 'remote.origin.uploadpack', tripwire(join(dir, 'uploadpack'), marker, 'uploadpack'));
    raw(repo, 'config', 'protocol.file.allow', 'always');
    raw(repo, 'config', 'core.sshCommand', tripwire(join(dir, 'ssh'), marker, 'ssh'));
    unlinkSync(join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    writeFileSync(join(repo, 'a.txt'), 'two\n');

    const git = createGitService();
    git.workingTreeFingerprint(repo);
    git.run(repo, ['cat-file', '-p', blob]);
    expect(existsSync(marker) ? readFileSync(marker, 'utf8') : '').toBe('');

    attempt(() => raw(repo, 'cat-file', '-p', blob)); // control: plain git lazy-fetches through it
    expect(readFileSync(marker, 'utf8')).toContain('uploadpack');
  });
});

describe('service-owned repositories (runServiceGit)', () => {
  it('builds its environment from scratch: no system or global config, nothing of aocd beyond PATH and locale', () => {
    const env = serviceGitEnv(
      { EXTRA: '1' },
      {
        PATH: '/usr/bin',
        LANG: 'C.UTF-8',
        HOME: '/home/aoc',
        GIT_DIR: '/elsewhere',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: '/tmp/evil',
        GIT_SSH_COMMAND: 'ssh -i /etc/aoc/keys/promotion',
        ANTHROPIC_API_KEY: 'sk-secret',
        AOC_MASTER_KEY: 'secret',
      },
    );
    expect(env).toEqual({ PATH: '/usr/bin', LANG: 'C.UTF-8', ...GIT_SERVICE_ENV, EXTRA: '1' });
  });

  it('ignores host-level config that the environment injects, and allows a transport only when asked to', () => {
    const dir = temp('aoc-git-service-');
    const src = join(dir, 'src');
    const head = initRepo(src);
    const bare = join(dir, 'clone.git');
    raw(dir, 'init', '-q', '--bare', bare);
    const saved = { ...process.env };
    try {
      Object.assign(process.env, {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'aoc.planted',
        GIT_CONFIG_VALUE_0: 'yes',
        GIT_CONFIG_GLOBAL: join(dir, 'evil-global'),
      });
      writeFileSync(join(dir, 'evil-global'), '[aoc]\n\tglobal = yes\n');
      expect(runServiceGit(bare, ['--git-dir', bare, 'config', '--get', 'aoc.planted']).code).toBe(1);
      expect(runServiceGit(bare, ['--git-dir', bare, 'config', '--get', 'aoc.global']).code).toBe(1);
      expect(runServiceGit(bare, ['--git-dir', bare, 'config', '--get', 'core.hooksPath']).stdout.trim()).toBe(
        '/dev/null',
      );
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    const denied = runServiceGit(bare, ['--git-dir', bare, 'fetch', '-q', '--no-tags', '--', src, head]);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain("transport 'file' not allowed");
    const fetched = runServiceGit(bare, [
      '--git-dir',
      bare,
      '-c',
      'protocol.file.allow=user',
      'fetch',
      '-q',
      '--no-tags',
      '--',
      src,
      head,
    ]);
    expect(fetched).toMatchObject({ code: 0 });
    expect(runServiceGit(bare, ['--git-dir', bare, 'cat-file', '-t', head]).stdout.trim()).toBe('commit');
  });
});

const OWNER = 'nobody';
const owner = (() => {
  const line = spawnSync('getent', ['passwd', OWNER], { encoding: 'utf8' }).stdout.split('\n')[0] ?? '';
  const [, , uid, gid] = line.split(':');
  return uid && gid ? { uid: Number(uid), gid: Number(gid) } : null;
})();
const ownerUnavailable =
  process.getuid?.() !== 0 ? 'aocd must be root to run git as another user' : owner ? null : `no "${OWNER}" user`;

describe('a repository owned by the session user, with aocd as root (G-01, G-04)', () => {
  /** A repository as session isolation leaves it: owned by the session user, under a directory it can reach. */
  function ownedRepo(): { repo: string; head: string } {
    const dir = temp('aoc-git-owned-');
    chmodSync(dir, 0o755);
    const repo = join(dir, 'repo');
    const head = initRepo(repo, { files: { 'a.txt': 'one\n' } });
    execFileSync('chown', ['-R', `${owner!.uid}:${owner!.gid}`, repo]);
    return { repo, head };
  }

  it.skipIf(ownerUnavailable !== null)(
    `runs git there as its owner: no dubious-ownership refusal, and what it writes stays the owner's${ownerUnavailable ? ` (skipped: ${ownerUnavailable})` : ''}`,
    () => {
      const { repo, head } = ownedRepo();
      expect(() => raw(repo, 'rev-parse', 'HEAD')).toThrow(/dubious ownership/);
      expect(gitOwnerOf(repo)).toEqual(owner);
      const git = createGitService();
      expect(git.isRepo(repo)).toBe(true);
      expect(git.head(repo)).toBe(head);
      writeFileSync(join(repo, 'a.txt'), 'two\n');
      expect(git.workingTreeFingerprint(repo)).toMatch(/^[0-9a-f]{64}$/);
      git.tag(repo, 'aoc/pin/1', head, 'pin');
      expect(statSync(join(repo, '.git', 'refs', 'tags', 'aoc', 'pin', '1')).uid).toBe(owner!.uid);
    },
  );

  it.skipIf(ownerUnavailable !== null)(
    `fetches from it into a repository of aocd's through an upload-pack run as the owner${ownerUnavailable ? ` (skipped: ${ownerUnavailable})` : ''}`,
    () => {
      const { repo, head } = ownedRepo();
      const bare = join(temp('aoc-git-clone-'), 'clone.git');
      raw(tmpdir(), 'init', '-q', '--bare', bare);
      const fetch = (extra: string[]) =>
        runServiceGit(bare, [`--git-dir=${bare}`, '-c', 'protocol.file.allow=user', 'fetch', '-q', '--no-tags', ...extra, '--', repo, head]);
      expect(fetch([]).stderr).toContain('dubious ownership');
      expect(uploadPackFor(bare)).toBeNull();
      expect(fetch([`--upload-pack=${uploadPackFor(repo)!}`])).toMatchObject({ code: 0 });
      expect(runServiceGit(bare, [`--git-dir=${bare}`, 'cat-file', '-t', head]).stdout.trim()).toBe('commit');
    },
  );
});
