import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AocConfigSchema } from '@aoc/contracts';
import { ConfigError, loadConfig, parseDaemonArgs, resolveHelperCommands } from '../src/config';
import { removeTempDirs, repoRoot, tempDir } from './helpers';

afterEach(() => removeTempDirs());

function writeJson(file: string, value: unknown): string {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
  return file;
}

/** A directory that is neither a bundle dir nor inside a checkout. */
function detached() {
  return { binDir: tempDir('aocd-bin-'), repoRoot: null };
}

describe('loadConfig', () => {
  it('falls back to built-in defaults with paths resolved against the cwd', () => {
    const cwd = tempDir();
    const { config, file, source, warnings } = loadConfig({ argv: [], env: {}, cwd, ...detached() });
    expect(source).toBe('defaults');
    expect(file).toBeNull();
    expect(config.port).toBe(7420);
    expect(config.dataDir).toBe(join(cwd, '.aoc', 'data'));
    expect(config.supervisor.workspacesDir).toBe(join(cwd, '.aoc', 'workspaces'));
    expect(config.audit.anchorRepoPath).toBe(join(cwd, '.aoc', 'anchor-repo'));
    expect(config.publicUrl).toBe('http://localhost:7420');
    expect(config.identity).toMatchObject({ origin: 'http://localhost:7420', rpId: 'localhost' });
    expect(warnings.some((w) => w.includes('hookCommand'))).toBe(true);
  });

  it('resolves the file in order: --config, then AOC_CONFIG, then ./aoc.config.json', () => {
    const cwd = tempDir();
    writeJson(join(cwd, 'aoc.config.json'), { port: 7001 });
    const envFile = writeJson(join(cwd, 'env', 'aoc.json'), { port: 7002 });
    const flagFile = writeJson(join(cwd, 'flag', 'aoc.json'), { port: 7003 });
    const opts = { cwd, ...detached() };

    expect(loadConfig({ ...opts, env: {} })).toMatchObject({
      source: 'cwd',
      file: join(cwd, 'aoc.config.json'),
      config: { port: 7001 },
    });
    expect(loadConfig({ ...opts, env: { AOC_CONFIG: 'env/aoc.json' } })).toMatchObject({
      source: 'env',
      file: envFile,
      config: { port: 7002 },
    });
    expect(
      loadConfig({ ...opts, argv: ['--config', 'flag/aoc.json'], env: { AOC_CONFIG: envFile } }),
    ).toMatchObject({
      source: 'flag',
      file: flagFile,
      config: { port: 7003 },
    });
    expect(loadConfig({ ...opts, argv: [`--config=${flagFile}`], env: {} }).config.port).toBe(7003);
  });

  it('applies env overrides over the file; AOC_DATA_DIR is relative to the cwd', () => {
    const cwd = tempDir();
    writeJson(join(cwd, 'conf', 'aoc.config.json'), {
      port: 7001,
      host: '127.0.0.1',
      dataDir: 'file-data',
      publicUrl: 'http://file.example',
    });
    const { config } = loadConfig({
      cwd,
      ...detached(),
      env: {
        AOC_CONFIG: 'conf/aoc.config.json',
        AOC_PORT: '9100',
        AOC_HOST: '0.0.0.0',
        AOC_DATA_DIR: 'env-data',
        AOC_PUBLIC_URL: 'https://aoc.example.com/',
      },
    });
    expect(config).toMatchObject({
      port: 9100,
      host: '0.0.0.0',
      dataDir: join(cwd, 'env-data'),
      publicUrl: 'https://aoc.example.com',
    });
    expect(config.identity).toMatchObject({ origin: 'https://aoc.example.com', rpId: 'aoc.example.com' });
  });

  it("resolves relative paths against the config file's directory", () => {
    const cwd = tempDir();
    const confDir = join(cwd, 'etc', 'aoc');
    writeJson(join(confDir, 'aoc.config.json'), {
      dataDir: 'data',
      registryFile: '../process-types.json',
      keys: { masterKeyFile: 'keys/master.key' },
      supervisor: {
        claudeBin: './bin/claude',
        claudeArgsPrefix: ['--import', 'tsx', './sim/cli.ts'],
        hookCommand: ['node', './dist/bin/aoc-hook.mjs', '--flag'],
        credentialProfilesFile: 'secrets/profiles.json',
        workspacesDir: '/abs/workspaces',
        sessionHomesDir: 'session-homes',
        runner: ['./bin/aoc-container-run', '{sessionId}', '--'],
      },
      metering: { rateCardFile: 'rates.json' },
      audit: { anchorRepoPath: '~/anchors' },
      selfModification: {
        aocRepoPaths: ['../..'],
        externalAuditLog: 'selfmod.log',
        protectedPaths: ['packages/kernel/'],
      },
      identity: { bootstrapTokenFile: 'bootstrap.token' },
    });
    const { config } = loadConfig({
      cwd: tempDir(),
      env: { AOC_CONFIG: join(confDir, 'aoc.config.json') },
      ...detached(),
    });
    expect(config.dataDir).toBe(join(confDir, 'data'));
    expect(config.registryFile).toBe(join(cwd, 'etc', 'process-types.json'));
    expect(config.keys.masterKeyFile).toBe(join(confDir, 'keys', 'master.key'));
    expect(config.supervisor.claudeBin).toBe(join(confDir, 'bin', 'claude'));
    expect(config.supervisor.claudeArgsPrefix).toEqual(['--import', 'tsx', join(confDir, 'sim', 'cli.ts')]);
    expect(config.supervisor.hookCommand).toEqual([
      'node',
      join(confDir, 'dist', 'bin', 'aoc-hook.mjs'),
      '--flag',
    ]);
    expect(config.supervisor.credentialProfilesFile).toBe(join(confDir, 'secrets', 'profiles.json'));
    expect(config.supervisor.workspacesDir).toBe('/abs/workspaces');
    expect(config.supervisor.sessionHomesDir).toBe(join(confDir, 'session-homes'));
    expect(config.supervisor.runner).toEqual([
      join(confDir, 'bin', 'aoc-container-run'),
      '{sessionId}',
      '--',
    ]);
    expect(config.metering.rateCardFile).toBe(join(confDir, 'rates.json'));
    expect(config.audit.anchorRepoPath).toBe(join(homedir(), 'anchors'));
    expect(config.selfModification.aocRepoPaths).toEqual([cwd]);
    expect(config.selfModification.externalAuditLog).toBe(join(confDir, 'selfmod.log'));
    expect(config.selfModification.protectedPaths).toEqual(['packages/kernel/']);
    expect(config.identity.bootstrapTokenFile).toBe(join(confDir, 'bootstrap.token'));
  });

  it('derives publicUrl from host/port and WebAuthn origin/rpId from publicUrl unless they are set', () => {
    const cwd = tempDir();
    expect(loadConfig({ cwd, env: { AOC_PORT: '8080' }, ...detached() }).config).toMatchObject({
      publicUrl: 'http://localhost:8080',
      identity: { origin: 'http://localhost:8080', rpId: 'localhost' },
    });
    expect(
      loadConfig({ cwd, env: { AOC_HOST: 'aoc.internal', AOC_PORT: '81' }, ...detached() }).config.publicUrl,
    ).toBe('http://aoc.internal:81');
    writeJson(join(cwd, 'aoc.config.json'), {
      publicUrl: 'https://aoc.example.com',
      identity: { rpId: 'example.com' },
    });
    expect(loadConfig({ cwd, env: {}, ...detached() }).config.identity).toMatchObject({
      origin: 'https://aoc.example.com',
      rpId: 'example.com',
    });
  });

  it('ignores // and $ documentation keys and warns about unknown keys', () => {
    const cwd = tempDir();
    writeJson(join(cwd, 'aoc.config.json'), {
      $schema: './schema.json',
      '//': 'top-level comment',
      prot: 1,
      supervisor: {
        '//': 'section comment',
        '//credentialProfilesFile': '/etc/aoc/profiles.json',
        claudBin: 'x',
      },
      fx: { sanity: { min: 3, typo: true } },
    });
    const { config, warnings } = loadConfig({ cwd, env: {}, ...detached() });
    expect(config.supervisor.credentialProfilesFile).toBeUndefined();
    expect(config.fx.sanity.min).toBe(3);
    expect(warnings.filter((w) => w.startsWith('unknown'))).toEqual([
      'unknown config key "prot" is ignored',
      'unknown config key "supervisor.claudBin" is ignored',
      'unknown config key "fx.sanity.typo" is ignored',
    ]);
  });

  it('fails loudly on a missing explicit file, bad JSON, schema violations and a bad AOC_PORT', () => {
    const cwd = tempDir();
    const load =
      (env: Record<string, string>, argv: string[] = []) =>
      () =>
        loadConfig({ cwd, env, argv, ...detached() });
    expect(load({ AOC_CONFIG: 'missing.json' })).toThrow(/config file not found: .*missing\.json/);
    writeFileSync(join(cwd, 'bad.json'), '{ nope');
    expect(load({}, ['--config', 'bad.json'])).toThrow(/cannot read config file .*bad\.json/);
    writeJson(join(cwd, 'array.json'), [1]);
    expect(load({ AOC_CONFIG: 'array.json' })).toThrow(/must contain a JSON object/);
    writeJson(join(cwd, 'invalid.json'), { port: 'x', intake: { triageAgents: 9 } });
    expect(load({ AOC_CONFIG: 'invalid.json' })).toThrow(
      /invalid config in .*invalid\.json: port: .*; intake\.triageAgents: /,
    );
    expect(load({ AOC_PORT: '70000' })).toThrow(ConfigError);
    expect(load({ AOC_PORT: 'abc' })).toThrow('AOC_PORT must be an integer 0-65535 (got "abc")');
    expect(load({ AOC_PUBLIC_URL: 'not a url' })).toThrow(/publicUrl must be an absolute URL/);
    expect(load({}, ['--config'])).toThrow('--config needs a file path');
    expect(load({}, ['--port', '1'])).toThrow(/unknown argument "--port"/);
  });

  it('falls back to the packaged registry and rate card when the defaults are absent next to the config', () => {
    const cwd = tempDir();
    const fromCheckout = loadConfig({
      cwd,
      env: {},
      binDir: join(repoRoot, 'packages', 'daemon', 'src'),
      repoRoot,
    });
    expect(fromCheckout.config.registryFile).toBe(join(repoRoot, 'config', 'process-types.json'));
    expect(fromCheckout.config.metering.rateCardFile).toBe(join(repoRoot, 'config', 'rate-card.json'));

    const dist = tempDir('aocd-dist-');
    writeJson(join(dist, 'config', 'process-types.json'), {});
    const fromBundle = loadConfig({ cwd, env: {}, binDir: join(dist, 'bin'), repoRoot: null });
    expect(fromBundle.config.registryFile).toBe(join(dist, 'config', 'process-types.json'));
    expect(fromBundle.config.metering.rateCardFile).toBe(join(cwd, 'config', 'rate-card.json'));

    writeJson(join(cwd, 'aoc.config.json'), { registryFile: 'mine.json' });
    expect(loadConfig({ cwd, env: {}, binDir: join(dist, 'bin'), repoRoot: null }).config.registryFile).toBe(
      join(cwd, 'mine.json'),
    );
    writeJson(join(cwd, 'aoc.config.json'), { registryFile: 'config/process-types.json' });
    expect(loadConfig({ cwd, env: {}, binDir: join(dist, 'bin'), repoRoot: null }).config.registryFile).toBe(
      join(dist, 'config', 'process-types.json'),
    );
  });

  it('aoc.config.example.json documents exactly the built-in defaults', () => {
    const opts = { cwd: repoRoot, env: {}, binDir: join(repoRoot, 'packages', 'daemon', 'src'), repoRoot };
    const example = loadConfig({ ...opts, argv: ['--config', 'aoc.config.example.json'] });
    expect(example.warnings.filter((w) => w.startsWith('unknown'))).toEqual([]);
    expect(example.config).toEqual(loadConfig(opts).config);
  });
});

describe('resolveHelperCommands', () => {
  const base = () => AocConfigSchema.parse({});

  it('prefers bundles next to the daemon bundle', () => {
    const bin = tempDir('aocd-bin-');
    for (const f of ['aoc-hook.mjs', 'aoc-mcp.mjs', 'aoc-sidecar.mjs']) writeFileSync(join(bin, f), '');
    const { config, warnings } = resolveHelperCommands(base(), {
      binDir: bin,
      repoRoot,
      execPath: '/usr/bin/node',
    });
    expect(config.supervisor.hookCommand).toEqual(['/usr/bin/node', join(bin, 'aoc-hook.mjs')]);
    expect(config.supervisor.mcpCommand).toEqual(['/usr/bin/node', join(bin, 'aoc-mcp.mjs')]);
    expect(config.supervisor.sidecarCommand).toEqual(['/usr/bin/node', join(bin, 'aoc-sidecar.mjs')]);
    expect(warnings).toEqual([]);
  });

  it('falls back to the source entries via tsx in a checkout, with tsx resolved absolutely', () => {
    const { config } = resolveHelperCommands(base(), {
      binDir: join(repoRoot, 'packages', 'daemon', 'src'),
      repoRoot,
      execPath: '/usr/bin/node',
    });
    const [node, flag, tsx, entry] = config.supervisor.hookCommand;
    expect([node, flag]).toEqual(['/usr/bin/node', '--import']);
    expect(tsx).toMatch(/^file:\/\/.*tsx/);
    expect(entry).toBe(join(repoRoot, 'packages', 'hooks', 'src', 'main.ts'));
    expect(config.supervisor.mcpCommand.at(-1)).toBe(
      join(repoRoot, 'packages', 'mcp-server', 'src', 'main.ts'),
    );
    expect(config.supervisor.sidecarCommand.at(-1)).toBe(
      join(repoRoot, 'packages', 'sidecar', 'src', 'main.ts'),
    );
  });

  it('keeps configured commands and is idempotent', () => {
    const configured = AocConfigSchema.parse({ supervisor: { hookCommand: ['my-hook'] } });
    const once = resolveHelperCommands(configured, {
      binDir: join(repoRoot, 'packages', 'daemon', 'src'),
      repoRoot,
    });
    expect(once.config.supervisor.hookCommand).toEqual(['my-hook']);
    expect(
      resolveHelperCommands(once.config, { repoRoot: null, binDir: tempDir() }).config.supervisor,
    ).toEqual(once.config.supervisor);
  });
});

describe('parseDaemonArgs', () => {
  it('parses --config and --help', () => {
    expect(parseDaemonArgs([])).toEqual({ config: null, help: false });
    expect(parseDaemonArgs(['--config', 'a.json', '-h'])).toEqual({ config: 'a.json', help: true });
  });
});
