import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitAsyncResult, GitCommit, GitService } from '@aoc/contracts';
import { childEnv } from './child-env';

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Transports git knows natively. Each is denied by name: a repository's own `protocol.<name>.allow` outranks `protocol.allow`. */
const TRANSPORTS = ['file', 'git', 'ssh', 'http', 'https', 'ftp', 'ftps', 'ext'] as const;

/**
 * Command-line settings on every git process AOC starts (threat model T-2, gap G-04). Command-line config outranks a
 * repository's own, so whatever an agent wrote into `.git/config` or `.git/hooks` of a repository AOC reads, git runs
 * no hook, fsmonitor command, signing or verification program, submodule recursion or automatic gc, and opens no
 * transport (a crafted partial clone cannot lazy-fetch through `core.sshCommand` or a local remote's `uploadpack`).
 * An operation that needs one transport allows it after these: the later `-c` wins.
 */
export const GIT_SAFETY_ARGS: readonly string[] = Object.entries({
  'core.hooksPath': '/dev/null',
  'core.fsmonitor': 'false',
  'core.attributesFile': '/dev/null',
  'log.showSignature': 'false',
  'commit.gpgSign': 'false',
  'tag.gpgSign': 'false',
  // %G? and friends verify signatures whatever log.showSignature says: no repository-chosen program may run.
  'gpg.program': '/dev/null',
  'gpg.openpgp.program': '/dev/null',
  'gpg.x509.program': '/dev/null',
  'gpg.ssh.program': '/dev/null',
  'submodule.recurse': 'false',
  'fetch.recurseSubmodules': 'false',
  'gc.auto': '0',
  'maintenance.auto': 'false',
  'protocol.allow': 'never',
  ...Object.fromEntries(TRANSPORTS.map((t) => [`protocol.${t}.allow`, 'never'])),
}).flatMap(([k, v]) => ['-c', `${k}=${v}`]);

/**
 * Environment of git in a repository AOC owns (mod-change's service clones): no system or global config (an agent
 * that could write aocd's home could otherwise plant hooks, aliases, `url.*.insteadOf` or credential helpers there),
 * no prompt, no lazy fetch, no home directory.
 */
export const GIT_SERVICE_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1',
  HOME: '/nonexistent',
};

const SERVICE_ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'] as const;

/** PATH and locale from `source`, then GIT_SERVICE_ENV, then `extra`: nothing else of aocd's environment. */
export function serviceGitEnv(
  extra: Record<string, string> = {},
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of SERVICE_ENV_ALLOWLIST) {
    const v = source[k];
    if (typeof v === 'string') env[k] = v;
  }
  return { ...env, ...GIT_SERVICE_ENV, ...extra };
}

const spawnGit = (dir: string, args: string[], env: Record<string, string>, timeoutMs = 60_000): GitRunResult => {
  const r = spawnSync('git', [...GIT_SAFETY_ARGS, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env,
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error) : '') };
};

/** git in a repository AOC owns: argv only, GIT_SAFETY_ARGS first, a scrubbed environment (serviceGitEnv). */
export function runServiceGit(
  dir: string,
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): GitRunResult {
  return spawnGit(dir, args, serviceGitEnv(opts.env), opts.timeoutMs);
}

type GitOwner = { uid: number; gid: number };
const ownerFrom = (st: GitOwner): GitOwner | null => (st.uid === 0 ? null : { uid: st.uid, gid: st.gid });

/**
 * Who git runs as in `dir`. With session isolation (G-01) aocd is root and the agents' repositories belong to the
 * session user: git there runs as that owner, so root never parses a repository an agent can write (threat model
 * T-2), and git's ownership check passes without `safe.directory`. Null: as aocd itself.
 */
export function gitOwnerOf(dir: string): GitOwner | null {
  if (process.geteuid?.() !== 0) return null;
  try {
    return ownerFrom(statSync(dir));
  } catch {
    return null;
  }
}

/** `gitOwnerOf` for the async runner: a stalled file system must not hold aocd's thread in the stat either. */
async function gitOwnerOfAsync(dir: string): Promise<GitOwner | null> {
  if (process.geteuid?.() !== 0) return null;
  try {
    return ownerFrom(await stat(dir));
  } catch {
    return null;
  }
}

/** What git as another user needs instead of root's account: no home, no system or global config. */
const OWNER_ENV = { HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/** Switches to a uid/gid (aocd is root), then runs the rest of argv with this process's stdio. */
const SWITCH_USER = [
  'const [uid, gid, ...cmd] = process.argv.slice(1);',
  'process.setgroups([]); process.setgid(Number(gid)); process.setuid(Number(uid));',
  "const r = require('node:child_process').spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });",
  'process.exit(r.status ?? 1);',
].join(' ');
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The `--upload-pack` command for fetching from `repo` when someone other than root owns it (G-01): git's server
 * side runs as that owner, while the fetching side — and the repository it writes — stays aocd's. Null: the
 * default upload-pack will do. git runs it through `sh -c` with the repository path appended.
 */
export function uploadPackFor(repo: string): string | null {
  const owner = gitOwnerOf(repo);
  if (!owner) return null;
  return [process.execPath, '-e', SWITCH_USER, String(owner.uid), String(owner.gid), 'git', ...GIT_SAFETY_ARGS, 'upload-pack']
    .map(shellQuote)
    .join(' ');
}

/**
 * How every git process in `dir` starts, sync or async: GIT_SAFETY_ARGS first; an allowlisted environment (no AOC_*,
 * keys or tokens, and no inherited GIT_DIR / GIT_WORK_TREE that would redirect it) plus what the caller passes
 * explicitly; and the directory's owner's identity, if it is not aocd's (gitOwnerOf).
 */
function invocation(args: string[], extra: Record<string, string> | undefined, owner: GitOwner | null) {
  return {
    argv: [...GIT_SAFETY_ARGS, ...args],
    env: childEnv(process.env, { GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', ...(owner ? OWNER_ENV : {}), ...extra }),
    ids: owner ? { uid: owner.uid, gid: owner.gid } : {},
  };
}

function git(dir: string, args: string[], opts: { env?: Record<string, string>; timeoutMs?: number } = {}) {
  const { argv, env, ids } = invocation(args, opts.env, gitOwnerOf(dir));
  const r = spawnSync('git', argv, {
    cwd: dir,
    encoding: 'utf8',
    env,
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: MAX_OUTPUT_BYTES,
    ...ids,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error) : '') };
}

/**
 * `git()` for callers on aocd's single thread: the event loop keeps serving while git runs, and a timeout kills git
 * together with whatever it started (a filter, ssh, a hook) instead of waiting for them. Never rejects: a spawn
 * failure is code 1; a timeout is code 124 with `timedOut` and no stdout, because half an answer must not pass for one.
 */
async function gitAsync(
  dir: string,
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<GitAsyncResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const verb = args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? 'git';
  const { argv, env, ids } = invocation(args, opts.env, await gitOwnerOfAsync(dir));
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn('git', argv, {
        cwd: dir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group: one signal then reaches everything git started.
        detached: true,
        ...ids,
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
 * Env-config entries that switch off every filter driver `dir` defines: a driver's clean or process command runs on
 * `git status` and `git diff`, as whoever runs them. They go in GIT_CONFIG_KEY_n / VALUE_n because a driver name
 * may contain "=", which `-c` cannot express; they outrank the repository's config like `-c` does.
 */
function filterOverridesFrom(configOutput: string): Record<string, string> {
  const names = new Set<string>();
  for (const rec of configOutput.split('\0')) {
    const m = /^filter\.(.+)\.[a-z]+$/s.exec(rec.split('\n', 1)[0] ?? '');
    if (m) names.add(m[1]!);
  }
  const entries = [...names].flatMap((n) => [
    [`filter.${n}.clean`, ''],
    [`filter.${n}.smudge`, ''],
    [`filter.${n}.process`, ''],
    [`filter.${n}.required`, 'false'],
  ]);
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k!;
    env[`GIT_CONFIG_VALUE_${i}`] = v!;
  });
  return env;
}

const FILTER_CONFIG = ['config', '-z', '--get-regexp', '^filter\\.'];
export function filterDriverOverrides(dir: string): Record<string, string> {
  return filterOverridesFrom(git(dir, FILTER_CONFIG).stdout);
}

/** The commands of the fingerprint: read-only, no index write, no filter, diff driver or submodule worktree runs. */
const STATUS_ARGS = [
  '--no-optional-locks',
  'status',
  '--porcelain=v1',
  '--untracked-files=all',
  '--ignore-submodules=dirty',
];
const DIFF_ARGS = [
  '--no-optional-locks',
  'diff',
  'HEAD',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--ignore-submodules=dirty',
];
const HEAD_ARGS = ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'];

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

/** `workingTreeFingerprint` for aocd's thread: null when git cannot describe the tree, `timedOut` when it did not answer. */
async function fingerprintAsync(
  dir: string,
  timeoutMs?: number,
): Promise<{ fingerprint: string | null; timedOut: boolean }> {
  const config = await gitAsync(dir, FILTER_CONFIG, { timeoutMs });
  if (config.timedOut) return { fingerprint: null, timedOut: true };
  const env = filterOverridesFrom(config.stdout);
  const [head, status, diff] = await Promise.all([
    gitAsync(dir, HEAD_ARGS, { timeoutMs }),
    gitAsync(dir, STATUS_ARGS, { env, timeoutMs }),
    gitAsync(dir, DIFF_ARGS, { env, timeoutMs }),
  ]);
  if (head.timedOut || status.timedOut || diff.timedOut) return { fingerprint: null, timedOut: true };
  // Not a repository, or one git will not read: no fingerprint, never one made of an empty answer.
  if (status.code !== 0) return { fingerprint: null, timedOut: false };
  const sha = head.code === 0 ? head.stdout.trim() : null;
  // Without a commit there is nothing to diff against.
  if (sha !== null && diff.code !== 0) return { fingerprint: null, timedOut: false };
  const fingerprint = workingTreeFingerprintOf({
    head: sha,
    status: status.stdout,
    diff: sha === null ? '' : diff.stdout,
  });
  return { fingerprint, timedOut: false };
}

/** Thin wrapper over the git CLI (argument arrays only — never a shell; GIT_SAFETY_ARGS on every call). */
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
      const env = filterDriverOverrides(dir);
      const status = git(dir, STATUS_ARGS, { env }).stdout;
      const diff = git(dir, DIFF_ARGS, { env }).stdout;
      return workingTreeFingerprintOf({ head: svc.head(dir), status, diff });
    },
    workingTreeFingerprintAsync: (dir, opts) => fingerprintAsync(dir, opts?.timeoutMs),
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
