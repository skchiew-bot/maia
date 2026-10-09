import { spawn } from 'node:child_process';
import { childEnv } from '@aoc/kernel';

export interface ExecResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: Buffer | string;
  timeoutMs?: number;
}

const MAX_OUTPUT = 32 * 1024 * 1024;

/**
 * Run a binary with an argument array (never a shell). Async so slow pushes / TSA round-trips never block
 * the sole-writer event loop. Never rejects: spawn errors surface as code 127. Without `opts.env` the child gets the
 * kernel's allowlist (PATH, HOME, locale, proxy and CA settings), never aocd's own environment.
 */
export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 60_000);
    child.stdout.on('data', (d: Buffer) => {
      size += d.length;
      if (size <= MAX_OUTPUT) out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 256) err.push(d);
    });
    child.on('error', (e) => done({ code: 127, stdout: Buffer.alloc(0), stderr: String(e) }));
    child.on('close', (code, signal) =>
      done({
        code: code ?? (signal ? 128 : 1),
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? undefined);
  });
}

/** stderr collapsed to one short line (detail for the encrypted anchor.failed payload). */
export function brief(stderr: string, max = 300): string {
  return stderr.replace(/\s+/g, ' ').trim().slice(0, max);
}
