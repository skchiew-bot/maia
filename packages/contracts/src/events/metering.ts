/** Metering events (owner: mod-metering, §10). Metering observes; it never gates. */
import { z } from 'zod';
import { defineEvent, meta, payload, zIso, zLabel, zNonNeg } from './define';

const rate = z.object({
  model: z.string(),
  inputPerMTok: zNonNeg,
  outputPerMTok: zNonNeg,
  cacheReadPerMTok: zNonNeg,
  cacheWrite5mPerMTok: zNonNeg,
  cacheWrite1hPerMTok: zNonNeg,
});

export const METERING_EVENTS = [
  defineEvent({
    type: 'ratecard.published',
    owner: 'metering',
    description: 'New rate-card version; applies forward only (never restates closed days, R12).',
    meta: meta({ version: z.number().int().min(1), effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), rateCount: z.number().int().min(1) }),
    payload: payload({ rates: z.array(rate), note: z.string().optional() }),
  }),
  defineEvent({
    type: 'subscription.updated',
    owner: 'metering',
    description: 'Subscription (Max plan seats) cost — shown separately from notional API-equivalent cost.',
    meta: meta({ plan: zLabel, seats: z.number().int().min(0), monthlyUsdPerSeat: zNonNeg, effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    payload: null,
  }),
  defineEvent({
    type: 'rollup.closed',
    owner: 'metering',
    description: 'Daily rollup frozen (USD + RM) with the rate-card version and FX status used. Never restated.',
    meta: meta({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      usdNotional: zNonNeg,
      rmNotional: zNonNeg,
      fxRate: zNonNeg,
      fxStatus: z.enum(['live', 'inherited', 'missing']),
      rateCardVersion: z.number().int().min(0),
      inputTokens: zNonNeg,
      outputTokens: zNonNeg,
      cacheReadTokens: zNonNeg,
      cacheWriteTokens: zNonNeg,
      throttleIdleMs: zNonNeg,
      closedAt: zIso,
    }),
    payload: payload({ byActor: z.array(z.any()), byProject: z.array(z.any()), byModel: z.array(z.any()) }),
  }),
] as const;
