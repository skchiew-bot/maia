import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecisionCardView } from '@aoc/contracts';
import RegistryPage from '../../src/pages/registry/RegistryPage';
import {
  APPROVER,
  BUILDER,
  ENTRIES,
  PLAYBOOKS,
  RUNS,
  TYPES,
  decision,
  failure,
  playbook,
  renderPage,
  routeFetch,
  streamEvent,
  type Call,
} from './fixtures';

const OPEN_DECISION = decision({ id: 'dec_bf', kind: 'playbook_approval', title: 'Approve the Bug fix playbook' });

function routes(viewer: DecisionCardView['viewer'] = OPEN_DECISION.viewer, extra: Record<string, unknown> = {}) {
  return {
    'GET /api/registry': ENTRIES,
    'GET /api/registry/process-types': TYPES,
    'GET /api/playbooks': PLAYBOOKS,
    'GET /api/decisions': { generatedAt: '2026-10-09T06:00:00.000Z', decisions: [{ ...OPEN_DECISION, viewer }] },
    'GET /api/registry/runs': { runs: RUNS },
    'GET /api/learning/model-dimension': { generatedAt: '2026-10-09T06:00:00.000Z', minRunsPerTier: 3, classes: [] },
    'GET /api/sessions': [],
    'GET /api/users': {
      users: [
        { id: 'usr_ceo', name: 'Chiew Sin Kwang', email: null, role: 'approver', flags: { complianceLead: false }, active: true, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
        { id: 'usr_aisyah', name: 'Aisyah Rahman', email: null, role: 'builder', flags: { complianceLead: false }, active: true, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
      ],
    },
    ...extra,
  };
}

const posted = (calls: Call[], path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Registry page', { timeout: 30_000 }, () => {
  it('leads with the distillation business case in notional USD and RM, from the daemon data', async () => {
    const { calls } = routeFetch(routes());
    renderPage(<RegistryPage />, APPROVER);

    const hero = (await screen.findByText('US$13.14')).closest('section')!;
    expect(within(hero).getByRole('heading', { name: 'Distillation business case · notional' })).toBeInTheDocument();
    expect(within(hero).getByText('RM 55.64')).toBeInTheDocument();
    expect(within(hero).getByText('12 finished runs in 8 weeks')).toBeInTheDocument();
    expect(within(hero).getByText('50% less per run')).toBeInTheDocument();
    // Nothing executed on a playbook yet: the realized figure says so instead of implying savings.
    expect(hero).toHaveTextContent('Saved to date: US$0.00 — no execution run has finished yet.');
    expect(hero).toHaveTextContent('Approved playbooks route the next Feature build runs to Sonnet.');

    const table = within(hero).getByRole('table');
    const names = within(table)
      .getAllByRole('rowheader')
      .map((th) => th.querySelector('.reg-ptab__name')?.textContent);
    expect(names).toEqual(['Feature build', 'Bug fix', 'Discovery build']);
    expect(within(table).getByText('Approved by Chiew Sin Kwang')).toBeInTheDocument();
    expect(within(table).getByText('Stays on Opus by design')).toBeInTheDocument();
    expect(within(hero).getByText('1 process type with no finished run yet')).toBeInTheDocument();
    expect(hero).toHaveTextContent('1 finished run is counted at US$0 because no rate card priced its model');

    // Routing: discovery locked on Opus, read-only triage without credentials.
    const routing = screen.getByRole('table', { name: 'Model routing per process type' });
    expect(within(routing).getByText('Read-only · no credentials')).toBeInTheDocument();
    expect(within(routing).getByText('playbook v1 approved')).toBeInTheDocument();
    expect(screen.getByText(/Discovery always runs on Opus\./)).toBeInTheDocument();

    expect(calls.filter((c) => c.method === 'GET').map((c) => c.path).sort()).toEqual(
      [
        '/api/decisions',
        '/api/learning/model-dimension',
        '/api/playbooks',
        '/api/registry',
        '/api/registry/process-types',
        '/api/registry/runs',
        '/api/sessions',
        '/api/users',
      ].sort(),
    );
    const decisions = calls.find((c) => c.path === '/api/decisions')!;
    expect(Object.fromEntries(decisions.query)).toEqual({ kind: 'playbook_approval', status: 'open' });
  });

  it('lets an Approver approve a proposed playbook through its decision, then refreshes', async () => {
    const { calls, count } = routeFetch(
      routes(undefined, { 'POST /api/decisions/dec_bf/resolve': { ...OPEN_DECISION, status: 'resolved' } }),
    );
    const user = userEvent.setup();
    renderPage(<RegistryPage />, APPROVER);

    const row = (await screen.findByText('Bug fix: 3-step playbook')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Approve' }));

    await screen.findByText('Playbook approved');
    expect(posted(calls, '/api/decisions/dec_bf/resolve').map((c) => c.body)).toEqual([{ optionId: 'approve' }]);
    await waitFor(() => expect(count('GET', '/api/registry')).toBe(2));
    expect(count('GET', '/api/playbooks')).toBe(2);
  });

  it('never offers the decision to a role that cannot resolve it, and never asks for the user list', async () => {
    const { count } = routeFetch(routes({ canResolve: false, reason: 'role', canWithdraw: false, canEscalate: false }));
    renderPage(<RegistryPage />, BUILDER);

    const row = (await screen.findByText('Bug fix: 3-step playbook')).closest('tr')!;
    expect(within(row).getByText('Only an Approver can approve a playbook.')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(count('GET', '/api/users')).toBe(0);
  });

  it('distills a playbook from a completed run and says what approval would change', async () => {
    const proposed = playbook({ playbookId: 'pbk_fb2', processType: 'feature-build', version: 2, status: 'proposed', active: false });
    const { calls } = routeFetch(
      routes(undefined, { 'POST /api/playbooks/distill': { playbook: proposed, decisionId: 'dec_pbk_fb2', method: 'llm' } }),
    );
    const user = userEvent.setup();
    renderPage(<RegistryPage />, APPROVER);

    await user.click(await screen.findByRole('button', { name: 'Distill a playbook from run ses_old' }));
    const dialog = await screen.findByRole('dialog', { name: 'Distill a playbook from a run' });
    expect(within(dialog).getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['ses_docs1', 'ses_old']);
    expect(within(dialog).getByRole('radio', { checked: true })).toHaveAttribute('value', 'ses_old');
    expect(dialog).toHaveTextContent('Approval supersedes playbook v1; Feature build keeps running on Sonnet.');

    await user.click(within(dialog).getByRole('button', { name: 'Propose playbook' }));
    await screen.findByText('Playbook v2 proposed for Feature build');
    expect(posted(calls, '/api/playbooks/distill').map((c) => c.body)).toEqual([{ sessionId: 'ses_old' }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('retires an approved playbook with a reason, and keeps a refusal inside the dialog', async () => {
    let attempts = 0;
    const { calls } = routeFetch(
      routes(undefined, {
        'POST /api/playbooks/pbk_fb/retire': () =>
          ++attempts === 1 ? failure(409, 'conflict', 'The playbook changed; reload and try again.') : { ...PLAYBOOKS[0], status: 'retired' },
      }),
    );
    const user = userEvent.setup();
    renderPage(<RegistryPage />, APPROVER);

    const row = (await screen.findByText('Feature build playbook v1')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Retire' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Retire “Feature build playbook v1”?' });
    expect(dialog).toHaveTextContent('New Feature build runs will launch on Opus (discovery)');
    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'quality');

    await user.click(within(dialog).getByRole('button', { name: 'Retire playbook' }));
    expect(await within(dialog).findByText(/The playbook changed; reload and try again\./)).toHaveTextContent('(HTTP 409 · conflict)');

    await user.click(within(dialog).getByRole('button', { name: 'Retire playbook' }));
    await screen.findByText('Playbook retired');
    expect(posted(calls, '/api/playbooks/pbk_fb/retire').map((c) => c.body)).toEqual([{ reason: 'quality' }, { reason: 'quality' }]);
  });

  it('refreshes from the event stream only for events that change registry data (no polling)', async () => {
    const { count } = routeFetch(routes());
    renderPage(<RegistryPage />, APPROVER);
    await screen.findByText('US$13.14');
    expect(count('GET', '/api/registry')).toBe(1);

    act(() => streamEvent('session.liveness_changed', 40));
    await new Promise((r) => setTimeout(r, 200));
    expect(count('GET', '/api/registry')).toBe(1);

    act(() => streamEvent('playbook.approved', 41));
    await waitFor(() => expect(count('GET', '/api/registry')).toBe(2));
    expect(count('GET', '/api/playbooks')).toBe(2);
    expect(count('GET', '/api/registry/process-types')).toBe(2);
  });

  it('shows an error state with a retry when the economics cannot load', async () => {
    routeFetch(routes(undefined, { 'GET /api/registry': () => failure(500, 'internal', 'Registry unavailable') }));
    renderPage(<RegistryPage />, APPROVER);
    const alert = await screen.findByText("Couldn't load registry economics");
    expect(alert.closest('[role="alert"]')).toHaveTextContent('Registry unavailable');
    expect(within(alert.closest('[role="alert"]') as HTMLElement).getByRole('button', { name: /retry|try again/i })).toBeInTheDocument();
  });
});
