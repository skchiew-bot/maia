import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreditTopupRequest, DecisionCardView } from '@aoc/contracts';
import CreditsPage from '../../src/pages/credits/CreditsPage';
import {
  ACCOUNTS,
  APPROVER,
  BUILDER,
  RATE_CARD,
  TOPUPS,
  account,
  decision,
  failure,
  renderPage,
  routeFetch,
  session,
  topup,
  type Call,
} from './fixtures';

const topupDecision = (r: CreditTopupRequest, viewer?: DecisionCardView['viewer']) =>
  decision({
    id: r.decisionId,
    kind: 'credit_topup',
    title: 'Credit top-up',
    subjectType: 'credit_topup',
    subjectId: r.requestId,
    requesterId: r.userId,
    excludedApproverIds: [r.userId],
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'deny', label: 'Deny' },
    ],
    ...(viewer ? { viewer } : {}),
  });

function routes(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/ratecard': RATE_CARD,
    'GET /api/credits/me': ACCOUNTS[1],
    'GET /api/credits/accounts': (c: Call) => ({ period: c.query.get('period') ?? '2026-10', accounts: ACCOUNTS }),
    'GET /api/credits/topup-requests': { requests: TOPUPS },
    'GET /api/decisions': { generatedAt: '2026-10-09T06:00:00.000Z', decisions: [topupDecision(TOPUPS[0]!)] },
    'GET /api/sessions': [session({ sessionId: 'ses_cx1' }), session({ sessionId: 'ses_obs', mode: 'observed' })],
    'GET /api/users': { users: [] },
    ...extra,
  };
}

const posted = (calls: Call[], path: string) => calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Credits page', { timeout: 30_000 }, () => {
  it('meters allocations against usage per person by name, with cap state, aging top-ups and a forecast', async () => {
    const { calls } = routeFetch(routes());
    renderPage(<CreditsPage />, APPROVER);

    const meters = await screen.findByRole('list', { name: 'Allocation and usage per person' });
    const rows = within(meters).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('.crd-who b')?.textContent)).toEqual(['Aisyah Rahman', 'Chiew Sin Kwang', 'Priya Nair', 'Tan Wei Jie']);
    expect(rows[0]).toHaveTextContent('reaches the cap ~Oct 25 at this pace');
    expect(rows[2]).toHaveTextContent('At cap · top-up waiting');
    expect(rows[2]).toHaveTextContent('25% auto-grant used this period');
    expect(rows[2]).toHaveTextContent('past the 1h SLA');
    expect(rows[3]).toHaveTextContent('close to the allocation');
    // Every meter carries its numbers as text for screen readers.
    expect(within(rows[0]!).getByRole('img').getAttribute('aria-label')).toMatch(/^Aisyah Rahman: used US\$135\.00 of US\$300\.00 allocation \(45%\)/);
    // An Approver never sets their own allocation.
    expect(rows[1]).toHaveTextContent('Your allocation is set by another Approver');
    expect(screen.getByRole('note')).toHaveTextContent('Capacity: Priya Nair at cap now; Aisyah Rahman reach the cap before Oct 31 at this pace.');

    const kpis = screen.getByRole('list', { name: 'Credits at a glance' });
    expect(kpis).toHaveTextContent('US$1,400');
    expect(kpis).toHaveTextContent('2 auto-grants · 1 top-up');
    expect(kpis).toHaveTextContent('oldest 3h · SLA 1h · 1 past it');

    const waiting = screen.getByRole('list', { name: 'Waiting top-up requests, oldest first' });
    expect(waiting).toHaveTextContent('Waiting 3h · past the 1h SLA');
    const decided = screen.getByRole('list', { name: 'Decided top-up requests' });
    expect(decided).toHaveTextContent('Granted by Chiew Sin Kwang');
    expect(decided).toHaveTextContent('balance US$269.67 → US$319.67');

    const trail = screen.getByRole('table', { name: 'Grant and top-up audit trail' });
    expect(within(trail).getAllByRole('row')).toHaveLength(4);
    expect(within(trail).getAllByRole('row')[1]).toHaveTextContent('US$269.67 → US$319.67');
    expect(within(trail).getAllByText('Policy (AI-approved)')).toHaveLength(2);

    expect(Object.fromEntries(calls.find((c) => c.path === '/api/decisions')!.query)).toEqual({ kind: 'credit_topup', status: 'open' });
  });

  it("approves a waiting top-up through its decision, but never the Approver's own request", async () => {
    const own = topup({ requestId: 'ctu_ceo', userId: APPROVER.id, userName: APPROVER.name, ageMs: 600_000, createdAt: '2026-10-09T05:50:00.000Z' });
    const { calls, count } = routeFetch(
      routes({
        'GET /api/credits/topup-requests': { requests: [...TOPUPS, own] },
        'GET /api/decisions': {
          generatedAt: '2026-10-09T06:00:00.000Z',
          decisions: [
            topupDecision(TOPUPS[0]!),
            topupDecision(own, { canResolve: false, reason: 'separation_of_duties', canWithdraw: true, canEscalate: false }),
          ],
        },
        'POST /api/decisions/dec_ctu_priya/resolve': { ok: true },
      }),
    );
    const user = userEvent.setup();
    renderPage(<CreditsPage />, APPROVER);

    const waiting = await screen.findByRole('list', { name: 'Waiting top-up requests, oldest first' });
    const [priya, mine] = within(waiting).getAllByRole('listitem');
    expect(priya).toHaveTextContent('Priya Nair');
    expect(mine).toHaveTextContent('You raised this request: another Approver decides (separation of duties).');
    expect(within(mine!).queryByRole('button')).toBeNull();

    await user.click(within(priya!).getByRole('button', { name: 'Approve US$50' }));
    await screen.findByText('Top-up approved');
    expect(posted(calls, '/api/decisions/dec_ctu_priya/resolve')).toEqual([{ optionId: 'approve' }]);
    await waitFor(() => expect(count('GET', '/api/credits/accounts')).toBe(2));
  });

  it('sets another person’s allocation for the current period', async () => {
    const { calls } = routeFetch(routes({ 'POST /api/credits/allocations': (c: Call) => account({ userId: 'usr_aisyah', userName: 'Aisyah Rahman', allocationUsd: (c.body as { amountUsd: number }).amountUsd }) }));
    const user = userEvent.setup();
    renderPage(<CreditsPage />, APPROVER);

    await user.click(await screen.findByRole('button', { name: 'Set allocation for Aisyah Rahman' }));
    const dialog = await screen.findByRole('dialog', { name: 'Allocation for Aisyah Rahman' });
    const amount = within(dialog).getByLabelText(/Allocation \(US\$, notional\)/);
    expect(amount).toHaveValue('300');
    await user.clear(amount);
    await user.type(amount, '320');
    await user.click(within(dialog).getByRole('button', { name: 'Save allocation' }));

    await screen.findByText('Allocation saved for October 2026');
    expect(posted(calls, '/api/credits/allocations')).toEqual([{ userId: 'usr_aisyah', period: '2026-10', amountUsd: 320 }]);
  });

  it('shows a closed period read-only', async () => {
    const { calls } = routeFetch(routes());
    const user = userEvent.setup();
    renderPage(<CreditsPage />, APPROVER);

    await screen.findByRole('list', { name: 'Allocation and usage per person' });
    await user.click(within(screen.getByRole('radiogroup', { name: 'Period' })).getByRole('radio', { name: 'September 2026' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/credits/accounts' && c.query.get('period') === '2026-09')).toBe(true));
    expect(await screen.findByText('Closed period: read-only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Set allocation/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Request a top-up' })).toBeDisabled();
  });

  it('lets a Builder see only their own account and request a top-up for an Approver to decide', async () => {
    const mine = ACCOUNTS[3]!;
    const { calls } = routeFetch(
      routes({
        'GET /api/credits/me': mine,
        'GET /api/credits/topup-requests': { requests: [TOPUPS[1]] },
        'GET /api/decisions': { generatedAt: '2026-10-09T06:00:00.000Z', decisions: [] },
        'POST /api/credits/topup-requests': (c: Call) => topup({ requestId: 'ctu_new', userId: BUILDER.id, ...(c.body as object) }),
      }),
    );
    const user = userEvent.setup();
    renderPage(<CreditsPage />, BUILDER);

    const kpis = await screen.findByRole('list', { name: 'Credits at a glance' });
    await within(kpis).findByText('US$319.67');
    expect(kpis).toHaveTextContent('of US$425.00 · 35% used');
    expect(calls.some((c) => c.path === '/api/credits/accounts')).toBe(false);
    expect(calls.some((c) => c.path === '/api/users')).toBe(false);
    expect(within(screen.getByRole('list', { name: 'Allocation and usage per person' })).getAllByRole('listitem')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Request a top-up' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request a credit top-up' });
    expect(dialog).toHaveTextContent('An Approver decides it — never you.');
    expect(within(dialog).getByLabelText(/Amount \(US\$, notional\)/)).toHaveValue('75');

    await user.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(within(dialog).getByText('Say what the extra credit is for (at least 3 characters).')).toBeInTheDocument();
    expect(posted(calls, '/api/credits/topup-requests')).toEqual([]);

    await user.type(within(dialog).getByLabelText(/What it is for/), 'One more evaluation pass on the CSAT overlay');
    const against = within(dialog).getByLabelText(/Against a session/);
    await waitFor(() => expect(within(against).getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(against, 'ses_cx1');
    await user.click(within(dialog).getByRole('button', { name: 'Send request' }));

    await screen.findByText('Top-up request sent');
    expect(posted(calls, '/api/credits/topup-requests')).toEqual([
      { amountUsd: 75, reason: 'One more evaluation pass on the CSAT overlay', sessionId: 'ses_cx1' },
    ]);
    expect(calls.find((c) => c.path === '/api/sessions' && c.query.get('mode') === 'managed')).toBeDefined();
  });

  it('shows an error state when the accounts cannot load', async () => {
    routeFetch(routes({ 'GET /api/credits/accounts': () => failure(500, 'internal', 'Credits unavailable') }));
    renderPage(<CreditsPage />, APPROVER);
    const title = await screen.findByText("Couldn't load credits");
    expect(title.closest('[role="alert"]')).toHaveTextContent('Credits unavailable');
  });
});
