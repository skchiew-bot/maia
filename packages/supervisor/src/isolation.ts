/**
 * Session isolation (§3, threat model O-1, gap G-01). With supervisor.isolation 'user', every managed turn —
 * claude, its hooks, its MCP server and the model's tools — runs as an unprivileged OS user, never as aocd's.
 * aocd (root) prepares a per-session directory and starts the turn under the session user's uid/gid, or through
 * a configured runner (a per-session container wrapper, setpriv). The sidecar stays with aocd: it reads the
 * session's 0600 transcript, which needs aocd's rights, not the agent's.
 *
 * Layout under supervisor.sessionHomesDir (owned by root, 0711):
 *   <sessionId>/              root:<session gid> 0750 — the session reads it, cannot change it
 *     mcp.json, settings.json root:<session gid> 0640
 *     home/                   <session user> 0700 — HOME; home/.claude is CLAUDE_CONFIG_DIR
 *     tmp/                    <session user> 0700 — TMPDIR
 *     credentials/            root:<session gid> 0750, only while a turn runs
 *       <key>                 <session user> 0400 — private copy of a profile key file
 *   .aoc-ns-init.sh           root 0644 — starts a turn in its own namespaces (below)
 *
 * Sessions of one kind share an OS user, so the uid alone cannot keep two concurrent turns apart (G-49). Without a
 * runner, each turn therefore starts in a PID and mount namespace of its own: it sees only its own processes in
 * /proc, and a tmpfs over the sessions root hides every session directory but its own.
 *
 * Directories and files are created through no-follow handles: a symlink planted where AOC expects one of its
 * own directories is refused, never followed (root must not chown or write through an agent's link).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fchownSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionIsolationOf, type AocConfig } from '@aoc/contracts';
import { MAX_CREDENTIAL_FILE_BYTES, readCredentialProfiles } from './launch-config';
import { signalTree } from './process-utils';

export interface OsUser {
  name: string;
  uid: number;
  gid: number;
}

export class IsolationError extends Error {
  override readonly name = 'IsolationError';
}

/** Resolved isolation settings (only when supervisor.isolation is 'user'). */
export interface SessionIsolation {
  /** Credentialed sessions. */
  writer: OsUser;
  /** Read-only sessions; the same as `writer` unless supervisor.readOnlySessionUser is set. */
  reader: OsUser;
  runner: string[];
  homesRoot: string;
  /** Set when turns start in namespaces of their own (no runner, supervisor.sessionNamespaces). */
  namespaces: TurnNamespaces | null;
}

/** Absolute paths of what a namespaced turn start runs, all as root. */
export interface TurnNamespaces {
  unshare: string;
  mount: string;
  mkdir: string;
  setpriv: string;
  init: string;
}

export const NS_INIT_FILE = '.aoc-ns-init.sh';
const NS_TOOLS = ['unshare', 'mount', 'mkdir', 'setpriv'] as const;
const SYSTEM_BIN = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** A system tool by name, from root-owned system directories only (never aocd's PATH). */
export function findSystemTool(name: string): string | null {
  for (const d of SYSTEM_BIN) {
    const p = join(d, name);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      // not in this directory
    }
  }
  return null;
}

export const NO_ISOLATION_WARNING =
  'supervisor.isolation is "none": managed sessions run as the aocd OS user and can read its KEK, both databases ' +
  'and the credential profiles (§3, threat model O-1). Development only; set supervisor.sessionUser for real work.';

const USER_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}\$?$/;

/** The passwd entry of `name` (getent, so NSS users work; /etc/passwd when getent is missing). */
export function lookupOsUser(name: string): OsUser {
  if (!USER_NAME.test(name)) throw new IsolationError(`"${name}" is not a valid OS user name`);
  const r = spawnSync('getent', ['passwd', name], { encoding: 'utf8', timeout: 10_000 });
  let line: string | undefined;
  if (!r.error) line = r.status === 0 ? r.stdout.split('\n')[0] : undefined;
  else {
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
    throw new IsolationError(
      `OS user "${name}" does not exist; create it first (docs/runbooks/credential-isolation.md §4)`,
    );
  return { name, uid: Number(uid), gid: Number(gid) };
}

export interface IsolationDeps {
  /** aocd's effective uid. */
  euid: number;
  lookup: (name: string) => OsUser;
  findTool: (name: string) => string | null;
}

/**
 * Validates the isolation settings against the mode. Throws IsolationError for configurations that must not
 * start; returns warnings for development shortcuts.
 */
export function resolveIsolation(
  config: AocConfig,
  deps: IsolationDeps = { euid: process.geteuid?.() ?? -1, lookup: lookupOsUser, findTool: findSystemTool },
): { isolation: SessionIsolation | null; warnings: string[] } {
  const sup = config.supervisor;
  const production = config.mode === 'production';
  if (sessionIsolationOf(config) === 'none') {
    if (production)
      throw new IsolationError(
        'production mode requires supervisor.isolation "user": managed sessions must not run as the aocd OS user (§3, threat model O-1)',
      );
    const warnings = [NO_ISOLATION_WARNING];
    if (sup.sessionUser)
      warnings.push('supervisor.sessionUser is ignored because supervisor.isolation is "none"');
    return { isolation: null, warnings };
  }
  if (!sup.sessionUser)
    throw new IsolationError(
      'supervisor.isolation "user" needs supervisor.sessionUser, an unprivileged OS user such as aoc-agent',
    );
  if (deps.euid !== 0)
    throw new IsolationError(
      `supervisor.isolation "user" needs aocd to run as root (it runs as uid ${deps.euid}): only root can start ` +
        'turns as the session user, prepare their private directories, stop them and read their 0600 transcripts ' +
        '(docs/runbooks/credential-isolation.md §4)',
    );
  const writer = deps.lookup(sup.sessionUser);
  const reader = sup.readOnlySessionUser ? deps.lookup(sup.readOnlySessionUser) : writer;
  for (const u of reader === writer ? [writer] : [writer, reader]) {
    if (u.uid === 0 || u.uid === deps.euid)
      throw new IsolationError(`session user ${u.name} must not be root or aocd's own user`);
    if (u.gid === 0)
      throw new IsolationError(`session user ${u.name} must not have root's group as its primary group`);
  }
  const warnings: string[] = [];
  if (reader === writer) {
    const why =
      'read-only sessions run as the credentialed session user, so a triage session could read a concurrent build ' +
      "session's key copy or its environment through /proc; set supervisor.readOnlySessionUser";
    if (production) throw new IsolationError(`production mode: ${why}`);
    warnings.push(why);
  } else if (reader.uid === writer.uid || reader.gid === writer.gid) {
    throw new IsolationError(
      `supervisor.readOnlySessionUser (${reader.name}) needs its own uid and primary group, apart from ${writer.name}`,
    );
  }
  const homesRoot = resolve(sup.sessionHomesDir);
  let namespaces: TurnNamespaces | null = null;
  if (!sup.runner.length && sup.sessionNamespaces) {
    const found = Object.fromEntries(NS_TOOLS.map((t) => [t, deps.findTool(t)]));
    const missing = NS_TOOLS.filter((t) => !found[t]);
    if (missing.length)
      throw new IsolationError(
        `supervisor.sessionNamespaces needs ${missing.join(', ')} (util-linux, coreutils) in ${SYSTEM_BIN.join(':')}`,
      );
    namespaces = {
      ...(found as Record<(typeof NS_TOOLS)[number], string>),
      init: join(homesRoot, NS_INIT_FILE),
    };
  } else if (!sup.runner.length) {
    const why =
      'supervisor.sessionNamespaces is false and no runner is set: concurrent sessions of one kind share an OS ' +
      "user and can read each other's environment and key copies (G-49)";
    if (production) throw new IsolationError(`production mode: ${why}`);
    warnings.push(why);
  }
  return { isolation: { writer, reader, runner: [...sup.runner], homesRoot, namespaces }, warnings };
}

/**
 * Run by root as `sh <init> …` under `unshare --mount --pid`, so it holds the new mount namespace while its first
 * child becomes PID 1 of the new PID namespace (a shell: a process that unshared its PID namespace cannot start
 * threads, which rules out node). That child mounts the namespace's own /proc, hides the sessions root under a
 * tmpfs and binds the turn's own directory back (through an fd opened before the tmpfs covered it), then becomes
 * the session user and execs the command. The parent forwards SIGINT/SIGTERM/SIGHUP to it, which
 * `unshare --fork` would not, and exits with its status. As PID 1, the command receives only the signals it
 * handles: an interrupt sent before claude installed its handler is dropped, and the supervisor's SIGKILL of the
 * process group after the grace ends the turn.
 */
const NS_INIT = `# Written by aocd (packages/supervisor/src/isolation.ts): starts one turn in its own PID and mount namespace.
if [ "\${1-}" = stage ]; then
  set -eu
  mount=$2 setpriv=$3 mkdir=$4 homes=$5 dir=$6 uid=$7 gid=$8; shift 8
  "$mount" -t proc -o nosuid,nodev,noexec proc /proc
  exec 3<"$dir"
  "$mount" -t tmpfs -o mode=0711,size=64k aoc-session-homes "$homes"
  "$mkdir" "$dir"
  "$mount" --no-canonicalize --bind /proc/self/fd/3 "$dir"
  exec 3<&-
  exec "$setpriv" --reuid="$uid" --regid="$gid" --clear-groups -- "$@"
fi
c= sig=
for s in INT TERM HUP; do trap "sig=$s; [ -z \\"\\$c\\" ] || kill -$s \\"\\$c\\"" "$s"; done
/bin/sh "$0" stage "$@" &
c=$!
[ -z "$sig" ] || kill -"$sig" "$c"
while :; do
  wait "$c" && st=0 || st=$?
  kill -0 "$c" 2>/dev/null || exit "$st"
done
`;

// ── spawning ────────────────────────────────────────────────────────────────

export interface TurnSpawn {
  command: string;
  args: string[];
  /** Set for a direct switch (no runner). */
  uid?: number;
  gid?: number;
}

export interface SpawnContext {
  sessionId: string;
  sessionDir: string;
  cwd: string;
}

/** How to start `command args` as `user`: a direct uid/gid switch, or the configured runner with its placeholders. */
export function turnSpawn(
  iso: SessionIsolation,
  user: OsUser,
  ctx: SpawnContext,
  command: string,
  args: string[],
): TurnSpawn {
  const ns = iso.namespaces;
  if (ns)
    return {
      command: ns.unshare,
      args: [
        '--mount',
        '--propagation',
        'private',
        '--pid',
        '--',
        '/bin/sh',
        ns.init,
        ns.mount,
        ns.setpriv,
        ns.mkdir,
        iso.homesRoot,
        ctx.sessionDir,
        String(user.uid),
        String(user.gid),
        command,
        ...args,
      ],
    };
  if (!iso.runner.length) return { command, args, uid: user.uid, gid: user.gid };
  const values: Record<string, string> = {
    user: user.name,
    uid: String(user.uid),
    gid: String(user.gid),
    sessionId: ctx.sessionId,
    sessionDir: ctx.sessionDir,
    cwd: ctx.cwd,
  };
  const [bin, ...pre] = iso.runner.map((a) =>
    a.replace(/\{(user|uid|gid|sessionId|sessionDir|cwd)\}/g, (_, k: string) => values[k]!),
  );
  return { command: bin!, args: [...pre, command, ...args] };
}

// ── per-session directories ─────────────────────────────────────────────────

export interface SessionDirs {
  dir: string;
  home: string;
  claudeConfigDir: string;
  tmp: string;
  credentials: string;
  mcpConfig: string;
  settings: string;
}

export function sessionDirs(homesRoot: string, sessionId: string): SessionDirs {
  const dir = join(homesRoot, sessionId);
  const home = join(dir, 'home');
  return {
    dir,
    home,
    claudeConfigDir: join(home, '.claude'),
    tmp: join(dir, 'tmp'),
    credentials: join(dir, 'credentials'),
    mcpConfig: join(dir, 'mcp.json'),
    settings: join(dir, 'settings.json'),
  };
}

const NOFOLLOW_DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/**
 * mkdir, then set owner and mode through a no-follow handle. Returns whether it was created. With
 * `onlyIfCreated`, an existing directory is left as it is (an operator-managed workspace).
 */
export function ensureDir(
  path: string,
  mode: number,
  uid: number,
  gid: number,
  opts: { onlyIfCreated?: boolean } = {},
): boolean {
  let created = true;
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    created = false;
  }
  if (!created && opts.onlyIfCreated) return false;
  let fd: number;
  try {
    fd = openSync(path, NOFOLLOW_DIR);
  } catch (err) {
    throw new IsolationError(
      `${path} must be a directory, not a link (${(err as NodeJS.ErrnoException).code})`,
    );
  }
  try {
    fchownSync(fd, uid, gid);
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
  return created;
}

/** A file only root can replace (its directory is root-owned), written fresh with the given owner and mode. */
function writeOwned(path: string, data: string | Buffer, mode: number, uid: number, gid: number): void {
  rmSync(path, { force: true });
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, data);
    fchownSync(fd, uid, gid);
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

/**
 * The sessions root: root-owned, 0711 (session users traverse it but cannot list other sessions), and no
 * ancestor a session user could rename. Called at startup.
 */
export function prepareHomesRoot(iso: SessionIsolation): void {
  mkdirSync(dirname(iso.homesRoot), { recursive: true });
  ensureDir(iso.homesRoot, 0o711, 0, 0);
  if (iso.namespaces) writeOwned(iso.namespaces.init, NS_INIT, 0o644, 0, 0);
  const sessionUids = new Set([iso.writer.uid, iso.reader.uid]);
  for (let d = dirname(realpathSync(iso.homesRoot)); ; d = dirname(d)) {
    const st = statSync(d);
    // Group/world-writable is fine only with the sticky bit (like /tmp): nobody can rename what they do not own.
    const foreignWrite = (st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0;
    if (sessionUids.has(st.uid) || foreignWrite)
      throw new IsolationError(
        `${d} (above supervisor.sessionHomesDir) can be changed by other users: session directories must sit under root-controlled directories`,
      );
    if (d === dirname(d)) break;
  }
}

/**
 * Creates the session's directories (idempotent). HOME and TMPDIR are created once and never touched again
 * by root, because the session user owns what is inside them.
 */
export function prepareSessionDirs(iso: SessionIsolation, user: OsUser, sessionId: string): SessionDirs {
  const d = sessionDirs(iso.homesRoot, sessionId);
  ensureDir(d.dir, 0o750, 0, user.gid);
  if (!existsSync(d.home)) {
    // Root-owned while it is being populated, so nothing can be planted in it before it is handed over.
    ensureDir(d.home, 0o700, 0, 0);
    ensureDir(d.claudeConfigDir, 0o700, user.uid, user.gid);
    ensureDir(d.home, 0o700, user.uid, user.gid);
  }
  ensureDir(d.tmp, 0o700, user.uid, user.gid, { onlyIfCreated: true });
  const owner = lstatSync(d.home).uid;
  if (owner !== user.uid)
    throw new IsolationError(
      `the home of session ${sessionId} belongs to uid ${owner}, not to ${user.name}: was supervisor.sessionUser changed?`,
    );
  return d;
}

/** mcp.json / settings.json: readable by the session (its group), never writable by it. */
export function writeSessionConfig(path: string, content: string, user: OsUser): void {
  writeOwned(path, content, 0o640, 0, user.gid);
}

/**
 * Private copies of a profile's key files for one turn: readable by the session user alone, in a directory the
 * session cannot change. Returns the copy path of each file, by name.
 */
export function materializeKeyFiles(
  dirs: SessionDirs,
  user: OsUser,
  files: Record<string, string>,
): Record<string, string> {
  const names = Object.keys(files);
  if (!names.length) return {};
  ensureDir(dirs.credentials, 0o750, 0, user.gid);
  const out: Record<string, string> = {};
  for (const name of names) {
    const src = files[name]!;
    let data: Buffer;
    try {
      if (statSync(src).size > MAX_CREDENTIAL_FILE_BYTES)
        throw Object.assign(new Error('too large'), { code: 'EFBIG' });
      data = readFileSync(src);
    } catch (err) {
      throw new IsolationError(
        `credential file "${name}" is unavailable (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
      );
    }
    const dest = join(dirs.credentials, name);
    writeOwned(dest, data, 0o400, user.uid, user.gid);
    out[name] = dest;
  }
  return out;
}

export function removeKeyFiles(dirs: SessionDirs): void {
  rmSync(dirs.credentials, { recursive: true, force: true });
}

/** Directories of one supervisor command or one self-check probe, removed when it ends. */
const THROWAWAY_DIR = /^aoc-(run|selfcheck)-/;

/**
 * Startup: no turn is running, so no key copy may exist, nor a throwaway directory (a crash can leave either
 * behind). Returns how many key copies were removed.
 */
export function removeStaleSessionFiles(homesRoot: string): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(homesRoot);
  } catch {
    return 0;
  }
  for (const id of entries) {
    if (THROWAWAY_DIR.test(id)) {
      rmSync(join(homesRoot, id), { recursive: true, force: true });
      continue;
    }
    const dir = join(homesRoot, id, 'credentials');
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

// ── startup self-check ──────────────────────────────────────────────────────

/**
 * Runs as the session user: `secret:` paths must not be readable, nor `peer:` ones (a concurrent session's), and
 * `reach:`/`read:`/`cmd:` ones must work.
 */
const PROBE = `printf 'uid %s\\n' "$(id -u)"
for a do
  p=\${a#*:}
  case $a in
    secret:*|peer:*) w=readable; case $a in peer:*) w=shared ;; esac
              if [ -d "$p" ]; then ls -A -- "$p" >/dev/null 2>&1 && printf '%s %s\\n' "$w" "$p"
              elif [ -f "$p" ]; then head -c 1 -- "$p" >/dev/null 2>&1 && printf '%s %s\\n' "$w" "$p"; fi ;;
    reach:*) [ -x "$p" ] || printf 'unreachable %s\\n' "$p" ;;
    read:*) [ -r "$p" ] || printf 'unreachable %s\\n' "$p" ;;
    cmd:*) command -v -- "$p" >/dev/null 2>&1 || printf 'unreachable %s\\n' "$p" ;;
  esac
done
`;

export interface SelfCheckInput {
  iso: SessionIsolation;
  /** Paths no session user may read: dataDir and its databases, the KEK, the profiles file, key files, … */
  secrets: string[];
  /** Directories session users must traverse (sessionHomesDir, workspacesDir). */
  reach: string[];
  /** Commands every turn runs: claudeBin and its prefix, the hook and MCP commands. */
  commands: string[][];
  /** PATH the turns get. */
  path: string;
  /** Production refuses sessions that can read a concurrent session's files or environment; development warns. */
  production: boolean;
  timeoutMs?: number;
}

const procStat = (pid: number): { uid: number; ppid: number } | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return {
      uid: statSync(`/proc/${pid}`).uid,
      ppid: Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]),
    };
  } catch {
    return null;
  }
};

/**
 * The process of a just-started turn that runs as `uid`: the spawned one itself (a direct switch, a runner that
 * execs), or its child (the namespace init's PID 1, as aocd sees it). Waits up to 2 s for the switch; null if none.
 */
function sessionProcess(spawned: number, uid: number): number | null {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 40; i++) {
    if (procStat(spawned)?.uid === uid) return spawned;
    for (const e of readdirSync('/proc')) {
      const pid = Number(e);
      const st = Number.isInteger(pid) ? procStat(pid) : null;
      if (st?.ppid === spawned && st.uid === uid) return pid;
    }
    Atomics.wait(wait, 0, 0, 50);
  }
  return null;
}

/** Absolute paths (and file: URLs) in a command line, which the session user must be able to read. */
function commandItems(command: string[]): string[] {
  const items: string[] = [];
  command.forEach((a, i) => {
    let p: string | null = null;
    if (a.startsWith('file:')) {
      try {
        p = fileURLToPath(a);
      } catch {
        p = null;
      }
    } else if (isAbsolute(a)) p = a;
    if (i === 0) items.push(p ? `reach:${p}` : `cmd:${a}`);
    else if (p) items.push(`read:${p}`);
  });
  return items;
}

/**
 * Proves, as each session user and through the same spawn path as a turn, that aocd's secrets are unreadable
 * and that what a turn needs is reachable. Throws IsolationError listing every problem. It also starts a peer
 * turn of the same user and checks that the probe can read neither the peer's session directory nor its
 * environment (G-49): a problem in production, a returned warning in development.
 */
export function selfCheck(input: SelfCheckInput): string[] {
  const { iso } = input;
  const items = [
    ...input.secrets.map((p) => `secret:${p}`),
    ...input.reach.map((p) => `reach:${p}`),
    ...input.commands.flatMap(commandItems),
  ];
  const problems: string[] = [];
  const shared: string[] = [];
  for (const user of iso.reader === iso.writer ? [iso.writer] : [iso.writer, iso.reader]) {
    const sessionId = `aoc-selfcheck-${user.name}`;
    const peerId = `aoc-selfcheck-peer-${user.name}`;
    const dirs = prepareSessionDirs(iso, user, sessionId);
    const peerDirs = prepareSessionDirs(iso, user, peerId);
    let peer: ChildProcess | null = null;
    try {
      writeSessionConfig(peerDirs.mcpConfig, '{}', user);
      const ps = turnSpawn(iso, user, { sessionId: peerId, sessionDir: peerDirs.dir, cwd: '/' }, '/bin/sh', [
        '-c',
        'exec sleep 60',
      ]);
      peer = spawn(ps.command, ps.args, {
        cwd: '/',
        env: { PATH: input.path, LANG: 'C' },
        stdio: 'ignore',
        detached: true,
        ...(ps.uid !== undefined ? { uid: ps.uid, gid: ps.gid } : {}),
      });
      peer.on('error', () => undefined);
      const peerPid = peer.pid ? sessionProcess(peer.pid, user.uid) : null;
      const peerItems = [
        `peer:${peerDirs.dir}`,
        `peer:${peerDirs.mcpConfig}`,
        ...(peerPid ? [`peer:/proc/${peerPid}/environ`] : []),
      ];
      const s = turnSpawn(iso, user, { sessionId, sessionDir: dirs.dir, cwd: dirs.home }, '/bin/sh', [
        '-c',
        PROBE,
        'aoc-selfcheck',
        ...items,
        ...peerItems,
      ]);
      const r = spawnSync(s.command, s.args, {
        cwd: '/',
        env: { PATH: input.path, LANG: 'C', HOME: dirs.home },
        encoding: 'utf8',
        timeout: input.timeoutMs ?? 30_000,
        ...(s.uid !== undefined ? { uid: s.uid, gid: s.gid } : {}),
      });
      const lines = (r.stdout ?? '').split('\n').filter(Boolean);
      const seen = /^uid (\d+)$/.exec(lines[0] ?? '')?.[1];
      if (r.error || seen === undefined) {
        const why = r.error ? r.error.message : (r.stderr ?? '').trim().slice(0, 300) || `exit ${r.status}`;
        problems.push(`cannot run commands as ${user.name}: ${why}`);
        continue;
      }
      if (Number(seen) !== user.uid) {
        problems.push(`the runner started the probe as uid ${seen}, not as ${user.name} (uid ${user.uid})`);
        continue;
      }
      for (const l of lines.slice(1)) {
        if (l.startsWith('readable ')) problems.push(`session user ${user.name} can read ${l.slice(9)}`);
        else if (l.startsWith('unreachable '))
          problems.push(`session user ${user.name} cannot reach ${l.slice(12)}`);
        else if (l.startsWith('shared '))
          shared.push(`a session of ${user.name} can read a concurrent session's ${l.slice(7)}`);
      }
    } finally {
      if (peer?.pid) signalTree(peer.pid, 'SIGKILL');
      rmSync(dirs.dir, { recursive: true, force: true });
      rmSync(peerDirs.dir, { recursive: true, force: true });
    }
  }
  const apart =
    'concurrent sessions are not kept apart (G-49): use supervisor.sessionNamespaces, or a runner that starts ' +
    'each turn in a container of its own';
  if (shared.length && input.production) problems.push(...shared, apart);
  if (problems.length)
    throw new IsolationError(
      `session isolation self-check failed:\n  - ${problems.join('\n  - ')}\n` +
        'Make aocd-owned paths 0700/0600 and session-facing paths traversable ' +
        '(docs/runbooks/credential-isolation.md §4).',
    );
  return shared.length ? [`${apart}: ${shared.join('; ')}`] : [];
}

/**
 * Key files every profile names, held or handed to sessions (each must stay unreadable to session users; only
 * per-session copies of the `session` ones are readable, and only for the length of a turn).
 */
export function profileKeyFiles(profilesFile: string): string[] {
  try {
    return [
      ...new Set(
        Object.values(readCredentialProfiles(profilesFile)).flatMap((p) => [
          ...Object.values(p.files),
          ...Object.values(p.session.files),
        ]),
      ),
    ];
  } catch (err) {
    throw new IsolationError(`cannot verify the credential profiles file: ${(err as Error).message}`);
  }
}
