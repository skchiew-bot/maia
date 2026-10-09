/**
 * Git plumbing shared by promotion and rollback (§8, §14; G-04): how a restore commit is made, how a push to the
 * protected remote is judged, and how a project with no remote has its own branch moved. Branches only ever move
 * forward — no history rewrite, and every update is a compare-and-swap from a verified base.
 */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `git <args>` in `cwd` (argv only, never a shell) with extra environment variables. */
export type GitRunner = (cwd: string, args: string[], env?: Record<string, string>) => Promise<RunResult>;

export class RepoOpError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

export const output = (r: RunResult) => `${r.stdout}\n${r.stderr}`.trim().slice(-2000);

export type PublishResult =
  | { ok: true; before: string; after: string; warning: string | null }
  | { ok: false; refused: 'not_fast_forward'; detail: string }
  | { ok: false; failed: string; detail: string };

/** The transports a promotion remote may use are the configuration's (@aoc/contracts): one rule for both. */
export { transportOf, type GitTransport } from '@aoc/contracts';

/** A remote URL without its user-info, where a token may hide: for messages and event payloads. */
export function displayUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1***@');
}

/** `git push --porcelain` result for the single ref pushed; `stale` when the remote was not where the lease said. */
export function pushOutcome(r: RunResult): { ok: true } | { ok: false; stale: boolean; detail: string } {
  if (r.code === 0) return { ok: true };
  return { ok: false, stale: /\(stale info\)/.test(`${r.stdout}\n${r.stderr}`), detail: output(r) };
}

export interface GitIdentity {
  name: string;
  email: string;
}

export const AOC_GIT_IDENTITY: GitIdentity = { name: 'AOC Supervisor', email: 'aoc-supervisor@localhost' };

/** A commit fully specified by its inputs, so the same object id comes out wherever it is made. */
export interface CommitSpec {
  tree: string;
  parent: string;
  message: string[];
  identity: GitIdentity;
  /** Author and committer time, in seconds since the epoch (UTC). */
  time: number;
}

/** `git commit-tree` for a spec: plumbing only (no hook, index, worktree or filter), never signed, UTF-8. */
export function commitTreeArgs(c: CommitSpec): { args: string[]; env: Record<string, string> } {
  const date = `${Math.floor(c.time)} +0000`;
  return {
    args: [
      '-c',
      'i18n.commitEncoding=UTF-8',
      'commit-tree',
      '--no-gpg-sign',
      c.tree,
      '-p',
      c.parent,
      ...c.message.flatMap((m) => ['-m', m]),
    ],
    env: {
      GIT_AUTHOR_NAME: c.identity.name,
      GIT_AUTHOR_EMAIL: c.identity.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: c.identity.name,
      GIT_COMMITTER_EMAIL: c.identity.email,
      GIT_COMMITTER_DATE: date,
    },
  };
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

/**
 * Moves `branch` of the project repository itself to `next`. `git` runs as the session user (the repository is the
 * agents' workspace), with the kernel's safety settings and the repository's filter drivers switched off. `from` is
 * the value the branch must still hold (a local target: a compare-and-swap); null accepts any value `next`
 * fast-forwards (the courtesy update after a push). A rollback's restore commit is first made again here from its
 * spec and must come out with the same id. A worktree of this repository that has the branch checked out is
 * fast-forwarded in place, with its work tree pinned to that path.
 */
export async function updateProjectBranch(
  git: GitRunner,
  repo: string,
  branch: string,
  from: string | null,
  next: string,
  restore?: CommitSpec,
): Promise<PublishResult> {
  const ref = `refs/heads/${branch}`;
  const current = await revParse(git, repo, ref);
  if (!current) return { ok: false, failed: 'branch_missing', detail: `${ref} does not exist` };
  if (from && current !== from)
    return { ok: false, refused: 'not_fast_forward', detail: `${branch} moved from ${from} to ${current}` };
  if (current === next) return { ok: true, before: current, after: next, warning: null };
  if (restore) {
    const { args, env } = commitTreeArgs(restore);
    const made = await git(repo, args, env);
    if (made.code !== 0 || made.stdout.trim() !== next)
      return {
        ok: false,
        failed: 'local_update_failed',
        detail: `the restore commit could not be made again in the project repository: ${output(made) || made.stdout.trim()}`,
      };
  }
  if ((await git(repo, ['merge-base', '--is-ancestor', current, next])).code !== 0)
    return { ok: false, refused: 'not_fast_forward', detail: `${next} does not contain ${branch} at ${current}` };
  const holder = (await listWorktrees(git, repo)).find((w) => w.branch === ref);
  if (holder) {
    // Worktree metadata is agent-writable: only a worktree of this very repository is touched.
    const own = await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const theirs = await git(holder.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (own.code !== 0 || theirs.code !== 0 || own.stdout.trim() !== theirs.stdout.trim())
      return {
        ok: false,
        failed: 'local_update_failed',
        detail: `the worktree at ${holder.path}, which has ${branch} checked out, does not belong to this repository`,
      };
    const pinned = ['--work-tree', holder.path];
    const status = await git(holder.path, [...pinned, 'status', '--porcelain']);
    if (status.code !== 0 || status.stdout.trim())
      return {
        ok: false,
        failed: 'default_branch_worktree_dirty',
        detail: `the working tree at ${holder.path} has uncommitted changes on ${branch}`,
      };
    const merged = await git(holder.path, [...pinned, 'merge', '--ff-only', '-q', next]);
    if (merged.code !== 0) return { ok: false, failed: 'local_update_failed', detail: output(merged) };
  } else {
    const updated = await git(repo, ['update-ref', ref, next, current]);
    if (updated.code !== 0) return { ok: false, failed: 'local_update_failed', detail: output(updated) };
  }
  return { ok: true, before: current, after: (await revParse(git, repo, ref)) ?? next, warning: null };
}
