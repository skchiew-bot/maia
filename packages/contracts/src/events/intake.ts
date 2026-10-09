/** Intake-portal and ticket events (owner: mod-intake, §7). */
import { z } from 'zod';
import { PUBLIC_TICKET_STATUSES, SEVERITIES } from '../domain';
import { defineEvent, meta, payload, zId } from './define';

const sha256 = z.string().length(64);

export const INTAKE_EVENTS = [
  defineEvent({
    type: 'intake.submitted',
    owner: 'intake',
    description: 'Requester filed an intake (description, media, comment, severity). Media bodies are encrypted; chain holds hashes only.',
    meta: meta({ ticketId: zId, requesterId: zId, severity: z.enum(SEVERITIES), attachmentCount: z.number().int().min(0), attachmentHashes: z.array(sha256) }),
    payload: payload({ title: z.string(), description: z.string(), comment: z.string().optional() }),
  }),
  defineEvent({
    type: 'intake.attachment_stored',
    owner: 'intake',
    description: 'Attachment validated (size, magic-byte type), scanned, encrypted and stored.',
    meta: meta({
      ticketId: zId,
      attachmentId: zId,
      sha256,
      mime: z.string().max(100),
      bytes: z.number().int().min(0),
      scan: z.enum(['clean', 'infected', 'unscanned', 'error']),
      scanner: z.string().max(60),
    }),
    payload: payload({ fileName: z.string() }),
  }),
  defineEvent({
    type: 'ticket.triage_started',
    owner: 'intake',
    description: 'Read-only triage session(s) spawned with a diagnosis budget.',
    meta: meta({ ticketId: zId, sessionIds: z.array(zId), budgetTokens: z.number().int().min(0), budgetMinutes: z.number().int().min(0) }),
    payload: null,
  }),
  defineEvent({
    type: 'ticket.diagnosis_reported',
    owner: 'intake',
    description: 'A triage session reported a root cause, confidence and fix plan.',
    meta: meta({ ticketId: zId, sessionId: zId, confidence: z.number().min(0).max(1), rootCauseClass: z.string().max(120).nullable() }),
    payload: payload({ rootCause: z.string(), fixPlan: z.string(), affectedAreas: z.array(z.string()).optional() }),
  }),
  defineEvent({
    type: 'ticket.escalated_to_human',
    owner: 'intake',
    description:
      'Low-confidence diagnosis, triage disagreement (R17), exhausted budget, a finished build with no resolvable UAT ref, or a go-live that could not be requested or completed → human decision.',
    meta: meta({ ticketId: zId, reason: z.enum(['low_confidence', 'disagreement', 'budget_exhausted', 'uat_build_missing', 'golive_blocked']), decisionId: zId }),
    payload: null,
  }),
  defineEvent({
    type: 'ticket.fix_plan_submitted',
    owner: 'intake',
    description: 'Fix plan submitted to the fix-plan gate (nothing touches code before it clears).',
    meta: meta({ ticketId: zId, decisionId: zId, sourceSessionId: zId.nullable() }),
    payload: payload({ fixPlan: z.string() }),
  }),
  defineEvent({
    type: 'ticket.build_started',
    owner: 'intake',
    description: 'Fix-plan gate cleared; managed build session launched.',
    meta: meta({ ticketId: zId, sessionId: zId, changeId: zId.nullable() }),
    payload: null,
  }),
  defineEvent({
    type: 'ticket.uat_ready',
    owner: 'intake',
    description: 'Build pushed to UAT; requester asked to test.',
    meta: meta({ ticketId: zId, uatRef: z.string().max(200), uatSha: z.string().max(64), decisionId: zId }),
    payload: null,
  }),
  defineEvent({
    type: 'ticket.uat_result',
    owner: 'intake',
    description: 'Requester UAT sign-off or rejection (rejections feed error-learning with priority).',
    meta: meta({ ticketId: zId, requesterId: zId, verdict: z.enum(['pass', 'fail']) }),
    payload: payload({ comment: z.string().optional() }),
  }),
  defineEvent({
    type: 'ticket.golive_requested',
    owner: 'intake',
    description: 'Promotion to main requested as a human-required decision under the Approver’s name.',
    meta: meta({ ticketId: zId, decisionId: zId, promotionId: zId.nullable() }),
    payload: null,
  }),
  defineEvent({
    type: 'ticket.closed',
    owner: 'intake',
    description: 'Ticket closed.',
    meta: meta({ ticketId: zId, resolution: z.enum(['fixed', 'wont_fix', 'duplicate', 'cannot_reproduce', 'withdrawn']) }),
    payload: payload({ note: z.string().optional() }),
  }),
  defineEvent({
    type: 'intake.media_accessed',
    owner: 'intake',
    description: 'Raw intake media was accessed (PDPA access log): who, which attachment.',
    meta: meta({ ticketId: zId, attachmentId: zId, userId: zId, basis: z.enum(['media_permission', 'linked_session']) }),
    payload: null,
  }),
  defineEvent({
    type: 'ticket.public_status_changed',
    owner: 'intake',
    description: 'Abstracted status the requester sees.',
    meta: meta({ ticketId: zId, publicStatus: z.enum(PUBLIC_TICKET_STATUSES) }),
    payload: null,
  }),
] as const;
