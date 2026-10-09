import { act, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, type AuthUser } from '../../src/api';
import { ClockProvider, fixedClock, ToastProvider } from '../../src/components';
import { AppRoutes } from '../../src/routes';
import { FakeEventSource, jsonResponse, mockFetch, stubReducedMotion } from '../helpers';
import { CONSOLE, DECISIONS, manifest, NOW, PROJECTS } from './fixtures';

configure({ asyncUtilTimeout: 8000 });
vi.setConfig({ testTimeout: 30_000 });
beforeAll(async () => {
  await import('../../src/pages/showcase/ShowcasePage');
});

const APPROVER: AuthUser = { id: 'usr_ceo', name: 'Chiew Sin Kwang', role: 'approver', flags: {} };

let calls: Record<string, number>;
let workDone: string[];
let restoreMotion: (() => void) | null = null;

function mount() {
  calls = {};
  mockFetch((url) => {
    const path = url.split('?')[0]!;
    calls[path] = (calls[path] ?? 0) + 1;
    if (path === '/api/console') return jsonResponse(CONSOLE);
    if (path === '/api/projects') return jsonResponse(PROJECTS);
    if (url === '/api/decisions?status=open') return jsonResponse({ generatedAt: '', decisions: DECISIONS });
    if (path === '/api/decisions/summary') return jsonResponse({ generatedAt: '', open: 3, resolvableByMe: 3, oldestOpenAt: null, oldestResolvableByMeAt: null, byKind: {} });
    if (path === '/api/sessions/ses_work/timeline') return jsonResponse({ manifest: manifest(workDone) });
    if (path === '/api/sessions/ses_done/timeline') return jsonResponse({ manifest: manifest(['t1', 't2', 't3', 't4', 't5', 't6']) });
    if (path.endsWith('/timeline')) return jsonResponse({ manifest: manifest(['t1']) });
    return jsonResponse({ error: { code: 'not_found', message: url } }, { status: 404 });
  });
  return render(
    <MemoryRouter initialEntries={['/showcase']}>
      <ClockProvider clock={fixedClock(NOW)}>
        <AuthProvider initialUser={APPROVER}>
          <ToastProvider>
            <AppRoutes />
          </ToastProvider>
        </AuthProvider>
      </ClockProvider>
    </MemoryRouter>,
  );
}

const aoc = (type: string, seq: number, sessionId: string) => ({
  seq,
  type,
  ts: '2026-10-09T05:41:30Z',
  scope: { sessionId },
  meta: {},
});

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  workDone = ['t1'];
});
afterEach(() => {
  vi.unstubAllGlobals();
  restoreMotion?.();
  restoreMotion = null;
});

const track = (name: RegExp) => screen.getByRole('img', { name });

describe('showcase', () => {
  it('draws each session on its own plan, with every mark available as text', async () => {
    mount();
    expect(await screen.findByRole('heading', { level: 1, name: 'Showcase' })).toBeInTheDocument();
    const map = await screen.findByRole('region', { name: /Fleet map/ });
    await waitFor(() =>
      expect(track(/^Greeting command/)).toHaveAccessibleName(
        'Greeting command: Working, phase Design (1 of 3), 2 of 17 weight done (12%)',
      ),
    );
    expect(within(map).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'AOC Platform',
      'Claims Intake Bot',
      'CX Copilot',
      'Across projects',
    ]);
    // A decision waiting on a session rides on its node; others wait as diamonds on their lane.
    expect(track(/^Normalise policy numbers/)).toHaveAccessibleName(/Waiting on you.*decision waiting 34m/);
    const cx = screen.getByRole('region', { name: 'CX Copilot' });
    expect(within(cx).getByRole('link', { name: /Fix plan/ })).toHaveAttribute('href', '/decisions');
    expect(within(screen.getByRole('region', { name: 'Across projects' })).getByText('Credit top-up')).toBeInTheDocument();
    expect(track(/^CSAT overlay/)).toHaveAccessibleName(/Throttled.*resets at/);
    // The observed session has no plan: one dot, labelled.
    expect(screen.getByRole('link', { name: /Observed · aoc: Stalled, observed, read-only/ })).toBeInTheDocument();
    // Finished sessions wait behind a toggle.
    expect(screen.queryByRole('img', { name: /^Finished fix/ })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: /Show 1 session that finished/ }));
    expect(await screen.findByRole('img', { name: /^Finished fix: finished/ })).toBeInTheDocument();
    expect(screen.getByText('Fleet map as a table')).toBeInTheDocument();
  });

  it('moves a node only when an event changes its numbers', async () => {
    mount();
    await waitFor(() => expect(track(/^Greeting command/)).toHaveAccessibleName(/2 of 17 weight done/));
    const es = FakeEventSource.last;
    act(() => es.open());
    const consoleCalls = calls['/api/console'];
    const timelineCalls = calls['/api/sessions/ses_work/timeline'];

    // Tool calls ring the node and fill the feed, but change no numbers: nothing is refetched.
    act(() => es.emit('aoc', aoc('tool.used', 501, 'ses_work')));
    await new Promise((r) => setTimeout(r, 300));
    expect(calls['/api/console']).toBe(consoleCalls);
    expect(calls['/api/sessions/ses_work/timeline']).toBe(timelineCalls);
    expect(document.querySelectorAll('.sc-ping')).toHaveLength(1);
    expect(screen.getByRole('region', { name: /Latest events/ })).toHaveTextContent('Tool calls');

    workDone = ['t1', 't2', 't4'];
    act(() => es.emit('aoc', aoc('task.done', 502, 'ses_work')));
    await waitFor(() =>
      expect(track(/^Greeting command/)).toHaveAccessibleName(
        'Greeting command: Working, phase Build (2 of 3), 8 of 17 weight done (47%)',
      ),
    );
    expect(calls['/api/sessions/ses_work/timeline']).toBe(timelineCalls! + 1);
    expect(screen.getByText(/Last event #502/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Latest events/ })).toHaveTextContent('Task done');

    act(() => es.emit('liveness', { sessionId: 'ses_work', state: 'stalled', since: '2026-10-09T05:41:40Z' }));
    await waitFor(() => expect(calls['/api/console']).toBe(consoleCalls! + 1));
    expect(screen.getByRole('region', { name: /Latest events/ })).toHaveTextContent('Stalled');
  });

  it('makes every change instant under reduced motion: no activity ring', async () => {
    restoreMotion = stubReducedMotion(true);
    mount();
    await waitFor(() => expect(track(/^Greeting command/)).toBeInTheDocument());
    const es = FakeEventSource.last;
    act(() => es.open());
    act(() => es.emit('aoc', aoc('tool.used', 600, 'ses_work')));
    await new Promise((r) => setTimeout(r, 150));
    expect(document.querySelectorAll('.sc-ping')).toHaveLength(0);
  });

  it('filters the map by liveness from the counts', async () => {
    const user = userEvent.setup();
    mount();
    const filters = await screen.findByRole('group', { name: 'Show sessions by liveness' });
    await waitFor(() => expect(within(filters).getAllByRole('button').length).toBeGreaterThan(1));
    expect(within(filters).getByRole('button', { name: /All live/ })).toHaveTextContent('4');
    await user.click(within(filters).getByRole('button', { name: /Throttled/ }));
    expect(screen.getByRole('img', { name: /^CSAT overlay/ })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /^Greeting command/ })).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Claims Intake Bot' })).getByText(/No sessions match this filter/)).toBeInTheDocument();
  });
});
