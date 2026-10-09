import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleSnapshot, DecisionListResponse, TowerSnapshot } from '@aoc/contracts';
import { AuthProvider, EventStreamProvider, type AuthUser } from '../../src/api';
import { ClockProvider, fixedClock, formatClock } from '../../src/components';
import ControlTowerPage from '../../src/pages/tower/ControlTowerPage';
import { FakeEventSource, FakeEventSourceCtor, jsonResponse, mockFetch } from '../helpers';
import { FIXTURE_IDS, FIXTURE_NOW, FIXTURE_USERS, makeOpenDecisions, makeTowerSnapshot } from './fixture';

const APPROVER: AuthUser = { id: FIXTURE_USERS.ceo.id, name: FIXTURE_USERS.ceo.name, role: 'approver', flags: {} };
const BUILDER: AuthUser = { id: FIXTURE_USERS.aisyah.id, name: FIXTURE_USERS.aisyah.name, role: 'builder', flags: {} };

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** In-memory daemon: serves the fixture and records writes; tests mutate `state` to move the world. */
function fakeDaemon() {
  const state: {
    tower: TowerSnapshot;
    decisions: DecisionListResponse;
    console: ConsoleSnapshot;
    towerStatus: number;
    fail: Record<string, { status: number; body: unknown }>;
  } = {
    tower: makeTowerSnapshot(),
    decisions: makeOpenDecisions(),
    console: { generatedAt: new Date(FIXTURE_NOW).toISOString(), kpis: {} as ConsoleSnapshot['kpis'], sessions: [] },
    towerStatus: 200,
    fail: {},
  };
  const calls: Call[] = [];
  const fetchMock = mockFetch((url, init) => {
    const u = new URL(url, 'http://aoc.test');
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname + u.search, body });
    const failure = state.fail[`${method} ${u.pathname}`];
    if (failure) return jsonResponse(failure.body, { status: failure.status });
    if (method === 'GET' && u.pathname === '/api/tower') {
      return state.towerStatus === 200
        ? jsonResponse(state.tower)
        : jsonResponse({ error: { code: 'x', message: 'Tower failed' } }, { status: state.towerStatus });
    }
    if (method === 'GET' && u.pathname === '/api/decisions') return jsonResponse(state.decisions);
    if (method === 'GET' && u.pathname === '/api/console') return jsonResponse(state.console);
    if (method === 'POST') return jsonResponse({ ok: true });
    return jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, { status: 404 });
  });
  const count = (method: string, path: string) =>
    calls.filter((c) => c.method === method && c.path.split('?')[0] === path).length;
  return { state, calls, fetchMock, count };
}

function Location() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname + l.search}</output>;
}

function renderTower(user: AuthUser = APPROVER) {
  return render(
    <MemoryRouter initialEntries={['/tower']}>
      <AuthProvider initialUser={user}>
        <ClockProvider clock={fixedClock(FIXTURE_NOW)}>
          <EventStreamProvider eventSource={FakeEventSourceCtor}>
            <Routes>
              <Route path="/tower" element={<ControlTowerPage />} />
              <Route path="*" element={<Location />} />
            </Routes>
          </EventStreamProvider>
        </ClockProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

let seq = 5000;
function emit(type: string, meta: Record<string, unknown> = {}) {
  seq += 1;
  act(() => FakeEventSource.last.emit('aoc', { seq, type, ts: new Date(FIXTURE_NOW).toISOString(), scope: {}, meta }));
  return seq;
}

/** Role queries over the whole page are slow in jsdom; rows are found by their title text instead. */
const rowOf = (title: string) => screen.getByText(title, { selector: '.tower-q__title a' }).closest('li')!;
const findRow = async (title: string) =>
  (await screen.findByText(title, { selector: '.tower-q__title a' })).closest('li')!;
const queue = () => screen.getByLabelText(/Attention queue, highest cost/);
const withoutItem = (snap: TowerSnapshot, id: string): TowerSnapshot => ({
  ...snap,
  attention: snap.attention.filter((a) => a.id !== id),
  kpis: { ...snap.kpis, needsYou: snap.kpis.needsYou - 1 },
});

// Full-page renders are heavy in jsdom; a generous budget keeps a parallel full-repo run from flaking.
describe('Control Tower page', { timeout: 30_000 }, () => {
  let daemon: ReturnType<typeof fakeDaemon>;

  beforeEach(() => {
    FakeEventSource.reset();
    daemon = fakeDaemon();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders every section with its numbers as text', async () => {
    renderTower();
    expect(screen.getByRole('heading', { level: 1, name: 'Control Tower' })).toBeInTheDocument();
    expect(await screen.findByText(/led by two passkey gates/)).toBeInTheDocument();
    expect(screen.getByText('12 items need you')).toContainHTML('b');

    const kpis = screen.getByLabelText('Operation at a glance');
    expect(within(kpis).getByRole('group', { name: 'Needs you' })).toHaveTextContent('12items');
    expect(within(kpis).getByRole('group', { name: 'Flow · verified tasks today' })).toHaveTextContent('+18%');
    expect(within(kpis).getByRole('group', { name: 'Human gate latency' })).toHaveTextContent('31m');
    expect(within(kpis).getByRole('group', { name: 'Customer waiting' })).toHaveTextContent('oldest 3d 2h in UAT');
    expect(within(kpis).getByRole('group', { name: 'Integrity' })).toHaveTextContent('Verified');

    // The queue: ranked by cost of delay, 11 rows visible, the lowest-cost item folded.
    const rows = within(queue()).getAllByRole('listitem');
    expect(rows).toHaveLength(11);
    expect(rows[0]).toHaveTextContent('Rank 1');
    expect(rows[0]).toHaveTextContent('Roll claims-intake main back to p1-done (7c2e9d1)');
    expect(rows[0]).toHaveTextContent('Rollback gate · 47m · INC-0093 open');
    expect(rows[0]).toHaveTextContent('Cost of delay 94 of 100');
    expect(rows[0]).toHaveTextContent('Critical');
    expect(screen.getByText('Show 1 lower-cost item')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Attention queue/ })).toHaveTextContent('12');

    // Fleet health: liveness as badges with counts, never a chart.
    const fleet = screen.getByLabelText('Live sessions by liveness');
    expect(within(fleet).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Waiting on you2',
      'Throttled1',
      'Dead1',
      'Stalled1',
      'Thinking1',
      'Working2',
    ]);
    expect(screen.getByText('8 live sessions · 5 ended today')).toBeInTheDocument();

    // Flow: the bottleneck stage says so in words; latency prints p50/p90/SLA.
    const uat = screen.getByRole('rowheader', { name: /UAT/ });
    expect(uat).toHaveTextContent('work waits here');
    expect(screen.getByRole('img', { name: /Rollback: p50 12m, p90 41m, SLA 30m, 2 breaches/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Tasks done per hour, 02:00 to 13:00/ })).toBeInTheDocument();

    // Spend: notional USD with RM alongside.
    expect(screen.getByText('US$152.38')).toBeInTheDocument();
    expect(screen.getByText('RM 642.27')).toBeInTheDocument();
    expect(screen.getAllByText('notional').length).toBeGreaterThan(0);
    expect(screen.getByText(/Capacity planning, not a ranking/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Tan Wei Jie: US\$3\.10 left at US\$21\.00 a day; caps today/ })).toBeInTheDocument();

    // Integrity and the radar (portfolio scopes only).
    expect(screen.getByText('Provisional')).toBeInTheDocument();
    expect(screen.getByText('1 blocked')).toBeInTheDocument();
    const radar = screen.getByRole('heading', { name: 'Gaming and anomaly radar' }).closest('section')!;
    expect(within(radar).getAllByRole('img')).toHaveLength(7);
    expect(within(radar).getByRole('img', { name: /Blind affirm-without-edit: 31%, 1\.7× the baseline of 18%; status alert/ })).toBeInTheDocument();
    expect(radar).toHaveTextContent('never ranked per person');
  });

  it('approves with the recommended option, shows it optimistically, and reconciles on the stream', async () => {
    const user = userEvent.setup();
    renderTower();
    const title = 'Merge the retry-dedupe fix to main?';
    await findRow(title);
    await waitFor(() => expect(daemon.count('GET', '/api/decisions')).toBe(1));
    act(() => FakeEventSource.last.open());

    await user.click(within(rowOf(title)).getByRole('button', { name: 'Approve' }));
    const panel = within(rowOf(title)).getByRole('group');
    expect(panel).toHaveTextContent('applies Hold for UAT first — the recommended option.');
    expect(panel).toHaveTextContent('Agent recommendation based on blast radius and reversibility.');
    expect(within(panel).getByRole('button', { name: 'Confirm approval' })).toHaveFocus();
    await user.type(within(panel).getByLabelText('Comment (optional)'), 'Hold it for UAT, then ship.');
    await user.click(within(panel).getByRole('button', { name: 'Confirm approval' }));

    await waitFor(() =>
      expect(daemon.calls.find((c) => c.method === 'POST')).toEqual({
        method: 'POST',
        path: `/api/decisions/${FIXTURE_IDS.mainMerge}/resolve`,
        body: { optionId: 'uat', comment: 'Hold it for UAT, then ship.' },
      }),
    );
    const status = await within(rowOf(title)).findByRole('status');
    expect(status).toHaveTextContent('Approved · Hold for UAT first');
    expect(status).toHaveTextContent('waiting for the audit log');
    expect(screen.getByRole('heading', { name: /Attention queue/ })).toHaveTextContent('11');

    // The event confirms it; the refetched snapshot no longer lists the item, so the row goes.
    daemon.state.tower = withoutItem(daemon.state.tower, `decision:${FIXTURE_IDS.mainMerge}`);
    const s = emit('decision.resolved', { decisionId: FIXTURE_IDS.mainMerge, optionId: 'uat' });
    await waitFor(() => expect(screen.queryByText(title, { selector: '.tower-q__title a' })).not.toBeInTheDocument());
    expect(s).toBeGreaterThan(0);
    expect(daemon.count('GET', '/api/tower')).toBe(2);
  });

  it('denies with the explicit refusal option', async () => {
    const user = userEvent.setup();
    renderTower();
    const title = 'Tan Wei Jie at credit cap; US$100 top-up pending';
    await findRow(title);
    await waitFor(() => expect(daemon.count('GET', '/api/decisions')).toBe(1));
    const row = rowOf(title);
    expect(within(row).getByRole('button', { name: 'Approve top-up' })).toBeEnabled();
    await user.click(await within(row).findByRole('button', { name: 'Deny' }));
    expect(within(row).getByRole('group')).toHaveTextContent('applies Deny.');
    await user.click(within(row).getByRole('button', { name: 'Confirm denial' }));
    await waitFor(() =>
      expect(daemon.calls.find((c) => c.method === 'POST')).toMatchObject({
        path: `/api/decisions/${FIXTURE_IDS.topup}/resolve`,
        body: { optionId: 'deny', comment: null },
      }),
    );
    expect(await within(rowOf(title)).findByRole('status')).toHaveTextContent('Denied · Deny');
  });

  it('sends passkey gates to the Decisions page, focused on the card', async () => {
    const user = userEvent.setup();
    renderTower();
    const row = await findRow('Promote CX Copilot v1.4.0 to production');
    const link = within(row).getByRole('link', { name: 'Approve with passkey' });
    expect(link).toHaveAttribute('href', `/decisions?focus=${FIXTURE_IDS.goLive}`);
    expect(within(row).getByText('passkey')).toBeInTheDocument();
    await user.click(link);
    expect(screen.getByTestId('location')).toHaveTextContent(`/decisions?focus=${FIXTURE_IDS.goLive}`);
    expect(daemon.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('restarts a dead session through the supervisor and waits for it to report back', async () => {
    const user = userEvent.setup();
    renderTower();
    const title = 'Rollback-runbook docs session exited with code 143';
    await findRow(title);
    act(() => FakeEventSource.last.open());
    expect(within(rowOf(title)).getByText('Dead')).toBeInTheDocument();

    await user.click(within(rowOf(title)).getByRole('button', { name: 'Restart' }));
    await waitFor(() =>
      expect(daemon.calls.find((c) => c.method === 'POST')).toEqual({
        method: 'POST',
        path: `/api/sessions/${FIXTURE_IDS.deadSession}/restart`,
        body: undefined,
      }),
    );
    expect(await within(rowOf(title)).findByRole('status')).toHaveTextContent('Restart requested');

    const s = emit('session.restarted', { sessionId: FIXTURE_IDS.deadSession });
    await waitFor(() =>
      expect(within(rowOf(title)).getByRole('status')).toHaveTextContent(
        `waiting for the session to report back · event #${s}`,
      ),
    );
    // Its liveness moves on; the next snapshot drops the row.
    daemon.state.tower = withoutItem(daemon.state.tower, `session_dead:${FIXTURE_IDS.deadSession}`);
    emit('session.liveness_changed', { sessionId: FIXTURE_IDS.deadSession, from: 'dead', to: 'working' });
    await waitFor(() => expect(screen.queryByText(title, { selector: '.tower-q__title a' })).not.toBeInTheDocument(), {
      timeout: 3000,
    });
  });

  it('nudges a stalled session with a required note', async () => {
    const user = userEvent.setup();
    renderTower();
    const title = 'Partitioned-table migration has produced no output';
    await findRow(title);
    await user.click(within(rowOf(title)).getByRole('button', { name: 'Nudge…' }));
    const box = within(rowOf(title)).getByLabelText(/Note for the session/);
    expect(box).toHaveFocus();
    await user.click(within(rowOf(title)).getByRole('button', { name: 'Send nudge' }));
    expect(within(rowOf(title)).getByText('Write a short note for the session.')).toBeInTheDocument();
    expect(daemon.calls.some((c) => c.method === 'POST')).toBe(false);

    await user.type(box, 'Check the migration lock, then continue.');
    await user.click(within(rowOf(title)).getByRole('button', { name: 'Send nudge' }));
    await waitFor(() =>
      expect(daemon.calls.find((c) => c.method === 'POST')).toEqual({
        method: 'POST',
        path: `/api/sessions/${FIXTURE_IDS.stalledSession}/nudge`,
        body: { text: 'Check the migration lock, then continue.' },
      }),
    );
    expect(await within(rowOf(title)).findByRole('status')).toHaveTextContent('Nudge sent');
  });

  it('closes an action panel with Escape and returns focus to its button', async () => {
    const user = userEvent.setup();
    renderTower();
    const title = 'Bind lesson: guard required env vars';
    await user.click(await screen.findByText('Show 1 lower-cost item'));
    await waitFor(() => expect(daemon.count('GET', '/api/decisions')).toBe(1));
    const approve = within(rowOf(title)).getByRole('button', { name: 'Approve' });
    await user.click(approve);
    expect(approve).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(within(rowOf(title)).queryByRole('group')).not.toBeInTheDocument();
    expect(approve).toHaveFocus();
  });

  it('shows why a refused action failed and keeps the row actionable', async () => {
    const user = userEvent.setup();
    daemon.state.fail[`POST /api/sessions/${FIXTURE_IDS.deadSession}/restart`] = {
      status: 409,
      body: { error: { code: 'writer_locked', message: 'Thread already has an active writer session' } },
    };
    renderTower();
    const title = 'Rollback-runbook docs session exited with code 143';
    await findRow(title);
    await user.click(within(rowOf(title)).getByRole('button', { name: 'Restart' }));
    const alert = await within(rowOf(title)).findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't restart the session");
    expect(alert).toHaveTextContent('Thread already has an active writer session (HTTP 409 · writer_locked)');
    expect(within(rowOf(title)).getByRole('button', { name: 'Restart' })).toBeEnabled();
    await user.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(within(rowOf(title)).queryByRole('alert')).not.toBeInTheDocument();
  });

  it("tells a Builder what they can't do and why (the server still enforces)", async () => {
    daemon.state.decisions = {
      ...daemon.state.decisions,
      decisions: daemon.state.decisions.decisions.map((d) => ({
        ...d,
        viewer: { canResolve: false, reason: 'role', canWithdraw: false, canEscalate: false },
      })),
    };
    daemon.state.console = {
      ...daemon.state.console,
      sessions: [
        { sessionId: FIXTURE_IDS.deadSession, ownerId: FIXTURE_USERS.priya.id },
        { sessionId: FIXTURE_IDS.stalledSession, ownerId: FIXTURE_USERS.aisyah.id },
      ] as ConsoleSnapshot['sessions'],
    };
    renderTower(BUILDER);
    const merge = 'Merge the retry-dedupe fix to main?';
    await findRow(merge);
    await waitFor(() => expect(within(rowOf(merge)).getByRole('button', { name: 'Approve' })).toBeDisabled());
    expect(rowOf(merge)).toHaveTextContent('Needs the Approver role');
    expect(within(rowOf('Promote CX Copilot v1.4.0 to production')).getByRole('link', { name: 'Open' })).toBeInTheDocument();

    const dead = 'Rollback-runbook docs session exited with code 143';
    await waitFor(() => expect(within(rowOf(dead)).getByRole('button', { name: 'Restart' })).toBeDisabled());
    expect(rowOf(dead)).toHaveTextContent('Only its owner or an Approver can drive this session');
    // Aisyah owns the stalled migration session, so she may nudge it.
    expect(within(rowOf('Partitioned-table migration has produced no output')).getByRole('button', { name: 'Nudge…' })).toBeEnabled();
  });

  it('refreshes from the stream with coalescing and ignores telemetry', async () => {
    renderTower();
    await screen.findByText(/led by two passkey gates/);
    expect(daemon.count('GET', '/api/tower')).toBe(1);
    act(() => FakeEventSource.last.open());

    emit('tool.used', { sessionId: 's1' });
    emit('usage.recorded', { sessionId: 's1' });
    emit('session.turn_started', { sessionId: 's1' });
    await new Promise((r) => setTimeout(r, 250));
    expect(daemon.count('GET', '/api/tower')).toBe(1);

    emit('session.liveness_changed', { sessionId: 's1' });
    emit('credit.cap_reached', { userId: 'u1' });
    emit('anchor.created', {});
    await waitFor(() => expect(daemon.count('GET', '/api/tower')).toBe(2));
    await new Promise((r) => setTimeout(r, 250));
    expect(daemon.count('GET', '/api/tower')).toBe(2);
  });

  it('holds its frame while loading, then shows an empty queue plainly', async () => {
    daemon.state.tower = { ...daemon.state.tower, attention: [], kpis: { ...daemon.state.tower.kpis, needsYou: 0 } };
    renderTower();
    expect(screen.getByRole('status')).toHaveTextContent('Loading the Control Tower…');
    expect(await screen.findByText('Nothing needs you right now')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Attention queue, highest cost/)).not.toBeInTheDocument();
  });

  it('shows a retryable error when the first load fails', async () => {
    const user = userEvent.setup();
    daemon.state.towerStatus = 500;
    renderTower();
    expect(await screen.findByText("Couldn't load the Control Tower")).toBeInTheDocument();
    daemon.state.towerStatus = 200;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/led by two passkey gates/)).toBeInTheDocument();
  });

  it('is role-aware when the server refuses the snapshot', async () => {
    daemon.state.towerStatus = 403;
    renderTower(BUILDER);
    expect(await screen.findByText('The Control Tower is not available for your role')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the Console' })).toHaveAttribute('href', '/console');
  });

  it('counts down open break-glass records and flags a late off-host anchor', async () => {
    const HOUR = 3_600_000;
    const snap = daemon.state.tower;
    daemon.state.tower = {
      ...snap,
      attention: [
        ...snap.attention,
        {
          id: 'breakglass_open:bg_77',
          kind: 'breakglass_open',
          severity: 'high',
          title: 'Break-glass promotion of claims hotfix 7f3a',
          detail: null,
          projectId: 'prj_claims',
          projectName: 'Claims Intake Bot',
          since: new Date(FIXTURE_NOW - 4 * HOUR).toISOString(),
          ageMs: 4 * HOUR,
          costOfDelay: { score: 60, basis: 'Break-glass · 4h · post-incident record due' },
          action: { kind: 'open', label: 'Open', href: '/changes/bg_77' },
          chips: ['break-glass'],
        },
      ],
      kpis: { ...snap.kpis, anchorAgeMs: 27 * HOUR },
      integrity: {
        ...snap.integrity,
        breakglassOpen: 1,
        lastAnchorAt: new Date(FIXTURE_NOW - 27 * HOUR).toISOString(),
        anchorAgeMs: 27 * HOUR,
      },
    };
    renderTower();
    const integrity = (await screen.findByText('Integrity and governance')).closest('section')!;
    expect(integrity).toHaveTextContent('Break-glass promotion of claims hotfix 7f3a · post-incident record due in 20h');
    expect(integrity).toHaveTextContent('1d 3h old');
    expect(integrity).toHaveTextContent('Nightly anchor missed');
    expect(within(screen.getByLabelText('Operation at a glance')).getByRole('group', { name: 'Integrity' })).toHaveTextContent(
      'over 26 h',
    );
  });

  it('applies the server-recommended option even when the decision card is unavailable', async () => {
    const user = userEvent.setup();
    const snap = daemon.state.tower;
    daemon.state.tower = {
      ...snap,
      attention: snap.attention.map((a) =>
        a.action.decisionId === FIXTURE_IDS.nric ? { ...a, action: { ...a.action, recommendedOptionId: 'ingest' } } : a,
      ),
    };
    daemon.state.fail['GET /api/decisions'] = { status: 500, body: { error: { code: 'boom', message: 'Down' } } };
    renderTower();
    const nric = 'Mask NRIC numbers at ingest, or on screen only';
    await findRow(nric);
    await waitFor(() => expect(daemon.count('GET', '/api/decisions')).toBe(1));
    await user.click(within(rowOf(nric)).getByRole('button', { name: 'Approve' }));
    expect(within(rowOf(nric)).getByRole('group')).toHaveTextContent('applies the recommended option.');
    await user.click(within(rowOf(nric)).getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() =>
      expect(daemon.calls.find((c) => c.method === 'POST')).toMatchObject({
        path: `/api/decisions/${FIXTURE_IDS.nric}/resolve`,
        body: { optionId: 'ingest', comment: null },
      }),
    );

    // A row without a server-named option cannot be approved inline while the cards are down.
    const merge = 'Merge the retry-dedupe fix to main?';
    await user.click(within(rowOf(merge)).getByRole('button', { name: 'Approve' }));
    expect(rowOf(merge)).toHaveTextContent('The decision could not be loaded here. Open it on the Decisions page');
  });

  it('keeps the last snapshot, labelled, when a refresh fails', async () => {
    renderTower();
    await screen.findByText(/led by two passkey gates/);
    act(() => FakeEventSource.last.open());
    daemon.state.towerStatus = 500;
    emit('decision.requested', { decisionId: 'dec_new' });
    expect(
      await screen.findByText(`Showing the snapshot from ${formatClock(FIXTURE_NOW)}`, {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Roll claims-intake main back to p1-done (7c2e9d1)')).toBeInTheDocument();
  });
});
