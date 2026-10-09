import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionDetail } from '@aoc/contracts';
import { AuthProvider, EventStreamProvider, type AuthUser } from '../../src/api';
import { ClockProvider, fixedClock, ToastProvider } from '../../src/components';
import SessionPage from '../../src/pages/sessions/SessionPage';
import { FakeEventSource, FakeEventSourceCtor, jsonResponse, mockFetch } from '../helpers';
import {
  activity,
  ago,
  decision,
  detail,
  iso,
  metering,
  NOW,
  rateCard,
  registry,
  summary,
  thread,
  timeline,
} from './fixtures';

const OWNER: AuthUser = { id: 'usr_aisyah', name: 'Aisyah Rahman', role: 'builder', flags: {} };

function renderSession(id = 'ses_work', user = OWNER) {
  return render(
    <MemoryRouter initialEntries={[`/sessions/${id}`]}>
      <ClockProvider clock={fixedClock(NOW)}>
        <AuthProvider initialUser={user}>
          <ToastProvider>
            <EventStreamProvider eventSource={FakeEventSourceCtor}>
              <Routes>
                <Route path="/sessions/:id" element={<SessionPage />} />
              </Routes>
            </EventStreamProvider>
          </ToastProvider>
        </AuthProvider>
      </ClockProvider>
    </MemoryRouter>,
  );
}

const feed = [
  { seq: 120, id: 'evt_3', ts: ago(1), type: 'tool.used', actor: { kind: 'agent', id: 'ses_work' }, scope: { sessionId: 'ses_work' }, meta: { toolName: 'Edit', fileChanging: true, ok: true }, hash: 'a'.repeat(64) },
  { seq: 118, id: 'evt_2', ts: ago(55), type: 'plan.amended', actor: { kind: 'human', id: 'usr_aisyah' }, scope: { sessionId: 'ses_work' }, meta: { manifestVersion: 2, added: 1, removed: 0 }, hash: 'b'.repeat(64) },
  { seq: 90, id: 'evt_1', ts: ago(150), type: 'drift.detected', actor: { kind: 'system', id: 'ledger' }, scope: { sessionId: 'ses_work' }, meta: { kind: 'off_plan_change', severity: 'medium' }, hash: 'c'.repeat(64) },
];

/** matchMedia that reports a phone-width viewport (≤640px). Returns a restore function. */
function stubPhoneWidth(): () => void {
  const previous = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width: 640px'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = previous;
  };
}

describe('SessionPage', () => {
  let session: SessionDetail;
  let posts: { url: string; body: unknown }[];
  let postStatus: number;
  let postBody: unknown;

  beforeEach(() => {
    FakeEventSource.reset();
    session = detail();
    posts = [];
    postStatus = 200;
    postBody = { ok: true };
    mockFetch((url, init) => {
      const path = url.split('?')[0]!;
      if (init.method === 'POST') {
        posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
        return jsonResponse(postBody, { status: postStatus });
      }
      const routes: Record<string, unknown> = {
        '/api/sessions/ses_work': session,
        '/api/sessions/ses_work/timeline': timeline(),
        '/api/sessions/ses_work/activity': activity(),
        '/api/sessions/ses_work/events': feed,
        '/api/metering/sessions/ses_work': metering(),
        '/api/ratecard': rateCard(),
        '/api/fx/status': { current: { rate: 4.215, status: 'live', sourceDate: '2026-10-09' } },
        '/api/registry/process-types': registry(),
        '/api/threads/thr_cx': thread(),
        '/api/sessions': [summary({ sessionId: 'ses_prev', title: 'Transcript pipeline', lifecycle: 'retired', liveness: null }), session],
        '/api/decisions': {
          generatedAt: iso(NOW),
          decisions: [
            decision({ id: 'dec_open', sessionId: 'ses_work', title: 'Merge summariser into main?', test: 'main', createdAt: ago(9) }),
            decision({
              id: 'dec_old',
              sessionId: 'ses_work',
              status: 'resolved',
              title: 'Store summaries as JSONB?',
              question: 'JSONB column on summaries, or a table of its own?',
              test: 'irreversible',
              options: [
                { id: 'jsonb', label: 'JSONB column' },
                { id: 'table', label: 'Own table' },
              ],
              recommendation: { optionId: 'jsonb', rationale: 'Fewer joins.' },
              createdAt: ago(240),
              ageMs: 22 * 60_000,
              resolution: {
                optionId: 'jsonb',
                resolvedBy: 'usr_aisyah',
                resolvedAt: ago(218),
                method: 'button',
                passkeyVerified: false,
                selfApproved: true,
                comment: null,
              },
              viewer: { canResolve: false, reason: 'not_open', canWithdraw: false, canEscalate: false },
            }),
          ],
        },
      };
      return path in routes
        ? jsonResponse(routes[path])
        : jsonResponse({ error: { code: 'not_found', message: 'Session not found' } }, { status: 404 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders the header, the timeline hero with its numbers, and the plan completion beneath', async () => {
    renderSession();
    expect(await screen.findByRole('heading', { level: 1, name: 'Add supervisor whisper suggestions' })).toBeInTheDocument();
    const badge = screen.getAllByRole('status').find((el) => el.textContent?.includes('Working'));
    expect(badge).toHaveTextContent('Working, for 12m');
    expect(screen.getByText('feature-build · execution')).toBeInTheDocument();

    const hero = await screen.findByRole('region', { name: 'Session timeline' });
    const chart = within(hero).getByRole('img', { name: /Session timeline from/ });
    expect(chart.getAttribute('aria-label')).toMatch(/P1 Design 1h 20m, P2 Build 5h \(in progress\)/);
    expect(chart.getAttribute('aria-label')).toMatch(/21 tool calls, peak 11 a minute/);
    const stat = (term: string) => within(hero).getByText(term, { selector: 'dt' }).nextElementSibling;
    expect(stat('Elapsed')).toHaveTextContent('6h 30m');
    expect(stat('Tool calls')).toHaveTextContent('21');
    expect(stat('Decisions')).toHaveTextContent('2 · 31m waiting, 1 open');
    expect(stat('Throttled')).toHaveTextContent('23m');
    const marks = within(hero).getByRole('group', { name: /Timeline marks/ });
    expect(within(marks).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      expect.stringMatching(/^Phase tag pinned: Phase complete: Design/),
      expect.stringMatching(/^Decision, test irreversible: Store summaries as JSONB\?, asked .*, JSONB column, after 22m$/),
      expect.stringMatching(/^Flagged task: Flagged close: t2, no file change/),
      expect.stringMatching(/^Drift: Change outside the plan, .*, medium severity$/),
      expect.stringMatching(/^Throttled 23m from .* to /),
      expect.stringMatching(/^Amendment: Manifest amended/),
      expect.stringMatching(/^Decision, test main: Merge summariser into main\?, asked .*, waiting 9m$/),
    ]);
    expect(within(hero).getByRole('img', { name: /Plan completion by phase: 42% of declared weight done, 2 of 4 tasks/ })).toBeInTheDocument();
    expect(within(hero).getByText(/Denominator changed .* \(amendment #1, weight 10 → 12\)/)).toBeInTheDocument();
  });

  it('lists the manifest with sizes, evidence, flagged closes and the audited amendment', async () => {
    renderSession();
    const manifest = await screen.findByRole('region', { name: 'Plan manifest' });
    expect(await within(manifest).findByText('1 task flagged')).toBeInTheDocument();
    const build = within(manifest).getByRole('table', { name: 'P2 Build tasks' });
    expect(within(build).getByText('Confidence badge on summary card')).toBeInTheDocument();
    expect(within(build).getByText(/Closed with no file-changing tool call/)).toBeInTheDocument();
    expect(within(build).getByText('9b07d3e')).toBeInTheDocument();
    expect(within(build).getByText('L')).toBeInTheDocument();
    expect(within(manifest).getByText(/Audited amendment #1/)).toBeInTheDocument();
    expect(within(manifest).getByText('denominator 3 → 4 tasks, weight 10 → 12')).toBeInTheDocument();
  });

  it('shows metering, decisions with who answered, lineage and the event log', async () => {
    renderSession();
    const meteringPanel = await screen.findByRole('region', { name: 'Metering' });
    expect((await within(meteringPanel).findAllByText('US$28.22')).length).toBeGreaterThan(0);
    expect(within(meteringPanel).getByText('RM 118.94')).toBeInTheDocument();
    expect(within(meteringPanel).getByRole('region', { name: 'Where the cost comes from' })).toHaveTextContent(/Cache write/);
    expect(within(meteringPanel).getByText(/Rate card v3 per MTok/)).toBeInTheDocument();

    const decisions = screen.getByRole('region', { name: 'Decisions' });
    expect(await within(decisions).findByRole('heading', { name: 'Merge summariser into main?' })).toBeInTheDocument();
    const log = within(decisions).getByRole('table', { name: 'Decisions this session raised' });
    expect(within(log).getByText('JSONB column (recommended)')).toBeInTheDocument();
    expect(within(log).getByText('JSONB column on summaries, or a table of its own?')).toBeInTheDocument();
    expect(within(log).getByText('Aisyah Rahman (you)')).toBeInTheDocument();

    const lineage = screen.getByRole('region', { name: 'Thread lineage' });
    const prev = await within(lineage).findAllByRole('link', { name: 'Transcript pipeline' });
    expect(prev[0]).toHaveAttribute('href', '/sessions/ses_prev');
    expect(lineage.querySelector('.session-lineage__thread')).toHaveTextContent('CX Copilot — main thread · session 2 of 2');

    const events = screen.getByRole('table', { name: 'Events for this session, newest first' });
    expect(within(events).getByText('Edit · file change')).toBeInTheDocument();
    expect(within(events).getByText('Change outside the plan · medium')).toBeInTheDocument();
  });

  it('nudges with the operator note and shows why other actions are off', async () => {
    const user = userEvent.setup();
    renderSession();
    const ops = await screen.findByRole('region', { name: 'Operator actions' });
    expect(within(ops).getByRole('button', { name: /Restart/ })).toBeDisabled();
    expect(within(ops).getByText(/is unavailable\. Not at a clean task boundary: t4 in progress\./)).toBeInTheDocument();
    await user.click(within(ops).getByRole('button', { name: /Nudge/ }));
    const dialog = screen.getByRole('dialog', { name: 'Nudge this session' });
    await user.click(within(dialog).getByRole('button', { name: 'Send nudge' }));
    expect(within(dialog).getByText('Write the note the agent should act on.')).toBeInTheDocument();
    expect(posts).toHaveLength(0);
    await user.type(within(dialog).getByRole('textbox'), 'Re-run the contract test first.');
    await user.click(within(dialog).getByRole('button', { name: 'Send nudge' }));
    await waitFor(() => expect(posts).toEqual([{ url: '/api/sessions/ses_work/nudge', body: { text: 'Re-run the contract test first.' } }]));
    expect(await screen.findByText('Nudge sent')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stops now or at the boundary, and surfaces server refusals in the dialog', async () => {
    const user = userEvent.setup();
    renderSession();
    const ops = await screen.findByRole('region', { name: 'Operator actions' });
    await user.click(within(ops).getByRole('button', { name: /Stop/ }));
    let dialog = screen.getByRole('dialog', { name: 'Stop this session' });
    await user.click(within(dialog).getByRole('radio', { name: /^Now/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Stop now' }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: '/api/sessions/ses_work/stop', body: { immediate: true } }));

    postStatus = 409;
    postBody = { error: { code: 'writer_locked', message: 'Thread busy', details: { holderSessionId: 'ses_other_writer01' } } };
    session = detail({ actions: { ...detail().actions, restart: { enabled: true, reason: null } } });
    act(() => {
      FakeEventSource.last.open();
      FakeEventSource.last.emit('aoc', { seq: 130, type: 'session.lifecycle_changed', ts: iso(NOW), scope: { sessionId: 'ses_work' }, meta: {} });
    });
    await waitFor(() => expect(within(ops).getByRole('button', { name: /Restart/ })).toBeEnabled());
    await user.click(within(ops).getByRole('button', { name: /Restart/ }));
    dialog = screen.getByRole('alertdialog', { name: 'Restart this session?' });
    await user.click(within(dialog).getByRole('button', { name: 'Restart' }));
    expect(await within(dialog).findByText(/Another session is this thread’s writer/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: '…iter01' })).toHaveAttribute('href', '/sessions/ses_other_writer01');
  });

  it('asks for a shorter first page of events on phones, where each event is a stacked card', async () => {
    const restore = stubPhoneWidth();
    try {
      renderSession();
      await screen.findByRole('table', { name: 'Events for this session, newest first' });
      const urls = vi.mocked(fetch).mock.calls.map(([u]) => String(u));
      expect(urls.filter((u) => u.startsWith('/api/sessions/ses_work/events?'))).toEqual(['/api/sessions/ses_work/events?limit=10']);
    } finally {
      restore();
    }
  });

  it('marks observed sessions read-only', async () => {
    const off = { enabled: false, reason: 'Observed sessions are read-only' };
    session = detail({ mode: 'observed', ownerId: null, ownerName: null, actions: { nudge: off, restart: off, stop: off, rollover: off, prompt: off } });
    renderSession();
    const ops = await screen.findByRole('region', { name: 'Operator actions' });
    expect(within(ops).getByText('Observed sessions are read-only.')).toBeInTheDocument();
    expect(within(ops).queryByRole('button')).toBeNull();
    expect(screen.getByText('Observed · read-only')).toBeInTheDocument();
  });

  it('says so when the session does not exist', async () => {
    renderSession('ses_missing');
    expect(await screen.findByRole('heading', { level: 1, name: 'Session not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the console' })).toHaveAttribute('href', '/console');
  });
});
