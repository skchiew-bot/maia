import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AffirmRateDTO, ChangeRequestDTO } from '@aoc/contracts';
import ChangePage from '../../src/pages/changes/ChangePage';
import ChangesPage from '../../src/pages/changes/ChangesPage';
import { FakeEventSource } from '../helpers';
import {
  AISYAH,
  CEO,
  COMMON_ROUTES,
  SHA_A,
  SHA_B,
  WEIJIE,
  auditEvent,
  change,
  decisionCard,
  demoChanges,
  field,
  fourFields,
  installApi,
  pins,
  renderPage,
} from '../governance/fixtures';

const AFFIRM_RATE: AffirmRateDTO = {
  rows: [
    {
      userId: AISYAH.id,
      name: AISYAH.name,
      affirmations: 6,
      affirmedWithoutEdit: 1,
      affirmWithoutEditRate: 1 / 6,
      flagged: 1,
      meanEditRatio: 0.8,
    },
  ],
  totals: {
    affirmations: 6,
    affirmedWithoutEdit: 1,
    affirmWithoutEditRate: 1 / 6,
    flagged: 1,
    meanEditRatio: 0.8,
  },
  blindDwellMs: 3000,
};

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => vi.unstubAllGlobals());

const location = () => screen.getByTestId('location').textContent;

// Page tests render the whole page; keep a generous budget for slow CI machines.
describe('Changes list', { timeout: 30_000 }, () => {
  it('leads with the pipeline and the records that need a human, with names on every row', async () => {
    const calls = installApi({
      ...COMMON_ROUTES,
      'GET /api/changes': { items: demoChanges() },
      'GET /api/governance/affirm-rate': AFFIRM_RATE,
    });
    renderPage(<ChangesPage />, { path: '/changes', route: '/changes' });

    expect(await screen.findByRole('heading', { level: 1, name: 'Changes' })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Change requests' });
    // 2 awaiting approval + 1 post-incident record; the CEO raised one and is the only Approver.
    expect(screen.getByText('3 records need a human')).toBeInTheDocument();
    expect(
      screen.getByText(/1 of them raised by the only Approver and waiting for a second/),
    ).toBeInTheDocument();

    const pipeline = screen.getByRole('list', { name: 'Change pipeline' });
    const awaiting = within(pipeline).getByRole('button', { name: /Awaiting approval/ });
    expect(awaiting).toHaveTextContent('2records');
    expect(awaiting).toHaveTextContent('oldest 2h 50m');
    expect(within(pipeline).getByRole('button', { name: /Drafting/ })).toHaveTextContent('Work waits here');

    expect(
      within(table).getByText('Enable RFC 3161 timestamping for production anchors'),
    ).toBeInTheDocument();
    expect(within(table).getByText('needs a second Approver')).toBeInTheDocument();
    expect(within(table).getAllByText('Aisyah Rahman').length).toBeGreaterThan(0);
    expect(within(table).getByText(/post-incident due in 21h/)).toBeInTheDocument();
    // Self-approved off-main work is still a full record in the list.
    expect(within(table).getAllByText('self-approved')).toHaveLength(2);

    // The approver lens: ordered by name, never ranked, with the numbers as text.
    expect(screen.getByRole('heading', { name: 'Edit-or-affirm accountability' })).toBeInTheDocument();
    expect(screen.getByText('Blind one-click confirms').nextSibling).toHaveTextContent(
      '1 under 3s without an edit',
    );
    expect(calls.some((c) => c.path === '/api/governance/affirm-rate')).toBe(true);
  });

  it('filters the list by a pipeline stage and keeps the filter in the URL', async () => {
    installApi({
      ...COMMON_ROUTES,
      'GET /api/changes': { items: demoChanges() },
      'GET /api/governance/affirm-rate': AFFIRM_RATE,
    });
    const user = userEvent.setup({ delay: null });
    renderPage(<ChangesPage />, { path: '/changes', route: '/changes' });
    const table = await screen.findByRole('table', { name: 'Change requests' });
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 8);

    await user.click(screen.getByRole('button', { name: /Awaiting approval/ }));
    expect(screen.getByRole('button', { name: /Awaiting approval/ })).toHaveAttribute('aria-pressed', 'true');
    expect(location()).toBe('/changes?stage=submitted');
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 2);
    expect(screen.getByText('2 of 8 records')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear the stage filter' }));
    expect(location()).toBe('/changes');
  });

  it('hides the approver lens from Builders', async () => {
    const calls = installApi({ ...COMMON_ROUTES, 'GET /api/changes': { items: demoChanges() } });
    renderPage(<ChangesPage />, { path: '/changes', route: '/changes', user: WEIJIE });
    await screen.findByRole('table', { name: 'Change requests' });
    expect(screen.queryByRole('heading', { name: 'Edit-or-affirm accountability' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/governance/affirm-rate')).toBe(false);
  });

  it('creates a draft only with a project, a scope and a title, then opens the record', async () => {
    const calls = installApi({
      ...COMMON_ROUTES,
      'GET /api/changes': { items: [] },
      'GET /api/governance/affirm-rate': AFFIRM_RATE,
      'GET /api/sessions': [],
      'POST /api/changes': (_url: URL, body: unknown) =>
        change({ changeId: 'chg_01NEWCHANGE0000000000000001', title: (body as { title: string }).title }),
    });
    const user = userEvent.setup({ delay: null });
    renderPage(<ChangesPage />, { path: '/changes', route: '/changes', user: WEIJIE });
    expect(await screen.findByText('No change requests yet')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'New change request' }));
    const dialog = await screen.findByRole('dialog', { name: 'New change request' });
    await user.click(within(dialog).getByRole('button', { name: 'Create draft' }));
    expect(within(dialog).getByText('Choose what the change touches.')).toBeInTheDocument();
    expect(within(dialog).getByText('Give the change a title of at least 3 characters.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await user.selectOptions(within(dialog).getByLabelText(/^Project/), 'prj_claims');
    await user.click(within(dialog).getByRole('radio', { name: /Touches main/ }));
    await user.type(within(dialog).getByLabelText(/^Title/), 'Merge the retry-dedupe fix to main');
    await user.click(within(dialog).getByRole('button', { name: 'Create draft' }));

    await waitFor(() => expect(location()).toBe('/changes/chg_01NEWCHANGE0000000000000001'));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      projectId: 'prj_claims',
      scope: 'main',
      title: 'Merge the retry-dedupe fix to main',
      sessionId: null,
    });
  });
});

function recordRoutes(c: ChangeRequestDTO, extra: Record<string, unknown> = {}) {
  return {
    ...COMMON_ROUTES,
    [`GET /api/changes/${c.changeId}`]: c,
    'GET /api/pins': pins(c.projectId),
    'GET /api/audit/events': {
      events: [
        auditEvent(3186, 'change.field_affirmed', {
          scope: { projectId: c.projectId, changeId: c.changeId },
        }),
        auditEvent(3185, 'change.drafted', { scope: { projectId: c.projectId, changeId: c.changeId } }),
        auditEvent(3184, 'change.drafted', { scope: { projectId: c.projectId, changeId: 'chg_other' } }),
      ],
      headSeq: 3368,
      nextFromSeq: null,
      nextToSeq: null,
    },
    'GET /api/sessions': [],
    ...extra,
  };
}

describe('Change record', { timeout: 30_000 }, () => {
  it('shows the four fields with who wrote and who affirmed each, and will not submit a half-done draft', async () => {
    const draft = demoChanges()[0]!;
    installApi(recordRoutes(draft));
    renderPage(<ChangePage />, { path: `/changes/${draft.changeId}`, route: '/changes/:id', user: AISYAH });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Release Claims Intake Bot v1.3 to production' }),
    ).toBeInTheDocument();
    for (const name of ['Impact analysis', 'Mitigation plan', 'Rollback plan', 'Acceptance test'])
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    const impact = screen.getByRole('region', { name: 'Impact analysis' });
    expect(within(impact).getByText('Edited and affirmed')).toBeInTheDocument();
    expect(within(impact).getByText('Written by').nextSibling).toHaveTextContent(
      'Aisyah Rahman (you)no AI draft',
    );

    const submit = screen.getByRole('button', { name: 'Submit for approval' });
    expect(submit).toBeDisabled();
    expect(
      screen.getByText('Affirm rollback plan, acceptance test and name the rollback target to submit.'),
    ).toBeInTheDocument();
    // Only this record's events make its audit trail.
    const trail = await screen.findByRole('table', { name: 'Audit events for this change request' });
    expect(within(trail).getAllByRole('row')).toHaveLength(1 + 2);
  });

  it('affirms a field with its review dwell and names the exact rollback target from the pinned states', async () => {
    const draft = demoChanges()[0]!;
    const calls = installApi(
      recordRoutes(draft, {
        [`POST /api/changes/${draft.changeId}/fields/rollbackPlan`]: (_u: URL, body: unknown) => {
          const b = body as { value: string; rollbackRef: string };
          return {
            ...draft,
            fields: draft.fields.map((f) =>
              f.field === 'rollbackPlan' ? field('rollbackPlan', b.value, {}, AISYAH) : f,
            ),
            affirmedCount: 3,
            rollbackRef: b.rollbackRef,
            rollbackSha: b.rollbackRef,
          };
        },
      }),
    );
    const user = userEvent.setup({ delay: null });
    renderPage(<ChangePage />, { path: `/changes/${draft.changeId}`, route: '/changes/:id', user: AISYAH });
    const card = await screen.findByRole('region', { name: 'Rollback plan' });
    const save = within(card).getByRole('button', { name: /affirm/i });
    expect(save).toBeDisabled();

    await user.type(within(card).getByRole('textbox', { name: /Rollback plan/ }), 'Redeploy v1.2.4.');
    expect(within(card).getByText('Pick the exact tag or commit to return to.')).toBeInTheDocument();
    const picker = within(card).getByRole('combobox', { name: /Return to/ });
    // The broken pin is listed for the record but cannot be chosen.
    expect(
      within(picker).getByRole('option', {
        name: /aoc\/phase\/claims-v1.2 · tag no longer in the repository/,
      }),
    ).toBeDisabled();
    await user.selectOptions(picker, SHA_A);
    await user.click(within(card).getByRole('button', { name: 'Save and affirm' }));

    await waitFor(() => expect(within(card).getByText('Edited and affirmed')).toBeInTheDocument());
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.path).toBe(`/api/changes/${draft.changeId}/fields/rollbackPlan`);
    expect(post.body).toEqual({ value: 'Redeploy v1.2.4.', dwellMs: 0, rollbackRef: SHA_A });
  });

  it('warns the only Approver that submitting their own request would block it', async () => {
    const own = change({
      changeId: 'chg_01CEOOWN00000000000000000001',
      projectId: 'prj_aoc',
      scope: 'production',
      title: 'Enable RFC 3161 timestamping for production anchors',
      createdBy: CEO.id,
      ownerId: CEO.id,
      fields: fourFields(CEO),
      affirmedCount: 4,
      rollbackRef: SHA_B,
    });
    const calls = installApi(
      recordRoutes(own, {
        [`POST /api/changes/${own.changeId}/submit`]: { ...own, status: 'submitted', submittedBy: CEO.id },
      }),
    );
    const user = userEvent.setup({ delay: null });
    renderPage(<ChangePage />, { path: `/changes/${own.changeId}`, route: '/changes/:id', user: CEO });
    expect(await screen.findByText('If you submit it, nobody can approve it')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Submit for approval' });
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() =>
      expect(calls.some((c) => c.path === `/api/changes/${own.changeId}/submit`)).toBe(true),
    );
  });

  it('shows the gate decision, the session doing the work and who did each step', async () => {
    const inProgress = demoChanges()[3]!;
    installApi(recordRoutes(inProgress, { [`GET /api/decisions/${inProgress.decisionId}`]: decisionCard() }));
    renderPage(<ChangePage />, { path: `/changes/${inProgress.changeId}`, route: '/changes/:id', user: CEO });

    const decision = await screen.findByRole('region', { name: 'Decision' });
    expect(await within(decision).findByText(/Approved — merge after green CI/)).toBeInTheDocument();
    expect(within(decision).getByText('Chiew Sin Kwang')).toBeInTheDocument();
    expect(within(decision).getByRole('link', { name: 'Open in Decisions' })).toHaveAttribute(
      'href',
      `/decisions?focus=${inProgress.decisionId}`,
    );
    expect(screen.getByRole('heading', { name: 'Do the work' })).toBeInTheDocument();
    expect(screen.getByText('Work started in a managed session')).toBeInTheDocument();
    expect(screen.getByText(/2h 50m/, { selector: 'strong' })).toBeInTheDocument();
    // Approved records cannot be edited: no affirm buttons.
    expect(screen.queryByRole('button', { name: /affirm/i })).not.toBeInTheDocument();
  });

  it('says plainly when a change id does not exist', async () => {
    installApi({ ...COMMON_ROUTES });
    renderPage(<ChangePage />, { path: '/changes/chg_missing', route: '/changes/:id' });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Change request not found' }),
    ).toBeInTheDocument();
  });
});
