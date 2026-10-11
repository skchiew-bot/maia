import { FILE_CHANGING_TOOLS, type PreToolGuard } from '@aoc/contracts';
import type { AocModule } from '@aoc/kernel';
import { registerApiRoutes } from './api';
import { livenessServiceOf, SessionsEngine } from './engine';
import { isReadOnlyBash, registerIngestRoutes } from './ingest';
import { createSessionsProjector } from './projector';
import { ObserverLimiter, SessionLimiter, type ObserverLimits, type SessionLimits } from './rate-limit';

export { SessionsEngine } from './engine';
export { SessionReadModels, APM_WINDOW_MINUTES } from './api';
export { isReadOnlyBash, summarize, HookDispatcher, boundUsageTimes, USAGE_MAX_AGE_MS } from './ingest';
export { DEFAULT_OBSERVER_LIMITS, DEFAULT_SESSION_LIMITS, type ObserverLimits, type SessionLimits } from './rate-limit';

export interface SessionsModuleOptions {
  /** Liveness sweep interval (ms); 0 disables the timer (tests call engine.refreshAll()). */
  sweepIntervalMs?: number;
  /** Per-observer-token limits on observed ingest (defaults: DEFAULT_OBSERVER_LIMITS). */
  observerLimits?: Partial<ObserverLimits>;
  /** Per-managed-session limits on ingest, per token kind (defaults: DEFAULT_SESSION_LIMITS). */
  sessionLimits?: Partial<SessionLimits>;
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
      const observerLimiter = new ObserverLimiter(opts.observerLimits ?? {}, () => ctx.clock.now());
      const sessionLimiter = new SessionLimiter(opts.sessionLimits ?? {}, () => ctx.clock.now());
      registerIngestRoutes(app, { ctx, engine: engine!, observerLimiter, sessionLimiter });
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
