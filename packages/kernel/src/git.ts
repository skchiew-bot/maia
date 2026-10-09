import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GitCommit, GitService } from '@aoc/contracts';
import { childEnv } from './child-env';

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

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
    maxBuffer: 64 * 1024 * 1024,
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

/**
 * Who git runs as in `dir`. With session isolation (G-01) aocd is root and the agents' repositories belong to the
 * session user: git there runs as that owner, so root never parses a repository an agent can write (threat model
 * T-2), and git's ownership check passes without `safe.directory`. Null: as aocd itself.
 */
export function gitOwnerOf(dir: string): { uid: number; gid: number } | null {
  if (process.geteuid?.() !== 0) return null;
  try {
    const st = statSync(dir);
    return st.uid === 0 ? null : { uid: st.uid, gid: st.gid };
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
 * git sees an allowlisted environment (no AOC_*, keys or tokens, and no inherited GIT_DIR / GIT_WORK_TREE that
 * would redirect it) plus what the caller passes explicitly, and runs as the directory's owner (gitOwnerOf).
 */
function git(dir: string, args: string[], opts: { env?: Record<string, string>; timeoutMs?: number } = {}) {
  const owner = gitOwnerOf(dir);
  const r = spawnSync('git', [...GIT_SAFETY_ARGS, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: childEnv(process.env, { GIT_TERMINAL_PROMPT: '0', ...(owner ? OWNER_ENV : {}), ...opts.env }),
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: 64 * 1024 * 1024,
    ...(owner ? { uid: owner.uid, gid: owner.gid } : {}),
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error) : '') };
}

/**
 * Env-config entries that switch off every filter driver `dir` defines: a driver's clean or process command runs on
 * `git status` and `git diff`, as whoever runs them. They go in GIT_CONFIG_KEY_n / VALUE_n because a driver name
 * may contain "=", which `-c` cannot express; they outrank the repository's config like `-c` does.
 */
export function filterDriverOverrides(dir: string): Record<string, string> {
  const names = new Set<string>();
  for (const rec of git(dir, ['config', '-z', '--get-regexp', '^filter\\.']).stdout.split('\0')) {
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
      // A read-only look at an agent's tree: no index write, no filter, diff driver or submodule worktree runs.
      const env = filterDriverOverrides(dir);
      const status = git(dir, ['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=dirty'], { env }).stdout;
      const diff = git(dir, ['--no-optional-locks', 'diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty'], { env }).stdout;
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
