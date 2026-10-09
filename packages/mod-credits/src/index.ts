import { defaultConfig } from '@aoc/contracts';
import type { AocModule, Reactor } from '@aoc/kernel';
import { CreditRepo, createCreditsProjector } from './projection';
import { registerCreditRoutes } from './routes';
import { CreditsEngine } from './service';

/** Options for the credits module (all behaviour is driven by `config.credits`). */
export interface CreditsModuleOptions {}

/**
 * Credits (§10, R7, R8): per-user period accounts, a hard cap enforced only at task boundaries
 * (`credits.checkBoundary`), the once-per-period policy auto grant, and approver top-ups. The module
 * registers no PreToolUse guard and no usage reactor, so it can never stop a session mid-task.
 */
export function createCreditsModule(_opts: CreditsModuleOptions = {}): AocModule {
  let timezone = defaultConfig().timezone;
  let engine: CreditsEngine | null = null;
  const get = (): CreditsEngine => {
    if (!engine) throw new Error('credits module not initialised');
    return engine;
  };

  const topupResolution: Reactor = {
    name: 'credits.topup_resolution',
    handles: ['decision.resolved', 'decision.withdrawn'],
    react(e) {
      if (e.type === 'decision.resolved') get().onDecisionResolved(e);
      else get().onDecisionWithdrawn(e);
    },
  };

  return {
    name: 'credits',
    projectors: [createCreditsProjector(() => timezone)],
    reactors: [topupResolution],
    init(ctx) {
      timezone = ctx.config.timezone;
      engine = new CreditsEngine(ctx, new CreditRepo(ctx.db));
      ctx.services.provide('credits', engine);
    },
    routes(app) {
      registerCreditRoutes(app, get);
    },
  };
}
