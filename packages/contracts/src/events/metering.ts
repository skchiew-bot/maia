/**
 * Metering events (owner: mod-metering, §10). Metering observes; it never gates. Every cost here is a
 * NOTIONAL API-EQUIVALENT figure (decision support for the Enterprise-migration case), never a bill.
 */
import { z } from 'zod';
import { defineEvent, meta, payload, zHash, zIso, zLabel, zNonNeg } from './define';
import { FX_SESSIONS } from './fx';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** USD list prices per million tokens for one model id. */
export const RateCardRateSchema = z.object({
  model: z.string().min(1).max(80),
  inputPerMTok: zNonNeg,
  outputPerMTok: zNonNeg,
  cacheReadPerMTok: zNonNeg,
  cacheWrite5mPerMTok: zNonNeg,
  cacheWrite1hPerMTok: zNonNeg,
});
export type RateCardRate = z.infer<typeof RateCardRateSchema>;

/** One frozen breakdown entry of a daily rollup. `key` = owner / project / model / process-type id (null = unknown). */
export const RollupBreakdownRowSchema = z.object({
  key: z.string().max(128).nullable(),
  usd: zNonNeg,
  /** null when the day had no FX rate. */
  rm: zNonNeg.nullable(),
  inputTokens: zNonNeg,
  outputTokens: zNonNeg,
  cacheReadTokens: zNonNeg,
  cacheWrite5mTokens: zNonNeg,
  cacheWrite1hTokens: zNonNeg,
  messages: zNonNeg,
  unpricedTokens: zNonNeg,
  unpricedModels: z.array(z.string()),
  tierPricedModels: z.array(z.string()),
  /** byActor only: throttle idle / hits attributed to the owner on that day. */
  throttleIdleMs: zNonNeg.optional(),
  throttleHits: zNonNeg.optional(),
});
export type RollupBreakdownRow = z.infer<typeof RollupBreakdownRowSchema>;

export const METERING_EVENTS = [
  defineEvent({
    type: 'ratecard.published',
    owner: 'metering',
    description: 'New immutable rate-card version; applies forward only (never restates closed days, R12).',
    meta: meta({
      version: z.number().int().min(1),
      effectiveFrom: day,
      rateCount: z.number().int().min(1),
      /** sha256 of the canonical rates array — lets an auditor pin the exact prices without decrypting the body. */
      ratesHash: zHash,
    }),
    payload: payload({
      rates: z.array(RateCardRateSchema),
      /** Model tier (opus/sonnet/haiku/fable) → rate model id used when a usage model has no exact rate. */
      tierFallback: z.record(z.string(), z.string()).optional(),
      note: z.string().optional(),
    }),
  }),
  defineEvent({
    type: 'subscription.updated',
    owner: 'metering',
    description: 'Subscription (Max plan seats) cost — shown separately from notional API-equivalent cost.',
    meta: meta({
      plan: zLabel,
      seats: z.number().int().min(0),
      monthlyUsdPerSeat: zNonNeg,
      effectiveFrom: day,
    }),
    payload: null,
  }),
  defineEvent({
    type: 'rollup.closed',
    owner: 'metering',
    description:
      'Daily rollup frozen (notional USD + RM) with the rate-card version and FX stamp used. Never restated.',
    meta: meta({
      date: day,
      usdNotional: zNonNeg,
      /** 0 when fxStatus is "missing" (render as unavailable). */
      rmNotional: zNonNeg,
      fxRate: zNonNeg,
      fxStatus: z.enum(['live', 'inherited', 'missing']),
      fxSourceDate: day.nullable(),
      /** BNM session of the FX rate used (null when missing or not stamped; absent on rollups closed before it existed). */
      fxSession: z.enum(FX_SESSIONS).nullable().optional(),
      rateCardVersion: z.number().int().min(0),
      inputTokens: zNonNeg,
      outputTokens: zNonNeg,
      cacheReadTokens: zNonNeg,
      cacheWriteTokens: zNonNeg,
      cacheWrite5mTokens: zNonNeg,
      cacheWrite1hTokens: zNonNeg,
      messages: zNonNeg,
      unpricedTokens: zNonNeg,
      throttleIdleMs: zNonNeg,
      throttleHits: z.number().int().min(0),
      /** Actual subscription spend prorated to the day — kept apart from the notional figure. */
      subscriptionUsd: zNonNeg,
      closedAt: zIso,
    }),
    payload: payload({
      byActor: z.array(RollupBreakdownRowSchema),
      byProject: z.array(RollupBreakdownRowSchema),
      byModel: z.array(RollupBreakdownRowSchema),
      byProcessType: z.array(RollupBreakdownRowSchema),
      unpricedModels: z.array(z.string()),
      tierPricedModels: z.array(z.string()),
    }),
  }),
] as const;
