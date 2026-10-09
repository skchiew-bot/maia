import type { AocModule } from '@aoc/kernel';
import { DecisionAlerts, type AlertOptions } from './alerts';
import { DecisionEngine } from './engine';
import { createDecisionsProjector } from './projection';
import { mountDecisionRoutes } from './routes';

export { DecisionEngine, DecisionError, type EscalateInput, type RaiseOptions } from './engine';
export { ERASED, type DecisionRecord } from './projection';
export { endTurnInstruction } from './routes';

export type DecisionsModuleOptions = AlertOptions;

/**
 * Unified human-required decisions (§2.3, §6, §8, §10, §11, R15): cards, routing, separation of duties,
 * passkey gates, the MCP request_decision ingest, in-page notifications, the opt-in webhook and aging reminders.
 */
export function createDecisionsModule(opts: DecisionsModuleOptions = {}): AocModule {
  let engine: DecisionEngine | null = null;
  let alerts: DecisionAlerts | null = null;
  const ready = () => {
    if (!engine || !alerts) throw new Error('decisions module used before init');
    return { engine, alerts };
  };
  return {
    name: 'decisions',
    projectors: [createDecisionsProjector()],
    reactors: [
      {
        name: 'decisions.notify',
        handles: ['decision.requested', 'decision.escalated'],
        async react(e) {
          // Let the operation that raised the event finish first: a card it closes in the same tick
          // (e.g. a policy auto-grant right after the request) needs nobody's attention.
          await new Promise<void>((resolve) => setImmediate(resolve));
          const decisionId = String(e.meta.decisionId);
          if (e.type === 'decision.requested') ready().alerts.onRequested(decisionId);
          else ready().alerts.onEscalated(decisionId, e.seq);
        },
      },
    ],
    jobs: [
      {
        name: 'decisions.aging',
        schedule: { everyMs: 60_000 },
        run: () => void ready().alerts.remindAging(),
      },
    ],
    init(ctx) {
      engine = new DecisionEngine(ctx);
      alerts = new DecisionAlerts(ctx, engine, opts);
      ctx.services.provide('decisions', engine);
    },
    routes(app, ctx) {
      mountDecisionRoutes(app, ctx, ready().engine);
    },
  };
}
