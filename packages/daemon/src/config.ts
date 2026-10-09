import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ZodTypeAny } from 'zod';
import { AocConfigSchema, defaultConfig, type AocConfig } from '@aoc/contracts';
import { findRepoRoot, moduleDir, resolveTsxImport } from './paths';

export class ConfigError extends Error {}

export type ConfigSource = 'flag' | 'env' | 'cwd' | 'defaults';

export interface LoadConfigOptions {
  argv?: readonly string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Directory of the daemon code/bundle (helper and packaged-default resolution). */
  binDir?: string;
  /** Source checkout root; `undefined` = detect from binDir, `null` = none. */
  repoRoot?: string | null;
}

export interface LoadedConfig {
  config: AocConfig;
  /** Absolute path of the file that was read; null when running on built-in defaults. */
  file: string | null;
  source: ConfigSource;
  /** Non-fatal findings worth printing at startup (unknown keys, helpers that do not exist yet). */
  warnings: string[];
}

export interface DaemonArgs {
  config: string | null;
  help: boolean;
}

export function parseDaemonArgs(argv: readonly string[]): DaemonArgs {
  const out: DaemonArgs = { config: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--config' || a.startsWith('--config=')) {
      const v = a === '--config' ? argv[++i] : a.slice('--config='.length);
      if (!v || v.startsWith('-')) throw new ConfigError('--config needs a file path');
      out.config = v;
    } else throw new ConfigError(`unknown argument "${a}" (usage: aocd [--config <file>])`);
  }
  return out;
}

/**
 * Resolve aocd's configuration. File: `--config <file>` > `AOC_CONFIG` > `./aoc.config.json` > built-in
 * defaults. Then env overrides (AOC_PORT, AOC_HOST, AOC_DATA_DIR, AOC_PUBLIC_URL), relative paths
 * resolved against the config file's directory, URL defaults derived from host/port, and the
 * supervisor's helper commands filled in when not configured.
 */
export function loadConfig(opts: LoadConfigOptions = {}): LoadedConfig {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const binDir = opts.binDir ?? moduleDir;
  const repoRoot = opts.repoRoot === undefined ? findRepoRoot(binDir) : opts.repoRoot;
  const args = parseDaemonArgs(opts.argv ?? []);

  const { file, source } = locateConfigFile(args.config, env, cwd);
  const raw = stripDocKeys(file ? readConfigFile(file) : {});
  const warnings = unknownKeys(AocConfigSchema, raw).map((k) => `unknown config key "${k}" is ignored`);
  applyEnvOverrides(raw, env, cwd);

  const parsed = AocConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new ConfigError(`invalid config${file ? ` in ${file}` : ''}: ${issues}`);
  }
  const given = (section: string, key: string) => {
    const s = raw[section];
    return isPlainObject(s) && key in s;
  };
  const defaults = defaultConfig();
  let config = resolvePaths(parsed.data, file ? dirname(file) : cwd);
  config = deriveUrls(config, {
    publicUrl: 'publicUrl' in raw,
    origin: given('identity', 'origin'),
    rpId: given('identity', 'rpId'),
  });
  config = withPackagedDefaults(
    config,
    {
      registryFile: parsed.data.registryFile !== defaults.registryFile,
      rateCardFile: parsed.data.metering.rateCardFile !== defaults.metering.rateCardFile,
    },
    binDir,
    repoRoot,
  );
  const helpers = resolveHelperCommands(config, { binDir, repoRoot });
  return { config: helpers.config, file, source, warnings: [...warnings, ...helpers.warnings] };
}

const HELPERS = [
  { key: 'sidecarCommand', bundle: 'aoc-sidecar.mjs', pkg: 'sidecar' },
  { key: 'hookCommand', bundle: 'aoc-hook.mjs', pkg: 'hooks' },
  { key: 'mcpCommand', bundle: 'aoc-mcp.mjs', pkg: 'mcp-server' },
] as const;

/**
 * Fill empty `supervisor.{sidecar,hook,mcp}Command`: the bundle next to the daemon bundle
 * (`[node, <binDir>/aoc-hook.mjs]`), else the source entry via tsx (`[node, --import, tsx, <repo>/packages/hooks/src/main.ts]`).
 * Configured commands are kept as they are. Idempotent.
 */
export function resolveHelperCommands(
  config: AocConfig,
  opts: { binDir?: string; repoRoot?: string | null; execPath?: string } = {},
): { config: AocConfig; warnings: string[] } {
  const binDir = opts.binDir ?? moduleDir;
  const repoRoot = opts.repoRoot === undefined ? findRepoRoot(binDir) : opts.repoRoot;
  const execPath = opts.execPath ?? process.execPath;
  const supervisor = { ...config.supervisor };
  const warnings: string[] = [];
  let tsx: string | null = null;
  for (const h of HELPERS) {
    if (supervisor[h.key].length) continue;
    const bundled = join(binDir, h.bundle);
    if (existsSync(bundled)) {
      supervisor[h.key] = [execPath, bundled];
    } else if (repoRoot) {
      const entry = join(repoRoot, 'packages', h.pkg, 'src', 'main.ts');
      tsx ??= resolveTsxImport(repoRoot);
      supervisor[h.key] = [execPath, '--import', tsx, entry];
      if (!existsSync(entry)) warnings.push(`supervisor.${h.key}: ${entry} does not exist yet`);
    } else {
      warnings.push(
        `supervisor.${h.key}: no ${h.bundle} next to the daemon and no source checkout; configure it explicitly`,
      );
    }
  }
  return { config: { ...config, supervisor }, warnings };
}

function locateConfigFile(
  flag: string | null,
  env: Record<string, string | undefined>,
  cwd: string,
): { file: string | null; source: ConfigSource } {
  if (flag) return { file: resolve(cwd, flag), source: 'flag' };
  if (env.AOC_CONFIG) return { file: resolve(cwd, env.AOC_CONFIG), source: 'env' };
  const local = join(cwd, 'aoc.config.json');
  return existsSync(local) ? { file: local, source: 'cwd' } : { file: null, source: 'defaults' };
}

function readConfigFile(file: string): Record<string, unknown> {
  if (!existsSync(file)) throw new ConfigError(`config file not found: ${file}`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`cannot read config file ${file}: ${(err as Error).message}`);
  }
  if (!isPlainObject(value)) throw new ConfigError(`config file ${file} must contain a JSON object`);
  return value;
}

function applyEnvOverrides(
  raw: Record<string, unknown>,
  env: Record<string, string | undefined>,
  cwd: string,
): void {
  if (env.AOC_PORT) {
    const port = Number(env.AOC_PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new ConfigError(`AOC_PORT must be an integer 0-65535 (got "${env.AOC_PORT}")`);
    raw.port = port;
  }
  if (env.AOC_HOST) raw.host = env.AOC_HOST;
  // Env paths are relative to the shell's cwd, not to the config file.
  if (env.AOC_DATA_DIR) raw.dataDir = resolve(cwd, expandHome(env.AOC_DATA_DIR));
  if (env.AOC_PUBLIC_URL) raw.publicUrl = env.AOC_PUBLIC_URL;
}

function resolvePaths(c: AocConfig, baseDir: string): AocConfig {
  const path = (p: string) => (isAbsolute(expandHome(p)) ? expandHome(p) : resolve(baseDir, p));
  const optPath = (p: string | undefined) => (p === undefined ? undefined : path(p));
  // Command arguments are only paths when they say so ("./x", "../x", "~/x").
  const arg = (a: string) => (/^(?:\.{1,2}|~)[\\/]/.test(a) ? path(a) : a);
  return {
    ...c,
    dataDir: c.dataDir === ':memory:' ? c.dataDir : path(c.dataDir),
    keys: { ...c.keys, masterKeyFile: optPath(c.keys.masterKeyFile) },
    registryFile: path(c.registryFile),
    supervisor: {
      ...c.supervisor,
      claudeBin: arg(c.supervisor.claudeBin),
      claudeArgsPrefix: c.supervisor.claudeArgsPrefix.map(arg),
      sidecarCommand: c.supervisor.sidecarCommand.map(arg),
      hookCommand: c.supervisor.hookCommand.map(arg),
      mcpCommand: c.supervisor.mcpCommand.map(arg),
      workspacesDir: path(c.supervisor.workspacesDir),
      credentialProfilesFile: optPath(c.supervisor.credentialProfilesFile),
    },
    metering: { ...c.metering, rateCardFile: path(c.metering.rateCardFile) },
    audit: {
      ...c.audit,
      anchorRepoPath: path(c.audit.anchorRepoPath),
      gnupgHome: optPath(c.audit.gnupgHome),
      tsaCaFile: optPath(c.audit.tsaCaFile),
      tsaUntrustedFile: optPath(c.audit.tsaUntrustedFile),
    },
    selfModification: {
      ...c.selfModification,
      aocRepoPaths: c.selfModification.aocRepoPaths.map(path),
      externalAuditLog: path(c.selfModification.externalAuditLog),
    },
    identity: { ...c.identity, bootstrapTokenFile: optPath(c.identity.bootstrapTokenFile) },
  };
}

const LOCAL_HOSTS = new Set(['', '127.0.0.1', '::1', '0.0.0.0', '::', 'localhost']);

/** publicUrl follows host/port unless set; WebAuthn origin and rpId follow publicUrl unless set. */
function deriveUrls(c: AocConfig, given: { publicUrl: boolean; origin: boolean; rpId: boolean }): AocConfig {
  const host = LOCAL_HOSTS.has(c.host) ? 'localhost' : c.host.includes(':') ? `[${c.host}]` : c.host;
  const publicUrl = given.publicUrl ? c.publicUrl.replace(/\/+$/, '') : `http://${host}:${c.port}`;
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new ConfigError(`publicUrl must be an absolute URL (got "${publicUrl}")`);
  }
  return {
    ...c,
    publicUrl,
    identity: {
      ...c.identity,
      origin: given.origin ? c.identity.origin : url.origin,
      rpId: given.rpId ? c.identity.rpId : url.hostname,
    },
  };
}

/** The default data files fall back to the packaged copies (dist/config or the checkout) when absent next to the config. */
function withPackagedDefaults(
  c: AocConfig,
  custom: { registryFile: boolean; rateCardFile: boolean },
  binDir: string,
  repoRoot: string | null,
): AocConfig {
  const packaged = (current: string, isCustom: boolean, name: string) => {
    if (isCustom || existsSync(current)) return current;
    const dirs = [join(binDir, '..', 'config'), ...(repoRoot ? [join(repoRoot, 'config')] : [])];
    return dirs.map((d) => join(d, name)).find((f) => existsSync(f)) ?? current;
  };
  return {
    ...c,
    registryFile: packaged(c.registryFile, custom.registryFile, 'process-types.json'),
    metering: {
      ...c.metering,
      rateCardFile: packaged(c.metering.rateCardFile, custom.rateCardFile, 'rate-card.json'),
    },
  };
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Keys starting with "//" or "$" are documentation (see aoc.config.example.json). */
function stripDocKeys(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (k.startsWith('//') || k.startsWith('$')) continue;
    out[k] = isPlainObject(val) ? stripDocKeys(val) : val;
  }
  return out;
}

function unknownKeys(schema: ZodTypeAny, value: unknown, prefix = ''): string[] {
  const shape = objectShape(schema);
  if (!shape || !isPlainObject(value)) return [];
  return Object.entries(value).flatMap(([k, v]) =>
    k in shape ? unknownKeys(shape[k]!, v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

function objectShape(schema: ZodTypeAny): Record<string, ZodTypeAny> | null {
  let s = schema;
  for (;;) {
    const def = s._def as { typeName?: string; innerType?: ZodTypeAny; schema?: ZodTypeAny };
    if (def.innerType && ['ZodDefault', 'ZodOptional', 'ZodNullable'].includes(def.typeName ?? ''))
      s = def.innerType;
    else if (def.typeName === 'ZodEffects' && def.schema) s = def.schema;
    else
      return def.typeName === 'ZodObject'
        ? (s as unknown as { shape: Record<string, ZodTypeAny> }).shape
        : null;
  }
}
