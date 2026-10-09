import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '../helpers';
import { RETURN_REFRESH_GAP_MS } from '../../src/pages/portal/hooks';
import {
  allowSlowRenders,
  BUILDER,
  get,
  INTERNAL_TERMS,
  manualClock,
  REQUESTER,
  renderPortal,
  routes,
  ticket,
} from './fixtures';

const TICKETS = [
  ticket({
    ticketId: 'tkt_ready',
    title: 'Search finds nothing for policy numbers',
    status: 'ready_for_testing',
    canSignOffUat: true,
    updatedAt: '2026-10-09T05:30:00Z',
    attachments: [{ attachmentId: 'a1', fileName: 'shot.png', mime: 'image/png', bytes: 2048 }],
  }),
  ticket({
    ticketId: 'tkt_work',
    title: 'Export button does nothing',
    status: 'being_worked_on',
    severity: 'low',
  }),
  ticket({
    ticketId: 'tkt_tested',
    title: 'Desktop freezes on switch',
    status: 'ready_for_testing',
    canSignOffUat: false,
    updatedAt: '2026-10-09T05:20:00Z',
  }),
  ticket({
    ticketId: 'tkt_done',
    title: 'Typo in the payment email',
    status: 'completed',
    updatedAt: '2026-10-08T05:00:00Z',
  }),
  ticket({
    ticketId: 'tkt_closed',
    title: 'Duplicate report',
    status: 'closed',
    updatedAt: '2026-10-07T05:00:00Z',
  }),
];

afterEach(() => vi.unstubAllGlobals());

allowSlowRenders();
beforeAll(async () => {
  await import('../../src/pages/portal/PortalHomePage');
});

describe('portal home', () => {
  it('leads with what needs the requester, then groups every request by abstracted status', async () => {
    routes(get('/portal/api/tickets', TICKETS));
    renderPortal('/portal', REQUESTER);
    expect(await screen.findByRole('heading', { level: 1, name: 'My requests' })).toBeInTheDocument();

    const callout = await screen.findByRole('region', { name: 'A fix is ready for your testing' });
    const testLink = within(callout).getByRole('link', {
      name: /Search finds nothing for policy numbers.*Test it now/,
    });
    expect(testLink).toHaveAttribute('href', '/portal/tickets/tkt_ready');

    const groups = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(groups).toEqual([
      'A fix is ready for your testing',
      'Waiting for your testing 1',
      'In progress 2',
      'Done 2',
    ]);

    const inProgress = screen.getByRole('region', { name: /In progress/ });
    const cards = within(inProgress).getAllByRole('listitem');
    // A request the requester already tested reads as being worked on, with a thank-you note.
    expect(cards.map((c) => within(c).getByRole('heading').textContent)).toEqual([
      'Desktop freezes on switch',
      'Export button does nothing',
    ]);
    expect(cards[0]).toHaveTextContent('Being worked on');
    expect(cards[0]).toHaveTextContent('Thanks for testing');
    expect(within(cards[1]!).getByRole('img', { name: 'Step 2 of 4: Being worked on' })).toBeInTheDocument();
    expect(cards[1]).toHaveTextContent('Impact: Minor');

    const ready = screen.getByRole('region', { name: /Waiting for your testing/ });
    expect(ready).toHaveTextContent('Please test the fix and tell us if it works');
    expect(ready).toHaveTextContent('1 file');
    expect(document.body.textContent).not.toMatch(INTERNAL_TERMS);
  });

  it('filters by status from the counts', async () => {
    const user = userEvent.setup();
    routes(get('/portal/api/tickets', TICKETS));
    renderPortal('/portal', REQUESTER);
    const filters = await screen.findByRole('group', { name: 'Show requests by status' });
    const buttons = within(filters).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([
      'All5',
      'Ready for your testing1',
      'Being worked on2',
      'Completed1',
      'Closed1',
    ]);
    await user.click(within(filters).getByRole('button', { name: /Closed/ }));
    expect(within(filters).getByRole('button', { name: /Closed/ })).toHaveAttribute('aria-pressed', 'true');
    const list = screen.getByRole('region', { name: /Closed/ });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByText('Export button does nothing')).toBeNull();
    await user.click(within(filters).getByRole('button', { name: /All/ }));
    expect(screen.getByText('Export button does nothing')).toBeInTheDocument();
  });

  it('refreshes when the requester comes back to the tab, without polling', async () => {
    let calls = 0;
    routes((url) => {
      if (url !== '/portal/api/tickets') return undefined;
      calls += 1;
      return jsonResponse(calls === 1 ? [] : [ticket()]);
    });
    const clock = manualClock();
    renderPortal('/portal', REQUESTER, clock);
    expect(await screen.findByText("You haven't reported anything yet")).toBeInTheDocument();
    // Focus and visibility events fired together (or right after loading) do not refetch twice.
    act(() => {
      fireEvent(window, new Event('focus'));
    });
    expect(calls).toBe(1);
    clock.advance(RETURN_REFRESH_GAP_MS + 1);
    act(() => {
      fireEvent(document, new Event('visibilitychange'));
      fireEvent(window, new Event('focus'));
    });
    expect(await screen.findByText('Claim form goes blank after I attach a PDF')).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it('offers the first request when there are none, and a retry when loading fails', async () => {
    let fail = true;
    routes((url) => {
      if (url !== '/portal/api/tickets') return undefined;
      return fail
        ? jsonResponse({ error: { code: 'internal', message: 'boom' } }, { status: 500 })
        : jsonResponse([]);
    });
    renderPortal('/portal', REQUESTER);
    expect(await screen.findByText("We couldn't load your requests")).toBeInTheDocument();
    expect(screen.getByText('Something went wrong on our side. Try again in a moment.')).toBeInTheDocument();
    fail = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Report a problem' })).toHaveAttribute(
      'href',
      '/portal/new',
    );
  });

  it('tells a Builder where requests reach them instead of calling the requester API', async () => {
    const fetchMock = routes();
    renderPortal('/portal', BUILDER);
    expect(await screen.findByText('This portal is for reporting problems')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open tickets' })).toHaveAttribute('href', '/tickets');
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/portal/api'))).toHaveLength(0),
    );
  });
});
