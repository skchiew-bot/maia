import type { AOC_ENV, INGEST_PATHS } from '@aoc/contracts';

/*
 * Hot-path copies of @aoc/contracts constants. Importing the contracts barrel at runtime evaluates zod and the whole
 * event catalog (~190 KB bundled, ~35 ms on every hook invocation), so the binary only `import type`s from it
 * (@aoc/client does the same). The `satisfies` clauses make tsc fail the moment these drift from the contracts.
 */

export const PATHS = {
  hook: '/ingest/hook',
  usage: '/ingest/usage',
  spool: '/ingest/spool',
} as const satisfies Pick<typeof INGEST_PATHS, 'hook' | 'usage' | 'spool'>;

export const ENV = {
  mode: 'AOC_MODE',
  sessionId: 'AOC_SESSION_ID',
  daemonUrl: 'AOC_DAEMON_URL',
  ingestToken: 'AOC_INGEST_TOKEN',
  spoolDir: 'AOC_SPOOL_DIR',
  internalLlm: 'AOC_INTERNAL_LLM',
  readOnly: 'AOC_READ_ONLY',
} as const satisfies Pick<
  typeof AOC_ENV,
  'mode' | 'sessionId' | 'daemonUrl' | 'ingestToken' | 'spoolDir' | 'internalLlm' | 'readOnly'
>;

/** Env vars only the hooks package reads (not part of AOC_ENV). */
export const HOOKS_ENV = {
  /** Path override for ~/.aoc/client.json (observed mode). */
  clientConfig: 'AOC_CLIENT_CONFIG',
  /** Set to "observed" by the command prefix of globally installed (observed) hook entries; see settings.ts. */
  hookScope: 'AOC_HOOK_SCOPE',
} as const;

export type Env = Record<string, string | undefined>;
