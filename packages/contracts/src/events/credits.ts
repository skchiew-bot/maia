/** Credit events (owner: mod-credits, §10 credits). Credits meter cost; they never pick the model. */
import { z } from 'zod';
import { defineEvent, meta, payload, zId, zLabel, zUsd } from './define';

const period = z.string().regex(/^\d{4}-\d{2}$/);
const uid = z.string().max(64);

export const CREDIT_EVENTS = [
  defineEvent({
    type: 'credit.allocated',
    owner: 'credits',
    description: 'Period allocation set for a user (notional USD).',
    meta: meta({ userId: uid, period, amountUsd: zUsd, allocatedBy: uid }),
    payload: null,
  }),
  defineEvent({
    type: 'credit.cap_reached',
    owner: 'credits',
    description:
      'Balance exhausted at a task boundary (never mid-task, R7). Once per session/task until the funding changes.',
    meta: meta({ userId: uid, sessionId: zId, taskId: zId.nullable(), balanceUsd: zUsd, period }),
    payload: null,
  }),
  defineEvent({
    type: 'credit.auto_granted',
    owner: 'credits',
    description:
      'First cap hit in the period: AI-approved auto grant up to 25% of the original allocation, once per period.',
    meta: meta({
      userId: uid,
      period,
      amountUsd: zUsd,
      balanceBefore: zUsd,
      balanceAfter: zUsd,
      sessionId: zId.nullable(),
      taskId: zId.nullable(),
      /** The original period allocation the grant is a percentage of (grants and top-ups never raise it). */
      allocationUsd: zUsd.optional(),
      /** The credit_topup decision resolved by policy, so auto grants share the decision audit trail. */
      decisionId: zId.nullable().optional(),
    }),
    payload: null,
  }),
  defineEvent({
    type: 'credit.topup_requested',
    owner: 'credits',
    description: 'Button-raised top-up request to a human approver (never the requester).',
    meta: meta({
      requestId: zId,
      userId: uid,
      period,
      amountUsd: zUsd,
      sessionId: zId.nullable(),
      taskId: zId.nullable(),
      decisionId: zId,
    }),
    payload: payload({ reason: z.string() }),
  }),
  defineEvent({
    type: 'credit.topup_granted',
    owner: 'credits',
    description: 'Top-up granted by an approver.',
    meta: meta({
      requestId: zId,
      userId: uid,
      amountUsd: zUsd,
      approverId: uid,
      balanceBefore: zUsd,
      balanceAfter: zUsd,
      decisionId: zId,
      /** Period the top-up lands in: the one current when it was approved. */
      period: period.optional(),
      /** Session / task the request was raised against. */
      sessionId: zId.nullable().optional(),
      taskId: zId.nullable().optional(),
    }),
    payload: null,
  }),
  defineEvent({
    type: 'credit.topup_denied',
    owner: 'credits',
    description: 'Top-up denied.',
    meta: meta({ requestId: zId, userId: uid, approverId: uid, decisionId: zId }),
    payload: null,
  }),
  defineEvent({
    type: 'credit.topup_withdrawn',
    owner: 'credits',
    description:
      'A pending top-up request closed because its decision was withdrawn (e.g. its session ended).',
    meta: meta({ requestId: zId, userId: uid, decisionId: zId, reason: zLabel }),
    payload: null,
  }),
] as const;
