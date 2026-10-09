import { describe, expect, it } from 'vitest';
import {
  AocConfigSchema,
  type FxRateDTO,
  type FxRunResultDTO,
  type FxStatusDTO,
  type MetaOf,
  type Notification,
} from '@aoc/contracts';
import type { TestRuntime } from '@aoc/kernel';
import { BNM_API_ACCEPT } from '../src';
import {
  apiUrl,
  at,
  bnmApi,
  bnmPage,
  closeDay,
  fxRuntime,
  honestModel,
  notPublished,
  observed,
  OCTOBER_1700,
  octoberPage,
  PAGE_URL,
  ratesApi,
  recorded,
  runDaily,
  tick,
  wrongModel,
} from './helpers';

type Extractor = 'haiku' | 'sonnet' | 'api';
const live = (date: string, rate: number, extractor: Extractor = 'haiku', session = '1700') =>
  ({
    date,
    pair: 'USD/MYR',
    rate,
    status: 'live',
    sourceDate: date,
    extractor,
    validation: 'pass',
    reason: 'fetched',
    session,
  }) as const;

const down = { status: 503, body: 'Service Unavailable' };

function notifications(t: TestRuntime): Notification[] {
  const out: Notification[] = [];
  t.rt.broadcaster.subscribe({
    role: 'approver',
    send: (m) => void (m.event === 'notification' && out.push(m.data)),
  });
  return out;
}

function metas<T extends 'fx.discrepancy_raised' | 'fx.discrepancy_resolved' | 'fx.carry_forward_alert'>(
  t: TestRuntime,
  type: T,
): MetaOf<T>[] {
  return t.rt.store.list({ types: [type] }).map((e) => e.meta as MetaOf<T>);
}

async function rateOn(t: TestRuntime, date: string): Promise<FxRateDTO> {
  return (await ratesApi(t, t.user('builder').headers, date, date))[0]!;
}

describe('daily FX run (session 1700: page scrape, BNM Open API cross-check)', () => {
  it('records the 1700 middle rate at 18:00, stamped with its session and reconciled at 4 dp with the API for that date and session', async () => {
    const t = await fxRuntime();
    // The API serves binary floats: 4.0899999999999999 is the page's 4.0900.
    t.http
      .page(octoberPage('2026-10-08'))
      .api('2026-10-08', bnmApi({ date: '2026-10-08', mid: '4.0899999999999999' }));
    t.llm.on('fx.extract@haiku', honestModel);

    expect(await tick(t, '2026-10-08', '17:59')).toEqual([]);
    expect(await tick(t, '2026-10-08', '18:00')).toEqual(['fx.daily']);
    expect(recorded(t)).toEqual([live('2026-10-08', 4.09)]);
    // Later attempts leave a live day alone.
    expect(await tick(t, '2026-10-08', '18:30')).toEqual(['fx.retry@18:30']);
    expect(await tick(t, '2026-10-08', '21:00')).toEqual(['fx.retry@21:00']);
    expect(await tick(t, '2026-10-08', '23:59')).toEqual([]);
    expect(recorded(t)).toHaveLength(1);

    expect(t.http.calls.map((c) => [c.url, c.headers.accept])).toEqual([
      [PAGE_URL, 'text/html,application/xhtml+xml'],
      ['https://api.bnm.gov.my/public/exchange-rate/USD/date/2026-10-08?session=1700', BNM_API_ACCEPT],
    ]);
    expect(t.llm.calls.map((c) => [c.model, c.purpose])).toEqual([['haiku', 'fx.extract']]);
    const fx = t.rt.services.get('fx');
    expect(fx.rateFor('2026-10-08')).toEqual({ rate: 4.09, status: 'live', sourceDate: '2026-10-08' });
    expect(fx.rateFor('2026-10-07')).toBeNull();

    const dto = await rateOn(t, '2026-10-08');
    expect(dto).toMatchObject({
      rate: 4.09,
      bnmSession: '1700',
      flagged: false,
      official: 4.09,
      officialDate: '2026-10-08',
      notes: null,
      closed: false,
      revisions: 1,
      recordedBy: 'scheduler:fx',
      problems: [],
    });
    expect(dto.rawExcerpt).toContain('8 Oct 2026 | 4.0900');
    expect(t.rt.store.verifyChain().ok).toBe(true);
    await t.close();
  });

  it('carries Friday forward over the weekend by design — no fetch, no LLM, not flagged; the rate keeps its session', async () => {
    const t = await fxRuntime();
    t.http
      .page(bnmPage({ date: '2026-10-09', mid: 4.0905 }))
      .api('2026-10-09', bnmApi({ date: '2026-10-09', mid: 4.0905 }));
    t.llm.on('fx.extract@haiku', honestModel);
    await runDaily(t, '2026-10-09');
    for (const time of ['18:00', '18:30', '21:00']) await tick(t, '2026-10-10', time);
    await runDaily(t, '2026-10-11');

    const weekend = {
      pair: 'USD/MYR',
      rate: 4.0905,
      status: 'inherited',
      sourceDate: '2026-10-09',
      extractor: 'none',
      validation: 'not_applicable',
      reason: 'weekend_or_holiday',
      session: '1700',
    };
    expect(recorded(t)).toEqual([
      live('2026-10-09', 4.0905),
      { date: '2026-10-10', ...weekend },
      { date: '2026-10-11', ...weekend },
    ]);
    expect(t.http.calls).toHaveLength(2);
    expect(t.llm.calls).toHaveLength(1);
    const rates = await ratesApi(t, t.user('builder').headers, '2026-10-09', '2026-10-11');
    expect(rates.map((r) => [r.flagged, r.bnmSession])).toEqual([
      [false, '1700'],
      [false, '1700'],
      [false, '1700'],
    ]);
    expect(t.rt.services.get('fx').rateFor('2026-10-12')).toEqual({
      rate: 4.0905,
      status: 'inherited',
      sourceDate: '2026-10-09',
    });
    await t.close();
  });

  it('bootstraps a first run on a weekend from the last publication the page shows', async () => {
    const t = await fxRuntime();
    t.http.page(bnmPage({ date: '2026-10-09', mid: 4.0905 })).api('2026-10-10', notPublished());
    t.llm.on('fx.extract@haiku', honestModel);
    await runDaily(t, '2026-10-10');
    await runDaily(t, '2026-10-11');
    expect(
      recorded(t).map((m) => [m.date, m.rate, m.status, m.sourceDate, m.extractor, m.reason, m.session]),
    ).toEqual([
      ['2026-10-10', 4.0905, 'inherited', '2026-10-09', 'haiku', 'weekend_or_holiday', '1700'],
      ['2026-10-11', 4.0905, 'inherited', '2026-10-09', 'none', 'weekend_or_holiday', '1700'],
    ]);
    expect(t.http.count(PAGE_URL)).toBe(1);
    await t.close();
  });

  it('stamps a weekday public holiday only at the last attempt: page unchanged and BNM 404 (Malaysia Day 2026-09-16)', async () => {
    const t = await fxRuntime();
    t.http
      .page(bnmPage({ date: '2026-09-15', mid: 4.08 }))
      .api('2026-09-15', bnmApi({ date: '2026-09-15', mid: 4.08 }))
      .api('2026-09-16', notPublished());
    t.llm.on('fx.extract@haiku', honestModel);
    await runDaily(t, '2026-09-15');

    expect(await tick(t, '2026-09-16', '18:00')).toEqual(['fx.daily']);
    expect(await tick(t, '2026-09-16', '18:30')).toEqual(['fx.retry@18:30']);
    expect(recorded(t)).toHaveLength(1); // not published yet: nothing recorded while an attempt remains
    expect(await tick(t, '2026-09-16', '21:00')).toEqual(['fx.retry@21:00']);
    expect(recorded(t).at(-1)).toEqual({
      date: '2026-09-16',
      pair: 'USD/MYR',
      rate: 4.08,
      status: 'inherited',
      sourceDate: '2026-09-15',
      extractor: 'haiku',
      validation: 'pass',
      reason: 'weekend_or_holiday',
      session: '1700',
    });
    expect(await rateOn(t, '2026-09-16')).toMatchObject({ flagged: false, revisions: 1, bnmSession: '1700' });
    expect(t.http.count(apiUrl('2026-09-16'))).toBe(3);
    await t.close();
  });

  it('records nothing before publication and says so to a manual run', async () => {
    const t = await fxRuntime();
    t.http.page(octoberPage('2026-10-08')).api('2026-10-09', notPublished());
    t.llm.on('fx.extract@haiku', honestModel);
    at(t, '2026-10-09', '10:00');
    const res = await t.json<FxRunResultDTO>('POST', '/api/fx/run', { headers: t.user('approver').headers });
    expect(res).toEqual({
      date: '2026-10-09',
      outcome: 'awaiting_publication',
      record: null,
      discrepancyDecisionId: null,
      problems: ['not_published'],
    });
    expect(recorded(t)).toEqual([]);
    await t.close();
  });

  it('flags a page still showing yesterday at the last attempt when the API shows BNM has published today', async () => {
    const t = await fxRuntime();
    t.http
      .page(octoberPage('2026-10-08'))
      .api('2026-10-08', bnmApi({ date: '2026-10-08', mid: 4.09 }))
      .api('2026-10-09', bnmApi({ date: '2026-10-09', mid: 4.0905 }));
    t.llm.on('fx.extract@haiku', honestModel);
    await runDaily(t, '2026-10-08');
    at(t, '2026-10-09', '18:00');
    expect(
      await t.json<FxRunResultDTO>('POST', '/api/fx/run', { headers: t.user('approver').headers }),
    ).toMatchObject({
      outcome: 'awaiting_publication',
      problems: ['page_not_updated'],
    });
    await runDaily(t, '2026-10-09');
    expect(recorded(t)[1]).toEqual({
      date: '2026-10-09',
      pair: 'USD/MYR',
      rate: 4.09,
      status: 'inherited',
      sourceDate: '2026-10-08',
      extractor: 'none',
      validation: 'not_applicable',
      reason: 'source_unreadable',
      session: '1700',
    });
    expect(await rateOn(t, '2026-10-09')).toMatchObject({
      flagged: true,
      problems: ['page_not_updated'],
      official: 4.0905,
      officialDate: '2026-10-09',
    });
    await t.close();
  });

  it('records the scraped figure unreconciled at the last attempt when the API cannot confirm it', async () => {
    const t = await fxRuntime();
    t.http
      .page(bnmPage({ date: '2026-10-09', mid: 4.0905 }))
      .api('2026-10-09', { status: 502, body: 'Bad Gateway' });
    t.llm.on('fx.extract@haiku', honestModel);
    await runDaily(t, '2026-10-09');
    expect(recorded(t)).toEqual([live('2026-10-09', 4.0905)]);
    const dto = await rateOn(t, '2026-10-09');
    expect(dto).toMatchObject({ official: null, flagged: false });
    expect(dto.notes).toMatch(/BNM Open API could not confirm it \(api_http_status: HTTP 502\)/);
    await t.close();
  });
});

describe("carry forward yesterday's rate (flagged)", () => {
  it.each([
    ['a network error', new Error('getaddrinfo ENOTFOUND www.bnm.gov.my'), 'page_network_error'],
    ['HTTP 503', down, 'page_http_status'],
    ['an empty page', { status: 200, body: '' }, 'page_empty'],
    [
      'no rate-like text',
      { status: 200, body: '<html><body><h1>Down for maintenance</h1></body></html>' },
      'page_no_rate_text',
    ],
  ] as const)(
    'when the page is unreadable: %s (the LLM is never called)',
    async (_label, response, problem) => {
      const t = await fxRuntime();
      t.http
        .page(octoberPage('2026-10-08'), response)
        .api('2026-10-08', bnmApi({ date: '2026-10-08', mid: 4.09 }));
      t.llm.on('fx.extract@haiku', honestModel);
      await runDaily(t, '2026-10-08');
      await runDaily(t, '2026-10-09');
      expect(recorded(t)[1]).toEqual({
        date: '2026-10-09',
        pair: 'USD/MYR',
        rate: 4.09,
        status: 'inherited',
        sourceDate: '2026-10-08',
        extractor: 'none',
        validation: 'not_applicable',
        reason: 'source_unreadable',
        session: '1700',
      });
      expect(t.llm.calls).toHaveLength(1);
      expect(t.http.apiCalls()).toHaveLength(1);
      expect(await rateOn(t, '2026-10-09')).toMatchObject({ flagged: true, problems: [problem] });
      await t.close();
    },
  );

  it('escalates a Haiku figure that fails self-validation to Sonnet once, and records Sonnet’s valid figure', async () => {
    const t = await fxRuntime();
    t.http
      .page(bnmPage({ date: '2026-10-09', mid: 4.0905 }))
      .api('2026-10-09', bnmApi({ date: '2026-10-09', mid: 4.0905 }));
    t.llm.on('fx.extract@haiku', wrongModel(4.231)).on('fx.extract@sonnet', honestModel);
    await runDaily(t, '2026-10-09');
    expect(recorded(t)).toEqual([live('2026-10-09', 4.0905, 'sonnet')]);
    expect(t.llm.calls.map((c) => c.model)).toEqual(['haiku', 'sonnet']);
    expect(t.llm.calls[1]!.prompt).toContain('failed these automatic checks: rate_not_in_source');
    await t.close();
  });

  it('stops after Sonnet also fails and carries yesterday forward — the bad figure is never written', async () => {
    const t = await fxRuntime();
    t.http
      .page(octoberPage('2026-10-08'), bnmPage({ date: '2026-10-09', mid: 4.0905, earlier: OCTOBER_1700 }))
      .api('2026-10-08', bnmApi({ date: '2026-10-08', mid: 4.09 }));
    t.llm
      .on('fx.extract@haiku', honestModel)
      .on('fx.extract@haiku', wrongModel(4.0951))
      .on('fx.extract@sonnet', wrongModel(4.0905, '2026-10-12'));
    await runDaily(t, '2026-10-08');
    await runDaily(t, '2026-10-09');
    expect(recorded(t)[1]).toEqual({
      date: '2026-10-09',
      pair: 'USD/MYR',
      rate: 4.09,
      status: 'inherited',
      sourceDate: '2026-10-08',
      extractor: 'sonnet',
      validation: 'fail',
      reason: 'validation_failed',
      session: '1700',
    });
    expect(t.llm.calls.map((c) => c.model)).toEqual(['haiku', 'haiku', 'sonnet']);
    expect(t.http.apiCalls()).toHaveLength(1);
    expect(await rateOn(t, '2026-10-09')).toMatchObject({
      flagged: true,
      problems: ['haiku:rate_not_in_source', 'sonnet:date_in_future'],
    });
    expect(recorded(t).some((m) => m.rate === 4.0951 || m.date === '2026-10-12')).toBe(false);
    await t.close();
  });
});

describe('BNM Open API cross-check', () => {
  it('never reconciles against the session 1130 counter rates (middle_rate null) served when no session is sent', async () => {
    const t = await fxRuntime();
    t.http.page(octoberPage('2026-10-08')).api('2026-10-08', observed('api-USD-no-session-param.json'));
    t.llm.on('fx.extract@haiku', honestModel);

    expect(await tick(t, '2026-10-08', '18:00')).toEqual(['fx.daily']);
    at(t, '2026-10-08', '18:10');
    expect(
      await t.json<FxRunResultDTO>('POST', '/api/fx/run', { headers: t.user('approver').headers }),
    ).toMatchObject({
      outcome: 'awaiting_corroboration',
      record: null,
      problems: ['api_wrong_session'],
    });
    await tick(t, '2026-10-08', '18:30');
    expect(recorded(t)).toEqual([]);
    await tick(t, '2026-10-08', '21:00');

    expect(recorded(t)).toEqual([live('2026-10-08', 4.09)]);
    expect(metas(t, 'fx.discrepancy_raised')).toEqual([]);
    expect(t.http.count(PAGE_URL)).toBe(4); // one read per attempt, never a mismatch re-fetch
    const dto = await rateOn(t, '2026-10-08');
    expect(dto).toMatchObject({ official: null, flagged: false, bnmSession: '1700' });
    expect(dto.notes).toMatch(/api_wrong_session: session 1130, expected 1700/);
    await t.close();
  });

  it('treats the page 4.0900 against an API 4.0870 as a discrepancy (compared at 4 dp; the old 0.005 tolerance hid it)', async () => {
    const t = await fxRuntime();
    t.http
      .page(octoberPage('2026-10-07'), octoberPage('2026-10-08'))
      .api('2026-10-07', bnmApi({ date: '2026-10-07', mid: '4.0880000000000001' }))
      .api('2026-10-08', bnmApi({ date: '2026-10-08', mid: 4.087 }));
    t.llm.on('fx.extract@haiku', honestModel);
    await runDaily(t, '2026-10-07');
    await runDaily(t, '2026-10-08');

    expect([t.http.count(PAGE_URL), t.http.count(apiUrl('2026-10-08'))]).toEqual([3, 2]);
    const [raised] = metas(t, 'fx.discrepancy_raised');
    expect(raised).toEqual({
      date: '2026-10-08',
      scraped: 4.09,
      official: 4.087,
      decisionId: expect.any(String),
      scrapedDate: '2026-10-08',
      officialDate: '2026-10-08',
      extractor: 'haiku',
      session: '1700',
    });
    expect(t.decisions!.get(raised!.decisionId)!.context).toContain(
      'At 4 dp they differ by 0.0030, more than the reconcile tolerance 0.0001.',
    );
    expect(recorded(t)).toEqual([
      live('2026-10-07', 4.088),
      {
        date: '2026-10-08',
        pair: 'USD/MYR',
        rate: 4.088,
        status: 'inherited',
        sourceDate: '2026-10-07',
        extractor: 'haiku',
        validation: 'fail',
        reason: 'discrepancy_pending',
        session: '1700',
      },
    ]);
    await t.close();
  });

  it('re-fetches once on a mismatch and records the figure that then reconciles', async () => {
    const t = await fxRuntime();
    t.http
      .page(bnmPage({ date: '2026-10-09', mid: 4.095 }), bnmPage({ date: '2026-10-09', mid: 4.0905 }))
      .api('2026-10-09', bnmApi({ date: '2026-10-09', mid: 4.0905 }));
    t.llm.on('fx.extract@haiku', honestModel);
    await runDaily(t, '2026-10-09');
    expect(recorded(t)).toEqual([live('2026-10-09', 4.0905)]);
    expect([t.http.count(PAGE_URL), t.http.count(apiUrl('2026-10-09'))]).toEqual([2, 2]);
    expect(metas(t, 'fx.discrepancy_raised')).toEqual([]);
    expect(t.decisions!.list()).toEqual([]);
    await t.close();
  });

  it('raises a discrepancy decision carrying both figures when the re-fetch still disagrees, then applies the approver’s choice', async () => {
    const t = await fxRuntime();
    t.http
      .page(bnmPage({ date: '2026-10-08', mid: 4.12 }), bnmPage({ date: '2026-10-09', mid: 4.1 }))
      .api('2026-10-08', bnmApi({ date: '2026-10-08', mid: 4.12 }))
      .api('2026-10-09', bnmApi({ date: '2026-10-09', mid: 4.15 }));
    t.llm.on('fx.extract@haiku', honestModel);
    await runDaily(t, '2026-10-08');
    await runDaily(t, '2026-10-09');
    expect([t.http.count(PAGE_URL), t.http.count(apiUrl('2026-10-09'))]).toEqual([3, 2]);

    const [raised] = metas(t, 'fx.discrepancy_raised');
    expect(raised).toEqual({
      date: '2026-10-09',
      scraped: 4.1,
      official: 4.15,
      decisionId: expect.any(String),
      scrapedDate: '2026-10-09',
      officialDate: '2026-10-09',
      extractor: 'haiku',
      session: '1700',
    });
    const card = t.decisions!.get(raised!.decisionId)!;
    expect(card).toMatchObject({
      kind: 'fx_discrepancy',
      requiredRole: 'approver',
      requiresPasskey: false,
      subjectType: 'fx_day',
      subjectId: '2026-10-09',
      requesterId: 'scheduler:fx',
    });
    expect(card.options.map((o) => o.id)).toEqual(['accept_official', 'accept_scraped', 'manual']);
    expect(card.context).toContain('Original confirmed figure: 4.1000');
    expect(card.context).toContain(
      'Conflicting figure: 4.1500 from the BNM Open API for 2026-10-09, session 1700.',
    );
    expect(recorded(t)[1]).toEqual({
      date: '2026-10-09',
      pair: 'USD/MYR',
      rate: 4.12,
      status: 'inherited',
      sourceDate: '2026-10-08',
      extractor: 'haiku',
      validation: 'fail',
      reason: 'discrepancy_pending',
      session: '1700',
    });

    const approver = t.user('approver');
    const builder = t.user('builder');
    const status = await t.json<FxStatusDTO>('GET', '/api/fx/status', { headers: builder.headers });
    expect(status.openDiscrepancy).toMatchObject({
      date: '2026-10-09',
      scraped: 4.1,
      official: 4.15,
      bnmSession: '1700',
      status: 'open',
      decisionStatus: 'open',
    });
    expect(status.todayRecord).toMatchObject({ flagged: true, reason: 'discrepancy_pending' });
    const rerun = await t.json<FxRunResultDTO>('POST', '/api/fx/run', { headers: approver.headers });
    expect(rerun).toMatchObject({
      outcome: 'skipped_discrepancy',
      discrepancyDecisionId: raised!.decisionId,
    });

    await expect(
      t.decisions!.resolve(card.id, { optionId: 'accept_official' }, builder.user),
    ).rejects.toThrow(/role/);
    await t.decisions!.resolve(card.id, { optionId: 'accept_official' }, approver.user);
    await t.drain();
    const resolvedEvent = t.rt.store.list({ types: ['decision.resolved'] })[0]!;
    const [resolved] = t.rt.store.list({ types: ['fx.discrepancy_resolved'] });
    expect(resolved).toMatchObject({
      causationId: resolvedEvent.id,
      actor: { kind: 'human', id: approver.user.id },
    });
    expect(resolved!.meta).toEqual({
      date: '2026-10-09',
      chosenRate: 4.15,
      decisionId: card.id,
      choice: 'accept_official',
      applied: true,
    });
    expect(recorded(t)[2]).toEqual({
      date: '2026-10-09',
      pair: 'USD/MYR',
      rate: 4.15,
      status: 'live',
      sourceDate: '2026-10-09',
      extractor: 'api',
      validation: 'pass',
      reason: 'manual_override',
      session: '1700',
    });
    expect(t.rt.services.get('fx').rateFor('2026-10-09')).toEqual({
      rate: 4.15,
      status: 'live',
      sourceDate: '2026-10-09',
    });
    expect(
      (await t.json<FxStatusDTO>('GET', '/api/fx/status', { headers: builder.headers })).openDiscrepancy,
    ).toBeNull();
    await t.close();
  });

  it('lets the approver enter the rate manually: the override resolves the open discrepancy decision', async () => {
    const t = await fxRuntime();
    t.http
      .page(bnmPage({ date: '2026-10-09', mid: 4.1 }))
      .api('2026-10-09', bnmApi({ date: '2026-10-09', mid: 4.15 }));
    t.llm.on('fx.extract@haiku', honestModel);
    await runDaily(t, '2026-10-09'); // first run ever: nothing to carry forward while it is open
    const [raised] = metas(t, 'fx.discrepancy_raised');
    expect(recorded(t)).toEqual([]);

    const approver = t.user('approver');
    const dto = await t.json<FxRateDTO>('POST', '/api/fx/rates/2026-10-09/override', {
      headers: approver.headers,
      body: { rate: 4.1475, reason: 'Confirmed against the BNM 1700 table' },
    });
    expect(dto).toMatchObject({
      date: '2026-10-09',
      rate: 4.1475,
      status: 'live',
      extractor: 'manual',
      validation: 'not_applicable',
      reason: 'manual_override',
      bnmSession: '1700',
      recordedBy: approver.user.id,
      notes: 'Confirmed against the BNM 1700 table',
    });
    expect(t.decisions!.get(raised!.decisionId)!.resolution).toMatchObject({
      optionId: 'manual',
      resolvedBy: approver.user.id,
      comment: 'Confirmed against the BNM 1700 table',
    });
    await t.drain();
    expect(metas(t, 'fx.discrepancy_resolved')).toEqual([
      {
        date: '2026-10-09',
        chosenRate: 4.1475,
        decisionId: raised!.decisionId,
        choice: 'manual',
        applied: true,
      },
    ]);
    expect(recorded(t)).toHaveLength(1);
    await t.close();
  });
});

describe('sanity bounds', () => {
  it('rejects out-of-band figures even when printed on the page (or injected into it); with nothing to carry forward, nothing is written', async () => {
    const t = await fxRuntime();
    t.http.page(bnmPage({ date: '2026-10-09', mid: 42.13 }));
    t.llm.on('fx.extract@haiku', honestModel).on('fx.extract@sonnet', wrongModel(9.9999));
    const notes = notifications(t);
    at(t, '2026-10-09');
    const res = await t.json<FxRunResultDTO>('POST', '/api/fx/run', { headers: t.user('approver').headers });
    expect(res).toMatchObject({
      date: '2026-10-09',
      outcome: 'no_rate',
      record: null,
      problems: ['haiku:out_of_band', 'sonnet:out_of_band'],
    });
    expect(recorded(t)).toEqual([]);
    expect(t.http.apiCalls()).toEqual([]);
    expect(notes).toContainEqual(
      expect.objectContaining({ kind: 'fx.alert', severity: 'danger', refs: { date: '2026-10-09' } }),
    );
    await t.close();
  });

  it('rejects a day-over-day move above 3% outright, whatever the API says', async () => {
    const t = await fxRuntime();
    t.http
      .page(octoberPage('2026-10-08'), bnmPage({ date: '2026-10-09', mid: 4.23 }))
      .api('2026-10-08', bnmApi({ date: '2026-10-08', mid: 4.09 }))
      .api('2026-10-09', bnmApi({ date: '2026-10-09', mid: 4.23 }));
    t.llm.on('fx.extract@haiku', honestModel).on('fx.extract@sonnet', honestModel);
    await runDaily(t, '2026-10-08');
    await runDaily(t, '2026-10-09');
    expect(recorded(t)[1]).toEqual({
      date: '2026-10-09',
      pair: 'USD/MYR',
      rate: 4.09,
      status: 'inherited',
      sourceDate: '2026-10-08',
      extractor: 'sonnet',
      validation: 'fail',
      reason: 'validation_failed',
      session: '1700',
    });
    expect(await rateOn(t, '2026-10-09')).toMatchObject({
      flagged: true,
      problems: ['haiku:daily_change_exceeded', 'sonnet:daily_change_exceeded'],
    });
    expect(t.http.count(apiUrl('2026-10-09'))).toBe(0);
    await t.close();
  });

  it('accepts a move above the 1.25% soft flag when the API agrees exactly at 4 dp', async () => {
    const t = await fxRuntime();
    t.http
      .page(octoberPage('2026-10-08'), bnmPage({ date: '2026-10-09', mid: 4.15 }))
      .api('2026-10-08', bnmApi({ date: '2026-10-08', mid: 4.09 }))
      .api('2026-10-09', bnmApi({ date: '2026-10-09', mid: '4.1500000000000004' }));
    t.llm.on('fx.extract@haiku', honestModel);
    await runDaily(t, '2026-10-08');
    await runDaily(t, '2026-10-09');
    expect(recorded(t)[1]).toEqual(live('2026-10-09', 4.15));
    const dto = await rateOn(t, '2026-10-09');
    expect(dto).toMatchObject({ official: 4.15, flagged: false });
    expect(dto.notes).toBe(
      'Day-over-day move 1.47% is above the 1.25% soft flag; the BNM Open API agrees exactly at 4 dp',
    );
    await t.close();
  });

  it('treats a soft-flagged move the API does not match exactly as a discrepancy, though one unit in the 4th decimal is within the tolerance', async () => {
    const t = await fxRuntime();
    t.http
      .page(octoberPage('2026-10-08'), bnmPage({ date: '2026-10-09', mid: 4.15 }))
      .api('2026-10-08', bnmApi({ date: '2026-10-08', mid: 4.09 }))
      .api('2026-10-09', bnmApi({ date: '2026-10-09', mid: 4.1501 }));
    t.llm.on('fx.extract@haiku', honestModel);
    await runDaily(t, '2026-10-08');
    await runDaily(t, '2026-10-09');
    const [raised] = metas(t, 'fx.discrepancy_raised');
    expect(raised).toMatchObject({ date: '2026-10-09', scraped: 4.15, official: 4.1501, session: '1700' });
    expect(t.decisions!.get(raised!.decisionId)!.context).toContain(
      'The day-over-day move 1.47% is above the 1.25% soft flag, so the figures must agree exactly at 4 dp; they differ by 0.0001.',
    );
    expect(recorded(t)[1]).toMatchObject({ rate: 4.09, status: 'inherited', reason: 'discrepancy_pending' });
    expect(t.http.count(PAGE_URL)).toBe(3);
    await t.close();
  });

  it('never accepts a soft-flagged move on the page alone: waits for the retries, then carries forward (flagged) for a manual check', async () => {
    const t = await fxRuntime();
    t.http
      .page(octoberPage('2026-10-08'), bnmPage({ date: '2026-10-09', mid: 4.15 }))
      .api('2026-10-08', bnmApi({ date: '2026-10-08', mid: 4.09 }))
      .api('2026-10-09', notPublished());
    t.llm.on('fx.extract@haiku', honestModel);
    const notes = notifications(t);
    await runDaily(t, '2026-10-08');

    expect(await tick(t, '2026-10-09', '18:00')).toEqual(['fx.daily']);
    expect(await tick(t, '2026-10-09', '18:30')).toEqual(['fx.retry@18:30']);
    expect(recorded(t)).toHaveLength(1);
    expect(await tick(t, '2026-10-09', '21:00')).toEqual(['fx.retry@21:00']);
    expect(recorded(t)[1]).toEqual({
      date: '2026-10-09',
      pair: 'USD/MYR',
      rate: 4.09,
      status: 'inherited',
      sourceDate: '2026-10-08',
      extractor: 'haiku',
      validation: 'fail',
      reason: 'validation_failed',
      session: '1700',
    });
    expect(await rateOn(t, '2026-10-09')).toMatchObject({
      flagged: true,
      problems: ['soft_flag_unconfirmed', 'api_not_published'],
    });
    expect(metas(t, 'fx.discrepancy_raised')).toEqual([]);
    expect(notes).toContainEqual(
      expect.objectContaining({
        kind: 'fx.alert',
        severity: 'warn',
        refs: { date: '2026-10-09' },
        title: expect.stringMatching(/a 1\.47% move on the BNM page could not be confirmed/),
      }),
    );
    await t.close();
  });
});

describe('schedule: 18:00 MYT, retries at 18:30 and 21:00', () => {
  it('waits while the 1700 rate is not published yet and records it at the retry that finds it', async () => {
    const t = await fxRuntime();
    const friday = bnmPage({ date: '2026-10-09', mid: 4.0905, earlier: OCTOBER_1700 });
    t.http
      .page(octoberPage('2026-10-08'), octoberPage('2026-10-08'), friday)
      .api('2026-10-08', bnmApi({ date: '2026-10-08', mid: 4.09 }))
      .api('2026-10-09', notPublished(), bnmApi({ date: '2026-10-09', mid: 4.0905 }));
    t.llm.on('fx.extract@haiku', honestModel);
    await runDaily(t, '2026-10-08');

    expect(await tick(t, '2026-10-09', '18:00')).toEqual(['fx.daily']);
    expect(recorded(t)).toHaveLength(1);
    expect(await tick(t, '2026-10-09', '18:30')).toEqual(['fx.retry@18:30']);
    expect(recorded(t)[1]).toEqual(live('2026-10-09', 4.0905));
    expect(await tick(t, '2026-10-09', '21:00')).toEqual(['fx.retry@21:00']);
    expect(await rateOn(t, '2026-10-09')).toMatchObject({ revisions: 1, official: 4.0905 });
    expect([t.http.count(PAGE_URL), t.http.count(apiUrl('2026-10-09'))]).toEqual([3, 2]);
    await t.close();
  });

  it('retries an unreadable page; the live rate then replaces the flagged carry-forward, and no alert fires before the last attempt', async () => {
    const t = await fxRuntime({ carryForwardAlertWeekdays: 1 });
    t.http
      .page(octoberPage('2026-10-08'), down, bnmPage({ date: '2026-10-09', mid: 4.0905 }))
      .api('2026-10-08', bnmApi({ date: '2026-10-08', mid: 4.09 }))
      .api('2026-10-09', bnmApi({ date: '2026-10-09', mid: 4.0905 }));
    t.llm.on('fx.extract@haiku', honestModel);
    await runDaily(t, '2026-10-08');

    await tick(t, '2026-10-09', '18:00');
    expect(recorded(t)[1]).toMatchObject({
      status: 'inherited',
      reason: 'source_unreadable',
      session: '1700',
    });
    expect(await rateOn(t, '2026-10-09')).toMatchObject({ flagged: true, problems: ['page_http_status'] });
    expect(metas(t, 'fx.carry_forward_alert')).toEqual([]);
    await tick(t, '2026-10-09', '18:30');
    expect(recorded(t)[2]).toEqual(live('2026-10-09', 4.0905));
    expect(await rateOn(t, '2026-10-09')).toMatchObject({ flagged: false, revisions: 2 });
    expect(t.http.count(apiUrl('2026-10-09'))).toBe(1);
    expect(metas(t, 'fx.carry_forward_alert')).toEqual([]);
    await t.close();
  });

  it('does not retry a day whose extraction failed validation (Sonnet was the last escalation); the approver can re-run it', async () => {
    const t = await fxRuntime();
    t.http
      .page(octoberPage('2026-10-08'), bnmPage({ date: '2026-10-09', mid: 4.0905 }))
      .api('2026-10-08', bnmApi({ date: '2026-10-08', mid: 4.09 }))
      .api('2026-10-09', bnmApi({ date: '2026-10-09', mid: 4.0905 }));
    t.llm
      .on('fx.extract@haiku', honestModel)
      .on('fx.extract@haiku', wrongModel(4.0951))
      .on('fx.extract@haiku', honestModel)
      .on('fx.extract@sonnet', wrongModel(4.0951));
    await runDaily(t, '2026-10-08');

    await tick(t, '2026-10-09', '18:00');
    expect(recorded(t)[1]).toMatchObject({ reason: 'validation_failed', validation: 'fail' });
    await tick(t, '2026-10-09', '18:30');
    await tick(t, '2026-10-09', '21:00');
    expect(t.llm.calls.map((c) => c.model)).toEqual(['haiku', 'haiku', 'sonnet']);
    expect(recorded(t)).toHaveLength(2);

    at(t, '2026-10-09', '21:30');
    const res = await t.json<FxRunResultDTO>('POST', '/api/fx/run', { headers: t.user('approver').headers });
    expect(res).toMatchObject({ outcome: 'live', record: { rate: 4.0905, revisions: 2 } });
    expect(t.llm.calls.map((c) => c.model)).toEqual(['haiku', 'haiku', 'sonnet', 'haiku']);
    await t.close();
  });

  it('with session 1200 (if mandated) runs from 13:00 on the API figure for that session, without a page cross-check', async () => {
    const t = await fxRuntime({
      session: '1200',
      runAtLocalTime: '13:00',
      retryAtLocalTimes: ['13:30', '15:00'],
    });
    t.http
      .apiSession('1200', '2026-10-07', notPublished(), observed('api-USD-date-2026-10-07-session-1200.json'))
      .apiSession('1200', '2026-10-08', notPublished());

    expect(await tick(t, '2026-10-07', '12:59')).toEqual([]);
    expect(await tick(t, '2026-10-07', '13:00')).toEqual(['fx.daily']);
    expect(recorded(t)).toEqual([]);
    expect(await tick(t, '2026-10-07', '13:30')).toEqual(['fx.retry@13:30']);
    expect(recorded(t)).toEqual([live('2026-10-07', 4.0862, 'api', '1200')]);
    expect(await tick(t, '2026-10-07', '15:00')).toEqual(['fx.retry@15:00']);

    // A day BNM never publishes for 1200 is a holiday at the last attempt; the carried rate keeps session 1200.
    for (const time of ['13:00', '13:30', '15:00']) await tick(t, '2026-10-08', time);
    expect(recorded(t)[1]).toEqual({
      date: '2026-10-08',
      pair: 'USD/MYR',
      rate: 4.0862,
      status: 'inherited',
      sourceDate: '2026-10-07',
      extractor: 'none',
      validation: 'not_applicable',
      reason: 'weekend_or_holiday',
      session: '1200',
    });

    expect(t.http.count(PAGE_URL)).toBe(0);
    expect(t.llm.calls).toEqual([]);
    expect(t.http.apiCalls().map((c) => c.url)).toEqual([
      ...Array(2).fill('https://api.bnm.gov.my/public/exchange-rate/USD/date/2026-10-07?session=1200'),
      ...Array(3).fill('https://api.bnm.gov.my/public/exchange-rate/USD/date/2026-10-08?session=1200'),
    ]);
    const dto = await rateOn(t, '2026-10-07');
    expect(dto).toMatchObject({ bnmSession: '1200', official: 4.0862, flagged: false });
    expect(dto.notes).toMatch(/not cross-checked with the page, whose default view is session 1700/);
    expect(
      await t.json<FxStatusDTO>('GET', '/api/fx/status', { headers: t.user('builder').headers }),
    ).toMatchObject({
      session: '1200',
      runAtLocalTime: '13:00',
      retryAtLocalTimes: ['13:30', '15:00'],
    });
    await t.close();
  });
});

describe('session 1200 (API figure only)', () => {
  it('carries forward (flagged) when the API is unreadable or its figure fails the sanity bounds', async () => {
    const t = await fxRuntime({
      session: '1200',
      runAtLocalTime: '13:00',
      retryAtLocalTimes: ['13:30', '15:00'],
    });
    t.http
      .apiSession('1200', '2026-10-07', observed('api-USD-date-2026-10-07-session-1200.json'))
      .apiSession('1200', '2026-10-08', { status: 502, body: 'Bad Gateway' })
      .apiSession('1200', '2026-10-09', bnmApi({ date: '2026-10-09', mid: 4.25, session: '1200' }))
      .apiSession('1200', '2026-10-12', bnmApi({ date: '2026-10-12', mid: 42.5, session: '1200' }));
    for (const d of ['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12']) await runDaily(t, d);
    expect(
      recorded(t).map((m) => [m.date, m.rate, m.status, m.extractor, m.validation, m.reason, m.session]),
    ).toEqual([
      ['2026-10-07', 4.0862, 'live', 'api', 'pass', 'fetched', '1200'],
      ['2026-10-08', 4.0862, 'inherited', 'none', 'not_applicable', 'source_unreadable', '1200'],
      ['2026-10-09', 4.0862, 'inherited', 'api', 'fail', 'validation_failed', '1200'],
      ['2026-10-12', 4.0862, 'inherited', 'api', 'fail', 'validation_failed', '1200'],
    ]);
    const rates = await ratesApi(t, t.user('builder').headers, '2026-10-08', '2026-10-12');
    expect(rates.map((r) => [r.date, r.flagged, r.problems])).toEqual([
      ['2026-10-08', true, ['api_http_status']],
      ['2026-10-09', true, ['daily_change_exceeded']],
      ['2026-10-12', true, ['api_out_of_band']],
    ]);
    expect(t.http.count(PAGE_URL)).toBe(0);
    await t.close();
  });
});

describe('carry-forward alert', () => {
  it('counts weekdays without a live rate: a weekend plus two holidays (Hari Raya 2025) does not alert, a third weekday does', async () => {
    const t = await fxRuntime();
    const friday = bnmPage({ date: '2025-03-28', mid: 4.433 });
    t.http
      .page(friday, friday, friday, down)
      .api('2025-03-28', bnmApi({ date: '2025-03-28', mid: 4.433 }))
      .api('2025-03-31', notPublished())
      .api('2025-04-01', notPublished());
    t.llm.on('fx.extract@haiku', honestModel);
    const notes = notifications(t);
    const alerts = () => metas(t, 'fx.carry_forward_alert');

    // Four calendar days without a publication (Sat 29 – Tue 1 Apr), but only two weekdays.
    for (const d of ['2025-03-28', '2025-03-29', '2025-03-30', '2025-03-31', '2025-04-01'])
      await runDaily(t, d);
    expect(recorded(t).map((m) => [m.date, m.status, m.reason])).toEqual([
      ['2025-03-28', 'live', 'fetched'],
      ['2025-03-29', 'inherited', 'weekend_or_holiday'],
      ['2025-03-30', 'inherited', 'weekend_or_holiday'],
      ['2025-03-31', 'inherited', 'weekend_or_holiday'],
      ['2025-04-01', 'inherited', 'weekend_or_holiday'],
    ]);
    expect(alerts()).toEqual([]);
    const builder = t.user('builder');
    expect(
      (await t.json<FxStatusDTO>('GET', '/api/fx/status', { headers: builder.headers })).carryForward,
    ).toEqual({
      days: 2,
      since: '2025-03-31',
      alertAfterDays: 3,
      alerted: false,
    });

    await runDaily(t, '2025-04-02'); // the page is down: a third weekday without a live rate
    expect(alerts()).toEqual([{ consecutiveDays: 3, since: '2025-03-31', date: '2025-04-02' }]);
    expect(notes.filter((n) => n.kind === 'fx.alert')).toEqual([
      expect.objectContaining({
        severity: 'warn',
        audience: ['approver', 'builder'],
        refs: { since: '2025-03-31', date: '2025-04-02' },
        title: expect.stringMatching(/3 weekdays in a row/),
      }),
    ]);
    await t.close();
  });

  it('alerts once per streak and counts weekdays with no record at all (aocd down)', async () => {
    const t = await fxRuntime();
    t.http.page(octoberPage('2026-10-08'), down).api('2026-10-08', bnmApi({ date: '2026-10-08', mid: 4.09 }));
    t.llm.on('fx.extract@haiku', honestModel);
    const alerts = () => metas(t, 'fx.carry_forward_alert');

    await runDaily(t, '2026-10-08'); // Thu live; aocd is down Fri 9 and Mon 12
    await runDaily(t, '2026-10-13'); // Tue: page down — Fri, Mon, Tue have no live rate
    expect(alerts()).toEqual([{ consecutiveDays: 3, since: '2026-10-09', date: '2026-10-13' }]);
    await runDaily(t, '2026-10-14'); // Wed: same streak, no second alert
    expect(alerts()).toHaveLength(1);
    const status = await t.json<FxStatusDTO>('GET', '/api/fx/status', { headers: t.user('builder').headers });
    expect(status.carryForward).toEqual({ days: 4, since: '2026-10-09', alertAfterDays: 3, alerted: true });
    expect(status.lastLive).toEqual({ date: '2026-10-08', rate: 4.09 });

    t.http
      .clear()
      .page(bnmPage({ date: '2026-10-15', mid: 4.0912 }), down)
      .api('2026-10-15', bnmApi({ date: '2026-10-15', mid: 4.0912 }));
    for (const d of ['2026-10-15', '2026-10-16', '2026-10-19']) await runDaily(t, d); // live Thu ends the streak
    expect(alerts()).toHaveLength(1);
    await runDaily(t, '2026-10-20');
    expect(alerts().map((a) => a.since)).toEqual(['2026-10-09', '2026-10-16']);
    await t.close();
  });
});

describe('forward-only rates', () => {
  it('refuses an override for a day closed by metering; approvers may override open days', async () => {
    const t = await fxRuntime();
    t.http
      .page(bnmPage({ date: '2026-10-08', mid: 4.2 }), bnmPage({ date: '2026-10-09', mid: 4.213 }))
      .api('2026-10-08', bnmApi({ date: '2026-10-08', mid: 4.2 }))
      .api('2026-10-09', bnmApi({ date: '2026-10-09', mid: 4.213 }));
    t.llm.on('fx.extract@haiku', honestModel);
    await runDaily(t, '2026-10-08');
    at(t, '2026-10-09', '00:15');
    closeDay(t, '2026-10-08');
    await runDaily(t, '2026-10-09');
    const approver = t.user('approver');
    const builder = t.user('builder');
    const override = (date: string, body: unknown, headers = approver.headers) =>
      t.request('POST', `/api/fx/rates/${date}/override`, { headers, body });

    const refused = await override('2026-10-08', { rate: 4.25, reason: 'late correction' });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('day_closed');
    expect(recorded(t).filter((m) => m.date === '2026-10-08')).toHaveLength(1);
    expect(t.rt.services.get('fx').rateFor('2026-10-08')).toEqual({
      rate: 4.2,
      status: 'live',
      sourceDate: '2026-10-08',
    });
    expect((await ratesApi(t, builder.headers, '2026-10-08', '2026-10-08'))[0]).toMatchObject({
      closed: true,
      revisions: 1,
    });

    expect(
      (await override('2026-10-09', { rate: 4.22, reason: 'a builder try' }, builder.headers)).status,
    ).toBe(403);
    expect((await override('2026-10-09', { rate: 42.2, reason: 'decimal slip' })).status).toBe(422);
    expect((await override('2026-10-10', { rate: 4.22, reason: 'tomorrow' })).status).toBe(422);
    expect((await override('2026-10-09', { rate: 4.22 })).status).toBe(422);

    const res = await override('2026-10-09', { rate: 4.2205, reason: 'BNM revised the 1700 fixing' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      date: '2026-10-09',
      rate: 4.2205,
      status: 'live',
      extractor: 'manual',
      reason: 'manual_override',
      bnmSession: '1700',
      revisions: 2,
      recordedBy: approver.user.id,
      closed: false,
    });
    // A human-set rate is final for the day: a later run does not overwrite it.
    expect((await t.json<FxRunResultDTO>('POST', '/api/fx/run', { headers: approver.headers })).outcome).toBe(
      'skipped_manual',
    );
    expect(recorded(t)).toHaveLength(3);
    await t.close();
  });

  it('never restates a recorded or closed day', async () => {
    const t = await fxRuntime();
    t.http
      .page(
        bnmPage({ date: '2026-10-09', mid: 4.213 }),
        bnmPage({ date: '2026-10-12', mid: 4.25 }),
        bnmPage({ date: '2026-10-13', mid: 4.2 }),
      )
      .api('2026-10-09', bnmApi({ date: '2026-10-09', mid: 4.213 }))
      .api('2026-10-12', bnmApi({ date: '2026-10-12', mid: 4.25 }))
      .api('2026-10-13', bnmApi({ date: '2026-10-13', mid: 4.24 }));
    t.llm.on('fx.extract@haiku', honestModel);
    const notes = notifications(t);
    for (const d of ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']) await runDaily(t, d);
    const builder = t.user('builder');
    const approver = t.user('approver');
    const view = async () =>
      (await ratesApi(t, builder.headers, '2026-10-09', '2026-10-13')).map((r) => [
        r.date,
        r.rate,
        r.status,
        r.sourceDate,
        r.reason,
        r.bnmSession,
      ]);

    // Monday's move does not reach back into the weekend that inherited Friday's rate.
    expect(await view()).toEqual([
      ['2026-10-09', 4.213, 'live', '2026-10-09', 'fetched', '1700'],
      ['2026-10-10', 4.213, 'inherited', '2026-10-09', 'weekend_or_holiday', '1700'],
      ['2026-10-11', 4.213, 'inherited', '2026-10-09', 'weekend_or_holiday', '1700'],
      ['2026-10-12', 4.25, 'live', '2026-10-12', 'fetched', '1700'],
    ]);
    // Re-running a day that is already live changes nothing.
    expect((await t.json<FxRunResultDTO>('POST', '/api/fx/run', { headers: approver.headers })).outcome).toBe(
      'skipped_live',
    );

    // Tuesday is mismatched; metering closes it before the approver answers.
    await runDaily(t, '2026-10-13');
    const [raised] = metas(t, 'fx.discrepancy_raised');
    at(t, '2026-10-14', '00:15');
    closeDay(t, '2026-10-13');
    await t.decisions!.resolve(raised!.decisionId, { optionId: 'accept_official' }, approver.user);
    await t.drain();
    expect(metas(t, 'fx.discrepancy_resolved')).toEqual([
      {
        date: '2026-10-13',
        chosenRate: 4.24,
        decisionId: raised!.decisionId,
        choice: 'accept_official',
        applied: false,
      },
    ]);
    expect(notes).toContainEqual(
      expect.objectContaining({
        kind: 'fx.alert',
        severity: 'info',
        refs: { date: '2026-10-13', decisionId: raised!.decisionId },
      }),
    );
    expect(t.rt.services.get('fx').rateFor('2026-10-13')).toEqual({
      rate: 4.25,
      status: 'inherited',
      sourceDate: '2026-10-12',
    });

    const counts = Object.fromEntries(
      ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13'].map((d) => [
        d,
        recorded(t).filter((m) => m.date === d).length,
      ]),
    );
    expect(Object.values(counts)).toEqual([1, 1, 1, 1, 1]);
    const before = await view();
    t.rt.store.rebuildProjections(['fx']);
    expect(await view()).toEqual(before);
    await t.close();
  });
});

describe('routes', () => {
  it('guards reads (audit.view / ratecard.edit) and the approver-only run trigger; status shows the schedule and session', async () => {
    const t = await fxRuntime();
    at(t, '2026-10-09', '09:00');
    const requester = t.user('requester');
    const builder = t.user('builder');
    expect((await t.request('GET', '/api/fx/rates')).status).toBe(401);
    expect((await t.request('GET', '/api/fx/rates', { headers: requester.headers })).status).toBe(403);
    expect((await t.request('GET', '/api/fx/status', { headers: requester.headers })).status).toBe(403);
    expect((await t.request('POST', '/api/fx/run', { headers: builder.headers })).status).toBe(403);
    expect(
      (await t.request('GET', '/api/fx/rates?from=2026-10-09&to=2026-10-01', { headers: builder.headers }))
        .status,
    ).toBe(422);
    expect(
      (await t.request('GET', '/api/fx/rates?from=2024-01-01&to=2026-10-09', { headers: builder.headers }))
        .status,
    ).toBe(422);
    expect(
      (await t.request('GET', '/api/fx/rates?from=9-10-2026', { headers: builder.headers })).status,
    ).toBe(422);
    expect(await t.json('GET', '/api/fx/rates', { headers: builder.headers })).toEqual({
      from: '2026-09-09',
      to: '2026-10-09',
      rates: [],
    });
    expect(await t.json<FxStatusDTO>('GET', '/api/fx/status', { headers: builder.headers })).toEqual({
      today: '2026-10-09',
      enabled: true,
      session: '1700',
      runAtLocalTime: '18:00',
      retryAtLocalTimes: ['18:30', '21:00'],
      todayRecord: null,
      current: null,
      lastLive: null,
      carryForward: { days: 0, since: null, alertAfterDays: 3, alerted: false },
      openDiscrepancy: null,
      openDiscrepancyCount: 0,
    });
    await t.close();
  });

  it('schedules nothing and refuses manual runs when FX is disabled', async () => {
    const t = await fxRuntime({ enabled: false });
    await expect(t.rt.runJob('fx.daily')).rejects.toThrow(/unknown job/);
    await expect(t.rt.runJob('fx.retry@18:30')).rejects.toThrow(/unknown job/);
    const res = await t.request('POST', '/api/fx/run', { headers: t.user('approver').headers });
    expect(res.status).toBe(409);
    await t.close();
  });
});

describe('config', () => {
  it('defaults follow the BNM research: session 1700 from 18:00 MYT, 4-dp reconciliation, 1.25% soft flag, alert after 3 weekdays', () => {
    expect(AocConfigSchema.parse({}).fx).toEqual({
      enabled: true,
      session: '1700',
      runAtLocalTime: '18:00',
      retryAtLocalTimes: ['18:30', '21:00'],
      pageUrl: 'https://www.bnm.gov.my/exchange-rates',
      apiUrl: 'https://api.bnm.gov.my/public/exchange-rate/USD',
      extractor: 'claude-cli',
      sanity: { min: 3.5, max: 5.5, maxDailyChangePct: 3, softFlagPct: 1.25 },
      reconcileTolerance: 0.0001,
      carryForwardAlertWeekdays: 3,
    });
  });

  it('accepts an earlier schedule for session 1200, and refuses one that runs before its session or out of order', () => {
    const problems = (fx: Record<string, unknown>) => {
      const r = AocConfigSchema.safeParse({ fx });
      return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    };
    expect(
      problems({ session: '1200', runAtLocalTime: '13:00', retryAtLocalTimes: ['13:30', '15:00'] }),
    ).toEqual([]);
    expect(problems({ runAtLocalTime: '12:30' })).toEqual([
      'fx.runAtLocalTime: must be after the 1700 session (BNM publishes it about 40 minutes later)',
    ]);
    expect(problems({ retryAtLocalTimes: ['21:00', '18:30'] })).toEqual([
      'fx.retryAtLocalTimes.1: must be later than 21:00 (after runAtLocalTime, ascending)',
    ]);
    expect(problems({ runAtLocalTime: '6pm' })).toEqual([
      'fx.runAtLocalTime: expected HH:MM (24-hour local time)',
    ]);
    expect(problems({ session: '1130' })).toHaveLength(1);
    expect(problems({ apiUrl: 'api.bnm.gov.my' })).toHaveLength(1);
  });
});
