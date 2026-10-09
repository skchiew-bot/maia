import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RollbacksPage from '../../src/pages/rollbacks/RollbacksPage';
import { FakeEventSource } from '../helpers';
import {
  AISYAH,
  CEO,
  COMMON_ROUTES,
  HOUR,
  MIN,
  SHA_A,
  ago,
  ahead,
  breakglass,
  demoChanges,
  installApi,
  pins,
  promotion,
  renderPage,
  rollback,
} from '../governance/fixtures';

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => vi.unstubAllGlobals());

const location = () => screen.getByTestId('location').textContent;

function routes(extra: Record<string, unknown> = {}) {
  return {
    ...COMMON_ROUTES,
    'GET /api/rollbacks': {
      items: [
        rollback(),
        rollback({
          rollbackId: 'rbk_01M4FDCEX5NOTCLEAN000000001',
          status: 'not_clean',
          decisionId: null,
          verification: { ...rollback().verification!, clean: false, testsPassed: 40, testsFailed: 2 },
        }),
      ],
    },
    'GET /api/breakglass': {
      items: [
        breakglass(),
        breakglass({
          breakglassId: 'brk_01M4FDC17SR530WMYBDYVHJW16',
          projectId: 'prj_claims',
          invokedBy: AISYAH.id,
          status: 'approved',
          approval: { approverId: CEO.id, passkeyVerified: true, at: ago(3 * HOUR) },
          postIncidentChangeId: 'chg_01M4FDC18EMAEAWC4PNK5594KQ',
          postIncidentStatus: 'draft',
          dueAt: ahead(21 * HOUR),
          promotion: promotion({
            promotionId: 'prm_breakglass',
            projectId: 'prj_claims',
            breakglass: true,
            breakglassId: 'brk_01M4FDC17SR530WMYBDYVHJW16',
            status: 'failed',
            refusal: null,
            failure: { reason: 'execution_error', detail: null, at: ago(3 * HOUR) },
          }),
        }),
      ],
    },
    'GET /api/promotions': {
      items: [
        promotion(),
        promotion({
          promotionId: 'prm_completed',
          projectId: 'prj_cxcopilot',
          status: 'completed',
          refusal: null,
          completion: {
            mainShaBefore: 'a'.repeat(40),
            mainShaAfter: 'b'.repeat(40),
            approverId: CEO.id,
            at: ago(HOUR),
          },
        }),
      ],
    },
    'GET /api/pins': (url: URL) => pins(url.searchParams.get('projectId') ?? 'prj_claims'),
    'GET /api/changes': { items: demoChanges() },
    ...extra,
  };
}

describe('Rollbacks', { timeout: 30_000 }, () => {
  it('shows every rollback’s gate stage and result, break-glass with its countdown, and promotion provenance', async () => {
    installApi(routes());
    renderPage(<RollbacksPage />, { path: '/rollbacks', route: '/rollbacks' });

    expect(await screen.findByRole('heading', { level: 1, name: 'Rollbacks' })).toBeInTheDocument();
    expect(await screen.findByText("1 rollback waits for the Approver's passkey")).toBeInTheDocument();
    expect(
      screen.getByText(
        /1 break-glass request waits for the Approver; the next post-incident record is due in 21h/,
      ),
    ).toBeInTheDocument();

    const tracks = screen.getAllByRole('list', { name: /gate stages/ });
    expect(tracks).toHaveLength(2);
    expect(within(tracks[0]!).getByText('clean: 42 passed, 0 failed')).toBeInTheDocument();
    expect(
      within(tracks[0]!).getByText('shown clean; waiting for the Approver to approve with a passkey'),
    ).toBeInTheDocument();
    expect(within(tracks[1]!).getByText('not clean: 40 passed, 2 failed')).toBeInTheDocument();
    expect(
      within(tracks[1]!).getByText('no approval requested: verification was not clean'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Approve with passkey in Decisions' })).toHaveAttribute(
      'href',
      '/decisions?focus=dec_01M4FDCDZ1BZDND5KCFB727KXV',
    );

    const bg = screen.getByRole('region', { name: 'Break-glass' });
    expect(within(bg).getByText('Awaiting the Approver')).toBeInTheDocument();
    expect(within(bg).getByText(/due in 21h/)).toBeInTheDocument();
    expect(
      within(bg).getByText(/approved, but the push failed \(execution_error\); main unchanged/),
    ).toBeInTheDocument();

    const promotions = await screen.findByRole('table', { name: /promotions/i });
    expect(
      within(promotions).getByText('2 orphan commits: no approved change record or fix plan'),
    ).toBeInTheDocument();
    expect(within(promotions).getByText('every commit traced through an approved gate')).toBeInTheDocument();
  });

  it('opens the promotion a Control Tower link names, once the list has loaded', async () => {
    installApi(routes({ 'GET /api/provenance': { ok: true, commits: [], orphanShas: [], reasons: [], baseRef: 'main' } }));
    renderPage(<RollbacksPage />, { path: '/rollbacks?promotionId=prm_completed', route: '/rollbacks' });
    expect(await screen.findByRole('dialog', { name: 'Promotion prm_…pleted' })).toBeInTheDocument();
  });

  it('requests a rollback to a pinned state that still resolves, never to one that does not', async () => {
    const calls = installApi(
      routes({
        'POST /api/rollbacks': (_u: URL, body: unknown) =>
          rollback({
            status: 'requested',
            verification: null,
            targetRef: (body as { targetRef: string }).targetRef,
          }),
      }),
    );
    const user = userEvent.setup({ delay: null });
    renderPage(<RollbacksPage />, {
      path: '/rollbacks?project=prj_claims',
      route: '/rollbacks',
      user: AISYAH,
    });

    const pinTable = await screen.findByRole('table', { name: /pinned states/i });
    const buttons = await within(pinTable).findAllByRole('button', { name: 'Roll back…' });
    expect(buttons).toHaveLength(1);
    await user.click(screen.getByRole('checkbox', { name: /no longer resolve/ }));
    const all = within(pinTable).getAllByRole('button', { name: 'Roll back…' });
    expect(all).toHaveLength(2);
    expect(all[1]).toBeDisabled();
    expect(all[1]).toHaveAttribute('title', 'Cannot roll back: tag no longer in the repository');

    await user.click(all[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Request a rollback' });
    expect(within(dialog).getByRole('combobox', { name: /Return to/ })).toHaveValue(SHA_A);
    await user.click(within(dialog).getByRole('button', { name: 'Request rollback' }));
    expect(within(dialog).getByText('Say why: at least a short sentence.')).toBeInTheDocument();
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why roll back/ }),
      'Duplicate claims are back.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Request rollback' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      projectId: 'prj_claims',
      targetRef: SHA_A,
      changeId: 'chg_01M4FDBZYA4VBEQ8CKEK7FP42E',
      reason: 'Duplicate claims are back.',
    });
  });

  it('opens the request prefilled from a change record’s “Roll back to this state” link', async () => {
    installApi(routes());
    renderPage(<RollbacksPage />, {
      path: `/rollbacks?project=prj_claims&target=${SHA_A}&change=chg_01M4FDBZYA4VBEQ8CKEK7FP42E`,
      route: '/rollbacks',
      user: AISYAH,
    });
    const dialog = await screen.findByRole('dialog', { name: 'Request a rollback' });
    await waitFor(() =>
      expect(within(dialog).getByRole('combobox', { name: /Return to/ })).toHaveValue(SHA_A),
    );
    expect(location()).toBe('/rollbacks?project=prj_claims');
  });

  it('warns the only Approver that a break-glass they invoke could not be approved, and asks for the acknowledgement', async () => {
    const calls = installApi(routes({ 'POST /api/breakglass': breakglass({ invokedBy: CEO.id }) }));
    const user = userEvent.setup({ delay: null });
    renderPage(<RollbacksPage />, { path: '/rollbacks', route: '/rollbacks', user: CEO });
    await user.click(await screen.findByRole('button', { name: 'Break-glass…' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Break-glass: emergency promotion' });
    expect(
      within(dialog).getByText('Single-Approver warning: nobody could approve this'),
    ).toBeInTheDocument();

    await user.selectOptions(within(dialog).getByRole('combobox', { name: /Project/ }), 'prj_aoc');
    await user.type(
      within(dialog).getByRole('textbox', { name: /Commit, branch or pinned tag/ }),
      'hotfix/backoff',
    );
    await user.type(
      within(dialog).getByRole('textbox', { name: /What is down/ }),
      'The console is down for every operator.',
    );
    await user.type(
      within(dialog).getByRole('textbox', { name: /normal path too slow/ }),
      'Gates are invisible while it loops.',
    );
    await user.type(
      within(dialog).getByRole('textbox', { name: /The fix/ }),
      'Cap the backoff at 30 s; watch reconnects.',
    );
    for (const label of [
      /Production is down/,
      /post-incident change record will be due/,
      /most heavily audited/,
    ])
      await user.click(within(dialog).getByRole('checkbox', { name: label }));
    await user.type(within(dialog).getByRole('textbox', { name: /Type BREAK GLASS/ }), 'break glass');
    await user.click(within(dialog).getByRole('button', { name: 'Invoke break-glass' }));
    expect(within(dialog).getByText('Acknowledge that nobody can approve it.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await user.click(
      within(dialog).getByRole('checkbox', { name: /nobody can approve a break-glass I invoke/ }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Invoke break-glass' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.path).toBe('/api/breakglass');
    expect(post.body).toEqual({
      projectId: 'prj_aoc',
      ref: 'hotfix/backoff',
      justification:
        'What is down and for whom:\nThe console is down for every operator.\n\n' +
        'Why the normal path is too slow:\nGates are invisible while it loops.\n\n' +
        'The fix and how the result will be checked:\nCap the backoff at 30 s; watch reconnects.',
    });
  });

  it('does not show a Builder the single-Approver warning', async () => {
    installApi(routes());
    const user = userEvent.setup({ delay: null });
    renderPage(<RollbacksPage />, { path: '/rollbacks', route: '/rollbacks', user: AISYAH });
    await user.click(await screen.findByRole('button', { name: 'Break-glass…' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Break-glass: emergency promotion' });
    expect(within(dialog).queryByText(/Single-Approver warning/)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/routes straight to Chiew Sin Kwang/)).toBeInTheDocument();
  });

  it('flags an overdue post-incident record', async () => {
    installApi(
      routes({
        'GET /api/breakglass': {
          items: [
            breakglass({
              status: 'approved',
              approval: { approverId: CEO.id, passkeyVerified: true, at: ago(30 * HOUR) },
              postIncidentChangeId: 'chg_01M4FDC18EMAEAWC4PNK5594KQ',
              postIncidentStatus: 'draft',
              dueAt: ago(6 * HOUR),
              overdue: true,
              overdueFlaggedAt: ago(6 * HOUR - 5 * MIN),
            }),
          ],
        },
      }),
    );
    renderPage(<RollbacksPage />, { path: '/rollbacks', route: '/rollbacks' });
    expect(await screen.findByText(/1 post-incident record is overdue/)).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Break-glass' })).getByText(/overdue/i),
    ).toBeInTheDocument();
  });
});
