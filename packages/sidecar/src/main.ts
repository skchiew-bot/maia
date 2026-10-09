/** AOC_INGEST_TOKEN=<sidecar token> aoc-sidecar --session <id> --pid <pid> --transcript <path> [--daemon <url>] [--interval 5000] [--state-dir <dir>] [--spool-dir <dir>] */
import { SIDECAR_READY_LINE } from '@aoc/contracts';
import { sidecarOptionsFrom } from './cli';
import { Sidecar } from './sidecar';

async function main(argv: string[]): Promise<void> {
  const opts = sidecarOptionsFrom(argv, process.env);
  if ('error' in opts) {
    process.stderr.write(`aoc-sidecar: ${opts.error}\n`);
    process.exit(2);
  }
  const sc = new Sidecar(opts);
  // The supervisor stops the sidecar once its turn's process is gone: report what is left, then exit.
  const shutdown = () => void sc.shutdown().finally(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stdout.write(`${SIDECAR_READY_LINE}\n`);
  await sc.start();
}

void main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`aoc-sidecar: ${String(err)}\n`);
  process.exit(1);
});
