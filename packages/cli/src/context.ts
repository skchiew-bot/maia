import { isAbsolute, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { clientConfigPath, loadClientConfig, resolveTarget, type ClientConfig, type Target } from './config';
import type { CliDeps } from './deps';
import { CliError, EXIT, UsageError } from './errors';
import { Api, isRecord } from './http';

export type GlobalOpts = {
  daemon?: string;
  token?: string;
};

/** Per-invocation state handed to every command: deps, resolved daemon target, output helpers. */
export class CommandContext {
  /** Set by commands that finish normally but must report a non-zero status (e.g. a broken chain). */
  exitCode: number = EXIT.OK;
  private resolved: Target | null = null;

  constructor(readonly deps: CliDeps) {}

  get configPath(): string {
    return clientConfigPath(this.deps.homeDir);
  }

  config(): ClientConfig | null {
    return loadClientConfig(this.configPath);
  }

  /** Daemon URL + token for this invocation (one command runs per context, so resolve once). */
  target(cmd: Command): Target {
    if (!this.resolved) {
      const g = cmd.optsWithGlobals<GlobalOpts>();
      this.resolved = resolveTarget({
        flagDaemon: g.daemon,
        flagToken: g.token,
        env: this.deps.env,
        file: this.config(),
      });
    }
    return this.resolved;
  }

  api(cmd: Command, timeoutMs?: number): Api {
    return new Api(this.target(cmd), this.deps.fetch, timeoutMs);
  }

  consoleUrl(cmd: Command, path: string): string {
    return this.target(cmd).daemonUrl + path;
  }

  print(text = ''): void {
    this.deps.stdout(text + '\n');
  }

  warn(text: string): void {
    this.deps.stderr(text + '\n');
  }

  json(data: unknown): void {
    this.print(JSON.stringify(data, null, 2));
  }

  /** Expand a leading ~ and resolve against the invocation's working directory. */
  resolvePath(p: string): string {
    const expanded =
      p === '~' ? this.deps.homeDir : p.startsWith('~/') ? join(this.deps.homeDir, p.slice(2)) : p;
    return isAbsolute(expanded) ? expanded : resolve(this.deps.cwd, expanded);
  }

  /** Free-text argument: words joined with spaces, or stdin when the only word is "-". */
  async text(parts: string[], what: string): Promise<string> {
    const raw = parts.length === 1 && parts[0] === '-' ? await this.deps.readStdin() : parts.join(' ');
    const text = raw.trim();
    if (!text) throw new UsageError(`${what} is empty`);
    return text;
  }

  /** A secret given as a flag value, or read from stdin when the value is "-". */
  async secret(value: string, what: string): Promise<string> {
    const v = value === '-' ? ((await this.deps.readStdin()).split(/\r?\n/)[0] ?? '') : value;
    if (!v.trim()) throw new UsageError(`${what} is empty`);
    return v.trim();
  }
}

/** Accept a bare array or an array wrapped in one of `keys` — and fail loudly on anything else. */
export function listOf<T>(data: unknown, what: string, ...keys: string[]): T[] {
  if (Array.isArray(data)) return data as T[];
  if (isRecord(data)) for (const k of keys) if (Array.isArray(data[k])) return data[k] as T[];
  throw new CliError(`unexpected ${what} response from the daemon (expected a list)`);
}

/** Accept an object or an object wrapped in `key`. */
export function objectOf<T>(data: unknown, what: string, key: string): T {
  if (isRecord(data) && isRecord(data[key])) return data[key] as T;
  if (isRecord(data)) return data as T;
  throw new CliError(`unexpected ${what} response from the daemon (expected an object)`);
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
