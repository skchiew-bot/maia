/**
 * The demo must never run the real `claude` CLI (no plan quota, no real repositories). Before aocd starts, the
 * config's managed-session command has to be claude-sim; anything else is refused.
 */
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** claude-sim's launcher in this checkout (runs the TypeScript entry through tsx). */
export const CLAUDE_SIM_BIN = fileURLToPath(new URL('../../claude-sim/bin/claude-sim.mjs', import.meta.url));
const CLAUDE_SIM_CLI = fileURLToPath(new URL('../../claude-sim/src/cli.ts', import.meta.url));
/** The esbuild bundle produced by scripts/build.mjs. */
const BUNDLE_NAME = 'claude-sim.mjs';

/** Node flags whose value is the next argument (`node --import tsx <script>`). */
const NODE_FLAGS_WITH_VALUE = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader', '--conditions', '-C']);

export interface ManagedCommand {
  claudeBin: string;
  claudeArgsPrefix: string[];
}

/**
 * Why `cmd` is not claude-sim, or null when it is. Accepted: claudeBin is a node binary whose script (the first
 * positional of claudeArgsPrefix) is claude-sim's launcher, its CLI source or its bundle; or claudeBin is the
 * bundle itself. Relative paths resolve against `baseDir`, as aocd resolves "./" and "../" in its config.
 */
export function claudeSimProblem(cmd: ManagedCommand, baseDir: string): string | null {
  const shown = [cmd.claudeBin, ...cmd.claudeArgsPrefix].join(' ');
  const refuse = (why: string) =>
    `supervisor.claudeBin runs "${shown}": ${why}. The demo only launches managed sessions on claude-sim, so it refuses to start (the real claude CLI is never spawned).`;
  const pathArg = (p: string) => (/^\.{1,2}[\\/]/.test(p) ? resolve(baseDir, p) : p);

  if (isSimScript(pathArg(cmd.claudeBin))) return null;
  if (!isNodeBinary(cmd.claudeBin)) return refuse('it is not node running claude-sim');
  const script = firstScript(cmd.claudeArgsPrefix);
  if (!script) return refuse('node is given no claude-sim script in supervisor.claudeArgsPrefix');
  const file = pathArg(script);
  if (!isAbsolute(file) || !existsSync(file)) return refuse(`the script ${script} does not exist`);
  return isSimScript(file) ? null : refuse(`${script} is not claude-sim`);
}

function isNodeBinary(bin: string): boolean {
  if (sameFile(bin, process.execPath)) return true;
  return /^node(?:js)?(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(basename(bin));
}

function firstScript(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (NODE_FLAGS_WITH_VALUE.has(a)) {
      i++;
      continue;
    }
    if (!a.startsWith('-')) return a;
  }
  return null;
}

function isSimScript(file: string): boolean {
  if (!isAbsolute(file) || !existsSync(file)) return false;
  if (sameFile(file, CLAUDE_SIM_BIN) || sameFile(file, CLAUDE_SIM_CLI)) return true;
  // A bundle built by scripts/build.mjs sits next to the other AOC binaries.
  return basename(file) === BUNDLE_NAME && existsSync(join(dirname(file), 'aocd.mjs'));
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}
