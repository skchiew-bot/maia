// Scenario tests for the Claude Code session hooks (.claude/settings.json): scripts/claude-session-start.mjs
// (SessionStart) and scripts/claude-continuity-check.mjs (Stop). Each test builds a throwaway clone of a local bare
// origin, commits copies of both hooks into it (they resolve the repository from their own path), and runs them with
// a minimal environment: no network, no global git config, and a fake pnpm that records its arguments.
// Run: node --test scripts/test/session-hooks.test.mjs
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = ['claude-session-start.mjs', 'claude-continuity-check.mjs'];

let tmp;
let origin;
let work;
let home;
let pnpmLog;

const baseEnv = () => ({
  PATH: `${join(tmp, 'bin')}:${process.env.PATH ?? ''}`,
  HOME: home,
  LANG: 'C.UTF-8',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  FAKE_PNPM_LOG: pnpmLog,
});

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: baseEnv(), encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(cwd, file, subject, body = '') {
  writeFileSync(join(cwd, file), `${subject}\n`);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', body ? `${subject}\n\n${body}` : subject);
}

function hook(name, { input = {}, env = {}, cwd = work, repo = work } = {}) {
  const r = spawnSync('node', [join(repo, 'scripts', name)], {
    cwd,
    env: { ...baseEnv(), ...env },
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const start = (opts) => hook('claude-session-start.mjs', opts);
const stop = (opts) => hook('claude-continuity-check.mjs', opts);
const pnpmCalls = () => (existsSync(pnpmLog) ? readFileSync(pnpmLog, 'utf8').split('\n').filter(Boolean) : []);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'aoc-session-hooks-'));
  origin = join(tmp, 'origin.git');
  work = join(tmp, 'work');
  home = join(tmp, 'home');
  pnpmLog = join(tmp, 'pnpm.log');
  mkdirSync(home);
  mkdirSync(join(tmp, 'bin'));
  writeFileSync(
    join(tmp, 'bin', 'pnpm'),
    '#!/bin/sh\necho "$*" >> "$FAKE_PNPM_LOG"\n[ -n "$FAKE_PNPM_EXIT" ] && { echo "fake pnpm failure" >&2; exit "$FAKE_PNPM_EXIT"; }\nexit 0\n',
  );
  chmodSync(join(tmp, 'bin', 'pnpm'), 0o755);

  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = join(tmp, 'seed');
  git(tmp, 'init', '-q', '-b', 'main', seed);
  mkdirSync(join(seed, 'scripts'));
  for (const h of HOOKS) copyFileSync(join(scripts, h), join(seed, 'scripts', h));
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'push', '-q', origin, 'main');
  git(tmp, 'clone', '-q', origin, work);
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** A feature branch pushed to origin, so the work tree starts with nothing unpushed. */
function onPushedBranch(name = 'feature') {
  git(work, 'checkout', '-q', '-b', name);
  commit(work, `${name}.txt`, `${name} work`);
  git(work, 'push', '-q', '-u', 'origin', name);
}

describe('Stop hook: claude-continuity-check.mjs', () => {
  test('lets a session stop silently when everything is pushed', () => {
    onPushedBranch();
    const r = stop();
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  });

  test('blocks the first stop on an uncommitted tracked change', () => {
    onPushedBranch();
    writeFileSync(join(work, 'README.md'), 'changed\n');
    const r = stop();
    assert.equal(r.status, 2);
    assert.match(r.stderr, /1 uncommitted file on feature\./);
    assert.match(r.stderr, /git push -u origin feature/);
  });

  test('blocks the first stop on an untracked file', () => {
    onPushedBranch();
    writeFileSync(join(work, 'new.txt'), 'new\n');
    const r = stop();
    assert.equal(r.status, 2);
    assert.match(r.stderr, /1 uncommitted file on feature/);
  });

  test('blocks the first stop on a commit not on GitHub', () => {
    onPushedBranch();
    commit(work, 'more.txt', 'more work');
    const r = stop();
    assert.equal(r.status, 2);
    assert.match(r.stderr, /1 commit not on GitHub on feature/);
  });

  test('names both uncommitted files and unpushed commits, pluralised', () => {
    onPushedBranch();
    commit(work, 'a.txt', 'a');
    commit(work, 'b.txt', 'b');
    writeFileSync(join(work, 'x.txt'), 'x\n');
    writeFileSync(join(work, 'y.txt'), 'y\n');
    const r = stop();
    assert.equal(r.status, 2);
    assert.match(r.stderr, /2 uncommitted files and 2 commits not on GitHub on feature/);
  });

  test('blocks on a new branch whose commit exists only locally', () => {
    git(work, 'checkout', '-q', '-b', 'fresh');
    commit(work, 'fresh.txt', 'fresh work');
    const r = stop();
    assert.equal(r.status, 2);
    assert.match(r.stderr, /1 commit not on GitHub on fresh/);
  });

  test('a new branch with no commits of its own has nothing to push', () => {
    git(work, 'checkout', '-q', '-b', 'empty');
    const r = stop();
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  test('lets the second stop through with a warning (stop_hook_active)', () => {
    onPushedBranch();
    commit(work, 'more.txt', 'more work');
    const r = stop({ input: { stop_hook_active: true } });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    assert.match(
      JSON.parse(r.stdout).systemMessage,
      /^1 commit not on GitHub on feature: your other Claude account will not see this until it is pushed\.$/,
    );
  });

  test('only warns on the default branch', () => {
    commit(work, 'main.txt', 'local main work');
    git(work, 'remote', 'set-head', 'origin', 'main');
    const r = stop();
    assert.equal(r.status, 0);
    assert.match(JSON.parse(r.stdout).systemMessage, /1 commit not on GitHub on the default branch main:/);
  });

  test('only warns on a detached HEAD', () => {
    onPushedBranch();
    git(work, 'checkout', '-q', '--detach');
    writeFileSync(join(work, 'README.md'), 'changed\n');
    const r = stop();
    assert.equal(r.status, 0);
    assert.match(JSON.parse(r.stdout).systemMessage, /1 uncommitted file on a detached HEAD:/);
  });

  test('only warns while a merge is in progress', () => {
    onPushedBranch();
    commit(work, 'clash.txt', 'feature side');
    git(work, 'checkout', '-q', '-b', 'other', 'main');
    commit(work, 'clash.txt', 'other side');
    git(work, 'checkout', '-q', 'feature');
    const merge = spawnSync('git', ['merge', '-q', 'other'], { cwd: work, env: baseEnv(), encoding: 'utf8' });
    assert.notEqual(merge.status, 0, 'the merge should stop on a conflict');
    const r = stop();
    assert.equal(r.status, 0);
    assert.match(JSON.parse(r.stdout).systemMessage, /on feature \(a merge or rebase is in progress\):/);
  });

  test('treats unreadable hook input as a first stop', () => {
    onPushedBranch();
    commit(work, 'more.txt', 'more work');
    const r = stop({ input: 'not json' });
    assert.equal(r.status, 2);
  });

  test('stays silent in Claude Code on the web, whose own Stop hook checks the same', () => {
    onPushedBranch();
    commit(work, 'more.txt', 'more work');
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', 'stop-hook-git-check.sh'), '#!/bin/sh\n');
    const r = stop({ env: { CLAUDE_CODE_REMOTE: 'true' } });
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, '');
  });

  test('still blocks in a remote session without the web Stop hook', () => {
    onPushedBranch();
    commit(work, 'more.txt', 'more work');
    const r = stop({ env: { CLAUDE_CODE_REMOTE: 'true' } });
    assert.equal(r.status, 2);
  });

  test('does nothing in a repository without an origin remote', () => {
    git(work, 'remote', 'remove', 'origin');
    writeFileSync(join(work, 'new.txt'), 'new\n');
    const r = stop();
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, '');
  });

  test('does nothing outside a git repository', () => {
    const plain = join(tmp, 'plain');
    mkdirSync(join(plain, 'scripts'), { recursive: true });
    copyFileSync(join(scripts, 'claude-continuity-check.mjs'), join(plain, 'scripts', 'claude-continuity-check.mjs'));
    const r = stop({ cwd: plain, repo: plain, env: { GIT_CEILING_DIRECTORIES: tmp } });
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, '');
  });
});

describe('SessionStart hook: claude-session-start.mjs', () => {
  test('reports the branch against GitHub and the default branch, and records origin/HEAD', () => {
    onPushedBranch();
    git(work, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    const r = start();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^Session start \(CLAUDE\.md, "Sessions and handoff"\):\n/);
    const head = git(work, 'rev-parse', '--short', 'HEAD');
    assert.match(
      r.stdout,
      new RegExp(`This session: feature @ ${head}: 0 ahead, 0 behind origin/feature; 1 ahead, 0 behind the default branch main\\.`),
    );
    assert.equal(git(work, 'symbolic-ref', 'refs/remotes/origin/HEAD'), 'refs/remotes/origin/main');
    assert.match(r.stdout, /never restart it on a new branch\.\n$/);
  });

  test('counts local commits ahead of and behind the remote branch', () => {
    onPushedBranch();
    const other = join(tmp, 'other');
    git(tmp, 'clone', '-q', '-b', 'feature', origin, other);
    commit(other, 'remote.txt', 'pushed elsewhere');
    git(other, 'push', '-q');
    commit(work, 'local.txt', 'local only');
    const r = start();
    assert.match(r.stdout, /feature @ \w+: 1 ahead, 1 behind origin\/feature/);
  });

  /** Another clone pushes one commit to feature, as the other account's session would. */
  function pushedElsewhere() {
    const other = join(tmp, 'other');
    git(tmp, 'clone', '-q', '-b', 'feature', origin, other);
    commit(other, 'remote.txt', 'pushed elsewhere');
    git(other, 'push', '-q');
    return git(other, 'rev-parse', 'HEAD');
  }

  test('fast-forwards a clean branch that is only behind GitHub', () => {
    onPushedBranch();
    const remoteHead = pushedElsewhere();
    const r = start();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Caught up with GitHub: fast-forwarded feature by 1 commit\.\n/);
    assert.equal(git(work, 'rev-parse', 'HEAD'), remoteHead);
    assert.match(r.stdout, /feature @ \w+: 0 ahead, 0 behind origin\/feature/);
  });

  test('leaves a branch that is behind with local changes, and says what to do', () => {
    onPushedBranch();
    pushedElsewhere();
    const before = git(work, 'rev-parse', 'HEAD');
    writeFileSync(join(work, 'feature.txt'), 'edited\n');
    const r = start();
    assert.equal(git(work, 'rev-parse', 'HEAD'), before);
    assert.match(
      r.stdout,
      /! feature is behind origin\/feature with local changes: commit them, then merge origin\/feature\./,
    );
  });

  test('leaves a branch that is behind mid-merge, and says to finish the merge first', () => {
    onPushedBranch();
    pushedElsewhere();
    git(work, 'checkout', '-q', '-b', 'side', 'main');
    commit(work, 'feature.txt', 'side version');
    git(work, 'checkout', '-q', 'feature');
    const merge = spawnSync('git', ['merge', '-q', 'side'], { cwd: work, env: baseEnv(), encoding: 'utf8' });
    assert.notEqual(merge.status, 0, 'the merge should stop on a conflict');
    const before = git(work, 'rev-parse', 'HEAD');
    const r = start();
    assert.equal(git(work, 'rev-parse', 'HEAD'), before);
    assert.match(
      r.stdout,
      /! feature is behind origin\/feature while a merge or rebase is in progress: finish or abort it, then merge origin\/feature\./,
    );
    assert.doesNotMatch(r.stdout, /with local changes/);
  });

  test('leaves a branch that has diverged from GitHub, and says to merge', () => {
    onPushedBranch();
    pushedElsewhere();
    commit(work, 'local.txt', 'local only');
    const before = git(work, 'rev-parse', 'HEAD');
    const r = start();
    assert.equal(git(work, 'rev-parse', 'HEAD'), before);
    assert.match(
      r.stdout,
      /! feature and origin\/feature have both moved: merge origin\/feature before pushing\./,
    );
  });

  test('does not fast-forward when the fetch failed', () => {
    onPushedBranch();
    pushedElsewhere();
    git(work, 'fetch', '-q');
    const before = git(work, 'rev-parse', 'HEAD');
    git(work, 'remote', 'set-url', 'origin', join(tmp, 'missing.git'));
    const r = start();
    assert.equal(git(work, 'rev-parse', 'HEAD'), before);
    assert.doesNotMatch(r.stdout, /Caught up/);
  });

  test('says when the branch is not on GitHub yet', () => {
    git(work, 'checkout', '-q', '-b', 'fresh');
    const r = start();
    assert.match(r.stdout, /This session: fresh @ \w+ \(not on GitHub yet\); 0 ahead, 0 behind the default branch main\./);
  });

  test('reports a detached HEAD', () => {
    git(work, 'checkout', '-q', '--detach');
    const r = start();
    assert.match(r.stdout, /This session: detached HEAD at \w+/);
    assert.doesNotMatch(r.stdout, /Next \(from the last checkpoint\)/);
  });

  test('counts uncommitted files, untracked included', () => {
    onPushedBranch();
    writeFileSync(join(work, 'README.md'), 'changed\n');
    writeFileSync(join(work, 'new.txt'), 'new\n');
    const r = start();
    assert.match(r.stdout, /; 2 uncommitted files\./);
  });

  test("shows the Next trailer of this branch's last checkpoint", () => {
    onPushedBranch();
    commit(work, 'wip.txt', 'wip: half done', 'Next: wire the projector into the daemon');
    const r = start();
    assert.match(r.stdout, /\n {2}Next \(from the last checkpoint\): wire the projector into the daemon\n/);
  });

  test('lists other branches with unmerged work and their Next, and the merged ones', () => {
    onPushedBranch('open-task');
    commit(work, 'wip.txt', 'wip: open task', 'Next: add the missing test');
    git(work, 'push', '-q');
    git(work, 'checkout', '-q', '-b', 'merged-task', 'main');
    git(work, 'push', '-q', '-u', 'origin', 'merged-task');
    git(work, 'checkout', '-q', 'main');
    const r = start();
    assert.match(r.stdout, /Branches with work not in main \(newest first\):\n/);
    assert.match(r.stdout, /  - open-task: 2 commits, 0 behind; .+: wip: open task \| Next: add the missing test\n/);
    assert.match(r.stdout, /Branches with nothing unmerged: merged-task\./);
    assert.doesNotMatch(r.stdout, /  - main:/);
  });

  test('lists at most six open branches and counts the rest', () => {
    for (let i = 1; i <= 8; i++) {
      git(work, 'checkout', '-q', '-b', `task-${i}`, 'main');
      commit(work, `t${i}.txt`, `task ${i}`);
      git(work, 'push', '-q', '-u', 'origin', `task-${i}`);
    }
    git(work, 'checkout', '-q', 'main');
    const r = start();
    assert.equal((r.stdout.match(/^ {2}- task-/gm) ?? []).length, 6);
    assert.match(r.stdout, /… and 2 more \(git for-each-ref refs\/remotes\/origin\)\./);
  });

  test('reports a failed fetch and still exits 0', () => {
    git(work, 'remote', 'set-url', 'origin', join(tmp, 'missing.git'));
    const r = start();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /! git fetch failed \(.+\); the branch state below may be stale\./);
    assert.match(r.stdout, /This session: main @ \w+/);
  });

  test('unshallows a shallow clone in a cloud session', () => {
    commit(work, 'two.txt', 'second');
    git(work, 'push', '-q');
    const shallow = join(tmp, 'shallow');
    git(tmp, 'clone', '-q', '--depth', '1', `file://${origin}`, shallow);
    assert.equal(git(shallow, 'rev-parse', '--is-shallow-repository'), 'true');
    const r = start({ cwd: shallow, repo: shallow, env: { CLAUDE_CODE_REMOTE: 'true' } });
    assert.equal(r.status, 0);
    assert.equal(git(shallow, 'rev-parse', '--is-shallow-repository'), 'false');
    assert.equal(git(shallow, 'rev-list', '--count', 'HEAD'), '2');
  });

  test('leaves a shallow clone shallow outside the cloud', () => {
    const shallow = join(tmp, 'shallow');
    commit(work, 'two.txt', 'second');
    git(work, 'push', '-q');
    git(tmp, 'clone', '-q', '--depth', '1', `file://${origin}`, shallow);
    start({ cwd: shallow, repo: shallow });
    assert.equal(git(shallow, 'rev-parse', '--is-shallow-repository'), 'true');
  });

  test('installs dependencies from the lockfile at a cloud startup', () => {
    const r = start({ input: { source: 'startup' }, env: { CLAUDE_CODE_REMOTE: 'true' } });
    assert.deepEqual(pnpmCalls(), ['install --frozen-lockfile']);
    assert.match(r.stdout, /\nDependencies installed from pnpm-lock\.yaml\.\n/);
  });

  test('skips the install on a cloud resume when node_modules exists', () => {
    mkdirSync(join(work, 'node_modules'));
    const r = start({ input: { source: 'resume' }, env: { CLAUDE_CODE_REMOTE: 'true' } });
    assert.deepEqual(pnpmCalls(), []);
    assert.doesNotMatch(r.stdout, /Dependencies installed/);
  });

  test('installs on a cloud compaction when node_modules is missing', () => {
    start({ input: { source: 'compact' }, env: { CLAUDE_CODE_REMOTE: 'true' } });
    assert.deepEqual(pnpmCalls(), ['install --frozen-lockfile']);
  });

  test('never installs outside the cloud', () => {
    start({ input: { source: 'startup' } });
    assert.deepEqual(pnpmCalls(), []);
  });

  test('reports a failed install and still exits 0', () => {
    const r = start({ input: { source: 'startup' }, env: { CLAUDE_CODE_REMOTE: 'true', FAKE_PNPM_EXIT: '3' } });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /! pnpm install --frozen-lockfile failed \(exit 3\): fake pnpm failure\n/);
    assert.match(r.stdout, /This session: main/);
  });

  test('prints nothing outside a git repository', () => {
    const plain = join(tmp, 'plain');
    mkdirSync(join(plain, 'scripts'), { recursive: true });
    copyFileSync(join(scripts, 'claude-session-start.mjs'), join(plain, 'scripts', 'claude-session-start.mjs'));
    const r = start({ cwd: plain, repo: plain, env: { GIT_CEILING_DIRECTORIES: tmp } });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});
