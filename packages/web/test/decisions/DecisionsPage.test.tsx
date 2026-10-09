import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionCardView } from '@aoc/contracts';
import { AuthProvider, EventStreamProvider, type AuthUser } from '../../src/api';
import { ClockProvider, ToastProvider, fixedClock } from '../../src/components';
import DecisionsPage from '../../src/pages/decisions/DecisionsPage';
import { FakeEventSource, FakeEventSourceCtor, jsonResponse, mockFetch } from '../helpers';
import { CEO, NOW, closedHistory, openQueue, resolved, WEIJIE_ID } from './fixtures';

function stubWide(wide: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: wide && query.includes('min-width: 1024px'),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  })) as unknown as typeof window.matchMedia;
}

interface Calls {
  resolve: { id: string; body: unknown }[];
  openLoads: number;
}

function installApi(
  open: DecisionCardView[] = openQueue(),
  closed: DecisionCardView[] = closedHistory(),
): Calls {
  const calls: Calls = { resolve: [], openLoads: 0 };
  mockFetch((raw, init) => {
    const url = new URL(raw, 'http://aoc.test');
    const method = init.method ?? 'GET';
    if (url.pathname === '/api/decisions' && method === 'GET') {
      if (url.searchParams.get('status') === 'open') {
        calls.openLoads += 1;
        return jsonResponse({ generatedAt: new Date(NOW).toISOString(), decisions: open });
      }
      return jsonResponse({ generatedAt: new Date(NOW).toISOString(), decisions: closed });
    }
    const resolveMatch = /^\/api\/decisions\/([^/]+)\/resolve$/.exec(url.pathname);
    if (resolveMatch && method === 'POST') {
      const body = JSON.parse(String(init.body)) as { optionId: string };
      calls.resolve.push({ id: resolveMatch[1]!, body });
      const c = open.find((d) => d.id === resolveMatch[1])!;
      return jsonResponse(resolved(c, CEO.id, 'button', body.optionId, 30_000));
    }
    if (url.pathname === '/api/users')
      return jsonResponse({
        users: [
          { id: CEO.id, name: CEO.name, role: 'approver', active: true },
          { id: WEIJIE_ID, name: 'Tan Wei Jie', role: 'builder', active: true },
        ],
      });
    if (url.pathname === '/api/sessions') return jsonResponse([]);
    if (url.pathname === '/api/projects')
      return jsonResponse([{ projectId: 'prj_claims', name: 'Claims Intake Bot' }]);
    if (url.pathname === '/api/passkeys') return jsonResponse({ passkeys: [] });
    return jsonResponse({ error: { code: 'not_found', message: 'nope' } }, { status: 404 });
  });
  return calls;
}

function renderPage(path = '/decisions', user: AuthUser = CEO) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider initialUser={user}>
        <ToastProvider>
          <ClockProvider clock={fixedClock(NOW)}>
            <EventStreamProvider eventSource={FakeEventSourceCtor}>
              <Routes>
                <Route path="/decisions" element={<DecisionsPage />} />
              </Routes>
            </EventStreamProvider>
          </ClockProvider>
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

// Render tests drive real React trees with user-event: allow for a loaded CI machine.
describe('Decisions inbox', { timeout: 15_000 }, () => {
  const originalMatchMedia = window.matchMedia;
  beforeEach(() => {
    FakeEventSource.reset();
    stubWide(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.matchMedia = originalMatchMedia;
  });

  it('splits the queue into what I can resolve and what waits on others, most urgent first', async () => {
    installApi();
    renderPage();
    const mine = await screen.findByRole('region', { name: /Waiting on you/ });
    const cards = within(mine).getAllByRole('listitem');
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveTextContent('Top-up request: Tan Wei Jie');
    expect(cards[0]).toHaveTextContent('Over SLA by 2h');
    expect(cards[1]).toHaveTextContent('Due in 10m');

    const others = screen.getByRole('region', { name: /Waiting on others/ });
    expect(within(others).getByText(/Read-only:/).parentElement).toHaveTextContent('You raised this request');
    // KPIs as text, each linking to its filter.
    expect(screen.getByRole('link', { name: 'Over SLA' })).toHaveAttribute('href', '/decisions?aging=over');
  });

  it('Approve applies the recommended option and refetches the queue', async () => {
    const user = userEvent.setup();
    const calls = installApi();
    renderPage();
    const mine = await screen.findByRole('region', { name: /Waiting on you/ });
    await user.click(within(mine).getByRole('button', { name: 'Approve: Hold for UAT first' }));
    await waitFor(() =>
      expect(calls.resolve).toEqual([{ id: 'dec_agent', body: { optionId: 'uat', comment: null } }]),
    );
    await waitFor(() => expect(calls.openLoads).toBeGreaterThanOrEqual(2));
    expect(await screen.findByText('Decided: Hold for UAT first')).toBeInTheDocument();
  });

  it('opens a deep-linked card and says a second Approver is needed for my own request', async () => {
    installApi();
    renderPage('/decisions?focus=dec_own');
    const detail = await screen.findByRole('complementary', { name: 'Selected decision' });
    expect(await within(detail).findByText(/a second Approver is needed to resolve it/)).toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: /with passkey/ })).toBeNull();
  });

  it('asks a user without a passkey to register one before signing a break-glass decision', async () => {
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    vi.stubGlobal('isSecureContext', true);
    installApi();
    renderPage('/decisions?focus=dec_bg');
    const detail = await screen.findByRole('complementary', { name: 'Selected decision' });
    expect(await within(detail).findByRole('button', { name: 'Register a passkey' })).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Approve with passkey' })).toBeDisabled();
    expect(within(detail).getByText(/Signed approval\./)).toBeInTheDocument();
  });

  it('shows the selected card in a drawer on phones', async () => {
    stubWide(false);
    installApi();
    renderPage('/decisions?focus=dec_agent');
    const drawer = await screen.findByRole('dialog', { name: 'Merge the retry-dedupe fix to main?' });
    expect(within(drawer).getByText('Agent recommends')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Approve: Hold for UAT first' })).toBeEnabled();
  });

  it('refreshes when a decision event arrives on the stream', async () => {
    const calls = installApi();
    renderPage();
    await screen.findByRole('region', { name: /Waiting on you/ });
    const before = calls.openLoads;
    act(() => {
      FakeEventSource.last.open();
      FakeEventSource.last.emit('aoc', {
        seq: 9,
        type: 'decision.requested',
        ts: new Date(NOW).toISOString(),
        scope: {},
        meta: {},
      });
    });
    await waitFor(() => expect(calls.openLoads).toBeGreaterThan(before));
  });

  it('shows time to decide per kind and how each closed decision was made', async () => {
    installApi();
    renderPage('/decisions?tab=resolved');
    expect(await screen.findByText('Time to decide, by kind')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /Agent decision: p50 25m, p90 1h 30m, SLA 1h, 1 over SLA/ }),
    ).toBeInTheDocument();
    const table = screen.getByRole('table', { name: /Closed decisions/ });
    expect(within(table).getByText('Signed (passkey)')).toBeInTheDocument();
    expect(within(table).getAllByText('Attribution (bearer token)')).toHaveLength(2);
  });

  it('says what would fill an empty inbox', async () => {
    installApi([], []);
    renderPage();
    expect(await screen.findByText('No open decisions')).toBeInTheDocument();
    expect(screen.getByText(/an agent hits a decision test/)).toBeInTheDocument();
  });
});
