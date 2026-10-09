import { existsSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { CommandContext } from '../context';
import type { CliDeps } from '../deps';
import { CliError } from '../errors';

/** Daemon bundled next to the CLI by scripts/build.mjs. */
export const DAEMON_BUNDLE = 'aocd.mjs';
const DEV_ENTRY = join('packages', 'daemon', 'src', 'main.ts');
const FORWARDED_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export interface DaemonEntry {
  kind: 'bundled' | 'dev';
  command: string;
  args: string[];
  cwd: string;
}

function findUp(start: string, test: (dir: string) => boolean): string | null {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (test(dir)) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** `aocd.mjs` next to this CLI's bundle; else `node --import tsx packages/daemon/src/main.ts` in a dev checkout. */
export function resolveDaemonEntry(
  deps: Pick<CliDeps, 'argv1' | 'cwd' | 'execPath'>,
  exists: (p: string) => boolean = existsSync,
): DaemonEntry | null {
  const cliDir = deps.argv1 ? dirname(resolve(deps.cwd, deps.argv1)) : null;
  if (cliDir && exists(join(cliDir, DAEMON_BUNDLE))) {
    return { kind: 'bundled', command: deps.execPath, args: [join(cliDir, DAEMON_BUNDLE)], cwd: deps.cwd };
  }
  for (const start of [cliDir, deps.cwd]) {
    const root = start ? findUp(start, (d) => exists(join(d, DEV_ENTRY))) : null;
    // Run from the checkout root so `--import tsx` resolves and relative config defaults match `pnpm dev`.
    if (root)
      return {
        kind: 'dev',
        command: deps.execPath,
        args: ['--import', 'tsx', join(root, DEV_ENTRY)],
        cwd: root,
      };
  }
  return null;
}

export function registerServe(program: Command, ctx: CommandContext): void {
  program
    .command('serve')
    .description('run the AOC daemon (aocd) in the foreground; signals are forwarded to it')
    .option('--config <file>', 'aocd configuration file')
    .action(async (opts: { config?: string }) => {
      const entry = resolveDaemonEntry(ctx.deps);
      if (!entry) {
        throw new CliError(
          `cannot find aocd: no ${DAEMON_BUNDLE} next to this CLI and no ${DEV_ENTRY} above ${ctx.deps.cwd}`,
        );
      }
      const args = opts.config ? [...entry.args, '--config', ctx.resolvePath(opts.config)] : entry.args;
      ctx.warn(`Starting aocd (${entry.kind}): ${[entry.command, ...args].join(' ')}`);
      ctx.exitCode = await runForwardingSignals(ctx, { command: entry.command, args, cwd: entry.cwd });
    });
}

async function runForwardingSignals(
  ctx: CommandContext,
  req: { command: string; args: string[]; cwd: string },
): Promise<number> {
  const { deps } = ctx;
  const child = deps.spawn({ ...req, detached: deps.platform !== 'win32' });
  const signals = deps.platform === 'win32' ? (['SIGINT', 'SIGTERM'] as NodeJS.Signals[]) : FORWARDED_SIGNALS;
  const forwarders = signals.map((sig) => [sig, () => void child.kill(sig)] as const);
  for (const [sig, fn] of forwarders) deps.signals.on(sig, fn);
  try {
    return await new Promise<number>((resolveExit, reject) => {
      child.once('error', (err) => reject(new CliError(`failed to start aocd: ${err.message}`)));
      child.once('exit', (code, signal) =>
        resolveExit(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1)),
      );
    });
  } finally {
    for (const [sig, fn] of forwarders) deps.signals.off(sig, fn);
  }
}
