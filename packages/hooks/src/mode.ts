import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENV, HOOKS_ENV, type Env } from './constants';

export interface ManagedMode {
  kind: 'managed';
  /** null = the supervisor launched the session without AOC_SESSION_ID: fails closed rather than degrading to observed. */
  aocSessionId: string | null;
  daemonUrl: string | null;
  token: string | null;
  spoolDir: string;
}
export interface ObservedMode {
  kind: 'observed';
  daemonUrl: string;
  token: string | null;
  spoolDir: string;
  /** Per-transcript read cursors for observed usage (~/.aoc/state). */
  stateDir: string;
}
export interface OffMode {
  kind: 'off';
  reason: 'no-client-config' | 'managed-registration-owns-session';
}
export type HookMode = ManagedMode | ObservedMode | OffMode;

/**
 * - `AOC_MODE=managed` → managed (enforce; fail loudly). The supervisor also sets AOC_SESSION_ID, AOC_DAEMON_URL,
 *   AOC_INGEST_TOKEN and optionally AOC_SPOOL_DIR.
 * - otherwise observed, configured by ~/.aoc/client.json (or $AOC_CLIENT_CONFIG); no usable config → off (silent).
 * - The globally installed observed entries carry AOC_HOOK_SCOPE=observed; inside a managed session (which inherits
 *   the user's global settings) they stand down so each event is relayed once, by the managed registration.
 */
export function resolveMode(env: Env, homeDir: string): HookMode {
  const aocDir = join(homeDir, '.aoc');
  if (env[ENV.mode] === 'managed') {
    if (env[HOOKS_ENV.hookScope] === 'observed')
      return { kind: 'off', reason: 'managed-registration-owns-session' };
    return {
      kind: 'managed',
      aocSessionId: nonEmpty(env[ENV.sessionId]),
      daemonUrl: nonEmpty(env[ENV.daemonUrl]),
      token: nonEmpty(env[ENV.ingestToken]),
      spoolDir: nonEmpty(env[ENV.spoolDir]) ?? join(aocDir, 'spool', 'managed'),
    };
  }
  const config = readObserverConfig(nonEmpty(env[HOOKS_ENV.clientConfig]) ?? join(aocDir, 'client.json'));
  if (!config) return { kind: 'off', reason: 'no-client-config' };
  return {
    kind: 'observed',
    daemonUrl: config.daemonUrl,
    token: config.observerToken,
    spoolDir: join(aocDir, 'spool', 'observed'),
    stateDir: join(aocDir, 'state'),
  };
}

/** Reads only what observed hooks need from the shared client config ({daemonUrl, observerToken}). */
export function readObserverConfig(file: string): { daemonUrl: string; observerToken: string | null } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const c = raw as { daemonUrl?: unknown; observerToken?: unknown } | null;
  if (!c || typeof c.daemonUrl !== 'string' || !isHttpUrl(c.daemonUrl)) return null;
  return {
    daemonUrl: c.daemonUrl,
    observerToken: typeof c.observerToken === 'string' && c.observerToken ? c.observerToken : null,
  };
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function nonEmpty(v: string | undefined): string | null {
  return v ? v : null;
}
