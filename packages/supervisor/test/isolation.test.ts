/**
 * Session isolation (G-01, threat model O-1). The settings, environment and credential-profile checks run
 * anywhere; the end-to-end checks create two throwaway OS users and run claude-sim as them, so they need root
 * (they are skipped otherwise, with that reason in their name).
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AocConfigSchema, ProcessRegistrySchema, defaultConfig, type AocConfig } from '@aoc/contracts';
import { AocRuntime, FakeClock, createLogger, silentLogger } from '@aoc/kernel';
import { createSupervisorModule } from '../src';
import {
  IsolationError,
  NO_ISOLATION_WARNING,
  lookupOsUser,
  removeStaleSessionFiles,
  resolveIsolation,
  sessionDirs,
  turnSpawn,
  type OsUser,
} from '../src/isolation';
import {
  buildSessionEnv,
  keyFileSecrets,
  readCredentialProfile,
  readCredentialProfileSpec,
  redactSecrets,
  resolveFileRefs,
  secretsToRedact,
  userSettingsProblems,
  workspaceSettingsProblems,
} from '../src/launch-config';
import { createHarness, type Harness, type HarnessOptions } from './harness';

const CLAUDE_SIM = fileURLToPath(new URL('../../claude-sim/bin/claude-sim.mjs', import.meta.url));
const FAKE_HELPER = fileURLToPath(new URL('./fixtures/fake-helper.mjs', import.meta.url));

const temps: string[] = [];
const temp = (prefix = 'aoc-iso-') => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ── settings, environment and profiles (no root needed) ─────────────────────

const cfg = (o: Record<string, unknown> = {}): AocConfig => AocConfigSchema.parse(o);
const USERS: Record<string, OsUser> = {
  'aoc-agent': { name: 'aoc-agent', uid: 1201, gid: 1201 },
  'aoc-reader': { name: 'aoc-reader', uid: 1202, gid: 1202 },
  'aoc-twin': { name: 'aoc-twin', uid: 1203, gid: 1201 },
  root: { name: 'root', uid: 0, gid: 0 },
};
const deps = (euid = 0) => ({
  euid,
  lookup: (name: string) => {
    const u = USERS[name];
    if (!u) throw new IsolationError(`OS user "${name}" does not exist`);
    return u;
  },
});

describe('isolation settings', () => {
  it('development defaults to running sessions as aocd, with a warning', () => {
    expect(resolveIsolation(cfg(), deps(1000))).toEqual({
      isolation: null,
      warnings: [NO_ISOLATION_WARNING],
    });
  });

  it('production refuses sessions that run as the aocd OS user', () => {
    expect(() =>
      resolveIsolation(cfg({ mode: 'production', supervisor: { isolation: 'none' } }), deps()),
    ).toThrow('production mode requires supervisor.isolation "user"');
    expect(() => resolveIsolation(cfg({ mode: 'production' }), deps())).toThrow(
      /needs supervisor.sessionUser/,
    );
  });

  it('naming a session user turns isolation on, and aocd must be root to switch to it', () => {
    const sup = { sessionUser: 'aoc-agent', sessionHomesDir: '/srv/aoc/homes' };
    expect(() => resolveIsolation(cfg({ supervisor: sup }), deps(1000))).toThrow(
      /needs aocd to run as root \(it runs as uid 1000\)/,
    );
    const r = resolveIsolation(cfg({ supervisor: sup }), deps());
    expect(r.isolation).toEqual({
      writer: USERS['aoc-agent'],
      reader: USERS['aoc-agent'],
      runner: [],
      homesRoot: '/srv/aoc/homes',
    });
    expect(r.warnings.join('\n')).toContain('set supervisor.readOnlySessionUser');
  });

  it('refuses root, unknown users and a read-only user sharing the build user’s uid or group', () => {
    expect(() => resolveIsolation(cfg({ supervisor: { sessionUser: 'root' } }), deps())).toThrow(
      /must not be root/,
    );
    expect(() => resolveIsolation(cfg({ supervisor: { sessionUser: 'ghost' } }), deps())).toThrow(
      /does not exist/,
    );
    expect(() =>
      resolveIsolation(
        cfg({ supervisor: { sessionUser: 'aoc-agent', readOnlySessionUser: 'aoc-twin' } }),
        deps(),
      ),
    ).toThrow(/needs its own uid and primary group/);
  });

  it('production requires a separate read-only session user', () => {
    expect(() =>
      resolveIsolation(cfg({ mode: 'production', supervisor: { sessionUser: 'aoc-agent' } }), deps()),
    ).toThrow(/production mode: read-only sessions run as the credentialed session user/);
    const r = resolveIsolation(
      cfg({
        mode: 'production',
        supervisor: { sessionUser: 'aoc-agent', readOnlySessionUser: 'aoc-reader' },
      }),
      deps(),
    );
    expect(r).toMatchObject({
      isolation: { writer: USERS['aoc-agent'], reader: USERS['aoc-reader'] },
      warnings: [],
    });
  });

  it('a production aocd refuses to start without isolation', async () => {
    const config = cfg({ mode: 'production', dataDir: ':memory:' });
    await expect(
      AocRuntime.create({
        config,
        modules: [createSupervisorModule({ sessionsDir: temp() })],
        clock: new FakeClock(),
        log: silentLogger,
        masterKey: randomBytes(32),
        dataDir: ':memory:',
      }),
    ).rejects.toThrow(/needs supervisor.sessionUser/);
  });

  it('warns on every launch while sessions run as the aocd OS user', async () => {
    const lines: string[] = [];
    h = await createHarness({ log: createLogger({ level: 'warn', sink: (l) => lines.push(l) }) });
    await h.launch('first', { threadId: 'thr_1' });
    await h.launch('second', { threadId: 'thr_2' });
    expect(lines.filter((l) => l.includes('supervisor.isolation is \\"none\\"')).length).toBe(1);
    expect(lines.filter((l) => l.includes('ISOLATION OFF')).length).toBe(2);
  });
});

describe('workspace settings are read without trusting the workspace', () => {
  const workspace = () => {
    const cwd = temp('aoc-ws-');
    mkdirSync(join(cwd, '.claude'));
    return cwd;
  };

  it('never blocks on a FIFO planted as a settings file', () => {
    const cwd = workspace();
    const fifo = spawnSync('mkfifo', [join(cwd, '.claude', 'settings.local.json')]);
    if (fifo.status !== 0) return; // no mkfifo on this host
    expect(workspaceSettingsProblems(cwd)).toEqual(['.claude/settings.local.json is unreadable']);
  });

  it('never reads through a link planted at a settings file or at .claude', () => {
    const cwd = workspace();
    const elsewhere = join(temp('aoc-ws-target-'), 'settings.json');
    writeFileSync(elsewhere, JSON.stringify({ env: { FROM_ELSEWHERE: '1' } }));
    symlinkSync(elsewhere, join(cwd, '.claude', 'settings.json'));
    expect(workspaceSettingsProblems(cwd)).toEqual(['.claude/settings.json is unreadable']);
    const linked = temp('aoc-ws-');
    symlinkSync(join(cwd, '.claude'), join(linked, '.claude'));
    expect(workspaceSettingsProblems(linked)).toEqual(['.claude is a link']);
  });
});

describe('an isolated session’s own user settings', () => {
  it('get the workspace rules: no disableAllHooks, no env, no link', () => {
    const dir = temp('aoc-userset-');
    expect(userSettingsProblems(dir)).toEqual([]);
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ permissions: { allow: ['Read'] } }));
    expect(userSettingsProblems(dir)).toEqual([]);
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ disableAllHooks: true, env: { AOC_MODE: 'observed' } }),
    );
    expect(userSettingsProblems(dir)).toEqual([
      '~/.claude/settings.json sets disableAllHooks',
      '~/.claude/settings.json sets env (AOC_MODE)',
    ]);
    const home = temp('aoc-userset-home-');
    symlinkSync(dir, join(home, '.claude'));
    expect(userSettingsProblems(join(home, '.claude'))).toEqual(['~/.claude is a link']);
  });
});

describe('startup cleanup', () => {
  it('removes every key copy and throwaway directory a crash left behind, and nothing else', () => {
    const homes = temp('aoc-homes-');
    for (const p of [
      'ses_a/credentials',
      'ses_a/home/.claude',
      'ses_b/home',
      'aoc-run-x/home',
      'aoc-selfcheck-u/tmp',
    ])
      mkdirSync(join(homes, p), { recursive: true });
    writeFileSync(join(homes, 'ses_a/credentials/ssh-key'), 'k');
    expect(removeStaleSessionFiles(homes)).toBe(1);
    expect(
      ['ses_a/credentials', 'aoc-run-x', 'aoc-selfcheck-u'].map((p) => existsSync(join(homes, p))),
    ).toEqual([false, false, false]);
    expect(existsSync(join(homes, 'ses_a/home/.claude')) && existsSync(join(homes, 'ses_b/home'))).toBe(true);
  });
});

describe('turn spawning', () => {
  const iso = {
    writer: USERS['aoc-agent']!,
    reader: USERS['aoc-reader']!,
    runner: [],
    homesRoot: '/srv/homes',
  };
  const ctx = { sessionId: 'ses_1', sessionDir: '/srv/homes/ses_1', cwd: '/w/prj' };

  it('switches uid and gid directly', () => {
    expect(turnSpawn(iso, iso.writer, ctx, 'claude', ['-p'])).toEqual({
      command: 'claude',
      args: ['-p'],
      uid: 1201,
      gid: 1201,
    });
  });

  it('or starts the turn through the runner, filling in its placeholders', () => {
    const runner = [
      'aoc-container-run',
      '--user={uid}:{gid}',
      '--name=aoc-{sessionId}',
      '--volume={sessionDir}:{sessionDir}',
      '--workdir={cwd}',
      '--label=user={user}',
      '--',
    ];
    expect(turnSpawn({ ...iso, runner }, iso.reader, ctx, 'claude', ['-p'])).toEqual({
      command: 'aoc-container-run',
      args: [
        '--user=1202:1202',
        '--name=aoc-ses_1',
        '--volume=/srv/homes/ses_1:/srv/homes/ses_1',
        '--workdir=/w/prj',
        '--label=user=aoc-reader',
        '--',
        'claude',
        '-p',
      ],
    });
  });
});

describe('isolated session environment', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/var/lib/aoc',
    USER: 'aoc',
    CLAUDE_CONFIG_DIR: '/var/lib/aoc/.claude',
    TMPDIR: '/var/lib/aoc/tmp',
    SSH_AUTH_SOCK: '/var/lib/aoc/agent.sock',
    LANG: 'C.UTF-8',
    ANTHROPIC_API_KEY: 'sk-ant-test',
  };
  const allowlist = [...defaultConfig().supervisor.envAllowlist, 'SSH_AUTH_SOCK'];
  const isolated = {
    user: 'aoc-agent',
    home: '/h/ses_1/home',
    claudeConfigDir: '/h/ses_1/home/.claude',
    tmpDir: '/h/ses_1/tmp',
  };

  it('replaces aocd’s account with the session’s own and turns off host git config and credential helpers', () => {
    const env = buildSessionEnv({
      source,
      allowlist,
      // A profile cannot point the session back at aocd's home.
      credentials: { GIT_SSH_COMMAND: 'ssh -i /h/ses_1/credentials/ssh-key', HOME: '/var/lib/aoc' },
      readOnly: false,
      aoc: { AOC_SESSION_ID: 'ses_1' },
      timezone: 'UTC',
      isolated,
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      HOME: '/h/ses_1/home',
      USER: 'aoc-agent',
      LOGNAME: 'aoc-agent',
      CLAUDE_CONFIG_DIR: '/h/ses_1/home/.claude',
      TMPDIR: '/h/ses_1/tmp',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'AOC agent',
      GIT_COMMITTER_NAME: 'AOC agent',
      GIT_AUTHOR_EMAIL: 'aoc-agent@localhost',
      GIT_COMMITTER_EMAIL: 'aoc-agent@localhost',
      GIT_SSH_COMMAND: 'ssh -i /h/ses_1/credentials/ssh-key',
      TZ: 'UTC',
      AOC_SESSION_ID: 'ses_1',
    });
  });

  it('lets a credential profile name the git identity of its machine user', () => {
    const env = buildSessionEnv({
      source,
      allowlist,
      credentials: { GIT_AUTHOR_NAME: 'aoc-feature-bot', GIT_AUTHOR_EMAIL: 'bot@example.com' },
      readOnly: false,
      aoc: {},
      timezone: 'UTC',
      isolated,
    });
    expect(env).toMatchObject({
      GIT_AUTHOR_NAME: 'aoc-feature-bot',
      GIT_COMMITTER_NAME: 'aoc-feature-bot',
      GIT_AUTHOR_EMAIL: 'bot@example.com',
      GIT_COMMITTER_EMAIL: 'bot@example.com',
    });
  });

  it('leaves a development session’s allowlisted variables as they were', () => {
    const env = buildSessionEnv({
      source,
      allowlist,
      credentials: null,
      readOnly: false,
      aoc: {},
      timezone: 'UTC',
    });
    expect(env).toMatchObject({ HOME: '/var/lib/aoc', CLAUDE_CONFIG_DIR: '/var/lib/aoc/.claude' });
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
  });
});

describe('credential profiles with key files', () => {
  const write = (profiles: unknown) => {
    const f = join(temp('aoc-prof-'), 'profiles.json');
    writeFileSync(f, JSON.stringify({ profiles }));
    return f;
  };

  it('refers to key files by name: originals for aocd’s own runs, any given path for a session', () => {
    const f = write({
      'git-feature': {
        env: { GIT_SSH_COMMAND: 'ssh -i {{file:ssh-key}} -o IdentitiesOnly=yes', GIT_PUSH_TOKEN: 'tok' },
        files: { 'ssh-key': '/etc/aoc/keys/git-feature' },
      },
      legacy: { env: { DEPLOY_TOKEN: 'd' } },
    });
    expect(readCredentialProfile(f, 'git-feature')).toEqual({
      GIT_SSH_COMMAND: 'ssh -i /etc/aoc/keys/git-feature -o IdentitiesOnly=yes',
      GIT_PUSH_TOKEN: 'tok',
    });
    expect(readCredentialProfile(f, 'legacy')).toEqual({ DEPLOY_TOKEN: 'd' });
    const spec = readCredentialProfileSpec(f, 'git-feature');
    expect(resolveFileRefs(spec.env, { 'ssh-key': '/h/ses_1/credentials/ssh-key' }).GIT_SSH_COMMAND).toBe(
      'ssh -i /h/ses_1/credentials/ssh-key -o IdentitiesOnly=yes',
    );
  });

  it('redacts a printed key file from session output, whole or line by line', () => {
    const key = join(temp('aoc-key-'), 'id_ed25519');
    const pem =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nQyNTUxOQAAACBkZXBsb3k\n-----END OPENSSH PRIVATE KEY-----\n';
    writeFileSync(key, pem);
    const secrets = secretsToRedact(keyFileSecrets({ 'ssh-key': key, missing: '/nonexistent/key' }));
    expect(redactSecrets(`$ cat key\n${pem}`, secrets)).not.toMatch(/b3BlbnNz|QyNTUxOQ/);
    expect(redactSecrets(JSON.stringify({ result: pem }), secrets)).not.toMatch(/b3BlbnNz|QyNTUxOQ/);
    expect(redactSecrets('head -2: b3BlbnNzaC1rZXktdjEAAAAA', secrets)).toBe('head -2: [redacted]');
  });

  it('rejects undeclared references and relative key paths without echoing values', () => {
    const undeclared = write({ p: { env: { GIT_SSH_COMMAND: 'ssh -i {{file:nope}} super-secret-value' } } });
    expect(() => readCredentialProfileSpec(undeclared, 'p')).toThrow(
      'credential profile "p": GIT_SSH_COMMAND refers to a file that "files" does not declare',
    );
    try {
      readCredentialProfileSpec(undeclared, 'p');
    } catch (err) {
      expect(String(err)).not.toContain('super-secret-value');
    }
    const relative = write({ p: { env: {}, files: { key: 'keys/p' } } });
    expect(() => readCredentialProfileSpec(relative, 'p')).toThrow(/file "key" needs an absolute path/);
  });

  it('splits a profile into the credential aocd holds, the branches it may push and what sessions get (R-02)', () => {
    const f = write({
      'git-feature': {
        env: { GIT_SSH_COMMAND: 'ssh -i {{file:ssh-key}} -o IdentitiesOnly=yes' },
        files: { 'ssh-key': '/etc/aoc/keys/git-feature' },
        push: { refs: ['refs/heads/feature/**', 'refs/heads/aoc/{threadId}/**'] },
        session: { env: { READ_KEY: '{{file:read}}', GIT_AUTHOR_NAME: 'AOC agent' }, files: { read: '/etc/aoc/keys/read' } },
      },
      held: { env: { DEPLOY_TOKEN: 'd' } },
    });
    const spec = readCredentialProfileSpec(f, 'git-feature');
    expect(spec.push).toEqual({ refs: ['refs/heads/feature/**', 'refs/heads/aoc/{threadId}/**'] });
    expect(spec.session).toEqual({
      env: { READ_KEY: '{{file:read}}', GIT_AUTHOR_NAME: 'AOC agent' },
      files: { read: '/etc/aoc/keys/read' },
    });
    // What aocd runs with is the credential alone: nothing of the session part, and the other way round.
    expect(readCredentialProfile(f, 'git-feature')).toEqual({
      GIT_SSH_COMMAND: 'ssh -i /etc/aoc/keys/git-feature -o IdentitiesOnly=yes',
    });
    expect(resolveFileRefs(spec.session.env, { read: '/h/ses_1/credentials/read' })).toEqual({
      READ_KEY: '/h/ses_1/credentials/read',
      GIT_AUTHOR_NAME: 'AOC agent',
    });
    // A profile that names no push refs pushes nothing, and hands its sessions nothing.
    const held = readCredentialProfileSpec(f, 'held');
    expect(held.push).toBeNull();
    expect(held.session).toEqual({ env: {}, files: {} });
  });

  it('refuses push refs that are not branches, and session references to undeclared files', () => {
    expect(() => readCredentialProfileSpec(write({ p: { env: {}, push: { refs: ['refs/tags/v*'] } } }), 'p')).toThrow(
      'credential profile "p": push.refs name branches (refs/heads/...), not refs/tags/v*',
    );
    expect(() =>
      readCredentialProfileSpec(write({ p: { env: {}, session: { env: { K: '{{file:nope}}' } } } }), 'p'),
    ).toThrow('credential profile "p": session.K refers to a file that "session.files" does not declare');
  });
});

// ── end to end, as real OS users (root only) ────────────────────────────────

const canCreateUsers =
  process.getuid?.() === 0 && spawnSync('useradd', ['--help'], { stdio: 'ignore' }).status === 0;
const hasSetpriv = spawnSync('setpriv', ['--version'], { stdio: 'ignore' }).status === 0;

/** useradd fails while another process holds the passwd lock, so it is retried briefly. */
async function run(cmd: string, args: string[]): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    if (r.status === 0) return;
    if (attempt === 10) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.error}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

interface World {
  root: string;
  secret: string;
  aocdHome: string;
  /** The key aocd holds to push upstream (R-02): no session ever gets it or a copy of it. */
  keyFile: string;
  /** A read-only key the profile hands to its sessions (`session.files`): they get a private copy per turn. */
  readKeyFile: string;
  kek: string;
  profiles: string;
  shared: string;
  logs: string;
  homes: string;
  work: string;
  gate: string;
}

/**
 * A host in miniature: aocd's secrets in a 0700 directory (profiles file, the key file it names, the KEK), aocd's
 * own HOME with an SSH key, and a world-readable directory for scenarios and helper logs.
 */
function world(): World {
  const root = temp();
  chmodSync(root, 0o755);
  const secret = join(root, 'secret');
  mkdirSync(secret, { mode: 0o700 });
  const aocdHome = join(root, 'aocd-home');
  mkdirSync(join(aocdHome, '.ssh'), { recursive: true, mode: 0o700 });
  writeFileSync(join(aocdHome, '.ssh', 'id_ed25519'), 'AOCD-SSH-PRIVATE-KEY\n', { mode: 0o600 });
  const keyFile = join(secret, 'git-feature.key');
  writeFileSync(keyFile, 'TEST-KEY-git-feature\n', { mode: 0o600 });
  const readKeyFile = join(secret, 'session-read.key');
  writeFileSync(readKeyFile, 'TEST-KEY-session-read\n', { mode: 0o600 });
  const kek = join(secret, 'kek');
  writeFileSync(kek, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  const profiles = join(secret, 'credential-profiles.json');
  writeFileSync(
    profiles,
    JSON.stringify({
      profiles: {
        'git-feature': {
          // The credential: held by aocd, used by the push gateway's upstream push. Never in a session (R-02).
          env: {
            GIT_SSH_COMMAND: 'ssh -i {{file:ssh-key}} -o IdentitiesOnly=yes',
            GIT_PUSH_TOKEN: 'ghp_feature_E2E',
          },
          files: { 'ssh-key': keyFile },
          push: { refs: ['refs/heads/feature/**'] },
          // What the session itself gets: a read-only key, as a private per-turn copy.
          session: { env: { READ_KEY_FILE: '{{file:read-key}}' }, files: { 'read-key': readKeyFile } },
        },
      },
    }),
    { mode: 0o600 },
  );
  const shared = join(root, 'shared');
  mkdirSync(shared);
  chmodSync(shared, 0o755);
  const logs = join(shared, 'logs');
  mkdirSync(logs);
  chmodSync(logs, 0o1777);
  return {
    root,
    secret,
    aocdHome,
    keyFile,
    readKeyFile,
    kek,
    profiles,
    shared,
    logs,
    homes: join(root, 'homes'),
    work: join(root, 'work'),
    gate: join(shared, 'gate'),
  };
}

const ISO_TYPES = ProcessRegistrySchema.parse({
  version: 'test',
  types: [
    {
      id: 'iso-build',
      name: 'Isolated build',
      class: 'execution',
      model: 'sonnet',
      credentialProfile: 'git-feature',
      requiresPlan: false,
      tools: { allow: ['Bash'] },
    },
    {
      id: 'iso-triage',
      name: 'Isolated triage',
      class: 'triage',
      model: 'sonnet',
      readOnly: true,
      permissionMode: 'dontAsk',
      requiresPlan: false,
      tools: { allow: ['Read'], deny: ['Bash'] },
    },
  ],
}).types;

const bash = (command: string) => ({ kind: 'bash', command, exec: true });
const read = (file_path: string) => ({ kind: 'tool', name: 'Read', input: { file_path } });
const endTurn = { kind: 'endTurn', final: true };

/** Writes a claude-sim scenario where session users can read it; returns the prompt marker. */
function scenario(w: World, name: string, steps: unknown[]): string {
  const file = join(w.shared, `${name}.json`);
  writeFileSync(file, JSON.stringify({ name, steps }), { mode: 0o644 });
  return `[[scenario:${file}]]`;
}

function isolationSettings(w: World, writer: string, reader: string) {
  return {
    sessionUser: writer,
    readOnlySessionUser: reader,
    sessionHomesDir: w.homes,
    workspacesDir: w.work,
    claudeBin: process.execPath,
    claudeArgsPrefix: [CLAUDE_SIM],
    hookCommand: [process.execPath, FAKE_HELPER, 'hook'],
    mcpCommand: [process.execPath, FAKE_HELPER, 'mcp'],
    credentialProfilesFile: w.profiles,
    envAllowlist: [
      ...defaultConfig().supervisor.envAllowlist,
      'CLAUDE_SIM_EXEC',
      'CLAUDE_SIM_SPEED',
      'FAKE_HELPER_LOG_DIR',
    ],
  };
}

function aocdEnv(w: World): Record<string, string | undefined> {
  return {
    HOME: w.aocdHome,
    CLAUDE_CONFIG_DIR: join(w.aocdHome, '.claude'),
    CLAUDE_SIM_EXEC: '1',
    CLAUDE_SIM_SPEED: '0.01',
    FAKE_HELPER_LOG_DIR: w.logs,
  };
}

function readJsonl(file: string): Record<string, unknown>[] {
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
}

describe.skipIf(!canCreateUsers)('OS-level isolation end to end (needs root to create session users)', () => {
  const tag = `${process.pid % 100000}${randomBytes(2).toString('hex')}`;
  const WRITER = `aoct${tag}w`;
  const READER = `aoct${tag}r`;
  let writer: OsUser;
  let reader: OsUser;

  beforeAll(async () => {
    for (const name of [WRITER, READER])
      await run('useradd', [
        '--system',
        '--no-create-home',
        '--home-dir',
        '/nonexistent',
        '--shell',
        '/usr/sbin/nologin',
        '--user-group',
        name,
      ]);
    writer = lookupOsUser(WRITER);
    reader = lookupOsUser(READER);
  }, 30_000);
  afterAll(async () => {
    for (const name of [WRITER, READER]) {
      await run('userdel', [name]).catch(() => undefined);
      // userdel normally removes the user's own group as well.
      spawnSync('groupdel', [name], { stdio: 'ignore' });
    }
  }, 30_000);

  const harness = (w: World, o: HarnessOptions = {}) =>
    createHarness({
      onDisk: true,
      types: ISO_TYPES,
      env: aocdEnv(w),
      config: { keys: { masterKeyFile: w.kek } },
      ...o,
      supervisor: { ...isolationSettings(w, WRITER, READER), ...o.supervisor },
    });

  const toolResults = (id: string) =>
    h!.sup
      .output(id)!
      .filter((i) => i.kind === 'tool_result')
      .map((i) => i.text);

  it('runs a build turn, its hooks and its MCP server as the session user, who can read none of aocd’s secrets', async () => {
    const w = world();
    h = await harness(w);
    const dataDir = h.t.dataDir;
    const marker = scenario(w, 'probe', [
      bash('id -u'),
      bash('printf "%s\\n%s\\n%s" "$HOME" "$CLAUDE_CONFIG_DIR" "$TMPDIR"'),
      bash(`cat ${w.profiles}`),
      bash(`cat ${w.kek}`),
      bash(`head -c 16 ${join(dataDir, 'aoc.db')}`),
      bash(`ls ${dataDir}`),
      bash(`cat ${join(w.aocdHome, '.ssh', 'id_ed25519')}`),
      bash('ls -a ~/.ssh'),
      bash(`cat ${w.keyFile}`),
      // The key its profile hands to sessions works: a private copy, named in READ_KEY_FILE. Printing it reaches no builder.
      bash('printf "%s\\n" "$READ_KEY_FILE"; wc -c < "$READ_KEY_FILE"; cat "$READ_KEY_FILE"'),
      // R-02: the credential aocd pushes with is nowhere in the session: not in its environment, not among its key copies.
      bash('env | grep -c -E "GIT_SSH_COMMAND|GIT_PUSH_TOKEN|ghp_feature_E2E|git-feature.key" || true'),
      bash('ls "$(dirname "$READ_KEY_FILE")"'),
      endTurn,
    ]);
    const id = await h.launch(`${marker} probe the sandbox`, { processType: 'iso-build' });
    await h.waitLifecycle(id, 'idle', 60_000);
    const dirs = sessionDirs(w.homes, id);
    const r = toolResults(id);
    expect(r).toHaveLength(12);

    expect(r[0]).toBe(String(writer.uid));
    expect(r[1]!.split('\n')).toEqual([dirs.home, dirs.claudeConfigDir, dirs.tmp]);
    expect(dirs.home).not.toBe(w.aocdHome);
    for (const [i, what] of [
      [2, 'credential profiles file'],
      [3, 'KEK'],
      [4, 'aoc.db'],
      [5, 'data dir'],
      [6, 'aocd ~/.ssh key'],
      [8, 'original key file'],
    ] as const)
      expect(r[i], what).toMatch(/^Exit code \d+[\s\S]*Permission denied/);
    expect(r[7]).toMatch(/No such file or directory/);
    // The copy's path is itself a session env value, so it is redacted like the key: 22 bytes were read from it.
    expect(r[9]!.split('\n')).toEqual(['[redacted]', '22', '[redacted]']);
    expect(r[10]).toBe('0'); // no GIT_SSH_COMMAND, GIT_PUSH_TOKEN or held key path in the session's environment
    expect(r[11]).toBe('read-key'); // the only key copy: the session's own, never the one aocd pushes with
    const all = r.join('\n');
    for (const secret of [
      'AOCD-SSH-PRIVATE-KEY',
      readFileSync(w.kek, 'utf8').trim(),
      'ghp_feature_E2E',
      'SQLite format',
      'TEST-KEY-git-feature',
      'TEST-KEY-session-read',
    ])
      expect(all).not.toContain(secret);

    // The key copy lived for the turn only; the session's directories belong to the right users.
    expect(existsSync(dirs.credentials)).toBe(false);
    const mode = (p: string) => statSync(p).mode & 0o7777;
    expect([statSync(dirs.dir).uid, statSync(dirs.dir).gid, mode(dirs.dir)]).toEqual([0, writer.gid, 0o750]);
    expect([statSync(dirs.home).uid, mode(dirs.home)]).toEqual([writer.uid, 0o700]);
    expect([statSync(dirs.settings).uid, statSync(dirs.settings).gid, mode(dirs.settings)]).toEqual([
      0,
      writer.gid,
      0o640,
    ]);
    expect(statSync(join(w.work, 'prj_demo')).uid).toBe(writer.uid);

    // Hooks and the MCP server are claude's children: same user, same private HOME. Nothing ran as root.
    const helpers = readJsonl(join(w.logs, `${writer.uid}.jsonl`));
    expect(new Set(helpers.map((e) => e.role))).toEqual(new Set(['hook', 'mcp']));
    expect(helpers.every((e) => e.uid === writer.uid && e.home === dirs.home)).toBe(true);
    expect(existsSync(join(w.logs, '0.jsonl'))).toBe(false);

    const launched = h.events('session.launched', id)[0]!;
    expect(h.payload(launched)).toMatchObject({ runAs: WRITER });
  }, 90_000);

  it('a read-only session cannot open a profile key file, a build session’s key copy or its environment', async () => {
    const w = world();
    h = await harness(w);
    const hold = scenario(w, 'hold', [
      bash(`while [ ! -e ${w.gate} ]; do sleep 0.05; done; echo released`),
      endTurn,
    ]);
    const build = await h.launch(`${hold} hold the credentials`, {
      processType: 'iso-build',
      threadId: 'thr_build',
    });
    const copy = join(sessionDirs(w.homes, build).credentials, 'read-key');
    await h.waitFor(() => existsSync(copy), 'the build turn’s key copy', 60_000);
    expect(statSync(copy)).toMatchObject({ uid: writer.uid, gid: writer.gid });
    expect(statSync(copy).mode & 0o777).toBe(0o400);
    const pid = Number(h.events('session.launched', build)[0]!.meta.pid);

    const snoop = scenario(w, 'snoop', [
      read(w.keyFile),
      read(copy),
      read(w.profiles),
      read(`/proc/${pid}/environ`),
      endTurn,
    ]);
    const triage = await h.launch(`${snoop} look around`, {
      processType: 'iso-triage',
      threadId: 'thr_triage',
    });
    await h.waitLifecycle(triage, 'idle', 60_000);
    const r = toolResults(triage);
    expect(r).toHaveLength(4);
    // claude-sim reports any stat failure as "does not exist"; the files do exist (checked as root above/below).
    expect(r.slice(0, 3).every((t) => /does not exist/.test(t))).toBe(true);
    expect(r[3]).toMatch(/EACCES: permission denied/);
    for (const leaked of [
      'TEST-KEY-git-feature',
      'TEST-KEY-session-read',
      'GIT_SSH_COMMAND',
      'ghp_feature_E2E',
      'AOC_INGEST_TOKEN',
    ])
      expect(r.join('\n')).not.toContain(leaked);
    expect(existsSync(w.keyFile) && existsSync(copy)).toBe(true);
    expect(h.payload(h.events('session.launched', triage)[0]!)).toMatchObject({ runAs: READER });

    writeFileSync(w.gate, 'go');
    await h.waitLifecycle(build, 'idle', 60_000);
    expect(toolResults(build)).toEqual(['released']);
    expect(existsSync(copy)).toBe(false);
  }, 120_000);

  it('refuses the next turn of a session that switched its own hooks off in its HOME', async () => {
    const w = world();
    h = await harness(w);
    const marker = scenario(w, 'unhook', [
      bash(`printf '%s' '{"disableAllHooks":true}' > "$CLAUDE_CONFIG_DIR/settings.json"`),
      endTurn,
    ]);
    const id = await h.launch(`${marker} make yourself at home`, { processType: 'iso-build' });
    await h.waitLifecycle(id, 'idle', 60_000);
    await expect(h.sup.nudge(id, 'carry on', h.ownerActor)).rejects.toMatchObject({
      status: 409,
      code: 'session_settings_override',
    });
    expect(h.lifecycle(id)).toBe('failed');
  }, 90_000);

  it('runs supervisor commands without credentials (acceptance tests) as the session user, never as root', async () => {
    const w = world();
    h = await harness(w);
    const plain = await h.sup.runIsolated({
      cwd: w.shared,
      command: ['sh', '-c', `id -u; printf '%s\\n' "$HOME"; cat ${w.profiles}`],
      credentialProfile: null,
      timeoutMs: 10_000,
    });
    const [uid, home] = plain.stdout.split('\n');
    expect(uid).toBe(String(writer.uid));
    expect(home!.startsWith(join(w.homes, 'aoc-run-')) && home!.endsWith('/home')).toBe(true);
    expect(plain.exitCode).not.toBe(0);
    expect(plain.stderr).toContain('Permission denied');
    expect(existsSync(dirname(home!))).toBe(false);
    // Promotion needs the profile's key: it stays with aocd and sees the original file.
    const promoted = await h.sup.runIsolated({
      cwd: w.shared,
      command: ['sh', '-c', 'id -u; printf "%s" "$GIT_SSH_COMMAND"'],
      credentialProfile: 'git-feature',
      timeoutMs: 10_000,
    });
    expect(promoted.stdout).toBe(`0\nssh -i ${w.keyFile} -o IdentitiesOnly=yes`);
  }, 60_000);

  it.skipIf(!hasSetpriv)(
    'can start turns through a runner instead of a direct switch',
    async () => {
      const w = world();
      h = await harness(w, {
        supervisor: { runner: ['setpriv', '--reuid={uid}', '--regid={gid}', '--clear-groups', '--'] },
      });
      const marker = scenario(w, 'runner', [bash('id -u; id -G'), endTurn]);
      const id = await h.launch(`${marker} who am i`, { processType: 'iso-build' });
      await h.waitLifecycle(id, 'idle', 60_000);
      expect(toolResults(id)).toEqual([`${writer.uid}\n${writer.gid}`]);
      expect(h.payload(h.events('session.launched', id)[0]!)).toMatchObject({
        runAs: WRITER,
        argv: expect.arrayContaining(['setpriv', `--reuid=${writer.uid}`]),
      });
    },
    90_000,
  );

  describe('startup self-check', () => {
    const start = (w: World, dataDir: string, supervisor: Record<string, unknown> = {}) =>
      AocRuntime.create({
        config: AocConfigSchema.parse({
          dataDir,
          keys: { masterKeyFile: w.kek },
          supervisor: { ...isolationSettings(w, WRITER, READER), ...supervisor },
        }),
        modules: [
          createSupervisorModule({
            sessionsDir: join(w.secret, 'sessions'),
            env: { PATH: process.env.PATH },
          }),
        ],
        clock: new FakeClock(),
        log: silentLogger,
        masterKey: randomBytes(32),
        dataDir,
      });

    it('refuses to start while a session user can read the data dir, and starts once it is private', async () => {
      const w = world();
      const dataDir = join(w.root, 'data');
      mkdirSync(dataDir);
      chmodSync(dataDir, 0o755);
      const refused = start(w, dataDir);
      await expect(refused).rejects.toThrow(IsolationError);
      await expect(refused).rejects.toThrow(`session user ${WRITER} can read ${dataDir}`);
      await expect(refused).rejects.toThrow(`session user ${READER} can read ${join(dataDir, 'aoc.db')}`);
      chmodSync(dataDir, 0o700);
      const rt = await start(w, dataDir);
      await rt.stop();
    }, 60_000);

    it('refuses to start while a session user can read the KEK, the profiles file or a key file it names', async () => {
      const w = world();
      chmodSync(w.secret, 0o755);
      for (const f of [w.kek, w.profiles, w.keyFile, w.readKeyFile]) chmodSync(f, 0o644);
      const dataDir = join(w.root, 'data');
      mkdirSync(dataDir, { mode: 0o700 });
      const err = await start(w, dataDir).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IsolationError);
      // Held or handed to sessions as a copy: the original of either must stay unreadable.
      for (const f of [w.kek, w.profiles, w.keyFile, w.readKeyFile])
        expect(String(err)).toContain(`session user ${WRITER} can read ${f}`);
    }, 60_000);

    it('refuses a runner that does not switch to the session user', async () => {
      const w = world();
      const dataDir = join(w.root, 'data');
      mkdirSync(dataDir, { mode: 0o700 });
      await expect(start(w, dataDir, { runner: ['env', '--'] })).rejects.toThrow(
        `the runner started the probe as uid 0, not as ${WRITER} (uid ${writer.uid})`,
      );
    }, 60_000);
  });
});
