/**
 * Isolated runs (G-04): commands the supervisor runs outside any session — the promotion push from mod-change's
 * service clone, and code AOC does not trust (a rollback target's acceptance tests, writes to an agent's
 * repository). They inherit almost nothing from aocd, and untrusted code runs as the unprivileged session user
 * (G-01) when one is configured — never with a credential.
 */
import { spawnSync } from 'node:child_process';
import { lchownSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** What an isolated run inherits from aocd: path, locale and proxy / CA settings. Never HOME, AOC_* or Claude credentials. */
export const ISOLATED_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
];

export function isolatedRunEnv(i: {
  source: Record<string, string | undefined>;
  timezone: string;
  /** The caller's variables; they win over what is inherited. */
  extra?: Record<string, string>;
  /** The credential profile's variables; they win over everything (AOC_* never passes). */
  credentials?: Record<string, string> | null;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ISOLATED_ENV_ALLOWLIST) {
    const v = i.source[k];
    if (typeof v === 'string') env[k] = v;
  }
  env.TZ = i.timezone;
  Object.assign(env, i.extra);
  for (const [k, v] of Object.entries(i.credentials ?? {})) if (!k.startsWith('AOC_')) env[k] = v;
  return env;
}

export interface SandboxUser {
  name: string;
  uid: number;
  gid: number;
}

const USER_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}\$?$/;

/** The passwd entry of the sandbox user (getent, so NSS users work). Never root, never aocd's own user. */
export function lookupSandboxUser(name: string, euid: number = process.geteuid?.() ?? -1): SandboxUser {
  if (!USER_NAME.test(name)) throw new Error(`"${name}" is not a valid OS user name`);
  const r = spawnSync('getent', ['passwd', name], { encoding: 'utf8', timeout: 10_000 });
  let line = !r.error && r.status === 0 ? r.stdout.split('\n')[0] : undefined;
  if (r.error) {
    try {
      line = readFileSync('/etc/passwd', 'utf8')
        .split('\n')
        .find((l) => l.startsWith(`${name}:`));
    } catch {
      line = undefined;
    }
  }
  const [n, , uid, gid] = (line ?? '').split(':');
  if (n !== name || !/^\d+$/.test(uid ?? '') || !/^\d+$/.test(gid ?? ''))
    throw new Error(`sandbox user "${name}" does not exist`);
  const user = { name, uid: Number(uid), gid: Number(gid) };
  if (user.uid === 0 || user.uid === euid)
    throw new Error(`sandbox user ${name} must be neither root nor aocd's own user`);
  return user;
}

/**
 * Gives directories the caller prepared (a verification checkout, its HOME and TMPDIR) to the sandbox user. Each
 * must be fresh and enterable by aocd alone until now (mkdtemp, 0700): entries are re-owned children first and
 * the directory itself last, so the sandbox user can change nothing while the walk runs, and each entry is
 * re-owned with lchown, so a symlink in the tree is re-owned itself and never followed.
 */
export function handOver(dirs: readonly string[], user: SandboxUser): void {
  for (const dir of dirs) {
    if (!isAbsolute(dir)) throw new Error(`hand-over needs an absolute directory (${dir})`);
    if (!lstatSync(dir).isDirectory()) throw new Error(`hand-over needs a directory, not a link or a file (${dir})`);
    reown(dir, user);
  }
}

function reown(path: string, user: SandboxUser): void {
  if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) reown(join(path, name), user);
  lchownSync(path, user.uid, user.gid);
}
