import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleSnapshot, DecisionListResponse } from '@aoc/contracts';
import { AuthProvider, EventStreamProvider, type AuthUser } from '../../src/api';
import { ClockProvider, fixedClock, ToastProvider } from '../../src/components';
import ConsolePage from '../../src/pages/console/ConsolePage';
import { FakeEventSource, FakeEventSourceCtor, jsonResponse, mockFetch } from '../helpers';
import { ago, decision, iso, MIN, NOW, registry, snapshot, summary } from '../sessions/fixtures';

const BUILDER: AuthUser = { id: 'usr_aisyah', name: 'Aisyah Rahman', role: 'builder', flags: {} };

function Location() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname + l.search + l.hash}</output>;
}

function renderConsole(path = '/console', user = BUILDER) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ClockProvider clock={fixedClock(NOW)}>
        <AuthProvider initialUser={user}>
          <ToastProvider>
            <EventStreamProvider eventSource={FakeEventSourceCtor}>
              <Routes>
                <Route path="/console" element={<ConsolePage />} />
                <Route path="*" element={<p>elsewhere</p>} />
              </Routes>
              <Location />
            </EventStreamProvider>
          </ToastProvider>
        </AuthProvider>
      </ClockProvider>
    </MemoryRouter>,
  );
}

const sessions = [
  summary({ sessionId: 'ses_work', title: 'Whisper suggestions', ownerId: 'usr_aisyah', ownerName: 'Aisyah Rahman' }),
  summary({
    sessionId: 'ses_wait',
    title: 'Backfill status',
    projectId: 'prj_claims',
    projectName: 'Claims Intake Bot',
    ownerId: 'usr_weijie',
    ownerName: 'Tan Wei Jie',
    lifecycle: 'waiting_decision',
    liveness: { state: 'waiting_on_you', reason: 'open_decision', since: ago(130) },
    openDecision: { decisionId: 'dec_1', kind: 'agent_decision', createdAt: ago(134) },
    apm: { windowMinutes: 30, points: Array(30).fill(0), current: 0 },
  }),
  summary({
    sessionId: 'ses_dead',
    title: 'Flaky e2e',
    lifecycle: 'failed',
    liveness: { state: 'dead', reason: 'no_heartbeat', since: ago(21) },
    ownerId: 'usr_weijie',
    ownerName: 'Tan Wei Jie',
  }),
  summary({
    sessionId: 'ses_obs',
    mode: 'observed',
    title: 'Observed · aoc-platform',
    ownerId: null,
    ownerName: null,
    progress: null,
    liveness: { state: 'thinking', reason: 'streaming', since: ago(2) },
  }),
  summary({
    sessionId: 'ses_done',
    title: 'QA export',
    lifecycle: 'ended',
    liveness: null,
    endedAt: iso(NOW - 120 * MIN),
    outcome: 'completed',
    costTodayUsd: 2.4,
    costTodayRm: 10.12,
  }),
];

const decisions: DecisionListResponse = {
  generatedAt: iso(NOW),
  decisions: [
    decision({ id: 'dec_1', sessionId: 'ses_wait' }),
    decision({
      id: 'dec_gate',
      kind: 'go_live',
      test: 'production',
      title: 'Promote CX Copilot v1.4.0?',
      requiresPasskey: true,
      sessionId: null,
      createdAt: ago(65),
    }),
    decision({
      id: 'dec_top',
      kind: 'credit_topup',
      test: null,
      title: 'Top up Wei Jie’s credits?',
      recommendation: null,
      sessionId: null,
      createdAt: ago(31),
      viewer: { canResolve: false, reason: 'role', canWithdraw: false, canEscalate: false },
    }),
  ],
};

describe('ConsolePage', () => {
  let posts: { url: string; body: unknown }[];
  let snap: ConsoleSnapshot;
  let failConsole: boolean;

  beforeEach(() => {
    FakeEventSource.reset();
    posts = [];
    snap = snapshot(sessions);
    failConsole = false;
    mockFetch((url, init) => {
      const path = url.split('?')[0];
      if (init.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body ?? '{}')) });
        return jsonResponse({ ...decisions.decisions[0], status: 'resolved' });
      }
      if (path === '/api/console')
        return failConsole ? jsonResponse({ error: { code: 'boom', message: 'Store restarting' } }, { status: 503 }) : jsonResponse(snap);
      if (path === '/api/decisions') return jsonResponse(decisions);
      if (path === '/api/fx/status') return jsonResponse({ current: { rate: 4.215, status: 'live', sourceDate: '2026-10-09' } });
      if (path === '/api/registry/process-types') return jsonResponse(registry());
      return jsonResponse({ error: { code: 'not_found', message: url } }, { status: 404 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows tiles in liveness precedence with their numbers as text, and the ended-today table', async () => {
    renderConsole();
    const tiles = await screen.findByRole('list', { name: /Live sessions, highest liveness precedence first/ });
    const names = within(tiles)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(names).toEqual(['Backfill status', 'Flaky e2e', 'Observed · aoc-platform', 'Whisper suggestions']);

    const waiting = within(tiles).getByRole('article', { name: 'Backfill status' });
    expect(within(waiting).getByText('Waiting on you')).toBeInTheDocument();
    expect(within(waiting).getByRole('link', { name: 'decision 2h 14m' })).toHaveAttribute('href', '/decisions?focus=dec_1');
    expect(within(waiting).getByText('APM now')).toBeInTheDocument();

    const working = within(tiles).getByRole('article', { name: 'Whisper suggestions' });
    expect(within(working).getByText('2/6')).toBeInTheDocument();
    expect(within(working).getByText('ETA after 3 tasks')).toBeInTheDocument();
    expect(within(working).getByText('41%')).toBeInTheDocument();
    expect(within(working).getByText('US$28.22')).toBeInTheDocument();
    expect(within(working).getByText('RM 118.94')).toBeInTheDocument();
    expect(within(working).getByRole('img', { name: /actions per minute over the last 30 minutes/ })).toBeInTheDocument();

    expect(within(tiles).getByText('observed · read-only')).toBeInTheDocument();
    // A dead session has no "APM now"; its chart still draws the window, so the number beside it is the window's peak.
    const dead = within(tiles).getByRole('article', { name: 'Flaky e2e' });
    expect(within(dead).getByText('APM peak')).toBeInTheDocument();
    expect(within(dead).queryByText('APM now')).not.toBeInTheDocument();
    expect(dead.querySelector('.console-tile__apm-value')).toHaveTextContent('6');

    const ended = screen.getByRole('table', { name: 'Sessions that ended today' });
    expect(within(ended).getByRole('link', { name: 'QA export' })).toHaveAttribute('href', '/sessions/ses_done');
    expect(within(ended).getByText('Completed, 2 of 6 tasks')).toBeInTheDocument();

    const counts = screen.getByRole('list', { name: /Live sessions by liveness/ });
    expect(within(counts).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Waiting on you1',
      'Throttled0',
      'Dead1',
      'Stalled0',
      'Thinking1',
      'Working1',
    ]);
    expect(screen.getByText('US$152.38')).toBeInTheDocument();
    expect(screen.getByText(/FX 4\.2150 BNM, live/)).toBeInTheDocument();
  });

  it('filters from the fleet counts and the selects, and keeps the filter in the URL', async () => {
    const user = userEvent.setup();
    renderConsole();
    const counts = await screen.findByRole('list', { name: /Live sessions by liveness/ });
    await user.click(within(counts).getByRole('button', { name: /Dead/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/console?liveness=dead');
    const tiles = screen.getByRole('list', { name: /Live sessions, highest liveness precedence first/ });
    expect(within(tiles).getAllByRole('article')).toHaveLength(1);
    expect(within(tiles).getByRole('heading', { level: 3 })).toHaveTextContent('Flaky e2e');
    await user.click(within(counts).getByRole('button', { name: /Dead/ }));
    await user.selectOptions(screen.getByLabelText('Project'), 'prj_claims');
    expect(within(screen.getByRole('list', { name: /highest liveness precedence/ })).getAllByRole('article')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await user.click(screen.getByRole('button', { name: 'Mine' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/console?mine=1');
    expect(within(screen.getByRole('list', { name: /highest liveness precedence/ })).getAllByRole('article')).toHaveLength(1);
  });

  it('approves the recommended option from the rail and is role-aware for the rest', async () => {
    const user = userEvent.setup();
    renderConsole();
    const rail = await screen.findByRole('complementary', { name: /Decisions waiting/ });
    const cards = within(rail).getAllByRole('listitem');
    // oldest first
    expect(cards.map((c) => within(c).getByRole('heading').textContent)).toEqual([
      'Backfill 41,208 claims tonight?',
      'Promote CX Copilot v1.4.0?',
      'Top up Wei Jie’s credits?',
    ]);
    expect(within(cards[1]!).getByRole('link', { name: /Approve with passkey/ })).toHaveAttribute('href', '/decisions?focus=dec_gate');
    expect(within(cards[2]!).getByText('An Approver decides')).toBeInTheDocument();
    expect(within(cards[0]!).getByText('Agent recommends')).toBeInTheDocument();
    // the headline and, under it, the question the agent actually asked
    expect(within(cards[0]!).getByText('Overnight batches, one transaction now, or derive on read?')).toBeInTheDocument();

    await user.click(within(cards[0]!).getByRole('button', { name: 'Approve: Batches of 5,000, 01:00–04:00' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: '/api/decisions/dec_1/resolve', body: { optionId: 'batches' } });
    expect(await screen.findByText('Approved: Batches of 5,000, 01:00–04:00')).toBeInTheDocument();
  });

  it('refreshes from the event stream, not a timer', async () => {
    renderConsole();
    await screen.findByRole('heading', { name: 'Whisper suggestions' });
    snap = snapshot([...sessions, summary({ sessionId: 'ses_new', title: 'Fresh session', liveness: { state: 'thinking', reason: 'starting', since: ago(0) } })]);
    act(() => {
      FakeEventSource.last.open();
      FakeEventSource.last.emit('aoc', { seq: 9, type: 'session.launch_requested', ts: iso(NOW), scope: { sessionId: 'ses_new' }, meta: {} });
    });
    expect(await screen.findByRole('heading', { name: 'Fresh session' })).toBeInTheDocument();
  });

  it('shows a retryable error when the snapshot cannot load', async () => {
    failConsole = true;
    const user = userEvent.setup();
    renderConsole();
    expect(await screen.findByText("Couldn't load the console")).toBeInTheDocument();
    failConsole = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Whisper suggestions' })).toBeInTheDocument();
  });

  it('says what would fill an empty console', async () => {
    snap = snapshot([]);
    renderConsole();
    expect(await screen.findByText('No sessions running')).toBeInTheDocument();
    expect(screen.getByText('No session has ended today')).toBeInTheDocument();
  });
});
