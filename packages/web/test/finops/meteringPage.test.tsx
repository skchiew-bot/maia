import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CostPerOutcomeDTO, FxStatusDTO } from '@aoc/contracts';
import { formatMyr } from '../../src/lib/format';
import MeteringPage from '../../src/pages/metering/MeteringPage';
import {
  APPROVER,
  BUILDER,
  DAILY,
  FX_RATES,
  FX_STATUS,
  NO_OUTCOMES,
  OUTCOMES,
  OUTCOMES_RM_GAP,
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
  streamEvent,
  type Call,
} from './fixtures';
import MIGRATION from './migration.json';

const OUTCOMES_ROUTE = 'GET /api/metering/cost-per-outcome';
const OUTCOMES_PATH = '/api/metering/cost-per-outcome';
/** The page's text for a ringgit figure of the daemon's. formatMyr joins RM and the figure with a no-break space; DOM text is matched with plain ones. */
const plain = (s: string | null) => (s ?? '').replace(/\u00a0/g, ' ');
const rm = (myr: number) => plain(formatMyr(myr));

function routes(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/ratecard': RATE_CARD,
    'GET /api/ratecard/versions': { versions: [VERSION_1] },
    'GET /api/metering/daily': DAILY,
    [OUTCOMES_ROUTE]: OUTCOMES,
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
      current: { rate: 4.2427, status: 'inherited', sourceDate: '2026-10-02', session: null },
      carryForward: { days: 3, since: '2026-10-07', alertAfterDays: 3, alerted: true },
      openDiscrepancy: {
        date: '2026-10-06',
        decisionId: 'dec_fx',
        bnmSession: '1700',
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

describe('Cost per outcome', { timeout: 30_000 }, () => {
  const outcomesWidget = () => screen.findByRole('region', { name: 'Cost per outcome' });

  it('shows range marks per kind with every number as text: notional US$ with the daemon’s RM beside it', async () => {
    const { calls } = routeFetch(routes());
    renderPage(<MeteringPage />, APPROVER);
    const widget = await outcomesWidget();

    expect(
      await within(widget).findByText('Portfolio lens only — spend per outcome, never a ranking of individuals.'),
    ).toBeInTheDocument();
    const kinds = within(widget).getByRole('list', { name: 'Notional cost per outcome, by kind' });
    const [tickets, changes, phases] = within(kinds).getAllByRole('listitem') as [HTMLElement, HTMLElement, HTMLElement];
    const figure = (row: HTMLElement, term: string) => within(row).getByText(term).nextElementSibling;

    expect(tickets).toHaveTextContent('Tickets fixed');
    // Each RM is the daemon's own (usage days at their stamped rates), printed as served: no US$ here times any rate.
    expect(tickets).toHaveTextContent('2 outcomes · US$34.00 total');
    expect(tickets).toHaveTextContent(rm(143.7432));
    expect(figure(tickets, 'Median')).toHaveTextContent(`US$17.00 ${rm(71.8716)}`);
    expect(figure(tickets, 'p90')).toHaveTextContent(`US$19.40 ${rm(82.04472)}`);
    expect(figure(tickets, 'Range')).toHaveTextContent(`US$14.00 – US$20.00 ${rm(59.1552)} – ${rm(84.588)}`);
    expect(within(tickets).queryByText(/unpriced/)).toBeNull();
    expect(within(tickets).queryByText(/RM incomplete/)).toBeNull();

    expect(changes).toHaveTextContent('Changes shipped');
    expect(changes).toHaveTextContent(rm(89.0834));
    expect(figure(changes, 'Median')).toHaveTextContent(`US$10.50 ${rm(44.5417)}`);
    expect(figure(changes, 'p90')).toHaveTextContent(`US$18.10 ${rm(76.79154)}`);
    expect(figure(changes, 'Range')).toHaveTextContent(`US$1.00 – US$20.00 ${rm(4.2294)} – ${rm(84.854)}`);

    // Usage no rate priced is counted at US$0, so the cost is understated: said on the row, never hidden.
    expect(phases).toHaveTextContent('Phases completed');
    expect(phases).toHaveTextContent('3 outcomes · US$34.82 total');
    expect(phases).toHaveTextContent(rm(147.437813));
    expect(figure(phases, 'Median')).toHaveTextContent(`US$8.80 ${rm(37.222294)}`);
    expect(figure(phases, 'p90')).toHaveTextContent(`US$20.11 ${rm(85.14918)}`);
    expect(figure(phases, 'Range')).toHaveTextContent(`US$3.08 – US$22.93 ${rm(13.084618)} – ${rm(97.130901)}`);
    expect(phases).toHaveTextContent('3 of 3 include unpriced usage');

    // One scale for the three kinds. Nothing says RM is estimated, and the footnote says who converts it.
    expect(widget).toHaveTextContent('one scale: US$0 to US$30');
    expect(widget).not.toHaveTextContent('≈');
    expect(widget).not.toHaveTextContent('indicative');
    expect(widget).toHaveTextContent('Ringgit is converted by the daemon, usage day by usage day, at that day\'s stamped BNM rate.');
    expect(widget).toHaveTextContent('Unpriced usage counts as US$0, so 3 of these outcomes cost more than shown.');

    // The range is the page's, and a portfolio lens never asks the daemon for a per-person cut.
    const asked = calls.find((c) => c.path === OUTCOMES_PATH)!;
    expect(Object.fromEntries(asked.query)).toEqual({ from: '2026-09-10', to: '2026-10-09' });
  });

  it('lists the outcomes newest first, each opening the ticket, change or project phase it names, never sorted by cost', async () => {
    routeFetch(routes());
    renderPage(<MeteringPage />, APPROVER);
    const widget = await outcomesWidget();
    const table = await within(widget).findByRole('table', {
      name: 'Outcomes completed in this range, newest first',
    });
    const links = within(table).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/changes/chg_01M4FDC0CVARB5BHJ5HX4BB3RC',
      '/tickets/tkt_01M4FC3GS5VXC370PY64VM0XE9',
      '/tickets/tkt_01M4FC3GS5VXC370PY64VM0XE8',
      '/changes/chg_01M4FDBZYA4VBEQ8CKEK7FP42E',
      '/projects/prj_aoc#prj-mt-phase-build',
      '/projects/prj_claims#prj-mt-phase-build',
      '/projects/prj_claims#prj-mt-phase-design',
    ]);
    const phase = links.find((a) => a.getAttribute('href') === '/projects/prj_aoc#prj-mt-phase-build')!.closest('tr')!;
    expect(phase).toHaveTextContent('Phase completed');
    expect(phase).toHaveTextContent('AOC Platform');
    expect(phase).toHaveTextContent(`US$22.93${rm(97.130901)}`);
    expect(phase).toHaveTextContent('unpriced');
    expect(phase.querySelector('[data-label="Process type"]')).toHaveTextContent('feature-build');
    expect(phase.querySelector('[data-label="Sessions"]')).toHaveTextContent('9');
    const ticket = links.find((a) => a.getAttribute('href') === '/tickets/tkt_01M4FC3GS5VXC370PY64VM0XE8')!.closest('tr')!;
    expect(ticket).toHaveTextContent(`US$14.00${rm(59.1552)}`);
    expect(ticket.querySelector('[data-label="Process type"]')).toHaveTextContent('bug-fix');
    // A change that spanned projects says so rather than naming one, and so does one with no single process type.
    const mixed = within(table).getByRole('link', { name: /chg_…4BB3RC/ }).closest('tr')!;
    expect(mixed).toHaveTextContent('Several projects');
    expect(mixed.querySelector('[data-label="Process type"]')).toHaveTextContent('Mixed or unknown');
    expect(mixed).toHaveTextContent(`US$1.00${rm(4.2294)}`);
    // No column sorts, so the list cannot become a cost leaderboard (and a phone has no sort menu to offer).
    expect(within(table).queryAllByRole('button')).toEqual([]);
    expect(within(widget).queryByRole('combobox', { name: 'Sort' })).toBeNull();
    // Seven outcomes are all shown.
    expect(within(widget).queryByRole('button', { name: /Show all/ })).toBeNull();
  });

  it('shows the newest ten outcomes and the rest on request', async () => {
    const many = {
      ...OUTCOMES,
      phasesCompleted: {
        ...OUTCOMES.phasesCompleted,
        items: Array.from({ length: 12 }, (_, i) => ({
          ...OUTCOMES.phasesCompleted.items[0]!,
          refId: `prj_aoc/phase${i + 1}`,
          projectId: 'prj_aoc',
          completedAt: new Date(Date.parse('2026-09-20T00:00:00.000Z') + i * 3_600_000).toISOString(),
        })),
      },
    };
    routeFetch(routes({ [OUTCOMES_ROUTE]: many }));
    const user = userEvent.setup();
    renderPage(<MeteringPage />, APPROVER);
    const widget = await outcomesWidget();
    const table = await within(widget).findByRole('table', { name: 'Outcomes completed in this range, newest first' });
    // 2 tickets + 2 changes + 12 phases = 16 outcomes: the newest ten.
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 10);
    expect(within(table).getAllByRole('link')[0]).toHaveAttribute('href', '/changes/chg_01M4FDC0CVARB5BHJ5HX4BB3RC');
    await user.click(within(widget).getByRole('button', { name: 'Show all 16 outcomes' }));
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 16);
    await user.click(within(widget).getByRole('button', { name: 'Show the newest 10' }));
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 10);
  });

  it('groups the same figures by project in name order, never by cost', async () => {
    routeFetch(routes());
    const user = userEvent.setup();
    renderPage(<MeteringPage />, APPROVER);
    const widget = await outcomesWidget();
    await user.click(
      within(await within(widget).findByRole('radiogroup', { name: 'Outcome view' })).getByRole('radio', {
        name: 'By project',
      }),
    );
    const table = await within(widget).findByRole('table', { name: /per project and kind, in project name order/ });
    const rows = within(table).getAllByRole('row').slice(1);
    const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map((c) => plain(c.textContent));
    expect(rows.map((r) => cells(r)[0])).toEqual(['AOC Platform', 'Claims Intake Bot', 'Several projects']);
    // Each RM is a sum or median of the daemon's per-outcome RM (never a US$ times a rate).
    expect(cells(rows[0]!).slice(1)).toEqual(['—', '—', `US$22.93median of 1 · ${rm(97.130901)}`, `US$22.93${rm(97.130901)}`]);
    expect(cells(rows[1]!).slice(1)).toEqual([
      `US$17.00median of 2 · ${rm(71.8716)}`,
      `US$20.00median of 1 · ${rm(84.854)}`,
      `US$5.94median of 2 · ${rm((13.084618 + 37.222294) / 2)}`,
      `US$65.88${rm(143.7432 + 84.854 + 13.084618 + 37.222294)}`,
    ]);
    expect(cells(rows[2]!).slice(1, 3)).toEqual(['—', `US$1.00median of 1 · ${rm(4.2294)}`]);
    expect(within(within(table).getAllByRole('row')[0]!).queryByRole('button')).toBeNull();
  });

  it('says what produces outcomes when none completed in the range', async () => {
    routeFetch(routes({ [OUTCOMES_ROUTE]: NO_OUTCOMES }));
    renderPage(<MeteringPage />, APPROVER);
    const widget = await outcomesWidget();
    expect(await within(widget).findByText('No outcomes completed in this range')).toBeInTheDocument();
    expect(widget).toHaveTextContent(
      'appears once a ticket is closed as fixed, a change request completes or a project phase completes',
    );
    expect(within(widget).queryByRole('radiogroup', { name: 'Outcome view' })).toBeNull();
    expect(within(widget).queryByRole('list', { name: 'Notional cost per outcome, by kind' })).toBeNull();
  });

  it('keeps an empty kind in its row, and one outcome reads as one figure', async () => {
    const one = {
      ...NO_OUTCOMES,
      phasesCompleted: {
        kind: 'phase_completed' as const,
        stats: {
          ...NO_OUTCOMES.phasesCompleted.stats,
          count: 1,
          totalUsd: 12,
          meanUsd: 12,
          medianUsd: 12,
          p90Usd: 12,
          minUsd: 12,
          maxUsd: 12,
          totalRm: 50.4,
          meanRm: 50.4,
          medianRm: 50.4,
          p90Rm: 50.4,
          minRm: 50.4,
          maxRm: 50.4,
        },
        items: [OUTCOMES.phasesCompleted.items[0]!].map((i) => ({
          ...i,
          notionalUsd: 12,
          notionalRm: 50.4,
          unpriced: false,
        })),
      },
    };
    routeFetch(routes({ [OUTCOMES_ROUTE]: one }));
    renderPage(<MeteringPage />, APPROVER);
    const widget = await outcomesWidget();
    const kinds = await within(widget).findByRole('list', { name: 'Notional cost per outcome, by kind' });
    const [tickets, , phases] = within(kinds).getAllByRole('listitem');
    expect(tickets).toHaveTextContent('None in this range');
    expect(tickets).toHaveTextContent('No ticket was closed as fixed in this range.');
    expect(phases).toHaveTextContent('1 outcome · US$12.00 total');
    expect(phases).toHaveTextContent(rm(50.4));
    expect(within(phases!).getByText('Cost').nextElementSibling).toHaveTextContent(`US$12.00 ${rm(50.4)}`);
    expect(within(phases!).queryByText('Range')).toBeNull();
    // One process type is nothing to choose between: no chips.
    expect(within(widget).queryByRole('group', { name: 'Filter outcomes by process type' })).toBeNull();
  });

  it('says it could not load, with the reason, and retries on request', async () => {
    let fail = true;
    const { count } = routeFetch(
      routes({ [OUTCOMES_ROUTE]: () => (fail ? failure(500, 'internal', 'Outcome model is rebuilding') : OUTCOMES) }),
    );
    const user = userEvent.setup();
    renderPage(<MeteringPage />, APPROVER);
    const widget = await outcomesWidget();
    const alert = await within(widget).findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load cost per outcome");
    expect(alert).toHaveTextContent('Outcome model is rebuilding');
    // The rest of the page does not wait for it.
    expect(screen.getByRole('list', { name: 'Metering at a glance' })).toBeInTheDocument();

    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await within(widget).findByText('Tickets fixed')).toBeInTheDocument();
    expect(count('GET', OUTCOMES_PATH)).toBe(2);
  });

  it('says a role without team metering cannot see it, and offers no retry', async () => {
    routeFetch(
      routes({
        [OUTCOMES_ROUTE]: () => failure(403, 'forbidden', 'Org-wide metering needs audit.view or credit.view_all'),
      }),
    );
    renderPage(<MeteringPage />, BUILDER);
    const widget = await outcomesWidget();
    expect(await within(widget).findByText('Not available for your role')).toBeInTheDocument();
    expect(widget).toHaveTextContent('needs permission to view the team');
    expect(within(widget).queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(within(widget).queryByRole('alert')).toBeNull();
    expect(screen.getByRole('list', { name: 'Metering at a glance' })).toBeInTheDocument();
  });

  it('stays a portfolio view under "My sessions": no per-person request, and the daemon’s figures do not change with the scope', async () => {
    const { calls } = routeFetch(routes());
    const user = userEvent.setup();
    renderPage(<MeteringPage />, BUILDER);
    const widget = await outcomesWidget();
    await within(widget).findByText('Tickets fixed');
    await user.click(within(screen.getByRole('radiogroup', { name: 'Scope' })).getByRole('radio', { name: 'My sessions' }));
    await waitFor(() => expect(lastGet(calls, '/api/metering/daily')!.query.get('mine')).toBe('1'));

    expect(calls.filter((c) => c.path === OUTCOMES_PATH).every((c) => !c.query.has('mine'))).toBe(true);
    // The outcomes bring their own ringgit, so the page loads no second set of days to price them with.
    expect(calls.filter((c) => c.path === '/api/metering/daily').map((c) => c.query.get('mine'))).toEqual([null, '1']);
    expect(within(widget).getAllByText('Median', { selector: 'dt' })).toHaveLength(3);
    expect(widget).toHaveTextContent(rm(71.8716));
  });

  it('prints the US$ figures and says RM is incomplete on every row when the daemon could convert none of them', async () => {
    const withoutRm = (cls: CostPerOutcomeDTO['ticketsFixed']) => ({
      ...cls,
      stats: {
        ...cls.stats,
        totalRm: null,
        meanRm: null,
        medianRm: null,
        p90Rm: null,
        minRm: null,
        maxRm: null,
        rmComplete: false,
      },
      items: cls.items.map((i) => ({ ...i, notionalRm: null, rmComplete: false })),
    });
    routeFetch(
      routes({
        [OUTCOMES_ROUTE]: {
          ...OUTCOMES,
          ticketsFixed: withoutRm(OUTCOMES.ticketsFixed),
          changesShipped: withoutRm(OUTCOMES.changesShipped),
          phasesCompleted: withoutRm(OUTCOMES.phasesCompleted),
        },
      }),
    );
    renderPage(<MeteringPage />, APPROVER);
    const widget = await outcomesWidget();
    expect(await within(widget).findByText('2 outcomes · US$34.00 total')).toBeInTheDocument();
    // No ringgit figure anywhere, and nothing computes one from the US$.
    expect(widget).not.toHaveTextContent(/RM\s\d/);
    expect(widget).not.toHaveTextContent('≈');
    const kinds = within(widget).getByRole('list', { name: 'Notional cost per outcome, by kind' });
    for (const row of within(kinds).getAllByRole('listitem')) expect(row).toHaveTextContent('RM incomplete');
    expect(kinds).toHaveTextContent('2 of 2 have usage on a day with no stamped FX rate, so are left out of the RM figures');
    expect(widget).toHaveTextContent('RM incomplete: 7 of 7 have usage on a day with no stamped FX rate');
  });

  it('says RM is incomplete, and why, for the outcome that had usage on a day with no stamped rate, and keeps the others’ RM', async () => {
    routeFetch(routes({ [OUTCOMES_ROUTE]: OUTCOMES_RM_GAP }));
    const user = userEvent.setup();
    renderPage(<MeteringPage />, APPROVER);
    const widget = await outcomesWidget();
    const kinds = await within(widget).findByRole('list', { name: 'Notional cost per outcome, by kind' });
    const [tickets, changes, phases] = within(kinds).getAllByRole('listitem') as [HTMLElement, HTMLElement, HTMLElement];
    // The kind's RM figures cover the one outcome that has a complete RM; the row says what was left out.
    expect(tickets).toHaveTextContent('2 outcomes · US$34.00 total');
    expect(tickets).toHaveTextContent('RM incomplete');
    expect(tickets).toHaveTextContent('1 of 2 has usage on a day with no stamped FX rate, so is left out of the RM figures');
    expect(within(tickets).getByText('Median').nextElementSibling).toHaveTextContent(`US$17.00 ${rm(84.588)}`);
    expect(within(changes).queryByText('RM incomplete')).toBeNull();
    expect(within(phases).queryByText('RM incomplete')).toBeNull();
    expect(widget).toHaveTextContent('RM incomplete: 1 of 7 has usage on a day with no stamped FX rate, so is left out of the RM figures. Their US$ is complete.');

    // The outcome itself keeps its US$ and shows no RM, not even the part the daemon could convert.
    const table = within(widget).getByRole('table', { name: 'Outcomes completed in this range, newest first' });
    const gap = within(table).getAllByRole('link').find((a) => a.getAttribute('href') === '/tickets/tkt_01M4FC3GS5VXC370PY64VM0XE8')!.closest('tr')!;
    expect(gap).toHaveTextContent('US$14.00');
    expect(gap).toHaveTextContent('RM incomplete');
    expect(gap).not.toHaveTextContent(rm(25.32));
    const whole = within(table).getAllByRole('link').find((a) => a.getAttribute('href') === '/tickets/tkt_01M4FC3GS5VXC370PY64VM0XE9')!.closest('tr')!;
    expect(whole).toHaveTextContent(`US$20.00${rm(84.588)}`);
    expect(whole).not.toHaveTextContent('RM incomplete');

    // The same in the project view: only the project and kind the outcome belongs to is flagged.
    await user.click(within(screen.getByRole('radiogroup', { name: 'Outcome view' })).getByRole('radio', { name: 'By project' }));
    const byProject = await within(widget).findByRole('table', { name: /per project and kind, in project name order/ });
    const claims = within(byProject).getByRole('link', { name: 'Claims Intake Bot' }).closest('tr')!;
    const [, ticketsCell, changesCell, , total] = within(claims).getAllByRole('cell');
    expect(ticketsCell).toHaveTextContent(`US$17.00median of 2 · ${rm(84.588)}RM incomplete`);
    expect(changesCell).not.toHaveTextContent('RM incomplete');
    expect(total).toHaveTextContent('RM incomplete');
    expect(within(byProject).getByRole('link', { name: 'AOC Platform' }).closest('tr')).not.toHaveTextContent('RM incomplete');
  });

  it('offers process-type chips when the outcomes name more than one, and narrows the whole panel with them', async () => {
    const { calls } = routeFetch(routes());
    const user = userEvent.setup();
    renderPage(<MeteringPage />, APPROVER);
    const widget = await outcomesWidget();
    const filter = await within(widget).findByRole('group', { name: 'Filter outcomes by process type' });
    const chip = (name: string) => within(filter).getByRole('button', { name });
    // In name order, never by cost; an outcome with no single type (one change) is in All only.
    expect(within(filter).getAllByRole('button').map((c) => [plain(c.textContent), c.getAttribute('aria-pressed')])).toEqual([
      ['All 7', 'true'],
      ['bug-fix 2', 'false'],
      ['discovery 1', 'false'],
      ['feature-build 3', 'false'],
    ]);
    expect(filter).toHaveTextContent('mixed ones appear only under All');

    await user.click(chip('feature-build 3'));
    expect(chip('feature-build 3')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('All 7')).toHaveAttribute('aria-pressed', 'false');
    const kinds = within(widget).getByRole('list', { name: 'Notional cost per outcome, by kind' });
    const [tickets, changes, phases] = within(kinds).getAllByRole('listitem') as [HTMLElement, HTMLElement, HTMLElement];
    expect(tickets).toHaveTextContent('None of this process type');
    expect(tickets).toHaveTextContent('No outcome of this kind has this process type.');
    expect(changes).toHaveTextContent('1 outcome · US$20.00 total');
    expect(changes).toHaveTextContent(rm(84.854));
    // Two phases: the kind's figures are worked out from the daemon's per-outcome ones.
    expect(phases).toHaveTextContent('2 outcomes · US$31.74 total');
    expect(phases).toHaveTextContent(rm(37.222294 + 97.130901));
    expect(within(phases).getByText('Median').nextElementSibling).toHaveTextContent(`US$15.87 ${rm((37.222294 + 97.130901) / 2)}`);
    const table = within(widget).getByRole('table', { name: 'Outcomes completed in this range, newest first' });
    expect(within(table).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      '/changes/chg_01M4FDBZYA4VBEQ8CKEK7FP42E',
      '/projects/prj_aoc#prj-mt-phase-build',
      '/projects/prj_claims#prj-mt-phase-build',
    ]);
    expect(widget).toHaveTextContent('Figures cover the 3 outcomes of the chosen process type');
    expect(widget).toHaveTextContent('Unpriced usage counts as US$0, so 2 of these outcomes cost more than shown.');

    // The project view follows, and the scale stays the whole range's so the marks stay comparable.
    await user.click(chip('bug-fix 2'));
    expect(widget).toHaveTextContent('one scale: US$0 to US$30');
    expect(within(widget).getByText('2 outcomes · US$34.00 total')).toBeInTheDocument();
    await user.click(within(screen.getByRole('radiogroup', { name: 'Outcome view' })).getByRole('radio', { name: 'By project' }));
    const byProject = await within(widget).findByRole('table', { name: /per project and kind, in project name order/ });
    expect(within(byProject).getAllByRole('row').slice(1)).toHaveLength(1);
    expect(byProject).toHaveTextContent('Claims Intake Bot');
    expect(byProject).not.toHaveTextContent('AOC Platform');

    // Choosing the chosen chip again, or All, shows everything. All of it was filtered in the browser.
    await user.click(chip('bug-fix 2'));
    expect(chip('All 7')).toHaveAttribute('aria-pressed', 'true');
    await user.click(chip('discovery 1'));
    await user.click(chip('All 7'));
    const everything = within(widget).getByRole('table', { name: /per project and kind, in project name order/ });
    expect(within(everything).getAllByRole('row').slice(1)).toHaveLength(3);
    expect(calls.filter((c) => c.path === OUTCOMES_PATH)).toHaveLength(1);
    expect(Object.fromEntries(calls.find((c) => c.path === OUTCOMES_PATH)!.query)).toEqual({ from: '2026-09-10', to: '2026-10-09' });
  });

  it('offers no process-type chips when the outcomes name only one, or none', async () => {
    const retyped = (processType: (was: string | null) => string | null): CostPerOutcomeDTO => {
      const re = (cls: CostPerOutcomeDTO['ticketsFixed']) => ({
        ...cls,
        items: cls.items.map((i) => ({ ...i, processType: processType(i.processType) })),
      });
      return {
        ...OUTCOMES,
        ticketsFixed: re(OUTCOMES.ticketsFixed),
        changesShipped: re(OUTCOMES.changesShipped),
        phasesCompleted: re(OUTCOMES.phasesCompleted),
      };
    };
    for (const dto of [retyped((was) => (was === null ? null : 'bug-fix')), retyped(() => null)]) {
      routeFetch(routes({ [OUTCOMES_ROUTE]: dto }));
      const { unmount } = renderPage(<MeteringPage />, APPROVER);
      const widget = await outcomesWidget();
      expect(await within(widget).findByText('Tickets fixed')).toBeInTheDocument();
      expect(within(widget).queryByRole('group', { name: 'Filter outcomes by process type' })).toBeNull();
      unmount();
    }
  });

  it('refetches on spend and outcome events, and only those', async () => {
    const { count } = routeFetch(routes());
    renderPage(<MeteringPage />, APPROVER);
    await within(await outcomesWidget()).findByText('Tickets fixed');
    expect(count('GET', OUTCOMES_PATH)).toBe(1);

    act(() => streamEvent('session.liveness_changed', 40));
    await new Promise((r) => setTimeout(r, 250));
    expect(count('GET', OUTCOMES_PATH)).toBe(1);

    let expected = 1;
    for (const type of ['usage.recorded', 'ticket.closed', 'change.completed', 'phase.completed']) {
      expected += 1;
      act(() => streamEvent(type, 40 + expected));
      await waitFor(() => expect(count('GET', OUTCOMES_PATH)).toBe(expected));
    }
  });
});
