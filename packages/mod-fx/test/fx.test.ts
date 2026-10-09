import { describe, expect, it } from 'vitest';
import type { FxRateDTO, FxRunResultDTO, FxStatusDTO, MetaOf, Notification } from '@aoc/contracts';
import type { TestRuntime } from '@aoc/kernel';
import {
  API_URL,
  at,
  bnmApi,
  bnmPage,
  closeDay,
  fxRuntime,
  honestModel,
  PAGE_URL,
  ratesApi,
  recorded,
  runDaily,
  wrongModel,
} from './helpers';

const live = (date: string, rate: number, extractor: 'haiku' | 'sonnet' = 'haiku') =>
  ({
    date,
    pair: 'USD/MYR',
    rate,
    status: 'live',
    sourceDate: date,
    extractor,
    validation: 'pass',
    reason: 'fetched',
  }) as const;

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

describe('daily FX run', () => {
  it('records a live rate: Haiku extraction reconciled with the BNM published figure, at the configured local time', async () => {
    const t = await fxRuntime();
    t.http.page(bnmPage({ date: '2026-10-09', mid: 4.213 })).api(bnmApi({ date: '2026-10-09', mid: 4.213 }));
    t.llm.on('fx.extract@haiku', honestModel);

    at(t, '2026-10-09', '12:00');
    expect(await t.rt.tickJobs()).toEqual([]);
    at(t, '2026-10-09', '12:31');
    expect(await t.rt.tickJobs()).toEqual(['fx.daily']);
    expect(await t.rt.tickJobs()).toEqual([]);

    expect(recorded(t)).toEqual([live('2026-10-09', 4.213)]);
    expect(t.llm.calls.map((c) => [c.model, c.purpose])).toEqual([['haiku', 'fx.extract']]);
    expect([t.http.count(PAGE_URL), t.http.count(API_URL)]).toEqual([1, 1]);
    const fx = t.rt.services.get('fx');
    expect(fx.rateFor('2026-10-09')).toEqual({ rate: 4.213, status: 'live', sourceDate: '2026-10-09' });
    expect(fx.rateFor('2026-10-08')).toBeNull();

    const builder = t.user('builder');
    const [dto] = await ratesApi(t, builder.headers, '2026-10-01', '2026-10-09');
    expect(dto).toMatchObject({
      rate: 4.213,
      flagged: false,
      official: 4.213,
      officialDate: '2026-10-09',
      session: '12:00 noon',
      closed: false,
      revisions: 1,
      recordedBy: 'scheduler:fx',
      problems: [],
    });
    expect(dto!.rawExcerpt).toContain('USD | 1 U.S. Dollar | 4.2080 | 4.2180 | 4.2130');
    expect(t.rt.store.verifyChain().ok).toBe(true);
    await t.close();
  });

  it('carries Friday forward over the weekend by design — no fetch, no LLM, not flagged', async () => {
    const t = await fxRuntime();
    t.http.page(bnmPage({ date: '2026-10-09', mid: 4.213 })).api(bnmApi({ date: '2026-10-09', mid: 4.213 }));
    t.llm.on('fx.extract@haiku', honestModel);
    await runDaily(t, '2026-10-09');
    await runDaily(t, '2026-10-10');
    await runDaily(t, '2026-10-11');

    const weekend = {
      pair: 'USD/MYR',
      rate: 4.213,
      status: 'inherited',
      sourceDate: '2026-10-09',
      extractor: 'none',
      validation: 'not_applicable',
      reason: 'weekend_or_holiday',
    };
    expect(recorded(t)).toEqual([
      live('2026-10-09', 4.213),
      { date: '2026-10-10', ...weekend },
      { date: '2026-10-11', ...weekend },
    ]);
    expect(t.http.calls).toHaveLength(2);
    expect(t.llm.calls).toHaveLength(1);
    const rates = await ratesApi(t, t.user('builder').headers, '2026-10-09', '2026-10-11');
    expect(rates.map((r) => r.flagged)).toEqual([false, false, false]);
    expect(t.rt.services.get('fx').rateFor('2026-10-12')).toEqual({
      rate: 4.213,
      status: 'inherited',
      sourceDate: '2026-10-09',
    });
    await t.close();
  });

  it('bootstraps a first run on a weekend from the last publication the page shows', async () => {
    const t = await fxRuntime();
    t.http.page(bnmPage({ date: '2026-10-09', mid: 4.213 })).api(bnmApi({ date: '2026-10-09', mid: 4.213 }));
    t.llm.on('fx.extract@haiku', honestModel);
    await runDaily(t, '2026-10-10');
    await runDaily(t, '2026-10-11');
    expect(recorded(t).map((m) => [m.date, m.rate, m.status, m.sourceDate, m.extractor, m.reason])).toEqual([
      ['2026-10-10', 4.213, 'inherited', '2026-10-09', 'haiku', 'weekend_or_holiday'],
      ['2026-10-11', 4.213, 'inherited', '2026-10-09', 'none', 'weekend_or_holiday'],
    ]);
    expect(t.http.count(PAGE_URL)).toBe(1);
    await t.close();
  });

  it('stamps a weekday holiday inherited from the older publication date the page still shows', async () => {
    const t = await fxRuntime();
    t.http.page(bnmPage({ date: '2026-10-09', mid: 4.213 })).api(bnmApi({ date: '2026-10-09', mid: 4.213 }));
    t.llm.on('fx.extract@haiku', honestModel);
    await runDaily(t, '2026-10-09');
    await runDaily(t, '2026-10-12'); // Monday: BNM closed, page still shows Friday
    expect(recorded(t).at(-1)).toEqual({
      date: '2026-10-12',
      pair: 'USD/MYR',
      rate: 4.213,
      status: 'inherited',
      sourceDate: '2026-10-09',
      extractor: 'haiku',
      validation: 'pass',
      reason: 'weekend_or_holiday',
    });
    const [mon] = await ratesApi(t, t.user('builder').headers, '2026-10-12', '2026-10-12');
    expect(mon!.flagged).toBe(false);
    await t.close();
  });

  it('records the scraped figure with validation pass when the BNM API is unavailable', async () => {
    const t = await fxRuntime();
    t.http.page(bnmPage({ date: '2026-10-09', mid: 4.213 })).api({ status: 502, body: 'Bad Gateway' });
    t.llm.on('fx.extract@haiku', honestModel);
    await runDaily(t, '2026-10-09');
    expect(recorded(t)).toEqual([live('2026-10-09', 4.213)]);
    const [dto] = await ratesApi(t, t.user('builder').headers, '2026-10-09', '2026-10-09');
    expect(dto).toMatchObject({ official: null, flagged: false });
    expect(dto!.notes).toMatch(/BNM Open API unavailable \(api_http_status: HTTP 502\)/);
    await t.close();
  });
});

describe("carry forward yesterday's rate (flagged)", () => {
  it.each([
    ['a network error', new Error('getaddrinfo ENOTFOUND www.bnm.gov.my'), 'page_network_error'],
    ['HTTP 503', { status: 503, body: 'Service Unavailable' }, 'page_http_status'],
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
        .page(bnmPage({ date: '2026-10-08', mid: 4.2 }), response)
        .api(bnmApi({ date: '2026-10-08', mid: 4.2 }));
      t.llm.on('fx.extract@haiku', honestModel);
      await runDaily(t, '2026-10-08');
      await runDaily(t, '2026-10-09');
      expect(recorded(t)[1]).toEqual({
        date: '2026-10-09',
        pair: 'USD/MYR',
        rate: 4.2,
        status: 'inherited',
        sourceDate: '2026-10-08',
        extractor: 'none',
        validation: 'not_applicable',
        reason: 'source_unreadable',
      });
      expect(t.llm.calls).toHaveLength(1);
      expect(t.http.count(API_URL)).toBe(1);
      const [fri] = await ratesApi(t, t.user('builder').headers, '2026-10-09', '2026-10-09');
      expect(fri).toMatchObject({ flagged: true, problems: [problem] });
      await t.close();
    },
  );

  it('escalates a Haiku figure that fails self-validation to Sonnet once, and records Sonnet’s valid figure', async () => {
    const t = await fxRuntime();
    t.http.page(bnmPage({ date: '2026-10-09', mid: 4.213 })).api(bnmApi({ date: '2026-10-09', mid: 4.213 }));
    t.llm.on('fx.extract@haiku', wrongModel(4.231)).on('fx.extract@sonnet', honestModel);
    await runDaily(t, '2026-10-09');
    expect(recorded(t)).toEqual([live('2026-10-09', 4.213, 'sonnet')]);
    expect(t.llm.calls.map((c) => c.model)).toEqual(['haiku', 'sonnet']);
    expect(t.llm.calls[1]!.prompt).toContain('failed these automatic checks: rate_not_in_source');
    await t.close();
  });

  it('stops after Sonnet also fails and carries yesterday forward — the bad figure is never written', async () => {
    const t = await fxRuntime();
    t.http
      .page(bnmPage({ date: '2026-10-08', mid: 4.2 }), bnmPage({ date: '2026-10-09', mid: 4.213 }))
      .api(bnmApi({ date: '2026-10-08', mid: 4.2 }));
    t.llm
      .on('fx.extract@haiku', honestModel)
      .on('fx.extract@haiku', wrongModel(4.231))
      .on('fx.extract@sonnet', wrongModel(4.213, '2026-10-12'));
    await runDaily(t, '2026-10-08');
    await runDaily(t, '2026-10-09');
    expect(recorded(t)[1]).toEqual({
      date: '2026-10-09',
      pair: 'USD/MYR',
      rate: 4.2,
      status: 'inherited',
      sourceDate: '2026-10-08',
      extractor: 'sonnet',
      validation: 'fail',
      reason: 'validation_failed',
    });
    expect(t.llm.calls.map((c) => c.model)).toEqual(['haiku', 'haiku', 'sonnet']);
    expect(t.http.count(API_URL)).toBe(1);
    const [fri] = await ratesApi(t, t.user('builder').headers, '2026-10-09', '2026-10-09');
    expect(fri).toMatchObject({
      flagged: true,
      problems: ['haiku:rate_not_in_source', 'sonnet:date_in_future'],
    });
    expect(recorded(t).some((m) => m.rate === 4.231 || m.date === '2026-10-12')).toBe(false);
    await t.close();
  });

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
    expect(t.http.count(API_URL)).toBe(0);
    expect(notes).toContainEqual(
      expect.objectContaining({ kind: 'fx.alert', severity: 'danger', refs: { date: '2026-10-09' } }),
    );
    await t.close();
  });
});

describe('reconciliation with the BNM published figure', () => {
  it('re-fetches once on a mismatch and records the figure that then reconciles', async () => {
    const t = await fxRuntime();
    t.http
      .page(bnmPage({ date: '2026-10-09', mid: 4.1 }), bnmPage({ date: '2026-10-09', mid: 4.15 }))
      .api(bnmApi({ date: '2026-10-09', mid: 4.15 }));
    t.llm.on('fx.extract@haiku', honestModel);
    await runDaily(t, '2026-10-09');
    expect(recorded(t)).toEqual([live('2026-10-09', 4.15)]);
    expect([t.http.count(PAGE_URL), t.http.count(API_URL)]).toEqual([2, 2]);
    expect(metas(t, 'fx.discrepancy_raised')).toEqual([]);
    expect(t.decisions!.list()).toEqual([]);
    await t.close();
  });

  it('raises a discrepancy decision carrying both figures when the re-fetch still disagrees, then applies the approver’s choice', async () => {
    const t = await fxRuntime();
    t.http
      .page(bnmPage({ date: '2026-10-08', mid: 4.12 }), bnmPage({ date: '2026-10-09', mid: 4.1 }))
      .api(bnmApi({ date: '2026-10-08', mid: 4.12 }), bnmApi({ date: '2026-10-09', mid: 4.15 }));
    t.llm.on('fx.extract@haiku', honestModel);
    await runDaily(t, '2026-10-08');
    await runDaily(t, '2026-10-09');
    expect([t.http.count(PAGE_URL), t.http.count(API_URL)]).toEqual([3, 3]);

    const [raised] = metas(t, 'fx.discrepancy_raised');
    expect(raised).toEqual({
      date: '2026-10-09',
      scraped: 4.1,
      official: 4.15,
      decisionId: expect.any(String),
      scrapedDate: '2026-10-09',
      officialDate: '2026-10-09',
      extractor: 'haiku',
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
    expect(card.context).toContain('Conflicting figure: 4.1500 from the BNM Open API');
    expect(recorded(t)[1]).toEqual({
      date: '2026-10-09',
      pair: 'USD/MYR',
      rate: 4.12,
      status: 'inherited',
      sourceDate: '2026-10-08',
      extractor: 'haiku',
      validation: 'fail',
      reason: 'discrepancy_pending',
    });

    const approver = t.user('approver');
    const builder = t.user('builder');
    const status = await t.json<FxStatusDTO>('GET', '/api/fx/status', { headers: builder.headers });
    expect(status.openDiscrepancy).toMatchObject({
      date: '2026-10-09',
      scraped: 4.1,
      official: 4.15,
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
    t.http.page(bnmPage({ date: '2026-10-09', mid: 4.1 })).api(bnmApi({ date: '2026-10-09', mid: 4.15 }));
    t.llm.on('fx.extract@haiku', honestModel);
    await runDaily(t, '2026-10-09'); // first run ever: nothing to carry forward while it is open
    const [raised] = metas(t, 'fx.discrepancy_raised');
    expect(recorded(t)).toEqual([]);

    const approver = t.user('approver');
    const dto = await t.json<FxRateDTO>('POST', '/api/fx/rates/2026-10-09/override', {
      headers: approver.headers,
      body: { rate: 4.1475, reason: 'Confirmed against the BNM 12:00 noon table' },
    });
    expect(dto).toMatchObject({
      date: '2026-10-09',
      rate: 4.1475,
      status: 'live',
      extractor: 'manual',
      validation: 'not_applicable',
      reason: 'manual_override',
      recordedBy: approver.user.id,
      notes: 'Confirmed against the BNM 12:00 noon table',
    });
    expect(t.decisions!.get(raised!.decisionId)!.resolution).toMatchObject({
      optionId: 'manual',
      resolvedBy: approver.user.id,
      comment: 'Confirmed against the BNM 12:00 noon table',
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

describe('carry-forward alert', () => {
  it('alerts once per streak after N consecutive carried-forward weekdays; weekends do not count', async () => {
    const t = await fxRuntime({ carryForwardAlertDays: 3 });
    const down = { status: 503, body: 'Service Unavailable' };
    t.http
      .page(bnmPage({ date: '2026-10-08', mid: 4.2 }), down)
      .api(bnmApi({ date: '2026-10-08', mid: 4.2 }));
    t.llm.on('fx.extract@haiku', honestModel);
    const notes = notifications(t);
    const alerts = () => metas(t, 'fx.carry_forward_alert');

    for (const d of ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12'])
      await runDaily(t, d); // Thu live, Fri, (Sat, Sun), Mon
    expect(alerts()).toEqual([]);
    await runDaily(t, '2026-10-13'); // Tue: 3rd carried-forward weekday
    expect(alerts()).toEqual([{ consecutiveDays: 3, since: '2026-10-09', date: '2026-10-13' }]);
    expect(notes.filter((n) => n.kind === 'fx.alert')).toEqual([
      expect.objectContaining({
        severity: 'warn',
        audience: ['approver', 'builder'],
        refs: { since: '2026-10-09', date: '2026-10-13' },
        title: expect.stringMatching(/3 weekdays in a row/),
      }),
    ]);
    await runDaily(t, '2026-10-14'); // Wed: same streak, no second alert
    expect(alerts()).toHaveLength(1);
    const status = await t.json<FxStatusDTO>('GET', '/api/fx/status', { headers: t.user('builder').headers });
    expect(status.carryForward).toEqual({ days: 4, since: '2026-10-09', alertAfterDays: 3, alerted: true });
    expect(status.lastLive).toEqual({ date: '2026-10-08', rate: 4.2 });

    t.http
      .clear()
      .page(bnmPage({ date: '2026-10-15', mid: 4.21 }), down)
      .api(bnmApi({ date: '2026-10-15', mid: 4.21 }));
    for (const d of ['2026-10-15', '2026-10-16', '2026-10-19']) await runDaily(t, d); // live Thu ends the streak; Fri, Mon carried
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
      .api(bnmApi({ date: '2026-10-08', mid: 4.2 }), bnmApi({ date: '2026-10-09', mid: 4.213 }));
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

    const res = await override('2026-10-09', { rate: 4.2205, reason: 'BNM revised the noon fixing' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      date: '2026-10-09',
      rate: 4.2205,
      status: 'live',
      extractor: 'manual',
      reason: 'manual_override',
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
      .api(
        bnmApi({ date: '2026-10-09', mid: 4.213 }),
        bnmApi({ date: '2026-10-12', mid: 4.25 }),
        bnmApi({ date: '2026-10-13', mid: 4.24 }),
      );
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
      ]);

    // Monday's move does not reach back into the weekend that inherited Friday's rate.
    expect(await view()).toEqual([
      ['2026-10-09', 4.213, 'live', '2026-10-09', 'fetched'],
      ['2026-10-10', 4.213, 'inherited', '2026-10-09', 'weekend_or_holiday'],
      ['2026-10-11', 4.213, 'inherited', '2026-10-09', 'weekend_or_holiday'],
      ['2026-10-12', 4.25, 'live', '2026-10-12', 'fetched'],
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
  it('guards reads (audit.view / ratecard.edit) and the approver-only run trigger', async () => {
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
      runAtLocalTime: '12:30',
      todayRecord: null,
      current: null,
      lastLive: null,
      carryForward: { days: 0, since: null, alertAfterDays: 4, alerted: false },
      openDiscrepancy: null,
      openDiscrepancyCount: 0,
    });
    await t.close();
  });

  it('schedules nothing and refuses manual runs when FX is disabled', async () => {
    const t = await fxRuntime({ enabled: false });
    await expect(t.rt.runJob('fx.daily')).rejects.toThrow(/unknown job/);
    const res = await t.request('POST', '/api/fx/run', { headers: t.user('approver').headers });
    expect(res.status).toBe(409);
    await t.close();
  });
});
