import type { PublicTicket, Severity } from '@aoc/contracts';
import { ApiError } from '../../api/client';
import type { IconName } from '../../components/Icon';

/**
 * Requester-facing view of a ticket (§7): abstracted status only. Nothing here may name an internal gate, the
 * approver, a queue position or an expected date.
 */
export type PortalStatus = PublicTicket['status'];

export interface StatusMeta {
  word: string;
  icon: IconName;
  /** Mark colour and its soft tint (same pairs as the shared RequestStatusBadge). */
  color: string;
  bg: string;
  /** What the status means for the requester, in one sentence. */
  explain: string;
}

export const STATUS_META: Record<PortalStatus, StatusMeta> = {
  received: {
    word: 'Received',
    icon: 'inbox',
    color: 'var(--text-3)',
    bg: 'var(--surface-2)',
    explain: 'We have your request and will start looking into it.',
  },
  being_worked_on: {
    word: 'Being worked on',
    icon: 'working',
    color: 'var(--info)',
    bg: 'var(--info-soft)',
    explain: 'We are working on this. When a fix is ready, we will ask you to test it here.',
  },
  ready_for_testing: {
    word: 'Ready for your testing',
    icon: 'waiting',
    color: 'var(--accent)',
    bg: 'var(--accent-soft)',
    explain: 'A fix is ready. Please try it on the test environment and tell us whether it works.',
  },
  completed: {
    word: 'Completed',
    icon: 'ok',
    color: 'var(--ok)',
    bg: 'var(--ok-soft)',
    explain: 'The fix is live. Thank you for reporting it.',
  },
  closed: {
    word: 'Closed',
    icon: 'ended',
    color: 'var(--text-3)',
    bg: 'var(--surface-2)',
    explain:
      'This request was closed without a change. If the problem is still happening, send a new request.',
  },
};

/** The path a request normally takes; `closed` leaves it. */
export const STEPS: readonly PortalStatus[] = [
  'received',
  'being_worked_on',
  'ready_for_testing',
  'completed',
];

export interface TicketView {
  /** Status to show. */
  status: PortalStatus;
  /** The requester has already answered the test request; we are finishing up. */
  tested: boolean;
  /** Waiting on the requester (test the fix). */
  needsYou: boolean;
}

export const TESTED_NOTE =
  'Thanks for testing. We are finishing up and will mark this request completed here.';

/**
 * The server moves a request back to "being worked on" as soon as the requester's pass is recorded and says so with
 * `fixConfirmed` (until a new build needs testing). Until it has moved it, and for requests whose pass was recorded
 * before it did, "ready for testing" with no test left to answer reads as being worked on. Either way the requester
 * is thanked rather than promised another test.
 */
export function viewOf(t: Pick<PublicTicket, 'status' | 'canSignOffUat' | 'fixConfirmed'>): TicketView {
  if (t.status === 'ready_for_testing' && !t.canSignOffUat)
    return { status: 'being_worked_on', tested: true, needsYou: false };
  if (t.status === 'being_worked_on' && t.fixConfirmed) return { status: 'being_worked_on', tested: true, needsYou: false };
  return { status: t.status, tested: false, needsYou: t.status === 'ready_for_testing' };
}

/** Plain-language severity: how much the problem affects the requester. */
export const SEVERITY_META: Record<Severity, { word: string; hint: string }> = {
  low: { word: 'Minor', hint: 'A small annoyance. I can still work normally.' },
  medium: { word: 'Moderate', hint: 'It slows me down, but I have a workaround.' },
  high: { word: 'Major', hint: 'I can’t do part of my work.' },
  critical: { word: 'Critical', hint: 'I can’t work at all, or customers are affected.' },
};

export const SEVERITY_ORDER: readonly Severity[] = ['low', 'medium', 'high', 'critical'];

export type TicketGroup = 'needs_you' | 'active' | 'done';

export const GROUP_TITLE: Record<TicketGroup, string> = {
  needs_you: 'Waiting for your testing',
  active: 'In progress',
  done: 'Done',
};

export function groupOf(t: PublicTicket): TicketGroup {
  const v = viewOf(t);
  if (v.needsYou) return 'needs_you';
  return v.status === 'completed' || v.status === 'closed' ? 'done' : 'active';
}

/** Requests in display order: waiting on you, then in progress, then done — newest activity first in each. */
export function groupTickets(
  tickets: readonly PublicTicket[],
): { group: TicketGroup; tickets: PublicTicket[] }[] {
  const order: TicketGroup[] = ['needs_you', 'active', 'done'];
  const byUpdate = (a: PublicTicket, b: PublicTicket) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  return order
    .map((group) => ({ group, tickets: tickets.filter((t) => groupOf(t) === group).sort(byUpdate) }))
    .filter((g) => g.tickets.length > 0);
}

/** Requests per displayed status (filter chips). */
export function countByStatus(tickets: readonly PublicTicket[]): Record<PortalStatus, number> {
  const counts: Record<PortalStatus, number> = {
    received: 0,
    being_worked_on: 0,
    ready_for_testing: 0,
    completed: 0,
    closed: 0,
  };
  for (const t of tickets) counts[viewOf(t).status] += 1;
  return counts;
}

/** Error text for requesters: no internal terms, no status codes, always a next step. */
export function portalErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0)
      return 'We couldn’t reach the service. Check your internet connection and try again.';
    if (error.status === 401) return 'You have been signed out. Sign in again to continue.';
    if (error.status === 403) return 'Your account can’t use this part of the portal.';
    if (error.status === 404) return 'We couldn’t find that request. The link may be out of date.';
    if (error.status === 429) return 'Too many attempts in a short time. Wait a minute, then try again.';
    if (error.status >= 500) return 'Something went wrong on our side. Try again in a moment.';
  }
  return 'Something went wrong. Try again.';
}
