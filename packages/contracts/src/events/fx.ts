/** FX events (owner: mod-fx, §10 rate card & FX). */
import { z } from 'zod';
import { defineEvent, meta, payload, zId, zNonNeg } from './define';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const FX_EVENTS = [
  defineEvent({
    type: 'fx.rate_recorded',
    owner: 'fx',
    description: 'Daily USD/MYR rate stamped fetched-live or inherited (carry-forward with source date).',
    meta: meta({
      date: day,
      pair: z.literal('USD/MYR'),
      rate: zNonNeg,
      status: z.enum(['live', 'inherited']),
      sourceDate: day,
      extractor: z.enum(['haiku', 'sonnet', 'api', 'manual', 'none']),
      validation: z.enum(['pass', 'fail', 'not_applicable']),
      reason: z.enum(['fetched', 'weekend_or_holiday', 'source_unreadable', 'validation_failed', 'discrepancy_pending', 'manual_override']),
    }),
    payload: payload({ sourceUrl: z.string().optional(), rawExcerpt: z.string().optional(), notes: z.string().optional() }),
  }),
  defineEvent({
    type: 'fx.discrepancy_raised',
    owner: 'fx',
    description: 'Scraped figure disagrees with the BNM published figure after one re-fetch → human-reviewed decision.',
    meta: meta({ date: day, scraped: zNonNeg, official: zNonNeg, decisionId: zId }),
    payload: payload({ detail: z.string().optional() }),
  }),
  defineEvent({
    type: 'fx.discrepancy_resolved',
    owner: 'fx',
    description: 'Discrepancy resolved by a human.',
    meta: meta({ date: day, chosenRate: zNonNeg, decisionId: zId }),
    payload: null,
  }),
  defineEvent({
    type: 'fx.carry_forward_alert',
    owner: 'fx',
    description: 'N consecutive carried-forward days → manual check requested.',
    meta: meta({ consecutiveDays: z.number().int().min(1), since: day }),
    payload: null,
  }),
] as const;
