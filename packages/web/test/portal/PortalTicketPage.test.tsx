import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '../helpers';
import {
  allowSlowRenders,
  APPROVER,
  get,
  INTERNAL_TERMS,
  REQUESTER,
  renderPortal,
  routes,
  ticket,
} from './fixtures';

allowSlowRenders();
beforeAll(async () => {
  await import('../../src/pages/portal/PortalTicketPage');
});
afterEach(() => vi.unstubAllGlobals());

const READY = ticket({
  ticketId: 'tkt_7',
  status: 'ready_for_testing',
  statusLabel: 'Ready for your testing',
  canSignOffUat: true,
  comment: 'Started after Monday.',
  attachments: [
    { attachmentId: 'a1', fileName: 'claim-form.png', mime: 'image/png', bytes: 6144 },
    { attachmentId: 'a2', fileName: 'recording.webm', mime: 'video/webm', bytes: 2.5 * 1024 * 1024 },
  ],
});

/** The answer to a sign-off: by default the ticket as the server holds it before it has reacted to the answer. */
function signoffRoute(record: { body?: unknown }, after: Parameters<typeof ticket>[0] = {}) {
  return (url: string, init: RequestInit) => {
    if (url !== '/portal/api/tickets/tkt_7/uat' || init.method !== 'POST') return undefined;
    record.body = JSON.parse(String(init.body));
    return jsonResponse({ ...READY, canSignOffUat: false, ...after });
  };
}

describe('portal ticket page', () => {
  it('shows the abstracted status, the request as sent, and the files', async () => {
    routes(get('/portal/api/tickets/tkt_7', READY));
    renderPortal('/portal/tickets/tkt_7', REQUESTER);
    expect(await screen.findByRole('heading', { level: 1, name: READY.title })).toBeInTheDocument();
    const status = screen.getByRole('region', { name: 'Status' });
    const steps = within(status).getByRole('list', { name: 'Progress' });
    expect(
      within(steps)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Received (done)',
      'Being worked on (done)',
      'Ready for your testing (current step)',
      'Completed (not yet)',
    ]);
    expect(
      within(steps)
        .getByText(/Ready for your testing/)
        .closest('li'),
    ).toHaveAttribute('aria-current', 'step');
    expect(status).toHaveTextContent('A fix is ready. Please try it on the test environment');
    const told = screen.getByRole('region', { name: 'What you told us' });
    expect(told).toHaveTextContent('Major — I can’t do part of my work.');
    expect(told).toHaveTextContent('Started after Monday.');
    const files = screen.getByRole('region', { name: /Your files/ });
    expect(files).toHaveTextContent('claim-form.png');
    expect(files).toHaveTextContent('Image · 6 KB');
    expect(files).toHaveTextContent('Video · 2.5 MB');
    expect(document.body.textContent).not.toMatch(INTERNAL_TERMS);
  });

  it('accepts the fix in two steps and thanks the requester', async () => {
    const user = userEvent.setup();
    const record: { body?: unknown } = {};
    routes(get('/portal/api/tickets/tkt_7', READY), signoffRoute(record));
    renderPortal('/portal/tickets/tkt_7', REQUESTER);
    const form = await screen.findByRole('form', { name: 'Does the fix work for you?' });
    await user.click(within(form).getByRole('button', { name: 'Send my answer' }));
    expect(await within(form).findByText('Choose whether the fix works for you.')).toBeInTheDocument();
    await user.click(within(form).getByRole('radio', { name: /Yes, it works/ }));
    await user.click(within(form).getByRole('button', { name: 'Send my answer' }));
    expect(await screen.findByText(/Thanks for confirming the fix works/)).toBeInTheDocument();
    expect(record.body).toEqual({ verdict: 'pass' });
    expect(screen.queryByRole('form', { name: 'Does the fix work for you?' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Status' })).toHaveTextContent('Being worked on');
  });

  it('reads the same when the server has already moved the request back to being worked on', async () => {
    const user = userEvent.setup();
    const record: { body?: unknown } = {};
    routes(
      get('/portal/api/tickets/tkt_7', READY),
      signoffRoute(record, { status: 'being_worked_on', statusLabel: 'Being worked on' }),
    );
    renderPortal('/portal/tickets/tkt_7', REQUESTER);
    const form = await screen.findByRole('form', { name: 'Does the fix work for you?' });
    await user.click(within(form).getByRole('radio', { name: /Yes, it works/ }));
    await user.click(within(form).getByRole('button', { name: 'Send my answer' }));
    expect(await screen.findByText(/Thanks for confirming the fix works/)).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Does the fix work for you?' })).toBeNull();
    const status = screen.getByRole('region', { name: 'Status' });
    expect(status).toHaveTextContent('Being worked on');
    expect(within(status).getByRole('list', { name: 'Progress' })).toHaveTextContent('Being worked on (current step)');
  });

  it('still thanks a requester who has passed the test when they come back to the page later', async () => {
    routes(
      get(
        '/portal/api/tickets/tkt_7',
        ticket({ ticketId: 'tkt_7', status: 'being_worked_on', statusLabel: 'Being worked on', fixConfirmed: true }),
      ),
    );
    renderPortal('/portal/tickets/tkt_7', REQUESTER);
    expect(await screen.findByText(/Thanks for testing\. We are finishing up/)).toBeInTheDocument();
    expect(screen.queryByText(/we will ask you to test it here/)).toBeNull();
    expect(screen.queryByRole('form', { name: 'Does the fix work for you?' })).toBeNull();
  });

  it('rejects the fix only with a description of what is still wrong', async () => {
    const user = userEvent.setup();
    const record: { body?: unknown } = {};
    routes(get('/portal/api/tickets/tkt_7', READY), signoffRoute(record));
    renderPortal('/portal/tickets/tkt_7', REQUESTER);
    const form = await screen.findByRole('form', { name: 'Does the fix work for you?' });
    await user.click(within(form).getByRole('radio', { name: /No, there is still a problem/ }));
    const comment = within(form).getByRole('textbox', { name: /What is still wrong/ });
    await user.click(within(form).getByRole('button', { name: 'Send my answer' }));
    expect(
      await within(form).findByText('Tell us what is still wrong, so we know what to look at.'),
    ).toBeInTheDocument();
    expect(comment).toHaveFocus();
    expect(record.body).toBeUndefined();
    await user.type(comment, 'Still blank in Firefox.');
    await user.click(within(form).getByRole('button', { name: 'Send my answer' }));
    expect(await screen.findByText(/We will look at it again/)).toBeInTheDocument();
    expect(record.body).toEqual({ verdict: 'fail', comment: 'Still blank in Firefox.' });
    // Until the server starts the new fix, the page already says what happens next.
    expect(screen.getByRole('region', { name: 'Status' })).toHaveTextContent('We are working on this.');
  });

  it('refreshes when the request moved on before the answer arrived', async () => {
    const user = userEvent.setup();
    let calls = 0;
    routes(
      (url, init) =>
        url === '/portal/api/tickets/tkt_7' && init.method !== 'POST'
          ? jsonResponse(++calls === 1 ? READY : { ...READY, status: 'completed', canSignOffUat: false })
          : undefined,
      (url) =>
        url === '/portal/api/tickets/tkt_7/uat'
          ? jsonResponse(
              { error: { code: 'not_ready', message: 'This ticket is not waiting for your testing' } },
              { status: 409 },
            )
          : undefined,
    );
    renderPortal('/portal/tickets/tkt_7', REQUESTER);
    const form = await screen.findByRole('form', { name: 'Does the fix work for you?' });
    await user.click(within(form).getByRole('radio', { name: /Yes, it works/ }));
    await user.click(within(form).getByRole('button', { name: 'Send my answer' }));
    expect(await screen.findByText('The fix is live. Thank you for reporting it.')).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it('lets only the reporter answer, and says plainly when a request is not theirs', async () => {
    routes(
      get('/portal/api/tickets/tkt_7', READY),
      get(
        '/portal/api/tickets/tkt_other',
        { error: { code: 'not_found', message: 'Ticket not found' } },
        404,
      ),
    );
    const { unmount } = renderPortal('/portal/tickets/tkt_7', APPROVER);
    expect(
      await screen.findByText('Only the person who reported this problem can confirm the fix.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send my answer' })).toBeNull();
    unmount();
    renderPortal('/portal/tickets/tkt_other', REQUESTER);
    expect(await screen.findByText("We couldn't find that request")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to my requests' })).toHaveAttribute('href', '/portal');
  });
});
