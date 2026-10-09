/**
 * mod-metering (§10, §14): notional API-equivalent cost from a forward-only rate card, daily USD/RM
 * rollups, throttle-loss metering, cost-per-outcome and the migration recommender. It observes; it never gates.
 */
import { addDays, type AocModule, type Job, type ModuleContext } from '@aoc/kernel';
import { closeDays } from './close';
import { METERING_ACTOR, MeteringModel } from './model';
import { createMeteringProjector } from './projector';
import { loadRateCardFile } from './ratecard-file';
import { registerMeteringRoutes } from './routes';
import { createMeteringService } from './service';

export { checkForwardOnly, earliestEffectiveFrom } from './dates';
export { MIGRATION_DEFAULTS, recommendMigration } from './migration';
export { costUsd, effectiveCard, matchRate, normalizeModelId, priceUsage } from './pricing';

export interface MeteringModuleOptions {
  /** Overrides config.metering.rateCardFile (the v1 seed and subscription seed). */
  rateCardFile?: string;
}

export const METERING_CLOSE_JOB = 'metering.close-days';

export function createMeteringModule(opts: MeteringModuleOptions = {}): AocModule {
  let ctxRef: ModuleContext | null = null;
  let model: MeteringModel | null = null;
  const modelFor = (ctx: ModuleContext): MeteringModel => (model ??= new MeteringModel(ctx));
  const projector = createMeteringProjector({
    tz: () => ctxRef?.config.timezone ?? 'Asia/Kuala_Lumpur',
    directory: () => ctxRef?.services.maybe('sessions') ?? null,
  });
  const closeJob: Job = {
    name: METERING_CLOSE_JOB,
    schedule: { dailyAt: '00:15' },
    run: (ctx) => void closeDays(modelFor(ctx)),
  };
  return {
    name: 'metering',
    projectors: [projector],
    jobs: [closeJob],
    init(ctx) {
      ctxRef = ctx;
      closeJob.schedule = { dailyAt: ctx.config.metering.closeDayAfterLocalTime };
      ctx.services.provide('metering', createMeteringService(modelFor(ctx)));
    },
    routes(app, ctx) {
      registerMeteringRoutes(app, modelFor(ctx));
    },
    start(ctx) {
      seedFromFile(modelFor(ctx), ctx, opts.rateCardFile ?? ctx.config.metering.rateCardFile);
    },
  };
}

/** First start: publish rate card v1 (effectiveFrom from the file) and the subscription seed, once each. */
function seedFromFile(m: MeteringModel, ctx: ModuleContext, path: string): void {
  const needCard = !m.hasPublishedRateCard();
  const needSubscription = ctx.store.list({ types: ['subscription.updated'], limit: 1 }).length === 0;
  if (!needCard && !needSubscription) return;
  const loaded = loadRateCardFile(path);
  if (!loaded.ok) {
    ctx.log.error('metering: rate card not loaded; usage stays unpriced until a rate card is published', {
      error: loaded.error,
    });
    ctx.notify({
      kind: 'info',
      title: 'Rate card file missing or invalid: metered usage is unpriced',
      audience: ['approver'],
      severity: 'warn',
    });
    return;
  }
  const f = loaded.file;
  // Days closed before any card existed stay frozen: the seed never reaches back into them (R12).
  const lastClosed = m.lastClosedDay();
  const effectiveFrom =
    lastClosed && f.effectiveFrom <= lastClosed ? addDays(lastClosed, 1) : f.effectiveFrom;
  if (needCard)
    m.publishRateCard(
      { effectiveFrom, rates: f.rates, tierFallback: f.tierFallback, note: f.note },
      METERING_ACTOR,
      'system',
    );
  if (needSubscription && f.subscription) {
    m.updateSubscription(
      { ...f.subscription, effectiveFrom },
      METERING_ACTOR,
      'system',
      'metering:subscription:seed',
    );
  }
}
