/**
 * Working directories for the demo's long-lived sessions (the live fleet, and the seeded sessions that work again).
 *
 * A session that edits files in the project's own checkout leaves it dirty, and a promotion or rollback refuses to
 * fast-forward a checked-out `main` with uncommitted changes (mod-change: `default_branch_worktree_dirty`). The gates
 * the demo leaves open would then fail whenever a fleet session happened to be writing. So those sessions work in
 * linked worktrees under `supervisor.workspacesDir/<projectId>/` (a place a session may work), detached at the tip of
 * `main`, and the checkout the gates move stays clean. Intake builds need no workspace: they commit what they change.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DemoLayout } from './layout';

const ISOLATED = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

function git(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ISOLATED } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || r.stdout).trim()}`);
}

/** Where the named long-lived session of a project works. */
export const workspaceDir = (layout: DemoLayout, projectId: string, name: string): string => join(layout.workspaces, projectId, name);

/**
 * The workspace `dir` of the project repository `repo`: created on first use, otherwise brought back to the tip of
 * `main` with nothing left over from the session that used it before.
 */
export function ensureWorkspace(repo: string, dir: string): string {
  if (existsSync(join(dir, '.git'))) {
    git(dir, ['checkout', '--quiet', '--force', '--detach', 'main']);
    git(dir, ['clean', '--quiet', '--force', '-d']);
    return dir;
  }
  mkdirSync(dirname(dir), { recursive: true });
  git(repo, ['worktree', 'prune']);
  git(repo, ['worktree', 'add', '--quiet', '--detach', dir, 'main']);
  return dir;
}
