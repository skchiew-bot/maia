import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FxStatusDTO } from '@aoc/contracts';
import MeteringPage from '../../src/pages/metering/MeteringPage';
import {
  APPROVER,
  BUILDER,
  DAILY,
  FX_RATES,
  FX_STATUS,
  PROJECTS,
  RATE_CARD,
  SUBSCRIPTION,
  SUMMARIES,
  THROTTLE,
  VERSION_1,
  decision,
  failure,
  renderPage,
  routeFetch,
  type Call,
} from './fixtures';
import MIGRATION from './migration.json';

function routes(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/ratecard': RATE_CARD,
    'GET /api/ratecard/versions': { versions: [VERSION_1] },
    'GET /api/metering/daily': DAILY,
    'GET /api/metering/summary': (c: Call) => SUMMARIES[c.query.get('groupBy') ?? 'project'] ?? SUMMARIES.project,
    'GET /api/metering/throttle': THROTTLE,
    'GET /api/metering/subscription': SUBSCRIPTION,
    'GET /api/metering/migration': MIGRATION,
    'GET /api/fx/status': FX_STATUS,
    'GET /api/fx/rates': { from: DAILY.from, to: DAILY.to, rates: FX_RATES },
    'GET /api/decisions': { generatedAt: DAILY.generatedAt, decisions: [] },
    'GET /api/projects': PROJECTS,
    'GET /api/sessions': [],
    'GET /api/users': { users: [] },
    ...extra,
  };
}

const lastGet = (calls: Call[], path: string) => [...calls].reverse().find((c) => c.method === 'GET' && c.path === path);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Metering page', { timeout: 30_000 }, () => {
  it('labels cost as notional, keeps the subscription apart and stamps every day with its FX status', async () => {
    const { calls } = routeFetch(routes());
    renderPage(<MeteringPage />, APPROVER);

    const kpis = await screen.findByRole('list', { name: 'Metering at a glance' });
    await within(kpis).findByText('US$31.16');
    expect(kpis).toHaveTextContent('RM 131.95 · notional, not a bill');
    expect(kpis).toHaveTextContent('Subscription · actual');
    expect(kpis).toHaveTextContent('max · 5 seats, prorated per day');
    expect(kpis).toHaveTextContent('2.0 h');
    expect(kpis).toHaveTextContent('1 plan-limit hit · 0 throttled now');

    // Usage no rate priced is called out, never silently costed at zero.
    expect(screen.getByText('21.4M tokens (81%) are counted at US$0 — no rate priced them')).toBeInTheDocument();

    const rollups = screen.getByRole('table', { name: 'Daily rollups with FX stamps' });
    const oct3 = within(rollups).getByText('Sat Oct 3').closest('tr')!;
    expect(oct3).toHaveTextContent('inherited from Oct 2');
    const oct2 = within(rollups).getByText('Fri Oct 2').closest('tr')!;
    expect(oct2).toHaveTextContent('live');
    expect(oct2).toHaveTextContent('BNM session 1700');

    // FX: the session comes from the record and the fetch time from the daemon's config, never assumed.
    const fx = screen.getByRole('heading', { name: 'FX · USD→MYR' }).closest('section')!;
    const fact = (term: string) => within(fx).getByText(term, { selector: 'dt' }).nextElementSibling;
    expect(fact('BNM session')).toHaveTextContent('session 1700');
    expect(fact('Daily fetch')).toHaveTextContent('18:00 (daemon local time)');
    expect(fx).toHaveTextContent('Source: Bank Negara Malaysia');

    expect(screen.getByText('Forward only.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Schedule a new version' })).toBeInTheDocument();

    // The range ends on the daemon's day, not the browser's.
    const daily = lastGet(calls, '/api/metering/daily')!;
    expect(Object.fromEntries(daily.query)).toEqual({ from: '2026-09-10', to: '2026-10-09' });
  });

  it('schedules a rate-card version forward only, and refuses a past date before calling the daemon', async () => {
    const { calls } = routeFetch(
      routes({
        'PUT /api/ratecard': (c: Call) => ({ ...VERSION_1, version: 2, status: 'scheduled', effectiveFrom: (c.body as { effectiveFrom: string }).effectiveFrom }),
      }),
    );
    const user = userEvent.setup();
    renderPage(<MeteringPage />, APPROVER);

    await user.click(await screen.findByRole('button', { name: 'Schedule a new version' }));
    const dialog = await screen.findByRole('dialog', { name: 'Schedule a new rate-card version' });
    const date = within(dialog).getByLabelText(/Effective from/);
    expect(date).toHaveValue('2026-10-10');

    fireEvent.change(date, { target: { value: '2026-10-09' } });
    await user.click(within(dialog).getByRole('button', { name: 'Publish version' }));
    expect(within(dialog).getByText('Rate changes apply forward only: choose Sat Oct 10 or later.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);

    fireEvent.change(date, { target: { value: '2026-10-12' } });
    const haikuOutput = within(dialog).getByLabelText('Output price for claude-haiku-5-5');
    await user.clear(haikuOutput);
    await user.type(haikuOutput, '0.6');
    await user.click(within(dialog).getByRole('button', { name: 'Publish version' }));

    await screen.findByText('Rate card v2 scheduled');
    const put = calls.find((c) => c.method === 'PUT' && c.path === '/api/ratecard')!;
    expect(put.body).toEqual({
      effectiveFrom: '2026-10-12',
      rates: [
        { model: 'claude-opus-5-5', inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWrite5mPerMTok: 5, cacheWrite1hPerMTok: 8 },
        { model: 'claude-haiku-5-5', inputPerMTok: 0.1, outputPerMTok: 0.6, cacheReadPerMTok: 0.01, cacheWrite5mPerMTok: 0.125, cacheWrite1hPerMTok: 0.2 },
      ],
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows a Builder the rate card read-only and lets them narrow to their own sessions', async () => {
    const { calls } = routeFetch(routes());
    const user = userEvent.setup();
    renderPage(<MeteringPage />, BUILDER);

    expect(await screen.findByText('Only an Approver can change the rate card')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Schedule a new version' })).toBeNull();
    expect(calls.some((c) => c.path === '/api/users')).toBe(false);

    await user.click(within(screen.getByRole('radiogroup', { name: 'Scope' })).getByRole('radio', { name: 'My sessions' }));
    await waitFor(() => expect(lastGet(calls, '/api/metering/daily')!.query.get('mine')).toBe('1'));
    expect(lastGet(calls, '/api/metering/summary')!.query.get('mine')).toBe('1');
    expect(screen.queryByText('Subscription · actual')).toBeNull();
  });

  it('lists people by name, never ranked by cost', async () => {
    const { calls } = routeFetch(routes());
    const user = userEvent.setup();
    renderPage(<MeteringPage />, APPROVER);

    await screen.findByRole('list', { name: 'Notional cost by project' });
    await user.click(within(screen.getByRole('radiogroup', { name: 'Break down by' })).getByRole('radio', { name: 'Person' }));
    const people = await screen.findByRole('table', { name: 'Notional cost per person, in name order' });
    expect(within(people).getAllByRole('rowheader').map((th) => th.textContent)).toEqual(['Aisyah Rahman', 'Tan Wei Jie']);
    expect(screen.getByText(/Listed by name, never ranked/)).toBeInTheDocument();
    expect(lastGet(calls, '/api/metering/summary')!.query.get('groupBy')).toBe('actor');
  });

  it('warns after consecutive carried-forward weekdays and shows both figures of an open discrepancy', async () => {
    const status: FxStatusDTO = {
      ...FX_STATUS,
      current: { rate: 4.2427, status: 'inherited', sourceDate: '2026-10-02' },
      carryForward: { days: 3, since: '2026-10-07', alertAfterDays: 3, alerted: true },
      openDiscrepancy: {
        date: '2026-10-06',
        decisionId: 'dec_fx',
        scraped: 4.25,
        official: 4.2294,
        scrapedDate: '2026-10-06',
        officialDate: '2026-10-06',
        extractor: 'haiku',
        status: 'open',
        decisionStatus: 'open',
        raisedAt: '2026-10-06T10:05:00.000Z',
        resolvedAt: null,
        chosenRate: null,
        choice: null,
        applied: null,
      },
      openDiscrepancyCount: 1,
    };
    const ticket = decision({ id: 'dec_fx', kind: 'fx_discrepancy', title: 'FX discrepancy on Oct 6', subjectType: 'fx_day', subjectId: '2026-10-06' });
    routeFetch(routes({ 'GET /api/fx/status': status, 'GET /api/decisions': { generatedAt: DAILY.generatedAt, decisions: [ticket] } }));
    renderPage(<MeteringPage />, APPROVER);

    expect(await screen.findByText('FX carried forward 3 weekdays in a row: check BNM manually')).toBeInTheDocument();
    expect(screen.getByText(/Scraped/).closest('p')).toHaveTextContent('Scraped 4.2500 (haiku) vs BNM published 4.2294 · difference 0.0206');
    expect(screen.getByText('FX discrepancy on Oct 6')).toBeInTheDocument();
  });

  it('shows an error state when the rate card cannot load', async () => {
    routeFetch(routes({ 'GET /api/ratecard': () => failure(500, 'internal', 'Metering unavailable') }));
    renderPage(<MeteringPage />, APPROVER);
    const title = await screen.findByText("Couldn't load metering");
    expect(title.closest('[role="alert"]')).toHaveTextContent('Metering unavailable');
  });
});
