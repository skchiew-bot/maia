/**
 * Git operations that run through the supervisor's isolated runner (§2.4, §3): rollback verification,
 * rollback execution and promotion. Branches only ever move forward — no force push, no history rewrite.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `git <args>` in `cwd` inside a supervisor-controlled environment. */
export type GitRunner = (cwd: string, args: string[]) => Promise<RunResult>;

export class RepoOpError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

const output = (r: RunResult) => `${r.stdout}\n${r.stderr}`.trim().slice(-2000);

async function must(git: GitRunner, cwd: string, args: string[], reason: string): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new RepoOpError(reason, `${reason}: ${output(r) || `git exited with ${r.code}`}`);
  return r.stdout.trim();
}

export async function revParse(git: GitRunner, cwd: string, ref: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
}

export async function listWorktrees(git: GitRunner, repo: string): Promise<WorktreeInfo[]> {
  const r = await git(repo, ['worktree', 'list', '--porcelain']);
  if (r.code !== 0) return [];
  return r.stdout
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.split('\n');
      return {
        path: lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length) ?? '',
        branch: lines.find((l) => l.startsWith('branch '))?.slice('branch '.length) ?? null,
      };
    })
    .filter((w) => w.path);
}

export async function pickRemote(git: GitRunner, repo: string): Promise<string | null> {
  const r = await git(repo, ['remote']);
  const remotes =
    r.code === 0
      ? r.stdout
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  return remotes.includes('origin') ? 'origin' : (remotes[0] ?? null);
}

async function withTempWorktree<T>(
  git: GitRunner,
  repo: string,
  prefix: string,
  addArgs: (dir: string) => string[],
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  const dir = join(tmp, 'wt');
  try {
    await must(git, repo, addArgs(dir), 'worktree_failed');
    return await fn(dir);
  } finally {
    await git(repo, ['worktree', 'remove', '--force', dir]).catch(() => undefined);
    rmSync(tmp, { recursive: true, force: true });
    await git(repo, ['worktree', 'prune']).catch(() => undefined);
  }
}

/** Check `sha` out on a NEW branch in a temporary worktree (the branch is kept as evidence; the worktree is removed). */
export async function withVerificationCheckout<T>(
  git: GitRunner,
  repo: string,
  branch: string,
  sha: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  await git(repo, ['worktree', 'prune']);
  // A previous attempt (crash mid-verification) may still hold the branch.
  for (const wt of await listWorktrees(git, repo)) {
    if (wt.branch === `refs/heads/${branch}`) await git(repo, ['worktree', 'remove', '--force', wt.path]);
  }
  return withTempWorktree(
    git,
    repo,
    'aoc-rollback-verify-',
    (dir) => ['worktree', 'add', '-B', branch, dir, sha],
    fn,
  );
}

/**
 * Create a NEW commit on top of `branch` whose tree is exactly `targetSha`'s tree (`git restore --source=<sha>
 * --staged --worktree :/` + `git commit`). It is built in a detached temporary worktree of the branch so that no
 * shared working tree — possibly a running session's — is disturbed; `fastForward` then publishes it.
 */
export async function createRestoreCommit(
  git: GitRunner,
  repo: string,
  branch: string,
  targetSha: string,
  message: string[],
): Promise<{ parent: string; commit: string }> {
  return withTempWorktree(
    git,
    repo,
    'aoc-rollback-exec-',
    (dir) => ['worktree', 'add', '--detach', dir, `refs/heads/${branch}`],
    async (dir) => {
      const parent = await must(git, dir, ['rev-parse', 'HEAD'], 'rev_parse_failed');
      await must(
        git,
        dir,
        ['restore', `--source=${targetSha}`, '--staged', '--worktree', ':/'],
        'restore_failed',
      );
      if ((await git(dir, ['diff', '--cached', '--quiet'])).code === 0) {
        throw new RepoOpError('already_at_target', `${branch} already has the tree of ${targetSha}`);
      }
      const ident = await git(dir, ['config', 'user.email']);
      const identity =
        ident.code === 0 && ident.stdout.trim()
          ? []
          : ['-c', 'user.name=AOC Supervisor', '-c', 'user.email=aoc-supervisor@localhost'];
      // --no-verify: the restored tree was committed before and has just passed its acceptance tests.
      await must(
        git,
        dir,
        [...identity, 'commit', '--no-verify', '-q', ...message.flatMap((m) => ['-m', m])],
        'commit_failed',
      );
      return { parent, commit: await must(git, dir, ['rev-parse', 'HEAD'], 'rev_parse_failed') };
    },
  );
}

export type FastForwardResult =
  | { ok: true; before: string; after: string; remote: string | null; warning: string | null }
  | { ok: false; refused: 'not_fast_forward'; detail: string }
  | { ok: false; failed: string; detail: string };

/**
 * Move `branch` forward to `newTip`: fast-forward only, never a force push. When the repo has a remote it is the
 * source of truth and is pushed first, so a failure leaves every copy of the branch unchanged. A working tree that
 * has the branch checked out is fast-forwarded in place (it must be clean); otherwise the ref is compare-and-swapped.
 */
export async function fastForward(
  git: GitRunner,
  repo: string,
  branch: string,
  newTip: string,
  expectedBefore?: string,
): Promise<FastForwardResult> {
  const before = await revParse(git, repo, `refs/heads/${branch}`);
  if (!before) return { ok: false, failed: 'branch_missing', detail: `refs/heads/${branch} does not exist` };
  if (expectedBefore && before !== expectedBefore)
    return {
      ok: false,
      refused: 'not_fast_forward',
      detail: `${branch} moved from ${expectedBefore} to ${before}`,
    };
  if (before === newTip) return { ok: true, before, after: newTip, remote: null, warning: null };
  if ((await git(repo, ['merge-base', '--is-ancestor', before, newTip])).code !== 0) {
    return {
      ok: false,
      refused: 'not_fast_forward',
      detail: `${newTip} does not contain ${branch} at ${before}`,
    };
  }
  const holder = (await listWorktrees(git, repo)).find((w) => w.branch === `refs/heads/${branch}`);
  if (holder) {
    const status = await git(holder.path, ['status', '--porcelain']);
    if (status.code !== 0 || status.stdout.trim()) {
      return {
        ok: false,
        failed: 'default_branch_worktree_dirty',
        detail: `the working tree at ${holder.path} has uncommitted changes on ${branch}`,
      };
    }
  }
  const remote = await pickRemote(git, repo);
  if (remote) {
    const push = await git(repo, ['push', remote, `${newTip}:refs/heads/${branch}`]);
    if (push.code !== 0) return { ok: false, failed: 'push_failed', detail: output(push) };
  }
  const local = holder
    ? await git(holder.path, ['merge', '--ff-only', '-q', newTip])
    : await git(repo, ['update-ref', `refs/heads/${branch}`, newTip, before]);
  if (local.code !== 0) {
    if (!remote) return { ok: false, failed: 'local_update_failed', detail: output(local) };
    return {
      ok: true,
      before,
      after: newTip,
      remote,
      warning: `pushed to ${remote}, but the local ${branch} could not be updated: ${output(local)}`,
    };
  }
  return {
    ok: true,
    before,
    after: (await revParse(git, repo, `refs/heads/${branch}`)) ?? newTip,
    remote,
    warning: null,
  };
}
