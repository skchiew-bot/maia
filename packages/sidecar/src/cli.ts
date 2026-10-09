import { homedir } from 'node:os';
import { join } from 'node:path';
import { AOC_ENV } from '@aoc/contracts';
import type { SidecarOptions } from './sidecar';

export const SIDECAR_USAGE =
  'usage: AOC_INGEST_TOKEN=<sidecar token> aoc-sidecar --session <id> --pid <pid> --transcript <path> [--daemon <url>] [--interval ms] [--state-dir dir] [--spool-dir dir]';

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Sidecar options from argv and the environment. The token comes from AOC_INGEST_TOKEN only: a command line is
 * readable by every local user, and the supervisor hands this process (and no other) the session's sidecar token.
 */
export function sidecarOptionsFrom(
  argv: string[],
  env: Record<string, string | undefined>,
): Omit<SidecarOptions, 'client' | 'isAlive' | 'now'> | { error: string } {
  if (argv.includes('--token')) return { error: `the token is read from ${AOC_ENV.ingestToken} only, never from argv` };
  const sessionId = arg('session', argv);
  const pid = Number(arg('pid', argv));
  const transcriptPath = arg('transcript', argv);
  const daemonUrl = arg('daemon', argv) ?? env[AOC_ENV.daemonUrl];
  const token = env[AOC_ENV.ingestToken];
  if (!sessionId || !Number.isInteger(pid) || pid <= 0 || !transcriptPath || !daemonUrl || !token) return { error: SIDECAR_USAGE };
  return {
    sessionId,
    pid,
    transcriptPath,
    daemonUrl,
    token,
    stateDir: arg('state-dir', argv) ?? join(homedir(), '.aoc', 'sidecar'),
    spoolDir: arg('spool-dir', argv),
    intervalMs: Number(arg('interval', argv) ?? 5000),
  };
}
