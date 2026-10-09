import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api';
import { portalDestination } from '../../src/pages/portal/hooks';
import {
  countByStatus,
  groupTickets,
  portalErrorMessage,
  STATUS_META,
  viewOf,
} from '../../src/pages/portal/model';
import { APPROVER, BUILDER, INTERNAL_TERMS, REQUESTER, ticket } from './fixtures';

describe('requester view of a ticket', () => {
  it('asks for testing only while the requester can answer', () => {
    expect(viewOf({ status: 'ready_for_testing', canSignOffUat: true })).toEqual({
      status: 'ready_for_testing',
      tested: false,
      needsYou: true,
    });
    // Answered (the server keeps "ready for testing" until the fix is live): no test left to do.
    expect(viewOf({ status: 'ready_for_testing', canSignOffUat: false })).toEqual({
      status: 'being_worked_on',
      tested: true,
      needsYou: false,
    });
    expect(viewOf({ status: 'completed', canSignOffUat: false })).toMatchObject({
      status: 'completed',
      needsYou: false,
    });
  });

  it('groups waiting-on-you first, then in progress, then done, newest first', () => {
    const tickets = [
      ticket({ ticketId: 'a', status: 'completed', updatedAt: '2026-10-08T00:00:00Z' }),
      ticket({ ticketId: 'b', status: 'received', updatedAt: '2026-10-09T01:00:00Z' }),
      ticket({ ticketId: 'c', status: 'ready_for_testing', canSignOffUat: true }),
      ticket({ ticketId: 'd', status: 'being_worked_on', updatedAt: '2026-10-09T03:00:00Z' }),
      ticket({ ticketId: 'e', status: 'closed' }),
      ticket({ ticketId: 'f', status: 'ready_for_testing', canSignOffUat: false }),
    ];
    expect(groupTickets(tickets).map((g) => [g.group, g.tickets.map((t) => t.ticketId)])).toEqual([
      ['needs_you', ['c']],
      ['active', ['f', 'd', 'b']],
      ['done', ['e', 'a']],
    ]);
    expect(countByStatus(tickets)).toEqual({
      received: 1,
      being_worked_on: 2,
      ready_for_testing: 1,
      completed: 1,
      closed: 1,
    });
  });

  it('speaks plainly: no internal terms in any status or error text', () => {
    for (const meta of Object.values(STATUS_META)) {
      expect(meta.word).not.toMatch(INTERNAL_TERMS);
      expect(meta.explain).not.toMatch(INTERNAL_TERMS);
    }
    for (const status of [0, 401, 403, 404, 429, 500, 503]) {
      const text = portalErrorMessage(new ApiError(status, 'x', 'Missing permission intake.view_own'));
      expect(text).not.toMatch(INTERNAL_TERMS);
      expect(text).not.toMatch(/\d{3}|permission|intake/);
    }
  });
});

describe('portal sign-in destination', () => {
  it('keeps requesters inside the portal whatever next says', () => {
    expect(portalDestination(REQUESTER, null)).toBe('/portal');
    expect(portalDestination(REQUESTER, '/portal/tickets/tkt_1')).toBe('/portal/tickets/tkt_1');
    expect(portalDestination(REQUESTER, '/console')).toBe('/portal');
    expect(portalDestination(REQUESTER, '//evil.example')).toBe('/portal');
  });

  it('sends Builders to their console and lets Approvers go where they asked', () => {
    expect(portalDestination(BUILDER, null)).toBe('/console');
    expect(portalDestination(BUILDER, '/portal/new')).toBe('/console');
    expect(portalDestination(BUILDER, '/tickets/tkt_1')).toBe('/tickets/tkt_1');
    expect(portalDestination(APPROVER, null)).toBe('/portal');
    expect(portalDestination(APPROVER, '/decisions')).toBe('/decisions');
  });
});
