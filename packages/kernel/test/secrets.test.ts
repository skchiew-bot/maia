import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AocConfigSchema } from '@aoc/contracts';
import {
  AocRuntime,
  childEnv,
  createGitService,
  EventStore,
  FakeClock,
  initRepo,
  loadOrCreateMasterKey,
  silentLogger,
  type Logger,
} from '../src';

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'aoc-secrets-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const hex = () => randomBytes(32).toString('hex');
const isRoot = process.getuid?.() === 0;

/** Runs `fn` with extra variables in aocd's own environment, then restores it. */
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

describe('kernel-spawned processes never inherit aocd secrets (G-46, O-13)', () => {
  const planted = {
    AOC_MASTER_KEY: 'kek-SECRET-1',
    AOC_BOOTSTRAP_TOKEN: 'bootstrap-SECRET-2',
    AOC_INGEST_TOKEN: 'ingest-SECRET-3',
    ANTHROPIC_API_KEY: 'sk-ant-SECRET-4',
    ANTHROPIC_AUTH_TOKEN: 'auth-SECRET-5',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-SECRET-6',
    GITHUB_TOKEN: 'ghp_SECRET-7',
    GIT_SSH_COMMAND: 'ssh -i /etc/aoc/keys/promotion-SECRET-8',
  };

  it('a git child (and whatever git starts) sees no AOC_*, ANTHROPIC_* or tokens', () => {
    const repo = join(temp(), 'repo');
    initRepo(repo);
    const git = createGitService();
    // A shell alias runs a child of git with git's own environment: exactly what hooks or filters would see.
    const r = withEnv(planted, () => git.run(repo, ['-c', 'alias.envdump=!env', 'envdump']));
    expect(r.code, r.stderr).toBe(0);
    const seen = parseEnv(r.stdout);
    expect(Object.keys(seen).filter((k) => /^(AOC_|ANTHROPIC_|CLAUDE_CODE_)/.test(k))).toEqual([]);
    for (const secret of Object.values(planted)) expect(r.stdout).not.toContain(secret);
    expect(seen.GIT_TERMINAL_PROMPT).toBe('0');
    // git prepends its exec-path for aliases; the rest is aocd's PATH.
    expect(seen.PATH).toContain(process.env.PATH);
  });

  it('ignores an inherited GIT_DIR and passes explicit caller variables through', () => {
    const a = join(temp(), 'a');
    const b = join(temp(), 'b');
    initRepo(a, { files: { 'a.txt': 'a\n' } });
    initRepo(b, { files: { 'b.txt': 'b\n' } });
    const git = createGitService();
    const head = withEnv({ GIT_DIR: join(b, '.git'), GIT_WORK_TREE: b }, () => git.head(a));
    expect(head).toBe(git.head(a));
    expect(head).not.toBe(git.head(b));
    const r = git.run(a, ['-c', 'alias.envdump=!env', 'envdump'], {
      env: { GIT_AUTHOR_NAME: 'AOC supervisor' },
    });
    expect(parseEnv(r.stdout).GIT_AUTHOR_NAME).toBe('AOC supervisor');
  });

  it('childEnv keeps only the allowlist, then explicit values', () => {
    expect(
      childEnv(
        {
          PATH: '/bin',
          HOME: '/home/aoc',
          LANG: 'C.UTF-8',
          AOC_MASTER_KEY: 'k',
          DEPLOY_TOKEN: 't',
          HTTPS_PROXY: 'http://p',
        },
        { GIT_TERMINAL_PROMPT: '0' },
      ),
    ).toEqual({
      PATH: '/bin',
      HOME: '/home/aoc',
      LANG: 'C.UTF-8',
      HTTPS_PROXY: 'http://p',
      GIT_TERMINAL_PROMPT: '0',
    });
  });
});

describe('KEK custody (R6)', () => {
  it('development: AOC_MASTER_KEY, else the file, else a generated 0600 key in a 0700 directory', () => {
    const d = temp();
    const file = join(d, 'keys', 'master.key');
    const generated = loadOrCreateMasterKey(file, {});
    expect(generated.created).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(d, 'keys')).mode & 0o777).toBe(0o700);
    expect(loadOrCreateMasterKey(file, {}).key.equals(generated.key)).toBe(true);
    const fromEnv = hex();
    expect(loadOrCreateMasterKey(file, { AOC_MASTER_KEY: fromEnv }).key.toString('hex')).toBe(fromEnv);
  });

  describe('development never replaces the KEK of a data dir that already holds data', () => {
    /** A data dir as aocd leaves it after real use: one sealed body, one event. */
    function populated(): string {
      const dataDir = join(temp(), 'data');
      const store = new EventStore({
        dataDir,
        clock: new FakeClock('2026-10-09T01:00:00.000Z'),
        log: silentLogger,
        masterKey: randomBytes(32),
      });
      store.append({
        type: 'session.nudged',
        actor: { kind: 'human', id: 'usr_1' },
        scope: { sessionId: 'ses_1' },
        meta: { sessionId: 'ses_1' },
        payload: { text: 'sealed under the original KEK' },
        source: 'api',
      });
      store.close();
      return dataDir;
    }
    /** Where a restored or mistyped configuration would point: no key there. */
    const lostKey = () => join(temp(), 'keys', 'master.key');

    it('refuses to generate a KEK beside aoc.db and bodies.db with data, and leaves nothing behind', () => {
      const dataDir = populated();
      const file = lostKey();
      let message = '';
      try {
        loadOrCreateMasterKey(file, {}, { dataDir });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('refusing to generate a new KEK');
      expect(message).toContain('aoc.db holds events');
      expect(message).toContain('bodies.db holds wrapped data keys');
      expect(message).toContain(dataDir);
      expect(message).toContain(file);
      expect(message).toContain('docs/runbooks/key-custody.md');
      expect(existsSync(file)).toBe(false);
      expect(existsSync(dirname(file))).toBe(false);
    });

    it('refuses when only bodies.db remains (aoc.db lost) or only aoc.db remains (bodies.db lost)', () => {
      const noChain = populated();
      for (const f of readdirSync(noChain).filter((f) => f.startsWith('aoc.db'))) rmSync(join(noChain, f));
      expect(() => loadOrCreateMasterKey(lostKey(), {}, { dataDir: noChain })).toThrow(
        /bodies\.db holds wrapped data keys/,
      );
      const noBodies = populated();
      for (const f of readdirSync(noBodies).filter((f) => f.startsWith('bodies.db')))
        rmSync(join(noBodies, f));
      expect(() => loadOrCreateMasterKey(lostKey(), {}, { dataDir: noBodies })).toThrow(
        /aoc\.db holds events/,
      );
    });

    it('fails closed on a database it cannot read', () => {
      const dataDir = join(temp(), 'data');
      mkdirSync(dataDir);
      writeFileSync(join(dataDir, 'aoc.db'), 'this is not a database'.repeat(200));
      const file = lostKey();
      expect(() => loadOrCreateMasterKey(file, {}, { dataDir })).toThrow(/aoc\.db cannot be read/);
      expect(existsSync(file)).toBe(false);
    });

    it('checks the key file directory when no data dir is given (the default <dataDir>/master.key)', () => {
      const dataDir = populated();
      expect(() => loadOrCreateMasterKey(join(dataDir, 'master.key'), {})).toThrow(
        /refusing to generate a new KEK/,
      );
      expect(existsSync(join(dataDir, 'master.key'))).toBe(false);
    });

    it('still generates for a fresh data dir, also one that only holds empty databases', () => {
      const fresh = join(temp(), 'data');
      const first = loadOrCreateMasterKey(join(fresh, 'master.key'), {}, { dataDir: fresh });
      expect(first.created).toBe(true);

      const empty = join(temp(), 'data');
      new EventStore({
        dataDir: empty,
        clock: new FakeClock(),
        log: silentLogger,
        masterKey: randomBytes(32),
      }).close();
      expect(readdirSync(empty)).toContain('aoc.db');
      expect(loadOrCreateMasterKey(join(empty, 'master.key'), {}, { dataDir: empty }).created).toBe(true);
    });

    it('does not get in the way of a KEK that exists: a key file, or AOC_MASTER_KEY', () => {
      const dataDir = populated();
      const key = hex();
      const file = join(temp(), 'kek');
      writeFileSync(file, `${key}\n`, { mode: 0o600 });
      expect(loadOrCreateMasterKey(file, {}, { dataDir }).key.toString('hex')).toBe(key);
      const fromEnv = hex();
      expect(
        loadOrCreateMasterKey(lostKey(), { AOC_MASTER_KEY: fromEnv }, { dataDir }).key.toString('hex'),
      ).toBe(fromEnv);
    });

    it('stops aocd at startup, before it touches the data', async () => {
      const dataDir = populated();
      const file = lostKey();
      const config = AocConfigSchema.parse({ dataDir, keys: { masterKeyFile: file } });
      await expect(
        AocRuntime.create({ config, modules: [], clock: new FakeClock(), log: silentLogger }),
      ).rejects.toThrow(/refusing to generate a new KEK.*docs\/runbooks\/key-custody\.md/s);
      expect(existsSync(file)).toBe(false);
      expect(existsSync(join(dataDir, 'master.key'))).toBe(false);
    });
  });

  describe('development: a KEK from AOC_MASTER_KEY is accepted, and warned about at startup', () => {
    /** Starts a runtime on a fresh data dir with `env`, returning every warning it logged. */
    async function startWith(env: Record<string, string>, masterKeyFile?: string): Promise<string[]> {
      const warnings: string[] = [];
      const log: Logger = {
        ...silentLogger,
        warn: (msg, fields) => void warnings.push(`${msg} ${JSON.stringify(fields ?? {})}`),
        child: () => log,
      };
      const config = AocConfigSchema.parse({
        dataDir: join(temp(), 'data'),
        keys: masterKeyFile ? { masterKeyFile } : {},
      });
      const rt = await AocRuntime.create({ config, modules: [], clock: new FakeClock(), log, env });
      await rt.stop();
      return warnings;
    }

    it('logs a warning that names the variable and the runbook, and never the key itself', async () => {
      const key = hex();
      const warnings = await startWith({ AOC_MASTER_KEY: key });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('AOC_MASTER_KEY');
      expect(warnings[0]).toContain('development only');
      expect(warnings[0]).toContain('docs/runbooks/key-custody.md');
      expect(warnings.join('\n')).not.toContain(key);
    });

    it('is quiet when the KEK comes from a file, generated or provided', async () => {
      expect(await startWith({})).toEqual([]);
      const file = join(temp(), 'kek');
      writeFileSync(file, `${hex()}\n`, { mode: 0o600 });
      expect(await startWith({}, file)).toEqual([]);
    });

    it('production still refuses it', async () => {
      const dir = temp();
      const kek = join(dir, 'kek');
      writeFileSync(kek, `${hex()}\n`, { mode: 0o400 });
      const config = AocConfigSchema.parse({
        mode: 'production',
        dataDir: join(dir, 'data'),
        keys: { masterKeyFile: kek },
      });
      await expect(
        AocRuntime.create({
          config,
          modules: [],
          clock: new FakeClock(),
          log: silentLogger,
          env: { AOC_MASTER_KEY: hex() },
        }),
      ).rejects.toThrow(/AOC_MASTER_KEY is refused/);
    });
  });

  describe('production', () => {
    const setup = () => {
      const d = temp();
      const dataDir = join(d, 'data');
      mkdirSync(dataDir, { mode: 0o700 });
      const kek = join(d, 'kek');
      const load = (file = kek, env: Record<string, string> = {}) =>
        loadOrCreateMasterKey(file, env, { production: true, dataDir });
      return { d, dataDir, kek, load };
    };

    it('refuses a KEK from AOC_MASTER_KEY, even when the file is fine', () => {
      const { kek, load } = setup();
      writeFileSync(kek, `${hex()}\n`, { mode: 0o400 });
      expect(() => load(kek, { AOC_MASTER_KEY: hex() })).toThrow(/AOC_MASTER_KEY is refused/);
    });

    it('never generates a KEK', () => {
      const { kek, load } = setup();
      expect(() => load()).toThrow(/unavailable \(ENOENT\); a production KEK is never generated/);
      expect(existsSync(kek)).toBe(false);
    });

    it('accepts only mode 0400 or 0600', () => {
      const { kek, load } = setup();
      const key = hex();
      writeFileSync(kek, `${key}\n`, { mode: 0o400 });
      expect(load().key.toString('hex')).toBe(key);
      chmodSync(kek, 0o600);
      expect(load().key.toString('hex')).toBe(key);
      for (const mode of [0o640, 0o644, 0o604, 0o700]) {
        chmodSync(kek, mode);
        expect(() => load(), mode.toString(8)).toThrow(
          `has mode 0${mode.toString(8)}; it must be 0400 or 0600`,
        );
      }
    });

    it('refuses a KEK inside dataDir (the default <dataDir>/master.key included)', () => {
      const { dataDir, load } = setup();
      const inside = join(dataDir, 'master.key');
      writeFileSync(inside, `${hex()}\n`, { mode: 0o600 });
      expect(() => load(inside)).toThrow(/is inside dataDir/);
    });

    it('accepts a systemd credential as systemd hands it over', () => {
      const { d, load } = setup();
      const creds = join(d, 'credentials');
      mkdirSync(creds, { mode: 0o700 });
      const file = join(creds, 'aoc-kek');
      writeFileSync(file, `${hex()}\n`, { mode: 0o440 });
      // Read-only only once filled, and writable again for cleanup: only root writes into a 0500 directory.
      chmodSync(creds, 0o500);
      try {
        expect(() => load(file)).toThrow(/mode 0440/);
        expect(load(file, { CREDENTIALS_DIRECTORY: creds }).key).toHaveLength(32);
      } finally {
        chmodSync(creds, 0o700);
      }
    });

    it.runIf(isRoot)('refuses a KEK owned by another user (root only: needs chown)', () => {
      const { kek, load } = setup();
      writeFileSync(kek, `${hex()}\n`, { mode: 0o600 });
      chownSync(kek, 65534, 65534);
      expect(() => load()).toThrow(/owned by uid 65534, not by aocd's user \(uid 0\)/);
    });
  });
});
