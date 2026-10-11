/**
 * Operator actions on the runtime itself (owner: aocd, threat model O-26): re-driving a dead-lettered reaction,
 * rebuilding projections and running a job by hand. Each records who ran it (the actor) and why (the payload).
 */
import { z } from 'zod';
import { defineEvent, meta, payload, zLabel } from './define';

export const ADMIN_OUTCOMES = ['ok', 'failed'] as const;
export type AdminOutcome = (typeof ADMIN_OUTCOMES)[number];

const outcome = z.enum(ADMIN_OUTCOMES);
/** The operator's reason, and the error when the action failed: free text, so encrypted. */
const why = payload({ reason: z.string(), error: z.string().optional() });

export const ADMIN_EVENTS = [
  defineEvent({
    type: 'admin.reactor_redriven',
    owner: 'aocd',
    description: 'An operator re-ran one reactor on one event whose reaction had been dead-lettered.',
    meta: meta({ reactor: zLabel, seq: z.number().int().min(1), outcome }),
    payload: why,
  }),
  defineEvent({
    type: 'admin.projections_rebuilt',
    owner: 'aocd',
    description: 'An operator rebuilt named projections from the log.',
    meta: meta({
      projectors: z.array(zLabel).min(1).max(100),
      outcome,
      /** Projectors left degraded by an event they could not apply (the rebuild itself succeeded). */
      degraded: z.array(zLabel).max(100),
    }),
    payload: why,
  }),
  defineEvent({
    type: 'admin.job_run',
    owner: 'aocd',
    description: 'An operator ran a scheduled job by name, outside its schedule.',
    meta: meta({ job: zLabel, outcome }),
    payload: why,
  }),
] as const;
