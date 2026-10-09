import type { MeteringService } from '@aoc/contracts';
import type { MeteringModel } from './model';
import { priceUsage } from './pricing';

/** MeteringService (contracts): notional API-equivalent figures for other modules. Observes only — never gates. */
export function createMeteringService(m: MeteringModel): MeteringService {
  return {
    notionalCostUsd: (model, usage, date) => priceUsage(model, usage, m.cardOn(date)).costUsd,
    fxRate: (date) => {
      const fx = m.liveFx(date);
      return fx.rate === null || fx.status === 'missing'
        ? null
        : { rate: fx.rate, status: fx.status, sourceDate: fx.sourceDate ?? date };
    },
    sessionCostUsd: (sessionId) => m.sessionCostUsd(sessionId),
    activeRateCardVersion: (date) => m.cardOn(date)?.version ?? 0,
  };
}
