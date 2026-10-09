import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GitAsyncResult, GitCommit, GitService } from '@aoc/contracts';
import { childEnv } from './child-env';

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * git sees an allowlisted environment (no AOC_*, keys or tokens, and no inherited GIT_DIR / GIT_WORK_TREE that
 * would redirect it) plus what the caller passes explicitly.
 */
function gitEnv(extra?: Record<string, string>): Record<string, string> {
  return childEnv(process.env, { GIT_TERMINAL_PROMPT: '0', ...extra });
}

function git(dir: string, args: string[], opts: { env?: Record<string, string>; timeoutMs?: number } = {}) {
  const r = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: gitEnv(opts.env),
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error) : '') };
}

/**
 * `git()` for callers on aocd's single thread: the event loop keeps serving while git runs, and a timeout kills git
 * together with whatever it started (a filter, ssh, a hook) instead of waiting for them. Never rejects: a spawn
 * failure is code 1; a timeout is code 124 with `timedOut` and no stdout, because half an answer must not pass for one.
 */
function gitAsync(
  dir: string,
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<GitAsyncResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const verb = args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? 'git';
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn('git', args, {
        cwd: dir,
        env: gitEnv(opts.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group: one signal then reaches everything git started.
        detached: true,
      });
    } catch (err) {
      resolve({ code: 1, stdout: '', stderr: String(err), timedOut: false });
      return;
    }
    const out: string[] = [];
    const err: string[] = [];
    let bytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const killTree = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const settle = (r: GitAsyncResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A grandchild can hold the pipes open after git is gone: do not wait for it.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(r);
    };
    const fail = (stderr: string, more: Partial<GitAsyncResult> = {}) =>
      settle({ code: 1, stdout: '', stderr, timedOut: false, ...more });
    timer = setTimeout(() => {
      killTree();
      fail(`git ${verb} timed out after ${timeoutMs} ms`, { code: 124, timedOut: true });
    }, timeoutMs);
    for (const [stream, into] of [
      [child.stdout!, out],
      [child.stderr!, err],
    ] as const) {
      stream.setEncoding('utf8');
      stream.on('error', () => undefined);
      stream.on('data', (chunk: string) => {
        bytes += chunk.length;
        if (bytes <= MAX_OUTPUT_BYTES) {
          into.push(chunk);
          return;
        }
        killTree();
        fail(`git ${verb} wrote more than ${MAX_OUTPUT_BYTES} bytes`);
      });
    }
    child.once('error', (e) => fail(String(e)));
    child.once('close', (code) =>
      settle({ code: code ?? 1, stdout: out.join(''), stderr: err.join(''), timedOut: false }),
    );
  });
}

/**
 * The working-tree fingerprint: changes when HEAD, the status or the diff against HEAD changes. One definition for
 * the sync and async readers, and for the baselines already in the log.
 */
export function workingTreeFingerprintOf(parts: {
  head: string | null;
  status: string;
  diff: string;
}): string {
  return createHash('sha256')
    .update(parts.head ?? 'no-head')
    .update('\0')
    .update(parts.status)
    .update('\0')
    .update(parts.diff)
    .digest('hex');
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
      return workingTreeFingerprintOf({ head: svc.head(dir), status, diff });
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
    runAsync: (dir, args, opts) => gitAsync(dir, args, opts),
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
