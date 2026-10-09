/**
 * stdio entry. Claude Code spawns this for each managed session with AOC_SESSION_ID, AOC_DAEMON_URL and
 * AOC_INGEST_TOKEN set by the supervisor. stdout carries JSON-RPC only; every log line goes to stderr.
 * No explicit exit on stdin close: the process ends by itself once in-flight calls are answered, so a
 * task_done already sent to the daemon is never cut off mid-flight.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient } from '@aoc/client';
import { readMcpServerEnv } from './env';
import { AOC_MCP_SERVER_VERSION, DAEMON_TIMEOUT_MS, createAocMcpServer } from './server';

const log = (line: string): void => {
  process.stderr.write(`aoc-mcp: ${line}\n`);
};
// A stray console.log from any dependency would corrupt the JSON-RPC stream.
console.log = console.info = console.debug = console.error;

async function main(): Promise<void> {
  const cfg = readMcpServerEnv(process.env);
  if (!cfg.ok) {
    for (const problem of cfg.problems) log(problem);
    log('refusing to start: managed sessions never run unauthenticated');
    process.exit(1);
  }
  const { sessionId, daemonUrl, token } = cfg.env;
  const server = createAocMcpServer({
    client: createClient({ daemonUrl, token, timeoutMs: DAEMON_TIMEOUT_MS }),
    sessionId,
  });
  server.server.onerror = (err) => log(`mcp error: ${err.message}`);
  await server.connect(new StdioServerTransport());
  log(`v${AOC_MCP_SERVER_VERSION} serving session ${sessionId} via ${daemonUrl}`);
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
