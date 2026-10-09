import type { AuditEventHeaderDTO, DecisionCardView, DecisionKind, PublicTicketStatus } from '@aoc/contracts';
import type { IconName } from '../../components/Icon';
import { formatInteger, formatPercent, formatTokens } from '../../lib/format';
import { KIND_LABEL, requesterOf, shortId, type PeopleLookup } from '../decisions/model';
import { PUBLIC_STATUS_LABEL, RESOLUTION_LABEL } from './model';

export interface EventLine {
  icon: IconName;
  tone: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';
  text: string;
  /** Linked record, when the event names one. */
  link?: { to: string; label: string };
}

type Meta = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' ? v : null);

const ESCALATION: Record<string, string> = {
  low_confidence: 'a triage agent reported low confidence',
  disagreement: 'the triage agents disagree on the root cause',
  budget_exhausted: 'triage ended without a diagnosis',
};

const MEDIA_BASIS: Record<string, string> = {
  media_permission: 'media permission',
  linked_session: 'their active session on this ticket',
};

/**
 * One timeline line per ticket event, written from the chained metadata only (ids, enums, numbers), so it
 * never depends on free text and still reads after an erasure.
 */
export function describeEvent(
  e: AuditEventHeaderDTO,
  people: PeopleLookup,
  decisions: ReadonlyMap<string, DecisionCardView>,
): EventLine {
  const m = e.meta as Meta;
  const who = (id: unknown) => requesterOf(str(id) || e.actor.id, people).name;
  const decision = decisions.get(str(m.decisionId));
  const kind = (str(m.kind) || decision?.kind) as DecisionKind | '';
  const kindLabel = kind ? KIND_LABEL[kind] : 'Decision';
  const decisionLink = m.decisionId
    ? { to: `/decisions?focus=${encodeURIComponent(str(m.decisionId))}`, label: 'Open decision' }
    : undefined;
  switch (e.type) {
    case 'intake.submitted':
      return {
        icon: 'tickets',
        tone: 'accent',
        text: `Submitted by ${who(m.requesterId)} · severity ${str(m.severity)} · ${formatInteger(num(m.attachmentCount) ?? 0)} attachment(s)`,
      };
    case 'intake.attachment_stored':
      return {
        icon: 'upload',
        tone: 'neutral',
        text: `Attachment stored encrypted: ${str(m.mime)}, ${formatInteger(num(m.bytes) ?? 0)} bytes, scan ${str(m.scan)}`,
      };
    case 'intake.media_accessed':
      return {
        icon: 'eye',
        tone: 'warn',
        text: `Raw media opened by ${who(m.userId)} (basis: ${MEDIA_BASIS[str(m.basis)] ?? str(m.basis)})`,
      };
    case 'ticket.triage_started': {
      const n = Array.isArray(m.sessionIds) ? m.sessionIds.length : 0;
      return {
        icon: 'search',
        tone: 'neutral',
        text: `Read-only triage started: ${n} agent(s), budget ${formatTokens(num(m.budgetTokens) ?? 0)} tokens and ${formatInteger(num(m.budgetMinutes) ?? 0)} min each`,
      };
    }
    case 'ticket.diagnosis_reported':
      return {
        icon: 'learning',
        tone: 'neutral',
        text: `Diagnosis from ${shortId(str(m.sessionId))}: confidence ${formatPercent(num(m.confidence) ?? 0)}${m.rootCauseClass ? ` · class ${str(m.rootCauseClass)}` : ''}`,
        link: m.sessionId ? { to: `/sessions/${encodeURIComponent(str(m.sessionId))}`, label: 'Session' } : undefined,
      };
    case 'ticket.escalated_to_human':
      return {
        icon: 'warn',
        tone: 'warn',
        text: `Escalated to a human: ${ESCALATION[str(m.reason)] ?? str(m.reason)}`,
        link: decisionLink,
      };
    case 'ticket.fix_plan_submitted':
      return { icon: 'decisions', tone: 'accent', text: 'Fix plan submitted to the fix-plan gate', link: decisionLink };
    case 'decision.requested':
      return { icon: 'decisions', tone: 'accent', text: `${kindLabel} requested`, link: decisionLink };
    case 'decision.resolved': {
      const option = decision?.options.find((o) => o.id === str(m.optionId))?.label ?? str(m.optionId);
      const method =
        m.method === 'passkey' ? 'signed (passkey)' : m.method === 'policy' ? 'platform policy' : 'attribution (bearer token)';
      return {
        icon: 'ok',
        tone: 'ok',
        text: `${kindLabel} resolved: ${option} — by ${who(m.resolvedBy)}, ${method}`,
        link: decisionLink,
      };
    }
    case 'decision.withdrawn':
      return { icon: 'close', tone: 'neutral', text: `${kindLabel} withdrawn (${str(m.reason).replace(/_/g, ' ')})`, link: decisionLink };
    case 'decision.escalated':
      return { icon: 'arrow-up', tone: 'warn', text: `${kindLabel} escalated to the Approver`, link: decisionLink };
    case 'ticket.build_started':
      return {
        icon: 'working',
        tone: 'neutral',
        text: `Build session ${shortId(str(m.sessionId))} started on the approved plan`,
        link: m.sessionId ? { to: `/sessions/${encodeURIComponent(str(m.sessionId))}`, label: 'Session' } : undefined,
      };
    case 'session.ended':
      return { icon: 'ended', tone: 'neutral', text: `Session ${shortId(e.scope.sessionId ?? '')} ended (${str(m.outcome)})` };
    case 'ticket.uat_ready':
      return {
        icon: 'ok',
        tone: 'accent',
        text: `Ready for UAT on ${str(m.uatRef)} at ${str(m.uatSha).slice(0, 8)}: the requester is asked to test`,
      };
    case 'ticket.uat_result':
      return m.verdict === 'pass'
        ? { icon: 'ok', tone: 'ok', text: `UAT passed: ${who(m.requesterId)} signed off the fix` }
        : { icon: 'danger', tone: 'danger', text: `UAT failed: ${who(m.requesterId)} still sees the problem; back to building` };
    case 'ticket.golive_requested':
      return { icon: 'key', tone: 'accent', text: 'Go-live requested: promotion to main waits for a passkey-signed approval', link: decisionLink };
    case 'promotion.requested':
      return { icon: 'changes', tone: 'neutral', text: `Promotion ${shortId(str(m.promotionId))} requested to ${str(m.targetBranch) || 'main'}` };
    case 'promotion.completed':
      return { icon: 'ok', tone: 'ok', text: `Promotion ${shortId(str(m.promotionId))} completed` };
    case 'promotion.refused':
      return { icon: 'danger', tone: 'danger', text: `Promotion refused: ${str(m.reason).replace(/_/g, ' ')}` };
    case 'ticket.public_status_changed':
      return {
        icon: 'user',
        tone: 'neutral',
        text: `Requester now sees “${PUBLIC_STATUS_LABEL[str(m.publicStatus) as PublicTicketStatus] ?? str(m.publicStatus)}”`,
      };
    case 'ticket.closed':
      return {
        icon: m.resolution === 'fixed' ? 'ok' : 'close',
        tone: m.resolution === 'fixed' ? 'ok' : 'neutral',
        text: `Closed: ${RESOLUTION_LABEL[str(m.resolution)] ?? str(m.resolution)}${e.actor.kind === 'human' ? ` by ${who(e.actor.id)}` : ''}`,
      };
    default:
      return { icon: 'dot', tone: 'neutral', text: e.type };
  }
}
