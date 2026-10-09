#!/usr/bin/env node
/*
 * Claude Code Stop hook (.claude/settings.json): a session may not finish with work that exists only in its container.
 * The same person continues this repository from a second Claude account when a usage limit is reached, and that
 * session starts from GitHub (CLAUDE.md, "Sessions and handoff"). The first time, the stop is blocked with what to
 * commit and push (exit 2, stderr). If the work is still unpushed on the stop that follows (stop_hook_active), the
 * session is let go with a warning to the user, so a push Claude cannot make never loops. On the default branch, a
 * detached HEAD or in the middle of a merge or rebase it only warns: where that work belongs is the user's call. It
 * never touches the network: "on GitHub" means reachable from a remote-tracking branch.
 * Claude Code on the web registers its own Stop hook (~/.claude/stop-hook-git-check.sh) that already blocks on
 * uncommitted, untracked and unpushed work; where it is present this one stays silent rather than say the same twice.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (
  process.env.CLAUDE_CODE_REMOTE === 'true' &&
  existsSync(join(homedir(), '.claude', 'stop-hook-git-check.sh'))
)
  process.exit(0);

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  // no or unreadable hook input: treat as a first stop
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function git(...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
}

if (git('rev-parse', '--is-inside-work-tree') !== 'true' || git('remote', 'get-url', 'origin') === null)
  process.exit(0);
const changed = (git('status', '--porcelain') ?? '').split('\n').filter(Boolean).length;
const unpushed = Number(git('rev-list', '--count', 'HEAD', '--not', '--remotes=origin') ?? 0);
if (!changed && !unpushed) process.exit(0);

const branch = git('symbolic-ref', '-q', '--short', 'HEAD');
const defaultBranch = (git('symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD') ?? '').replace(
  /^origin\//,
  '',
);
const busy = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'].some((p) => {
  const path = git('rev-parse', '--git-path', p);
  return path !== null && existsSync(resolve(root, path));
});
const what = [
  changed && `${changed} uncommitted file${changed === 1 ? '' : 's'}`,
  unpushed && `${unpushed} commit${unpushed === 1 ? '' : 's'} not on GitHub`,
]
  .filter(Boolean)
  .join(' and ');

if (!branch || branch === defaultBranch || busy || input.stop_hook_active) {
  const on = !branch
    ? 'a detached HEAD'
    : busy
      ? `${branch} (a merge or rebase is in progress)`
      : branch === defaultBranch
        ? `the default branch ${branch}`
        : branch;
  process.stdout.write(
    JSON.stringify({
      systemMessage: `${what} on ${on}: your other Claude account will not see this until it is pushed.`,
    }),
  );
  process.exit(0);
}
process.stderr.write(
  `This session has ${what} on ${branch}. A session in the other Claude account starts from GitHub and will not see ` +
    'them (CLAUDE.md, "Sessions and handoff"). Before finishing: commit (a `wip:` subject is fine while checks are red), ' +
    `\`git push -u origin ${branch}\`, and update the "## Handoff" section of the branch's PR. If the work should be ` +
    'discarded instead, ask the user.\n',
);
process.exit(2);
