import { AOC_ENV } from '@aoc/contracts';

export interface McpServerEnv {
  sessionId: string;
  daemonUrl: string;
  token: string;
}

export type McpServerEnvResult = { ok: true; env: McpServerEnv } | { ok: false; problems: string[] };

/**
 * The supervisor passes these to the MCP server of every managed session. Without all three the server
 * must not start: an unauthenticated or session-less voice would let work proceed unrecorded (§2, §3).
 */
export function readMcpServerEnv(env: Record<string, string | undefined>): McpServerEnvResult {
  const sessionId = env[AOC_ENV.sessionId]?.trim() ?? '';
  const daemonUrl = env[AOC_ENV.daemonUrl]?.trim() ?? '';
  const token = env[AOC_ENV.ingestToken]?.trim() ?? '';
  const missing = (
    [
      [AOC_ENV.sessionId, sessionId],
      [AOC_ENV.daemonUrl, daemonUrl],
      [AOC_ENV.ingestToken, token],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);
  const problems = missing.length ? [`missing ${missing.join(', ')}`] : [];
  if (daemonUrl && !isHttpUrl(daemonUrl)) problems.push(`${AOC_ENV.daemonUrl} must be an http(s) URL`);
  return problems.length ? { ok: false, problems } : { ok: true, env: { sessionId, daemonUrl, token } };
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
