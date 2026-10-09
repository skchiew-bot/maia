/** aoc-sidecar --session <id> --pid <pid> --transcript <path> --daemon <url> --token <t> [--interval 5000] [--state-dir <dir>] [--spool-dir <dir>] */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Sidecar } from './sidecar';

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]): Promise<void> {
  const sessionId = arg('session', argv);
  const pid = Number(arg('pid', argv));
  const transcriptPath = arg('transcript', argv);
  const daemonUrl = arg('daemon', argv) ?? process.env.AOC_DAEMON_URL;
  const token = arg('token', argv) ?? process.env.AOC_INGEST_TOKEN;
  if (!sessionId || !Number.isInteger(pid) || pid <= 0 || !transcriptPath || !daemonUrl || !token) {
    process.stderr.write('usage: aoc-sidecar --session <id> --pid <pid> --transcript <path> --daemon <url> --token <token> [--interval ms] [--state-dir dir]\n');
    process.exit(2);
  }
  const stateDir = arg('state-dir', argv) ?? join(homedir(), '.aoc', 'sidecar');
  const sc = new Sidecar({
    sessionId,
    pid,
    transcriptPath,
    daemonUrl,
    token,
    stateDir,
    spoolDir: arg('spool-dir', argv),
    intervalMs: Number(arg('interval', argv) ?? 5000),
  });
  const shutdown = () => {
    sc.stop();
    void sc.flush().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await sc.start();
}

void main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`aoc-sidecar: ${String(err)}\n`);
  process.exit(1);
});
