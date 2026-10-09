import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { sessionIsolationOf, type AocConfig } from '@aoc/contracts';
import { createLogger } from '@aoc/kernel';
import { ConfigError, loadConfig, parseDaemonArgs, type LoadedConfig } from './config';
import { createAocServer, type AocServer } from './server';

const USAGE = `Usage: aocd [--config <file>]

Config file: --config <file>, else $AOC_CONFIG, else ./aoc.config.json, else built-in defaults.
Env overrides: AOC_PORT, AOC_HOST, AOC_DATA_DIR, AOC_PUBLIC_URL; AOC_LOG_LEVEL=debug|info|warn|error.
Secrets never go in the config file: AOC_BOOTSTRAP_TOKEN and ANTHROPIC_API_KEY come from the environment, the KEK
from keys.masterKeyFile (AOC_MASTER_KEY is accepted in development only): see .env.example.
`;

/** Intake videos (up to intake.maxVideoBytes) on slow links need longer than Node's 5-minute default. */
const REQUEST_TIMEOUT_MS = 15 * 60_000;
const SHUTDOWN_GRACE_MS = 5000;
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/** aocd: load config, compose the server, listen, start jobs, and shut down cleanly on SIGINT/SIGTERM. */
export async function runDaemon(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let loaded: LoadedConfig;
  try {
    if (parseDaemonArgs(argv).help) {
      process.stdout.write(USAGE);
      return;
    }
    loaded = loadConfig({ argv, env });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    process.stderr.write(`aocd: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  const { config } = loaded;
  const level = LOG_LEVELS.find((l) => l === env.AOC_LOG_LEVEL) ?? 'info';
  const log = createLogger({ level });
  for (const warning of loaded.warnings) log.warn('config warning', { warning });

  // A half-started composition may hold timers or handles, so failures exit explicitly.
  let aoc: AocServer;
  try {
    aoc = await createAocServer(config, { log });
  } catch (err) {
    log.error('startup failed', { err: String(err), stack: (err as Error).stack });
    process.exit(1);
  }
  let server: Server;
  try {
    server = await listen(aoc, config.host, config.port);
  } catch (err) {
    log.error('cannot listen', { host: config.host, port: config.port, err: String(err) });
    await aoc.close().catch(() => {});
    process.exit(1);
  }
  aoc.runtime.startJobs();
  const { port } = server.address() as AddressInfo;
  process.stdout.write(banner(aoc, loaded, port, env));
  log.info('aocd started', {
    host: config.host,
    port,
    headSeq: aoc.runtime.store.head().seq,
    modules: aoc.runtime.modules.length,
  });

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) {
      log.warn('second signal: exiting without a clean shutdown', { signal });
      process.exit(1);
    }
    stopping = true;
    log.info('shutting down', { signal });
    stop(server, aoc).then(
      () => {
        log.info('stopped');
        process.exit(0);
      },
      (err: unknown) => {
        log.error('shutdown failed', { err: String(err) });
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function listen(aoc: AocServer, host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: aoc.app.fetch, hostname: host, port, serverOptions: { requestTimeout: REQUEST_TIMEOUT_MS } },
      () => {
        server.off('error', reject);
        resolve(server as Server);
      },
    );
    server.once('error', reject);
  });
}

/** Stop accepting, end the event streams, let in-flight requests finish (bounded), then stop the runtime. */
async function stop(server: Server, aoc: AocServer): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  aoc.closeStreams();
  server.closeIdleConnections();
  const idle = setInterval(() => server.closeIdleConnections(), 100);
  const force = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
  await closed;
  clearInterval(idle);
  clearTimeout(force);
  // Drains reactors, stops jobs and modules, closes the DB. Managed claude processes are the
  // supervisor's to stop or recover; the daemon never kills them itself.
  await aoc.close();
}

function banner(aoc: AocServer, loaded: LoadedConfig, port: number, env: NodeJS.ProcessEnv): string {
  const { config } = aoc;
  const bound = config.host.includes(':') ? `[${config.host}]` : config.host;
  const lines = [
    `aocd listening on http://${bound}:${port}`,
    `  console  ${config.port === 0 ? `http://localhost:${port}` : config.publicUrl}/`,
    `  config   ${loaded.file ?? 'built-in defaults (no aoc.config.json)'}`,
    `  data     ${config.dataDir}`,
    `  sessions ${sessionsLine(config)}`,
  ];
  if (!aoc.webDir) lines.push('  ui       not built (run `pnpm build`); serving the API only');
  const hint = signInHint(aoc, env);
  if (hint) lines.push(`  sign-in  ${hint}`);
  return `${lines.join('\n')}\n`;
}

/** Who managed sessions run as (§3): the startup self-check has already passed when this prints. */
function sessionsLine(config: AocConfig): string {
  const s = config.supervisor;
  if (sessionIsolationOf(config) === 'none')
    return 'run as this OS user: isolation is off (development only; set supervisor.sessionUser)';
  return `run as ${s.sessionUser}${s.readOnlySessionUser ? `, read-only ones as ${s.readOnlySessionUser}` : ''} (${config.mode})`;
}

/** Where to find the bootstrap token — never the token itself. */
function signInHint(aoc: AocServer, env: NodeJS.ProcessEnv): string | null {
  const identity = aoc.runtime.services.maybe('identity');
  if (!identity) return 'no identity service is loaded, so authenticated APIs answer 401';
  let users: number;
  try {
    users = identity.listUsers().length;
  } catch {
    return null;
  }
  if (users > 0) return null;
  const file = aoc.config.identity.bootstrapTokenFile;
  const where = env.AOC_BOOTSTRAP_TOKEN
    ? 'from $AOC_BOOTSTRAP_TOKEN'
    : file
      ? `in ${file}`
      : 'printed once by `aoc init`';
  return `no users yet; sign in as the first Approver with the bootstrap token (${where})`;
}
