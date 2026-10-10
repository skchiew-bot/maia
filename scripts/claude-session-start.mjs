#!/usr/bin/env node
/*
 * Claude Code SessionStart hook (.claude/settings.json). The same person works on this repository from two Claude
 * accounts and moves to the other one when a usage limit is reached, so a session in either account starts from what
 * is on GitHub and must learn where the work stands (CLAUDE.md, "Sessions and handoff"). In a cloud session the full
 * history is fetched (the clone is shallow, and scripts/check-docs.mjs reads every commit subject) and the dependencies
 * are installed from the lockfile. In any session, a branch that is only behind GitHub, with nothing local to lose, is
 * fast-forwarded. Then a short status goes to stdout, which Claude Code adds to the
 * session's context. A failing step reports one line and the hook still exits 0: it must never stop a session starting.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  // no or unreadable hook input: a manual run
}
const cloud = process.env.CLAUDE_CODE_REMOTE === 'true';

function run(cmd, args, timeout = 20_000) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', timeout });
  const err = (r.stderr ?? '').trim() || (r.error ? String(r.error.message) : '');
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err, status: r.status };
}
const git = (...args) => run('git', args);
const lastLine = (text) => text.split('\n').filter(Boolean).at(-1) ?? '';
const counts = (range) =>
  (git('rev-list', '--left-right', '--count', range).out || '0\t0').split('\t').map(Number);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

if (git('rev-parse', '--is-inside-work-tree').out !== 'true') process.exit(0);
const lines = [];

const shallow = git('rev-parse', '--is-shallow-repository').out === 'true';
const fetch = run(
  'git',
  [
    'fetch',
    '--quiet',
    '--prune',
    ...(cloud && shallow ? ['--unshallow'] : []),
    'origin',
    '+refs/heads/*:refs/remotes/origin/*',
  ],
  120_000,
);
if (!fetch.ok)
  lines.push(`! git fetch failed (${lastLine(fetch.err)}); the branch state below may be stale.`);

// Recorded locally so the Stop hook (scripts/claude-continuity-check.mjs) knows the default branch without the network.
const symref = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(
  run('git', ['ls-remote', '--symref', 'origin', 'HEAD']).out,
);
if (symref) git('symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${symref[1]}`);
const defaultBranch =
  symref?.[1] ??
  git('symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD').out.replace(/^origin\//, '');

// A resumed session's copy falls behind when the other account pushed meanwhile. Catch up only when nothing local can
// be lost (a clean tree, no commits of its own, no merge or rebase under way); otherwise say what to do. Before the
// install, so the lockfile it installs from is the current one.
const current = git('symbolic-ref', '-q', '--short', 'HEAD').out;
if (fetch.ok && current && git('rev-parse', '-q', '--verify', `refs/remotes/origin/${current}`).ok) {
  const [ahead, behind] = counts(`HEAD...origin/${current}`);
  const dirty = git('status', '--porcelain').out !== '';
  const busy = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply'].some((p) => {
    const path = git('rev-parse', '--git-path', p).out;
    return path !== '' && existsSync(resolve(root, path));
  });
  if (behind && !ahead && !dirty && !busy) {
    const ff = git('merge', '--ff-only', '--quiet', `origin/${current}`);
    lines.push(
      ff.ok
        ? `Caught up with GitHub: fast-forwarded ${current} by ${plural(behind, 'commit')}.`
        : `! Could not fast-forward ${current} to origin/${current}: ${lastLine(ff.err)}`,
    );
  } else if (behind && ahead) {
    lines.push(`! ${current} and origin/${current} have both moved: merge origin/${current} before pushing.`);
  } else if (behind) {
    lines.push(
      `! ${current} is behind origin/${current} with local changes: commit them, then merge origin/${current}.`,
    );
  }
}

if (
  cloud &&
  (input.source === 'startup' || input.source === undefined || !existsSync(join(root, 'node_modules')))
) {
  let install = run('pnpm', ['install', '--frozen-lockfile'], 240_000);
  if (install.status === null && /ENOENT/.test(install.err))
    install = run('corepack', ['pnpm', 'install', '--frozen-lockfile'], 240_000);
  lines.push(
    install.ok
      ? 'Dependencies installed from pnpm-lock.yaml.'
      : `! pnpm install --frozen-lockfile failed (exit ${install.status}): ${lastLine(install.err || install.out)}`,
  );
}

const branch = git('symbolic-ref', '-q', '--short', 'HEAD').out;
const head = git('rev-parse', '--short', 'HEAD').out;
const next = (ref) => git('log', '-1', '--format=%(trailers:key=Next,valueonly,separator=%x20)', ref).out;
const remoteHas = (b) => git('rev-parse', '-q', '--verify', `refs/remotes/origin/${b}`).ok;
const changed = git('status', '--porcelain').out.split('\n').filter(Boolean).length;

const where = [];
if (!branch) where.push(`detached HEAD at ${head}`);
else if (remoteHas(branch)) {
  const [ahead, behind] = counts(`HEAD...origin/${branch}`);
  where.push(`${branch} @ ${head}: ${ahead} ahead, ${behind} behind origin/${branch}`);
} else where.push(`${branch} @ ${head} (not on GitHub yet)`);
if (defaultBranch && branch !== defaultBranch && remoteHas(defaultBranch)) {
  const [ahead, behind] = counts(`HEAD...origin/${defaultBranch}`);
  where.push(`${ahead} ahead, ${behind} behind the default branch ${defaultBranch}`);
}
if (changed) where.push(plural(changed, 'uncommitted file'));
lines.push(`This session: ${where.join('; ')}.`);
if (branch && next('HEAD')) lines.push(`  Next (from the last checkpoint): ${next('HEAD')}`);

if (defaultBranch && remoteHas(defaultBranch)) {
  const others = git(
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:lstrip=3)',
    'refs/remotes/origin',
  )
    .out.split('\n')
    .filter((b) => b && b !== 'HEAD' && b !== defaultBranch && b !== branch);
  const open = [];
  const merged = [];
  for (const b of others) {
    const [behind, ahead] = counts(`origin/${defaultBranch}...origin/${b}`);
    if (!ahead) merged.push(b);
    else open.push({ b, ahead, behind });
  }
  if (open.length) {
    lines.push(`Branches with work not in ${defaultBranch} (newest first):`);
    for (const { b, ahead, behind } of open.slice(0, 6)) {
      const [when, subject] = git('log', '-1', '--format=%cr%x09%s', `origin/${b}`).out.split('\t');
      const n = next(`origin/${b}`);
      lines.push(
        `  - ${b}: ${plural(ahead, 'commit')}, ${behind} behind; ${when}: ${(subject ?? '').slice(0, 72)}${n ? ` | Next: ${n.slice(0, 80)}` : ''}`,
      );
    }
    if (open.length > 6)
      lines.push(`  … and ${open.length - 6} more (git for-each-ref refs/remotes/origin).`);
  }
  if (merged.length)
    lines.push(
      `Branches with nothing unmerged: ${merged.slice(0, 6).join(', ')}${merged.length > 6 ? ', …' : ''}.`,
    );
}
lines.push(
  'To continue a task, work on its branch and read its PR "## Handoff" section first (/pickup); never restart it on a new branch.',
);

process.stdout.write(`Session start (CLAUDE.md, "Sessions and handoff"):\n${lines.join('\n')}\n`);
