import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readClientConfig, type ClientConfigFile } from '@aoc/client';
import { UsageError } from './errors';

/** aocd's default bind (AocConfig host/port). */
export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:7420';
export const ENV_DAEMON_URL = 'AOC_DAEMON_URL';
export const ENV_TOKEN = 'AOC_TOKEN';

export type ClientConfig = Partial<ClientConfigFile>;
export type ValueSource = 'flag' | 'env' | 'config' | 'default' | 'none';

export interface Target {
  daemonUrl: string;
  token: string | null;
  daemonSource: ValueSource;
  tokenSource: ValueSource;
}

export function clientConfigPath(homeDir: string): string {
  return join(homeDir, '.aoc', 'client.json');
}

export function loadClientConfig(path: string): ClientConfig | null {
  const c = readClientConfig(path) as unknown;
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as ClientConfig) : null;
}

/** Written atomically, 0600 inside a 0700 directory: the file holds bearer tokens. */
export function saveClientConfig(path: string, cfg: ClientConfig): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const clean: ClientConfig = {};
  if (cfg.daemonUrl) clean.daemonUrl = cfg.daemonUrl;
  if (cfg.token) clean.token = cfg.token;
  if (cfg.observerToken) clean.observerToken = cfg.observerToken;
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  chmodSync(path, 0o600);
}

export function normalizeDaemonUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UsageError(`invalid daemon URL "${raw}"`, 'expected e.g. http://127.0.0.1:7420');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new UsageError(`daemon URL must be http(s): "${raw}"`);
  return raw.trim().replace(/\/+$/, '');
}

export function isLoopbackUrl(url: string): boolean {
  const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h);
}

/** Precedence: --flag > environment > ~/.aoc/client.json > default. */
export function resolveTarget(i: {
  flagDaemon?: string;
  flagToken?: string;
  env: Record<string, string | undefined>;
  file: ClientConfig | null;
}): Target {
  let daemonUrl = DEFAULT_DAEMON_URL;
  let daemonSource: ValueSource = 'default';
  if (i.flagDaemon) [daemonUrl, daemonSource] = [i.flagDaemon, 'flag'];
  else if (i.env[ENV_DAEMON_URL]) [daemonUrl, daemonSource] = [i.env[ENV_DAEMON_URL]!, 'env'];
  else if (i.file?.daemonUrl) [daemonUrl, daemonSource] = [i.file.daemonUrl, 'config'];

  let token: string | null = null;
  let tokenSource: ValueSource = 'none';
  if (i.flagToken) [token, tokenSource] = [i.flagToken, 'flag'];
  else if (i.env[ENV_TOKEN]) [token, tokenSource] = [i.env[ENV_TOKEN]!, 'env'];
  else if (i.file?.token) [token, tokenSource] = [i.file.token, 'config'];

  return { daemonUrl: normalizeDaemonUrl(daemonUrl), token, daemonSource, tokenSource };
}
