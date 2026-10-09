import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecisionCardView, InternalTicket, PromotionDTO } from '@aoc/contracts';
import { AuthProvider, type AuthUser } from '../../src/api';
import { ClockProvider, ToastProvider, fixedClock } from '../../src/components';
import TicketPage from '../../src/pages/tickets/TicketPage';
import TicketsPage from '../../src/pages/tickets/TicketsPage';
import { card } from '../decisions/fixtures';
import { jsonResponse, mockFetch } from '../helpers';
import { NOW, history, ticket, ticketList } from './fixtures';

const CEO: AuthUser = { id: 'usr_ceo', name: 'Chiew Sin Kwang', role: 'approver', flags: {} };
const BUILDER: AuthUser = { id: 'usr_aisyah', name: 'Aisyah Rahman', role: 'builder', flags: {} };
const ID = 'tkt_01M4FC3GS5VXC370PY64VM0XE8';

const fixPlanCard = (): DecisionCardView =>
  card({
    id: 'dec_fix',
    kind: 'fix_plan',
    test: null,
    title: 'Agent desktop logs me out right after login — fix plan',
    question: 'Approve this fix plan? Nothing touches code until it clears this gate (§7).',
    options: [
      { id: 'approve', label: 'Approve fix plan' },
      { id: 'reject', label: 'Reject and re-triage' },
    ],
    recommendation: null,
    requesterId: 'system:intake',
    excludedApproverIds: ['system:intake'],
    subjectType: 'ticket',
    subjectId: ID,
    sessionId: null,
    createdAt: new Date(NOW - 35 * 60_000).toISOString(),
  });

interface Posts {
  url: string;
  body: unknown;
}

function installApi(
  opts: {
    tickets?: InternalTicket[];
    one?: InternalTicket | null;
    promotions?: PromotionDTO[];
    decisions?: DecisionCardView[];
  } = {},
): Posts[] {
  const posts: Posts[] = [];
  mockFetch((raw, init) => {
    const url = new URL(raw, 'http://aoc.test');
    if ((init.method ?? 'GET') === 'POST') {
      posts.push({ url: url.pathname, body: JSON.parse(String(init.body)) });
      return jsonResponse({});
    }
    if (url.pathname === '/api/tickets') return jsonResponse(opts.tickets ?? ticketList());
    if (url.pathname === `/api/tickets/${ID}`)
      return opts.one === null
        ? jsonResponse({ error: { code: 'not_found', message: 'Ticket not found' } }, { status: 404 })
        : jsonResponse(opts.one ?? ticket({ ticketId: ID }));
    if (url.pathname === '/api/audit/events') {
      const all = history();
      const type = url.searchParams.get('type');
      return jsonResponse({
        events: type ? all.filter((e) => e.type === type) : all,
        headSeq: 200,
        nextFromSeq: null,
        nextToSeq: null,
      });
    }
    if (url.pathname === '/api/promotions') return jsonResponse({ items: opts.promotions ?? [] });
    if (url.pathname === '/api/decisions')
      return jsonResponse({
        generatedAt: new Date(NOW).toISOString(),
        decisions: opts.decisions ?? [fixPlanCard()],
      });
    if (url.pathname === '/api/users')
      return jsonResponse({
        users: [{ id: 'usr_ceo', name: 'Chiew Sin Kwang', role: 'approver', active: true }],
      });
    if (url.pathname === '/api/sessions' || url.pathname === '/api/projects') return jsonResponse([]);
    if (url.pathname === '/api/passkeys') return jsonResponse({ passkeys: [] });
    return jsonResponse({ error: { code: 'not_found', message: 'nope' } }, { status: 404 });
  });
  return posts;
}

const failedPromotion = (ticketId: string): PromotionDTO => ({
  promotionId: 'prm_01',
  projectId: 'prj_claims',
  fromRef: `uat/${ticketId}`,
  fromSha: 'a'.repeat(40),
  targetBranch: 'main',
  ticketId,
  changeId: null,
  breakglassId: null,
  breakglass: false,
  status: 'failed',
  requestedBy: 'system:intake',
  requestedAt: new Date(NOW - 15 * 60_000).toISOString(),
  decisionId: 'dec_golive',
  refusal: null,
  rejection: null,
  failure: {
    reason: 'credential_profile_missing',
    detail: null,
    at: new Date(NOW - 10 * 60_000).toISOString(),
  },
  completion: null,
});

function renderAt(path: string, user: AuthUser = CEO) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider initialUser={user}>
        <ToastProvider>
          <ClockProvider clock={fixedClock(NOW)}>
            <Routes>
              <Route path="/tickets" element={<TicketsPage />} />
              <Route path="/tickets/:id" element={<TicketPage />} />
            </Routes>
          </ClockProvider>
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

afterEach(() => vi.unstubAllGlobals());

// Render tests drive real React trees with user-event: allow for a loaded CI machine.
describe('Tickets list', { timeout: 15_000 }, () => {
  it('leads with the pipeline funnel and lists every ticket with its gates and budget', async () => {
    installApi();
    renderAt('/tickets');
    const funnel = await screen.findByRole('img', { name: /^Ticket pipeline:/ });
    expect(funnel).toHaveAccessibleName(
      expect.stringContaining('Fix-plan gate 1 tickets (oldest 35m · median 35m)'),
    );
    expect(funnel).toHaveAccessibleName(expect.stringContaining('Closed 1 tickets'));

    const table = screen.getByRole('table', { name: 'Intake tickets' });
    const rows = within(table).getAllByRole('row').slice(1);
    // Open work first, most severe first; the closed ticket last.
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual([
      expect.stringContaining('Duplicate claims created'),
      expect.stringContaining('Agent desktop logs me out'),
      expect.stringContaining('Claim photos upload twice'),
      expect.stringContaining('Export to PDF'),
    ]);
    expect(within(rows[1]!).getByRole('link', { name: /Agent desktop/ })).toHaveAttribute(
      'href',
      `/tickets/${ID}`,
    );
    expect(within(rows[1]!).getByText(/21\.9K \/ 800K/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/sessions: 2 triage$/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/sessions: 2 triage, 1 build/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/compares a seconds timestamp/)).toBeInTheDocument();
    expect(within(rows[0]!).getByTitle('Go-live: not started')).toBeInTheDocument();
    expect(screen.getByText('Go-live did not start after a UAT pass')).toBeInTheDocument();
  });

  it('shows a failed go-live promotion in the gates, as the ticket page does', async () => {
    const atGate = ticket({
      ticketId: 'tkt_01M4FC5A9KQ7XW2N3D8RBZT6HE',
      title: 'Claim totals round down to the nearest ringgit',
      projectId: 'prj_claims',
      stage: 'go_live_gate',
      publicStatus: 'ready_for_testing',
      buildSessionId: 'ses_build_2',
      openDecisionIds: [],
    });
    installApi({ tickets: [atGate], promotions: [failedPromotion(atGate.ticketId)] });
    renderAt('/tickets');
    const table = await screen.findByRole('table', { name: 'Intake tickets' });
    const row = within(table).getAllByRole('row')[1]!;
    expect(await within(row).findByTitle('Go-live: promotion failed')).toBeInTheDocument();
    expect(within(row).getByTitle('UAT: passed')).toBeInTheDocument();
    expect(screen.getByText('Go-live promotion did not complete')).toBeInTheDocument();
    // Nobody is asked for a decision after the promotion failed, so it is not counted as waiting on a gate.
    expect(screen.getByRole('group', { name: 'Waiting on a human gate' })).toHaveTextContent(
      /^Waiting on a human gate0/,
    );
  });

  it('filters by stage from the chips and the KPI links', async () => {
    const user = userEvent.setup();
    installApi();
    renderAt('/tickets');
    await screen.findByRole('table', { name: 'Intake tickets' });
    expect(screen.getByRole('link', { name: 'Waiting on a human gate' })).toHaveAttribute(
      'href',
      '/tickets?stage=gates',
    );
    await user.click(screen.getByRole('button', { name: /^Awaiting human/ }));
    const rows = within(screen.getByRole('table', { name: 'Intake tickets' }))
      .getAllByRole('row')
      .slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Claim photos upload twice');
  });

  it('says where tickets come from when there are none', async () => {
    installApi({ tickets: [] });
    renderAt('/tickets');
    expect(await screen.findByText('No tickets yet')).toBeInTheDocument();
    expect(screen.getByText(/requester files a bug through the intake portal/)).toBeInTheDocument();
  });
});

// Render tests drive real React trees with user-event: allow for a loaded CI machine.
describe('Ticket page', { timeout: 15_000 }, () => {
  it('shows where the time went, the open gate and the diagnosis, and approves the fix plan inline', async () => {
    const user = userEvent.setup();
    const posts = installApi();
    renderAt(`/tickets/${ID}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Agent desktop logs me out right after login' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('img', {
        name: /^Time by stage: Received 0s, Triage 5m, Fix-plan gate 35m so far/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Nothing touches code until the Approver signs off the fix plan.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/compares a seconds timestamp with Date.now\(\) milliseconds/),
    ).toBeInTheDocument();
    expect(screen.getByText('Requester sees “Being worked on”', { exact: false })).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Approve fix plan' }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        url: '/api/decisions/dec_fix/resolve',
        body: { optionId: 'approve', comment: null },
      }),
    );
  });

  it('closes a ticket with a resolution from the dialog', async () => {
    const user = userEvent.setup();
    const posts = installApi();
    renderAt(`/tickets/${ID}`);
    await user.click(await screen.findByRole('button', { name: 'Close ticket…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Close this ticket?' });
    await user.selectOptions(within(dialog).getByLabelText('Resolution'), 'cannot_reproduce');
    await user.click(within(dialog).getByRole('button', { name: 'Close ticket' }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        url: `/api/tickets/${ID}/close`,
        body: { resolution: 'cannot_reproduce' },
      }),
    );
  });

  it('keeps raw media behind the role boundary for Builders', async () => {
    const withMedia = ticket({
      ticketId: ID,
      attachments: [
        {
          attachmentId: 'att_1',
          fileName: 'claim-error.png',
          mime: 'image/png',
          bytes: 113,
          sha256: 'f'.repeat(64),
          scan: 'clean',
        },
      ],
    });
    installApi({ one: withMedia });
    const { unmount } = renderAt(`/tickets/${ID}`, BUILDER);
    expect(await screen.findByText('claim-error.png')).toBeInTheDocument();
    expect(screen.getByText('Withheld')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open (logged)' })).toBeNull();
    unmount();

    renderAt(`/tickets/${ID}`, CEO);
    expect(await screen.findByRole('link', { name: 'Open (logged)' })).toHaveAttribute(
      'href',
      `/api/tickets/${ID}/attachments/att_1`,
    );
  });

  it('lets an operator request go-live again when UAT passed but no promotion started', async () => {
    const user = userEvent.setup();
    const passedUat = ticket({
      ticketId: ID,
      stage: 'uat',
      publicStatus: 'ready_for_testing',
      buildSessionId: 'ses_build',
      uatRef: `uat/${ID}`,
      openDecisionIds: [],
    });
    const posts = installApi({ one: passedUat, decisions: [] });
    const { unmount } = renderAt(`/tickets/${ID}`, BUILDER);
    expect(await screen.findByText('UAT passed, but go-live did not start')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Request go-live again' }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        url: '/api/promotions',
        body: { projectId: 'prj_cxcopilot', fromRef: `uat/${ID}`, ticketId: ID },
      }),
    );
    unmount();

    // The only Approver could never sign a go-live they requested themselves (separation of duties).
    renderAt(`/tickets/${ID}`, CEO);
    const button = await screen.findByRole('button', { name: 'Request go-live again' });
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveAccessibleDescription(/You are the only Approver.*ask a Builder to request it/);
  });

  it('says so when the ticket does not exist', async () => {
    installApi({ one: null });
    renderAt(`/tickets/${ID}`);
    expect(await screen.findByText('No ticket with this id')).toBeInTheDocument();
  });
});
