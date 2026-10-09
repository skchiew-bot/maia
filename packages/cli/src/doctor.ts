/**
 * `aoc doctor`: credential-isolation posture (§3, R1) plus health. Every check reads through injected
 * env / fs / git / probe so it is testable, and reports NAMES only — never a secret's value or a key's
 * contents.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { HOOK_EVENTS } from '@aoc/contracts';
import type { GitRunner } from './deps';
import { inspectObservedHooks } from './observed-hooks';

export const RUNBOOK_PATH = 'docs/runbooks/credential-isolation.md';
/** Marker the AOC pre-push guard script carries. */
export const PRE_PUSH_GUARD_MARKER = 'aoc:pre-push-guard';
const GUARD_RE = /aoc[\s:_-]*pre-push[\s:_-]*guard/i;

/** Deploy-grade secrets that must live only in supervisor-controlled session envs. `*` = any characters. */
export const DEPLOY_SECRET_ENV_PATTERNS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AZURE_*',
  'GOOGLE_APPLICATION_CREDENTIALS',
  '*_DEPLOY_*',
  'NPM_TOKEN',
  'VERCEL_TOKEN',
  'FLY_API_TOKEN',
  'KUBECONFIG',
] as const;

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';
export type Verdict = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorFs {
  exists(path: string): boolean;
  isFile(path: string): boolean;
  readdir(path: string): string[];
  /** First `bytes` of a file as text, or null when unreadable. */
  readHead(path: string, bytes: number): string | null;
  readText(path: string): string | null;
  /** Permission bits, or null when the path does not exist. */
  mode(path: string): number | null;
}

export interface DaemonProbe {
  reachable: boolean;
  status: number | null;
  user: { id: string; name: string; role: string } | null;
  error: string | null;
}

export interface DoctorInput {
  env: Record<string, string | undefined>;
  homeDir: string;
  cwd: string;
  platform: NodeJS.Platform;
  fs: DoctorFs;
  git: GitRunner;
  daemonUrl: string;
  tokenPresent: boolean;
  probe(): Promise<DaemonProbe>;
  configPath: string;
  observerTokenPresent: boolean;
  settingsPath: string;
}

export const nodeDoctorFs: DoctorFs = {
  exists: (p) => existsSync(p),
  isFile: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  readdir: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
  readHead: (p, bytes) => {
    let fd: number | null = null;
    try {
      fd = openSync(p, 'r');
      const buf = Buffer.alloc(bytes);
      const n = readSync(fd, buf, 0, bytes, 0);
      return buf.subarray(0, n).toString('utf8');
    } catch {
      return null;
    } finally {
      if (fd !== null) closeSync(fd);
    }
  },
  readText: (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  mode: (p) => {
    try {
      return statSync(p).mode & 0o777;
    } catch {
      return null;
    }
  },
};

function globToRegex(glob: string): RegExp {
  const body = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${body}$`, 'i');
}
const SECRET_RES = DEPLOY_SECRET_ENV_PATTERNS.map(globToRegex);

/**
 * Names of non-empty env vars that look like deploy-grade credentials. The name is matched first, so only
 * those variables' values are read (to tell set from empty), and values are never returned.
 */
export function deploySecretEnvNames(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter((name) => SECRET_RES.some((re) => re.test(name)) && (env[name] ?? '').trim() !== '')
    .sort();
}

const SSH_NOT_KEYS = /^(known_hosts.*|authorized_keys.*|config|environment|rc|.*\.pub|.*\.sock|.*\.socket)$/;

/** Names of private keys in ~/.ssh (by PEM/OpenSSH/PuTTY header or the id_* convention). */
export function sshPrivateKeyNames(sshDir: string, fs: DoctorFs): string[] {
  return fs
    .readdir(sshDir)
    .filter((name) => !SSH_NOT_KEYS.test(name) && fs.isFile(join(sshDir, name)))
    .filter((name) => {
      // Just enough bytes for the header line — never the key material.
      const head = fs.readHead(join(sshDir, name), 40) ?? '';
      return /PRIVATE KEY-----|^PuTTY-User-Key-File-/m.test(head) || /^id_[A-Za-z0-9_-]+$/.test(name);
    })
    .sort();
}

/** A displayable name for a credential.helper value — inline shell helpers may embed secrets, so never echo them. */
export function helperName(value: string): string {
  const v = value.trim();
  if (v.startsWith('!'))
    return /\bgh\s+auth\s+git-credential\b/.test(v) ? 'gh auth git-credential' : 'inline shell helper';
  return basename(v.split(/\s+/)[0] ?? v);
}

export function gitCredentialHelpers(
  git: GitRunner,
  cwd: string,
): { helpers: string[]; gitAvailable: boolean } {
  const pattern = '^credential\\..*helper$';
  let r = git(['config', '--show-scope', '--get-regexp', pattern], cwd);
  let scoped = true;
  if (r.code === 129) {
    r = git(['config', '--get-regexp', pattern], cwd); // git < 2.26 has no --show-scope
    scoped = false;
  }
  if (r.code === 127) return { helpers: [], gitAvailable: false };
  const helpers = new Set<string>();
  for (const line of r.code === 0 ? r.stdout.split('\n') : []) {
    const parts = line.trim().split(/\s+/);
    const [scope, , ...value] = scoped ? parts : ['', ...parts];
    const name = helperName(value.join(' '));
    if (name) helpers.add(scope ? `${name} (${scope})` : name);
  }
  return { helpers: [...helpers], gitAvailable: true };
}

function hooksDirFallback(cwd: string, fs: DoctorFs): string | null {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git');
    if (fs.exists(dotGit)) {
      if (!fs.isFile(dotGit)) return join(dotGit, 'hooks');
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readText(dotGit) ?? '');
      if (!m) return null;
      const gitDir = resolve(dir, m[1]!.trim());
      const common = fs.readText(join(gitDir, 'commondir'));
      return join(common ? resolve(gitDir, common.trim()) : gitDir, 'hooks');
    }
    if (dirname(dir) === dir) return null;
  }
}

/** Path of the current repo's pre-push hook (honours worktrees and core.hooksPath), or null outside a repo. */
export function prePushPath(git: GitRunner, cwd: string, fs: DoctorFs): string | null {
  const r = git(['rev-parse', '--git-path', 'hooks/pre-push'], cwd);
  if (r.code === 0 && r.stdout.trim()) return resolve(cwd, r.stdout.trim());
  if (r.code === 127) {
    const dir = hooksDirFallback(cwd, fs);
    return dir ? join(dir, 'pre-push') : null;
  }
  return null;
}

// ── checks ───────────────────────────────────────────────────────────────────
function check(id: string, label: string, status: CheckStatus, detail: string): DoctorCheck {
  return { id, label, status, detail };
}

function daemonChecks(i: DoctorInput, p: DaemonProbe): DoctorCheck[] {
  const why = p.error?.includes(i.daemonUrl)
    ? p.error
    : `${i.daemonUrl} unreachable (${p.error ?? 'no answer'})`;
  const daemon = p.reachable
    ? check('daemon', 'Daemon reachable', 'pass', `${i.daemonUrl} answered (HTTP ${p.status})`)
    : check('daemon', 'Daemon reachable', 'fail', `${why} — start it with \`aoc serve\``);
  let auth: DoctorCheck;
  if (!i.tokenPresent)
    auth = check('auth', 'Logged in', 'fail', 'no token — run `aoc login --token <token>`');
  else if (!p.reachable) auth = check('auth', 'Logged in', 'skip', 'daemon unreachable — token not verified');
  else if (p.status === 200 && p.user)
    auth = check('auth', 'Logged in', 'pass', `as ${p.user.name} (${p.user.role})`);
  else if (p.status === 401 || p.status === 403)
    auth = check(
      'auth',
      'Logged in',
      'fail',
      `token rejected (HTTP ${p.status}) — run \`aoc login --token <token>\``,
    );
  else
    auth = check(
      'auth',
      'Logged in',
      'warn',
      `unexpected answer from /api/auth/me (HTTP ${p.status ?? '?'})`,
    );
  return [daemon, auth];
}

function configPermsCheck(i: DoctorInput): DoctorCheck {
  const label = 'Client config private';
  const mode = i.fs.mode(i.configPath);
  if (mode === null) return check('config-perms', label, 'skip', `no ${i.configPath}`);
  if (i.platform === 'win32')
    return check('config-perms', label, 'skip', 'POSIX permissions not applicable on Windows');
  const octal = mode.toString(8).padStart(4, '0');
  return mode & 0o077
    ? check(
        'config-perms',
        label,
        'warn',
        `${i.configPath} is ${octal} — it holds tokens: chmod 600 ${i.configPath}`,
      )
    : check('config-perms', label, 'pass', `${i.configPath} is ${octal}`);
}

function observedHooksCheck(i: DoctorInput): DoctorCheck {
  const label = 'Observed-session hooks';
  const raw = i.fs.readText(i.settingsPath);
  if (raw === null)
    return check(
      'observed-hooks',
      label,
      'warn',
      `not installed (no ${i.settingsPath}) — run \`aoc hooks install-observed\``,
    );
  let data: unknown;
  try {
    data = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return check('observed-hooks', label, 'warn', `${i.settingsPath} is not valid JSON`);
  }
  const { installed, missing } = inspectObservedHooks(data);
  if (installed.length === 0) {
    return check(
      'observed-hooks',
      label,
      'warn',
      'not installed — sessions started outside AOC are invisible (R1); run `aoc hooks install-observed`',
    );
  }
  if (missing.length > 0)
    return check(
      'observed-hooks',
      label,
      'warn',
      `missing for ${missing.join(', ')} — rerun \`aoc hooks install-observed\``,
    );
  if (!i.observerTokenPresent) {
    return check(
      'observed-hooks',
      label,
      'warn',
      `installed for all ${HOOK_EVENTS.length} events, but no observer token in ${i.configPath}`,
    );
  }
  return check('observed-hooks', label, 'pass', `installed for all ${HOOK_EVENTS.length} events`);
}

function envSecretsCheck(i: DoctorInput): DoctorCheck {
  const names = deploySecretEnvNames(i.env);
  return names.length
    ? check(
        'env-secrets',
        'No deploy secrets in shell env',
        'warn',
        `${names.join(', ')} set — deploy credentials belong only in supervisor session envs (§3)`,
      )
    : check(
        'env-secrets',
        'No deploy secrets in shell env',
        'pass',
        'none of the deploy-grade variables are set',
      );
}

function sshKeysCheck(i: DoctorInput): DoctorCheck {
  const dir = join(i.homeDir, '.ssh');
  const keys = sshPrivateKeyNames(dir, i.fs);
  return keys.length
    ? check(
        'ssh-keys',
        'No private keys in ~/.ssh',
        'warn',
        `${keys.join(', ')} — make sure none is a deploy key or can push protected branches`,
      )
    : check(
        'ssh-keys',
        'No private keys in ~/.ssh',
        'pass',
        i.fs.exists(dir) ? 'no private keys found' : 'no ~/.ssh directory',
      );
}

function gitCredentialsCheck(i: DoctorInput): DoctorCheck {
  const label = 'No git credential helpers';
  const { helpers, gitAvailable } = gitCredentialHelpers(i.git, i.cwd);
  const xdg = i.env.XDG_CONFIG_HOME || join(i.homeDir, '.config');
  const stores = [join(i.homeDir, '.git-credentials'), join(xdg, 'git', 'credentials')].filter((p) =>
    i.fs.exists(p),
  );
  const found = [
    ...(helpers.length ? [`helpers: ${helpers.join(', ')}`] : []),
    ...(stores.length ? [`plaintext store: ${stores.join(', ')}`] : []),
  ];
  if (found.length)
    return check(
      'git-credentials',
      label,
      'warn',
      `${found.join('; ')} — stored git credentials can push from this shell`,
    );
  if (!gitAvailable) return check('git-credentials', label, 'skip', 'git not found');
  return check('git-credentials', label, 'pass', 'no credential helper configured');
}

function prePushCheck(i: DoctorInput): DoctorCheck {
  const label = 'Repo pre-push is the AOC guard';
  const path = prePushPath(i.git, i.cwd, i.fs);
  if (!path) return check('pre-push', label, 'skip', `${i.cwd} is not inside a git repository`);
  const text = i.fs.readText(path);
  if (text === null)
    return check(
      'pre-push',
      label,
      'warn',
      `no pre-push hook (${path}) — pushes from this repo are not gated`,
    );
  if (!GUARD_RE.test(text))
    return check('pre-push', label, 'warn', `${path} exists but is not the AOC guard`);
  const mode = i.fs.mode(path) ?? 0;
  if (i.platform !== 'win32' && !(mode & 0o111))
    return check('pre-push', label, 'warn', `AOC guard at ${path} is not executable (chmod +x)`);
  return check('pre-push', label, 'pass', `AOC guard installed at ${path}`);
}

export function verdictOf(checks: DoctorCheck[]): Verdict {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'pass';
}

export async function runDoctor(
  i: DoctorInput,
): Promise<{ checks: DoctorCheck[]; verdict: Verdict; runbook: string }> {
  const probe = await i.probe();
  const checks = [
    ...daemonChecks(i, probe),
    configPermsCheck(i),
    observedHooksCheck(i),
    envSecretsCheck(i),
    sshKeysCheck(i),
    gitCredentialsCheck(i),
    prePushCheck(i),
  ];
  return { checks, verdict: verdictOf(checks), runbook: RUNBOOK_PATH };
}
