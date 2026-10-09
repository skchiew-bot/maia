/** FX events (owner: mod-fx, §10 rate card & FX). */
import { z } from 'zod';
import { defineEvent, meta, payload, zId, zNonNeg } from './define';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const llmExtractor = z.enum(['haiku', 'sonnet']);

/**
 * BNM sessions (MYT) that publish a Kuala Lumpur interbank middle rate. 1130 is deliberately absent: it is the best
 * counter rate of selected commercial banks and has no middle rate.
 */
export const FX_SESSIONS = ['0900', '1200', '1700'] as const;
/** The session a rate belongs to. Absent on records made before sessions were stamped. */
const session = z.enum(FX_SESSIONS).optional();

/** One LLM extraction attempt (Haiku first, Sonnet once on failed self-validation). Problems are machine codes. */
const extractionAttempt = z.object({
  model: llmExtractor,
  ok: z.boolean(),
  usdMyr: z.number().nullable(),
  publishedDate: z.string().nullable(),
  problems: z.array(z.string()),
});

export const FX_DISCREPANCY_OPTIONS = ['accept_official', 'accept_scraped', 'manual'] as const;

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
      reason: z.enum([
        'fetched',
        'weekend_or_holiday',
        'source_unreadable',
        'validation_failed',
        'discrepancy_pending',
        'manual_override',
      ]),
      /** BNM session of the rate (interbank middle rate, RM per 1 USD); a carried-forward rate keeps its source's. */
      session,
    }),
    payload: payload({
      sourceUrl: z.string().optional(),
      /** Verbatim page-text window around the rate the extractor reported. */
      rawExcerpt: z.string().optional(),
      notes: z.string().optional(),
      /** The extractor's own evidence snippet (model output). */
      evidence: z.string().optional(),
      publishedDate: z.string().optional(),
      /** Session text as the extractor read it on the page (the stamped session is `meta.session`). */
      session: z.string().optional(),
      /** BNM Open API figure used for reconciliation, when available. */
      official: z.number().optional(),
      officialDate: z.string().optional(),
      /** Machine problem codes (unreadable source, failed validation checks). */
      problems: z.array(z.string()).optional(),
      attempts: z.array(extractionAttempt).optional(),
    }),
  }),
  defineEvent({
    type: 'fx.discrepancy_raised',
    owner: 'fx',
    description:
      'Scraped figure disagrees with the BNM published figure after one re-fetch → human-reviewed decision.',
    meta: meta({
      date: day,
      scraped: zNonNeg,
      official: zNonNeg,
      decisionId: zId,
      scrapedDate: day.optional(),
      officialDate: day.optional(),
      extractor: llmExtractor.optional(),
      /** Session both figures are for. */
      session,
    }),
    payload: payload({
      detail: z.string().optional(),
      evidence: z.string().optional(),
      attempts: z.array(extractionAttempt).optional(),
    }),
  }),
  defineEvent({
    type: 'fx.discrepancy_resolved',
    owner: 'fx',
    description: 'Discrepancy resolved by a human.',
    meta: meta({
      date: day,
      chosenRate: zNonNeg,
      decisionId: zId,
      choice: z.enum(FX_DISCREPANCY_OPTIONS).optional(),
      /** false when the day was already closed by metering: the decision is audited but the day is never restated. */
      applied: z.boolean().optional(),
    }),
    payload: null,
  }),
  defineEvent({
    type: 'fx.carry_forward_alert',
    owner: 'fx',
    description:
      'N consecutive weekdays without a live rate (holidays count, weekends do not) → manual check requested.',
    /** consecutiveDays counts weekdays; since is the first of them. */
    meta: meta({ consecutiveDays: z.number().int().min(1), since: day, date: day.optional() }),
    payload: null,
  }),
] as const;
