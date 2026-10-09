/**
 * Real git history for the demo repositories, dated by the seeder's fake clock. Commits are built with plumbing
 * (a throwaway index, `commit-tree`, `update-ref`) so the working tree of a repository, and its checked-out `main`,
 * are never touched while the seeder writes history: only the platform moves `main`, through promotion, rollback
 * and break-glass (AOC-SPEC-003 §3, §14).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { childEnv } from '@aoc/kernel';

export interface Author {
  name: string;
  email: string;
}

/** The host's git configuration (signing, hooks, templates) must not leak into seeded history. */
const ISOLATED = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

export function git(repo: string, args: string[], opts: { input?: string; env?: Record<string, string> } = {}): string {
  const r = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    input: opts.input,
    env: childEnv(process.env, { ...ISOLATED, ...opts.env }),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${repo}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

/** The commit a ref resolves to, or null. */
export function revParse(repo: string, ref: string): string | null {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd: repo,
    encoding: 'utf8',
    env: childEnv(process.env, ISOLATED),
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

const stamp = (at: number) => `${Math.floor(at / 1000)} +0000`;
const identity = (a: Author, at: number): Record<string, string> => ({
  GIT_AUTHOR_NAME: a.name,
  GIT_AUTHOR_EMAIL: a.email,
  GIT_AUTHOR_DATE: stamp(at),
  GIT_COMMITTER_NAME: a.name,
  GIT_COMMITTER_EMAIL: a.email,
  GIT_COMMITTER_DATE: stamp(at),
});

/** A repository with one dated commit on `main`; the repository-level identity is the one `initRepo` gives test repos. */
export function initDemoRepo(dir: string, files: Record<string, string>, at: number, author: Author): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'aoc@localhost']);
  git(dir, ['config', 'user.name', 'AOC']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'Initial import'], { env: identity(author, at) });
  return git(dir, ['rev-parse', 'HEAD']);
}

export interface CommitInput {
  /** Branch to advance (created from `base` when it does not exist). Never the checked-out `main`. */
  branch: string;
  /** Where a new branch starts (default: `main`). */
  base?: string;
  /** Whole-file contents to write, by repo-relative path; `null` removes the file. */
  files: Record<string, string | null>;
  message: string;
  /** Trailer lines such as `AOC-Session: ses_…` (git trailer block after a blank line). */
  trailers?: string[];
  author: Author;
  at: number;
}

const NO_BLOB = '0000000000000000000000000000000000000000';

/** Commit `files` on top of `branch` (or `base`) at the given time and move the branch there. */
export function commitFiles(repo: string, c: CommitInput): string {
  const parent = revParse(repo, `refs/heads/${c.branch}`) ?? revParse(repo, c.base ?? 'refs/heads/main');
  if (!parent) throw new Error(`no base commit for ${c.branch} in ${repo}`);
  const scratch = mkdtempSync(join(tmpdir(), 'aoc-seed-index-'));
  const index = { GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    git(repo, ['read-tree', parent], { env: index });
    const entries = Object.entries(c.files).map(([path, content]) =>
      content === null
        ? `0 ${NO_BLOB}\t${path}`
        : `100644 ${git(repo, ['hash-object', '-w', '--stdin'], { input: content })}\t${path}`,
    );
    git(repo, ['update-index', '--index-info'], { input: `${entries.join('\n')}\n`, env: index });
    const tree = git(repo, ['write-tree'], { env: index });
    const message = `${[c.message, ...(c.trailers?.length ? ['', ...c.trailers] : [])].join('\n')}\n`;
    const commit = git(repo, ['commit-tree', tree, '-p', parent, '-F', '-'], {
      input: message,
      env: identity(c.author, c.at),
    });
    git(repo, ['update-ref', `refs/heads/${c.branch}`, commit]);
    return commit;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** An annotated tag (the platform's pins are annotated, immutable tags). */
export function annotatedTag(repo: string, name: string, sha: string, message: string, tagger: Author, at: number): void {
  git(repo, ['tag', '-a', name, sha, '-m', message], { env: identity(tagger, at) });
}
