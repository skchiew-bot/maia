import { FILE_CHANGING_TOOLS, type PreToolGuard } from '@aoc/contracts';
import type { AocModule } from '@aoc/kernel';
import { registerApiRoutes } from './api';
import { livenessServiceOf, SessionsEngine } from './engine';
import { isReadOnlyBash, registerIngestRoutes } from './ingest';
import { createSessionsProjector } from './projector';

export { SessionsEngine } from './engine';
export { SessionReadModels, APM_WINDOW_MINUTES } from './api';
export { isReadOnlyBash, summarize, HookDispatcher } from './ingest';

export interface SessionsModuleOptions {
  /** Liveness sweep interval (ms); 0 disables the timer (tests call engine.refreshAll()). */
  sweepIntervalMs?: number;
}

/** Defence-in-depth guard for read-only (triage) sessions (§7: triage agents run read-only). */
export const readOnlyGuard: PreToolGuard = {
  name: 'read-only',
  order: 20,
  evaluate(ctx) {
    if (!ctx.session.readOnly) return null;
    if ((FILE_CHANGING_TOOLS as readonly string[]).includes(ctx.toolName)) {
      return { decision: 'deny', guard: 'read-only', reason: 'This is a read-only session: file changes are not allowed (AOC-SPEC-003 §7).', blockReason: 'read_only' };
    }
    if (ctx.toolName === 'Bash') {
      const cmd = String(ctx.toolInput.command ?? '');
      if (!isReadOnlyBash(cmd)) {
        return { decision: 'deny', guard: 'read-only', reason: `Read-only session: only inspection commands are allowed (blocked: ${cmd.slice(0, 120)}).`, blockReason: 'read_only' };
      }
    }
    return null;
  },
};

export function createSessionsModule(opts: SessionsModuleOptions = {}): AocModule {
  let engine: SessionsEngine | null = null;
  let timer: NodeJS.Timeout | null = null;
  let timezone = 'Asia/Kuala_Lumpur';
  return {
    name: 'sessions',
    projectors: [createSessionsProjector(() => timezone)],
    guards: [readOnlyGuard],
    init(ctx) {
      timezone = ctx.config.timezone;
      engine = new SessionsEngine(ctx);
      ctx.services.provide('sessions', engine);
      ctx.services.provide('liveness', livenessServiceOf(engine));
    },
    routes(app, ctx) {
      registerIngestRoutes(app, { ctx, engine: engine! });
      registerApiRoutes(app, ctx, engine!);
    },
    start() {
      const every = opts.sweepIntervalMs ?? 5000;
      if (every > 0) {
        timer = setInterval(() => {
          try {
            engine?.refreshAll();
          } catch {
            /* the next sweep retries; errors are surfaced via projection health */
          }
        }, every);
        timer.unref();
      }
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
