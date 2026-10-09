import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import type { AocConfig, LlmService } from '@aoc/contracts';
import {
  AocRuntime,
  createLogger,
  systemClock,
  type AocModule,
  type AppEnv,
  type Clock,
  type Logger,
} from '@aoc/kernel';
import { resolveHelperCommands } from './config';
import { bodyLimit, csrfGuard, requestId, securityHeaders } from './http';
import { resolveLlm } from './llm';
import { createDefaultModules } from './modules';
import { findRepoRoot, moduleDir } from './paths';
import { createStreamHub, type StreamOptions } from './sse';
import { mountStatic, resolveWebDir, webDirCandidates } from './static';

export interface AocServerOptions {
  log?: Logger;
  clock?: Clock;
  /** KEK override (tests). Production: AOC_MASTER_KEY or keys.masterKeyFile / <dataDir>/master.key. */
  masterKey?: Buffer;
  /** Replace the default module composition (tests, embedding). */
  modules?: AocModule[];
  /** `llm` service override; default from @aoc/llm (see resolveLlm). */
  llm?: LlmService;
  /** Built UI directory; null disables static serving; default: auto-detect (dist/web, packages/web/dist). */
  webDir?: string | null;
  /** Directory of the daemon code (helper and UI discovery); default: this module's directory. */
  binDir?: string;
  sse?: StreamOptions;
}

export interface AocServer {
  app: Hono<AppEnv>;
  runtime: AocRuntime;
  config: AocConfig;
  webDir: string | null;
  /** End all open event streams so an HTTP server can finish closing. */
  closeStreams(): void;
  /** closeStreams, then runtime.stop(): drain reactors, stop jobs, stop modules, close the DB. Idempotent. */
  close(): Promise<void>;
}

/**
 * aocd's composition root: one AocRuntime (the sole writer of the event log) with every module, and
 * the Hono app around it — request id, security headers, CSRF guard, body limits, module routes,
 * health, the operator event stream and the static UI.
 */
export async function createAocServer(config: AocConfig, opts: AocServerOptions = {}): Promise<AocServer> {
  const log = opts.log ?? createLogger();
  const clock = opts.clock ?? systemClock;
  const binDir = opts.binDir ?? moduleDir;
  const helpers = resolveHelperCommands(config, { binDir });
  for (const w of helpers.warnings) log.debug('helper command', { warning: w });
  config = helpers.config;
  // The data dir holds the event log, the encrypted body store and possibly the generated KEK.
  if (config.dataDir !== ':memory:') mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

  const llm = opts.llm ?? resolveLlm(config);
  const daemon: AocModule = {
    name: 'aocd',
    init(ctx) {
      if (!ctx.services.has('llm')) ctx.services.provide('llm', llm);
    },
  };
  const runtime = await AocRuntime.create({
    config,
    modules: [...(opts.modules ?? createDefaultModules()), daemon],
    clock,
    log,
    masterKey: opts.masterKey,
  });
  const startedAt = clock.now();

  const app = new Hono<AppEnv>();
  app.use('*', securityHeaders(config));
  app.use('*', requestId());
  app.use('*', csrfGuard(config));
  app.use('*', bodyLimit(config));
  runtime.mount(app);

  app.get('/api/health', (c) => {
    const degraded = runtime.store.projectionHealth().filter((p) => p.status !== 'ok').length;
    const checks = runtime.modules.flatMap((m) => {
      if (!m.health) return [];
      try {
        return [{ name: m.name, ...m.health() }];
      } catch {
        return [{ name: m.name, ok: false, detail: { error: 'health_check_failed' } }];
      }
    });
    // Module details (e.g. which malware scanner runs) are for operators, not anonymous callers or requesters.
    const role = c.get('auth')?.user.role;
    const operator = role === 'approver' || role === 'builder';
    return c.json({
      status: degraded || checks.some((h) => !h.ok) ? 'degraded' : 'ok',
      headSeq: runtime.store.head().seq,
      uptimeMs: Math.max(0, clock.now() - startedAt),
      modules: runtime.modules.map((m) => m.name),
      projections: { degraded },
      ...(checks.length
        ? {
            checks: Object.fromEntries(
              checks.map((h) => [h.name, operator ? { ok: h.ok, ...h.detail } : { ok: h.ok }]),
            ),
          }
        : {}),
    });
  });

  const streams = createStreamHub(runtime, opts.sse);
  app.get('/api/stream', (c) => streams.handle(c));

  const webDir =
    opts.webDir === null
      ? null
      : resolveWebDir(opts.webDir ? [resolve(opts.webDir)] : webDirCandidates(binDir, findRepoRoot(binDir)));
  mountStatic(app, webDir);
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404));

  let closing: Promise<void> | null = null;
  return {
    app,
    runtime,
    config,
    webDir,
    closeStreams: () => streams.closeAll(),
    close() {
      closing ??= (async () => {
        streams.closeAll();
        await runtime.stop();
      })();
      return closing;
    },
  };
}
