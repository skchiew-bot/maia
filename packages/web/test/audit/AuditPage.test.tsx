import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEventDetailDTO, AuditEventPageDTO } from '@aoc/contracts';
import AuditPage from '../../src/pages/audit/AuditPage';
import { FakeEventSource } from '../helpers';
import {
  CEO,
  COMMON_ROUTES,
  HOUR,
  WEIJIE,
  ago,
  anchors,
  auditEvent,
  decisionCard,
  health,
  installApi,
  renderPage,
  verifyReport,
} from '../governance/fixtures';

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => vi.unstubAllGlobals());

const location = () => screen.getByTestId('location').textContent;

const page = (events: AuditEventPageDTO['events']): AuditEventPageDTO => ({
  events,
  headSeq: 3368,
  nextFromSeq: null,
  nextToSeq: events.length ? events[events.length - 1]!.seq - 1 : null,
});

const EXPLORER = [
  auditEvent(3368, 'token.issued', { actor: { kind: 'human', id: CEO.id }, scope: {} }),
  auditEvent(3367, 'change.submitted', {
    scope: { projectId: 'prj_claims', changeId: 'chg_01M4FDBZYA4VBEQ8CKEK7FP42E' },
    hasBody: true,
    payloadHashPrefix: '5f8d2a544ab8876a',
  }),
  auditEvent(3366, 'session.liveness_changed', {
    actor: { kind: 'system', id: 'liveness' },
    scope: { projectId: 'prj_claims', sessionId: 'ses_01M4FAFKJ0HS6W702V2VZ0N2MV' },
  }),
];

const SELFMOD = [
  auditEvent(3329, 'selfmod.blocked', {
    actor: { kind: 'agent', id: 'ses_01M4FAFKJ0HS6W702V2VZ0N2MV' },
    meta: {
      rule: 'audit_store.edit',
      pathHash: 'c32a5efb11223344',
      externalLogged: true,
      sessionId: 'ses_01M4FAFKJ0HS6W702V2VZ0N2MV',
    },
  }),
];

function detail(seq: number): AuditEventDetailDTO {
  return {
    ...EXPLORER.find((e) => e.seq === seq)!,
    bodyScope: 'prj_claims',
    sourceTs: null,
    causationId: null,
    body: 'present',
    erased: false,
    bodyVerified: true,
    payloadVisible: true,
    payloadWithheldReason: null,
    payload: { note: 'Approved after green CI' },
  };
}

function routes(extra: Record<string, unknown> = {}) {
  return {
    ...COMMON_ROUTES,
    'GET /api/audit/health': health(),
    'GET /api/audit/anchors': anchors(),
    'GET /api/audit/events': (url: URL) => {
      const type = url.searchParams.get('type');
      if (type === 'chain.verified')
        return page([
          auditEvent(3151, 'chain.verified', {
            actor: { kind: 'system', id: 'scheduler:audit' },
            meta: { ok: true, checked: 3150, anchorsChecked: 1, anchorsMatched: 1 },
          }),
        ]);
      if (type === 'selfmod.blocked') return page(SELFMOD);
      if (type === 'body.erased') return page([]);
      const prefix = url.searchParams.get('typePrefix');
      return page(prefix ? EXPLORER.filter((e) => e.type.startsWith(prefix)) : EXPLORER);
    },
    'GET /api/audit/events/3367': detail(3367),
    'GET /api/decisions': {
      generatedAt: ago(0),
      decisions: [
        decisionCard({
          id: 'dec_01ERASE0000000000000000001',
          kind: 'erasure_request',
          title: 'Erasure request',
          question: 'Approve crypto-shredding one body scope for a PDPA request from the data subject?',
        }),
        // Approved, but not an erasure request: never offered.
        decisionCard({ id: 'dec_01CHANGE000000000000000001' }),
      ],
    },
    ...extra,
  };
}

describe('Audit', { timeout: 30_000 }, () => {
  it('answers whether the log is intact with the numbers as text, and says local anchors are not enough', async () => {
    installApi(routes());
    renderPage(<AuditPage />, { path: '/audit', route: '/audit' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Audit' })).toBeInTheDocument();

    expect(
      await screen.findByRole('img', {
        name: /^3,149 of 3,368 events \(9\d(\.\d)?%\) are at or before the last anchor; 219 newer events are not anchored yet\.$/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Covered by an anchor')).toHaveTextContent('3,149');
    expect(screen.getByText('Last run passed')).toBeInTheDocument();
    expect(screen.getByText('Only verify-against-anchor proves integrity.')).toBeInTheDocument();

    const anchorsWidget = screen.getByRole('region', { name: 'Off-host anchors' });
    expect(within(anchorsWidget).getByText('Last anchor').nextSibling).toHaveTextContent('3h ago');
    expect(within(anchorsWidget).getByText('within 1d 2h')).toBeInTheDocument();
    expect(within(anchorsWidget).getByText('Anchors are not off-host')).toBeInTheDocument();

    const selfmod = screen.getByRole('region', { name: 'Self-modification blocks' });
    expect(within(selfmod).getByText('audit_store.edit')).toBeInTheDocument();
    expect(within(selfmod).getByText('logged outside AOC')).toBeInTheDocument();

    const explorer = await screen.findByRole('table', { name: 'Audit events, newest first' });
    expect(within(explorer).getAllByRole('row')).toHaveLength(1 + 3);
    expect(within(explorer).getByText('change.submitted')).toBeInTheDocument();
    expect(within(explorer).getByText('5f8d2a544ab8876a')).toBeInTheDocument();
    expect(within(explorer).getAllByText('header only')).toHaveLength(2);

    expect(
      screen.getByText(/Anchors stay on this host \(audit.anchorRemote is not set\)/),
    ).toBeInTheDocument();
  });

  it('verifies against the anchors and shows each anchor’s proof', async () => {
    const calls = installApi(routes({ 'GET /api/audit/verify': verifyReport() }));
    const user = userEvent.setup({ delay: null });
    renderPage(<AuditPage />, { path: '/audit', route: '/audit', user: WEIJIE });
    await user.click(await screen.findByRole('button', { name: 'Verify against anchors' }));

    expect(await screen.findByText('Matches 1 anchor, but they are local only')).toBeInTheDocument();
    const proofs = screen.getByRole('region', { name: 'Anchor proofs' });
    expect(within(proofs).getByText('#3,149')).toBeInTheDocument();
    expect(within(proofs).getAllByText(/match/i).length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.path === '/api/audit/verify')).toHaveLength(1);
  });

  it('anchors the chain head on request', async () => {
    const calls = installApi(
      routes({
        'POST /api/audit/anchor': {
          ok: true,
          anchor: { ...anchors().anchors[0]!, seq: 3369, anchoredAt: new Date().toISOString() },
          pushError: null,
        },
      }),
    );
    const user = userEvent.setup({ delay: null });
    renderPage(<AuditPage />, { path: '/audit', route: '/audit' });
    await user.click(await screen.findByRole('button', { name: 'Anchor now' }));
    expect(await screen.findByText('Anchored the chain head #3,369')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/audit/anchor')).toBe(true);
  });

  it('filters the explorer by event family through the URL and opens an event’s chain detail', async () => {
    const calls = installApi(routes());
    const user = userEvent.setup({ delay: null });
    renderPage(<AuditPage />, { path: '/audit', route: '/audit' });
    await screen.findByRole('table', { name: 'Audit events, newest first' });

    await user.type(screen.getByRole('combobox', { name: 'Event type' }), 'change.');
    await waitFor(() => expect(location()).toBe('/audit?prefix=change.'), { timeout: 3000 });
    await waitFor(() =>
      expect(
        calls.some((c) => c.path === '/api/audit/events' && c.query.get('typePrefix') === 'change.'),
      ).toBe(true),
    );
    const explorer = screen.getByRole('table', { name: 'Audit events, newest first' });
    await waitFor(() => expect(within(explorer).getAllByRole('row')).toHaveLength(1 + 1));

    await user.click(within(explorer).getByRole('button', { name: '#3,367' }));
    expect(location()).toBe('/audit?prefix=change.&seq=3367');
    const drawer = await screen.findByRole('dialog', { name: 'Event #3,367' });
    expect(await within(drawer).findByText(/Approved after green CI/)).toBeInTheDocument();
    expect(within(drawer).getByRole('region', { name: 'Chain' })).toBeInTheDocument();
  });

  it('filters the explorer to one session from the Session page link (?sessionId=) and clears it with the field', async () => {
    const session = 'ses_01M4FAFKJ0HS6W702V2VZ0N2MV';
    const calls = installApi(routes());
    const user = userEvent.setup({ delay: null });
    renderPage(<AuditPage />, { path: `/audit?sessionId=${session}&range=all`, route: '/audit' });
    await screen.findByRole('table', { name: 'Audit events, newest first' });

    const field = screen.getByRole('textbox', { name: 'Session or ticket id' });
    expect(field).toHaveValue(session);
    expect(
      calls.some((c) => c.path === '/api/audit/events' && c.query.get('sessionId') === session),
    ).toBe(true);
    // The link asks for the whole log, so a session older than the 7-day default is not silently cut off.
    expect(screen.getByRole('radio', { name: 'All' })).toBeChecked();

    await user.clear(field);
    await waitFor(() => expect(location()).toBe('/audit?range=all'), { timeout: 3000 });
    await waitFor(() =>
      expect(
        calls.filter((c) => c.path === '/api/audit/events' && !c.query.has('type') && !c.query.has('sessionId'))
          .length,
      ).toBeGreaterThan(0),
    );
  });

  it('lets only an Approver crypto-shred, and only under an approved erasure request (O-28)', async () => {
    const calls = installApi(
      routes({
        'POST /api/audit/erase': {
          scopeId: 'ses_01M4FAFKJ0HS6W702V2VZ0N2MV',
          reason: 'pdpa_request',
          bodiesErased: 12,
          eventsInScope: 40,
          eventSeq: 3370,
          decisionId: 'dec_01ERASE0000000000000000001',
        },
      }),
    );
    const user = userEvent.setup({ delay: null });
    renderPage(<AuditPage />, { path: '/audit', route: '/audit' });
    const erase = await screen.findByRole('region', { name: 'Erasure (crypto-shred)' });
    await user.click(within(erase).getByRole('button', { name: 'Crypto-shred this scope' }));
    expect(
      within(erase).getByText('Erasure needs an approved erasure request that names this scope.'),
    ).toBeInTheDocument();
    const requests = within(erase).getByRole('combobox', { name: /Approved erasure request/ });
    expect(within(requests).queryByRole('option', { name: /dec_01CHANGE/ })).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    const scope = 'ses_01M4FAFKJ0HS6W702V2VZ0N2MV';
    await user.type(within(erase).getByRole('textbox', { name: /Body scope/ }), scope);
    await user.selectOptions(requests, 'dec_01ERASE0000000000000000001');
    await user.type(within(erase).getByRole('textbox', { name: /Type the scope id again/ }), scope);
    await user.click(within(erase).getByRole('button', { name: 'Crypto-shred this scope' }));

    expect(await within(erase).findByText(`Scope ${scope} erased`)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      scopeId: scope,
      decisionId: 'dec_01ERASE0000000000000000001',
    });
    expect(calls.some((c) => c.path === '/api/decisions' && c.query.get('kind') === 'erasure_request')).toBe(true);
  });

  it('lets Builders ask for an erasure, never carry one out (O-28)', async () => {
    const calls = installApi(
      routes({
        'GET /api/audit/health': health({ lastAnchor: { ...health().lastAnchor!, at: ago(30 * HOUR) } }),
        'POST /api/audit/erasure-requests': {
          requestId: 'erq_01REQ00000000000000000001',
          decisionId: 'dec_01ERASE0000000000000000002',
          scopeIds: ['ses_a', 'tkt_b'],
          reason: 'secret_leak',
          requesterId: WEIJIE.id,
          createdAt: ago(0),
          eventsInScope: { ses_a: 3, tkt_b: 7 },
        },
      }),
    );
    const user = userEvent.setup({ delay: null });
    renderPage(<AuditPage />, { path: '/audit', route: '/audit', user: WEIJIE });
    const erase = await screen.findByRole('region', { name: 'Erasure (crypto-shred)' });
    // An anchor older than the 26-hour threshold is called out as such.
    expect(await screen.findByText('older than 1d 2h')).toBeInTheDocument();
    expect(within(erase).queryByRole('button', { name: 'Crypto-shred this scope' })).not.toBeInTheDocument();

    await user.click(within(erase).getByRole('button', { name: 'Request the erasure' }));
    expect(within(erase).getByText('Enter 1 to 20 body scope ids, separated by spaces or commas.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await user.type(within(erase).getByRole('textbox', { name: /Body scopes/ }), 'ses_a, tkt_b ses_a');
    await user.selectOptions(within(erase).getByRole('combobox', { name: /Reason/ }), 'secret_leak');
    await user.type(within(erase).getByRole('textbox', { name: /Why, and the impact/ }), 'A key was pasted');
    await user.click(within(erase).getByRole('button', { name: 'Request the erasure' }));
    expect(await within(erase).findByText('Request sent')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      scopeIds: ['ses_a', 'tkt_b'],
      reason: 'secret_leak',
      rationale: 'A key was pasted',
    });
    expect(within(erase).getByText(/ses_a \(3\), tkt_b \(7\)/)).toBeInTheDocument();
  });
});
