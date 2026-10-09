import type { Permission, Role, StoredEvent } from '@aoc/contracts';

/** Bodies of intake tickets (raw requester text, media metadata): personal data behind the role boundary (§6, §7). */
export function isTicketBody(e: Pick<StoredEvent, 'type' | 'bodyScope' | 'scope'>): boolean {
  if (e.type.startsWith('intake.')) return true;
  if (e.bodyScope?.startsWith('tkt_')) return true;
  return !!e.scope.ticketId && e.bodyScope === e.scope.ticketId;
}

/**
 * Who may read an event body in the audit trail: approvers only, and ticket bodies additionally need
 * ticket.media_view. Builders see the full header trail (transparent console) but never bodies.
 */
export function payloadAccess(
  e: Pick<StoredEvent, 'type' | 'bodyScope' | 'scope'>,
  viewer: { role: Role; can: (perm: Permission) => boolean },
): { visible: boolean; reason: 'not_approver' | 'ticket_media' | null } {
  if (viewer.role !== 'approver') return { visible: false, reason: 'not_approver' };
  if (isTicketBody(e) && !viewer.can('ticket.media_view')) return { visible: false, reason: 'ticket_media' };
  return { visible: true, reason: null };
}
