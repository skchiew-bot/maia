import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GitCommit, GitService } from '@aoc/contracts';

function git(dir: string, args: string[], opts: { env?: Record<string, string>; timeoutMs?: number } = {}) {
  const r = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env },
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error) : '') };
}

/** Thin wrapper over the git CLI (argument arrays only — never a shell). */
export function createGitService(): GitService {
  const svc: GitService = {
    isRepo: (dir) => existsSync(dir) && git(dir, ['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true',
    revParse: (dir, ref) => {
      const r = git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      return r.code === 0 ? r.stdout.trim() : null;
    },
    commitExists: (dir, sha) => /^[0-9a-f]{7,64}$/i.test(sha) && git(dir, ['cat-file', '-e', `${sha}^{commit}`]).code === 0,
    head: (dir) => svc.revParse(dir, 'HEAD'),
    currentBranch: (dir) => {
      const r = git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      return r.code === 0 ? r.stdout.trim() : null;
    },
    workingTreeFingerprint: (dir) => {
      if (!svc.isRepo(dir)) return null;
      const status = git(dir, ['status', '--porcelain=v1', '--untracked-files=all']).stdout;
      const diff = git(dir, ['diff', 'HEAD', '--no-color']).stdout;
      const head = svc.head(dir) ?? 'no-head';
      return createHash('sha256').update(head).update('\0').update(status).update('\0').update(diff).digest('hex');
    },
    tag: (dir, name, sha, message) => {
      const r = git(dir, ['tag', '-a', name, sha, '-m', message]);
      if (r.code !== 0) throw new Error(`git tag failed: ${r.stderr.trim()}`);
    },
    createBranch: (dir, branch, ref) => {
      const r = git(dir, ['branch', branch, ref]);
      if (r.code !== 0) throw new Error(`git branch failed: ${r.stderr.trim()}`);
    },
    isAncestor: (dir, a, d) => git(dir, ['merge-base', '--is-ancestor', a, d]).code === 0,
    log: (dir, range, limit = 500) => {
      const r = git(dir, ['log', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e', `-n${limit}`, range]);
      if (r.code !== 0) return [];
      return r.stdout
        .split('\x1e')
        .map((s) => s.trim())
        .filter(Boolean)
        .map<GitCommit>((rec) => {
          const [sha, parents, an, ae, date, subject] = rec.split('\x1f');
          return { sha: sha!, parents: parents ? parents.split(' ') : [], authorName: an!, authorEmail: ae!, date: date!, subject: subject ?? '' };
        });
    },
    run: (dir, args, opts) => git(dir, args, opts),
  };
  return svc;
}

/** Initialise a repo with one commit (tests, anchor repo). */
export function initRepo(dir: string, opts: { files?: Record<string, string>; branch?: string } = {}): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', opts.branch ?? 'main']);
  git(dir, ['config', 'user.email', 'aoc@localhost']);
  git(dir, ['config', 'user.name', 'AOC']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  for (const [p, c] of Object.entries(opts.files ?? { 'README.md': '# test\n' })) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  return git(dir, ['rev-parse', 'HEAD']).stdout.trim();
}
