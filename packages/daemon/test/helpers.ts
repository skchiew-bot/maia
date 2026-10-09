import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AocConfigSchema, type AocConfig, type Role } from '@aoc/contracts';
import { DevIdentityService, silentLogger, type AocModule } from '@aoc/kernel';
import { findRepoRoot } from '../src/paths';
import { createAocServer, type AocServer, type AocServerOptions } from '../src/server';

export const repoRoot = findRepoRoot(fileURLToPath(new URL('.', import.meta.url)))!;

const dirs: string[] = [];
export function tempDir(prefix = 'aocd-test-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
export function removeTempDirs(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** A complete config whose every path lives in `dir` (data files come from the checkout). */
export function testConfig(dir: string, overrides: Record<string, unknown> = {}): AocConfig {
  return AocConfigSchema.parse({
    dataDir: join(dir, 'data'),
    port: 0,
    registryFile: join(repoRoot, 'config', 'process-types.json'),
    supervisor: { workspacesDir: join(dir, 'workspaces') },
    metering: { rateCardFile: join(repoRoot, 'config', 'rate-card.json') },
    fx: { extractor: 'fake' },
    audit: { anchorRepoPath: join(dir, 'anchor-repo') },
    selfModification: { externalAuditLog: join(dir, 'selfmod-audit.log') },
    ...overrides,
  });
}

export interface TestServer {
  aoc: AocServer;
  dir: string;
  identity: DevIdentityService;
  user(role: Role): { token: string; headers: Record<string, string> };
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

/**
 * The daemon with a dev identity module instead of the production composition, so HTTP-surface tests
 * do not depend on how the domain modules evolve.
 */
export async function bootTestServer(
  opts: Omit<AocServerOptions, 'modules'> & { modules?: AocModule[]; config?: Record<string, unknown> } = {},
): Promise<TestServer> {
  const dir = tempDir();
  let identity: DevIdentityService | null = null;
  const identityModule: AocModule = {
    name: 'test-identity',
    init(ctx) {
      identity = new DevIdentityService(ctx.store);
      ctx.services.provide('identity', identity);
    },
  };
  const { config, modules, ...rest } = opts;
  const aoc = await createAocServer(testConfig(dir, config), {
    log: silentLogger,
    masterKey: randomBytes(32),
    webDir: null,
    ...rest,
    modules: [identityModule, ...(modules ?? [])],
  });
  const ident = identity as DevIdentityService | null;
  if (!ident) throw new Error('test identity module did not init');
  return {
    aoc,
    dir,
    identity: ident,
    user(role) {
      const { token } = ident.createUser({ role });
      return { token, headers: { authorization: `Bearer ${token}` } };
    },
    request: (path, init) => Promise.resolve(aoc.app.request(path, init)),
    close: () => aoc.close(),
  };
}

export interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
  retry?: string;
  comment?: string;
}

/** Incremental text/event-stream parser over a Response body. */
export class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private readonly frames: SseFrame[] = [];
  private pending: ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> | null = null;

  constructor(res: Response) {
    if (!res.body) throw new Error('response has no body');
    this.reader = res.body.getReader();
  }

  /** Next complete frame (a comment line counts as a frame). */
  async next(timeoutMs = 2000): Promise<SseFrame> {
    const deadline = Date.now() + timeoutMs;
    while (!this.frames.length) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('timed out waiting for an SSE frame');
      this.pending ??= this.reader.read();
      const r = await Promise.race([
        this.pending,
        new Promise<null>((res) => setTimeout(() => res(null), remaining)),
      ]);
      if (r === null) continue;
      this.pending = null;
      if (r.done) throw new Error('stream ended');
      this.buffer += this.decoder.decode(r.value, { stream: true });
      this.parse();
    }
    return this.frames.shift()!;
  }

  /** Frames up to and including the first one matching `pred`. */
  async until(pred: (f: SseFrame) => boolean, timeoutMs = 2000): Promise<SseFrame[]> {
    const out: SseFrame[] = [];
    for (;;) {
      const f = await this.next(timeoutMs);
      out.push(f);
      if (pred(f)) return out;
    }
  }

  async cancel(): Promise<void> {
    await this.reader.cancel();
  }

  private parse(): void {
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const frame: SseFrame = {};
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) frame.comment = line.slice(1).trim();
        else {
          const sep = line.indexOf(':');
          const field = sep === -1 ? line : line.slice(0, sep);
          const value = sep === -1 ? '' : line.slice(sep + 1).replace(/^ /, '');
          if (field === 'id' || field === 'event' || field === 'data' || field === 'retry')
            frame[field] = value;
        }
      }
      this.frames.push(frame);
    }
  }
}
