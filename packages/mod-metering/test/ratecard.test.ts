import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  MeteringDailyDTO,
  MeteringSubscriptionDTO,
  MeteringSummaryDTO,
  RateCardDTO,
  RateCardRate,
  RateCardVersionDTO,
  RateCardVersionsDTO,
} from '@aoc/contracts';
import { createMeteringModule } from '../src';
import { closeDays, launch, meteringRuntime, myt, RATE_CARD_FILE, StubFx, usage } from './helpers';

const fileRates = (JSON.parse(readFileSync(RATE_CARD_FILE, 'utf8')) as { rates: RateCardRate[] }).rates;
const withOpusInput = (price: number): RateCardRate[] =>
  fileRates.map((r) => (r.model === 'claude-opus-5-5' ? { ...r, inputPerMTok: price } : r));
const fx = (date: string, rate = 4.2) => ({ rate, status: 'live' as const, sourceDate: date });

describe('rate card', () => {
  it('publishes v1 from the configured file once (effectiveFrom from the file) and seeds the subscription', async () => {
    const t = await meteringRuntime();
    const approver = t.user('approver');
    const rc = await t.json<RateCardDTO>('GET', '/api/ratecard', { headers: approver.headers });
    expect(rc.costLabel).toMatch(/notional API-equivalent/i);
    expect(rc.active).toMatchObject({
      version: 1,
      effectiveFrom: '2026-10-01',
      status: 'active',
      currency: 'USD',
      erased: false,
      publishedBy: 'metering',
    });
    expect(rc.active!.rates).toHaveLength(7);
    expect(rc.active!.tierFallback).toMatchObject({ opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5' });
    expect(rc).toMatchObject({
      today: '2026-10-09',
      lastClosedDay: null,
      earliestEffectiveFrom: '2026-10-10',
      scheduled: [],
    });
    const [published] = t.rt.store.list({ types: ['ratecard.published'] });
    expect(published!.meta).toMatchObject({ version: 1, effectiveFrom: '2026-10-01', rateCount: 7 });
    expect(published!.meta.ratesHash).toMatch(/^[0-9a-f]{64}$/);

    // a restart never republishes v1 or re-seeds the subscription
    await createMeteringModule().start!(t.rt.ctx);
    expect(t.rt.store.list({ types: ['ratecard.published'] })).toHaveLength(1);
    expect(t.rt.store.list({ types: ['subscription.updated'] })).toHaveLength(1);

    const sub = await t.json<MeteringSubscriptionDTO>('GET', '/api/metering/subscription', {
      headers: approver.headers,
    });
    expect(sub.basis).toBe('actual_subscription');
    expect(sub.active).toMatchObject({
      plan: 'max',
      seats: 5,
      monthlyUsdPerSeat: 200,
      monthlyUsd: 1000,
      effectiveFrom: '2026-10-01',
      status: 'active',
    });
    expect(sub.dailyUsdToday).toBeCloseTo(1000 / 31, 5);
    await t.close();
  });

  it('versions are immutable and edits apply forward only: today, past and invalid cards are rejected', async () => {
    const t = await meteringRuntime();
    const approver = t.user('approver');
    const builder = t.user('builder');
    const requester = t.user('requester');
    const put = (body: unknown, headers = approver.headers) =>
      t.request('PUT', '/api/ratecard', { headers, body });

    expect((await put({ rates: fileRates }, builder.headers)).status).toBe(403);
    expect((await t.request('GET', '/api/ratecard', { headers: requester.headers })).status).toBe(403);
    expect((await t.request('GET', '/api/ratecard', { headers: builder.headers })).status).toBe(200);

    const today = await put({ rates: fileRates, effectiveFrom: '2026-10-09' });
    expect(today.status).toBe(422);
    expect(await today.json()).toMatchObject({
      error: {
        code: 'forward_only',
        details: { reason: 'not_after_today', earliestEffectiveFrom: '2026-10-10' },
      },
    });
    expect((await put({ rates: fileRates, effectiveFrom: '2026-10-01' })).status).toBe(422);
    expect((await put({ rates: fileRates, effectiveFrom: '2026-02-30' })).status).toBe(422);
    expect((await put({ rates: [...fileRates, fileRates[0]] })).status).toBe(422);
    expect((await put({ rates: fileRates, tierFallback: { opus: 'claude-opus-99' } })).status).toBe(422);
    expect((await put({ rates: fileRates, effectiveFrom: '2030-01-01' })).status).toBe(422);
    expect(t.rt.store.list({ types: ['ratecard.published'] })).toHaveLength(1);

    // default effectiveFrom = tomorrow; an omitted tier fallback is inherited minus targets this card no longer prices
    const sonnetOpus = fileRates.filter(
      (r) => r.model === 'claude-opus-5-5' || r.model === 'claude-sonnet-5-5',
    );
    const v2 = await t.json<RateCardVersionDTO>('PUT', '/api/ratecard', {
      headers: approver.headers,
      body: { rates: sonnetOpus, note: 'trim' },
      expect: 201,
    });
    expect(v2).toMatchObject({
      version: 2,
      effectiveFrom: '2026-10-10',
      status: 'scheduled',
      note: 'trim',
      publishedBy: approver.user.id,
    });
    expect(v2.tierFallback).toEqual({ opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' });
    const v3 = await t.json<RateCardVersionDTO>('PUT', '/api/ratecard', {
      headers: approver.headers,
      body: { rates: fileRates, effectiveFrom: '2026-11-01' },
      expect: 201,
    });
    expect(v3.version).toBe(3);

    const rc = await t.json<RateCardDTO>('GET', '/api/ratecard', { headers: approver.headers });
    expect(rc.active?.version).toBe(1);
    expect(rc.scheduled.map((v) => v.version)).toEqual([2, 3]);
    const versions = await t.json<RateCardVersionsDTO>('GET', '/api/ratecard/versions', {
      headers: builder.headers,
    });
    expect(versions.versions.map((v) => [v.version, v.status])).toEqual([
      [3, 'scheduled'],
      [2, 'scheduled'],
      [1, 'active'],
    ]);
    // the published version 1 body is unchanged by later versions
    expect(versions.versions[2]!.rates).toEqual(fileRates);

    t.clock.set(myt('2026-10-10', '09:00'));
    const next = await t.json<RateCardDTO>('GET', '/api/ratecard', { headers: approver.headers });
    expect(next.active?.version).toBe(2);
    expect(t.rt.services.get('metering').activeRateCardVersion('2026-10-09')).toBe(1);
    expect(t.rt.services.get('metering').activeRateCardVersion('2026-11-02')).toBe(3);
    await t.close();
  });

  it('never restates a closed day after a rate edit, and rebuilding from the log reproduces every figure', async () => {
    const stub = new StubFx({
      '2026-10-09': fx('2026-10-09'),
      '2026-10-10': fx('2026-10-10'),
      '2026-10-11': fx('2026-10-11', 4.5),
    });
    const t = await meteringRuntime({ fx: stub });
    const approver = t.user('approver');
    launch(t, { sessionId: 'ses_1', ownerId: approver.user.id });
    usage(t, 'ses_1', { input: 1_000_000 }); // 10-09: $4 at v1

    t.clock.set(myt('2026-10-10', '00:20'));
    await closeDays(t);
    const put = (body: unknown) => t.request('PUT', '/api/ratecard', { headers: approver.headers, body });
    const closed = await put({ rates: withOpusInput(8), effectiveFrom: '2026-10-09' });
    expect(await closed.json()).toMatchObject({
      error: { code: 'forward_only', details: { reason: 'closed_day', lastClosedDay: '2026-10-09' } },
    });
    expect((await put({ rates: withOpusInput(8), effectiveFrom: '2026-10-10' })).status).toBe(422);
    // even with a skewed clock, a day at or before the last closed day can never be repriced
    t.clock.set(myt('2026-10-08', '12:00'));
    expect(await (await put({ rates: withOpusInput(8), effectiveFrom: '2026-10-09' })).json()).toMatchObject({
      error: { details: { reason: 'closed_day' } },
    });

    t.clock.set(myt('2026-10-10', '09:00'));
    expect(
      await t.json<RateCardVersionDTO>('PUT', '/api/ratecard', {
        headers: approver.headers,
        body: { rates: withOpusInput(8) },
        expect: 201,
      }),
    ).toMatchObject({
      version: 2,
      effectiveFrom: '2026-10-11',
    });
    usage(t, 'ses_1', { input: 1_000_000 }); // 10-10: still v1
    t.clock.set(myt('2026-10-11', '09:00'));
    usage(t, 'ses_1', { input: 1_000_000 }); // 10-11: v2

    const read = () =>
      t.json<MeteringDailyDTO>('GET', '/api/metering/daily?from=2026-10-09&to=2026-10-11', {
        headers: approver.headers,
      });
    const daily = await read();
    expect(daily.days.map((d) => [d.date, d.status, d.notionalUsd, d.rateCardVersion, d.notionalRm])).toEqual(
      [
        ['2026-10-09', 'closed', 4, 1, 16.8],
        ['2026-10-10', 'open', 4, 1, 16.8],
        ['2026-10-11', 'open', 8, 2, 36],
      ],
    );
    expect(daily.totals.notionalUsd).toBe(16);
    const rollups = t.rt.store.list({ types: ['rollup.closed'] });
    expect(rollups).toHaveLength(1);
    expect(rollups[0]!.meta).toMatchObject({ date: '2026-10-09', usdNotional: 4, rateCardVersion: 1 });

    t.rt.store.rebuildProjections(['metering']);
    expect({ ...(await read()), generatedAt: null }).toEqual({ ...daily, generatedAt: null });
    const summary = await t.json<MeteringSummaryDTO>(
      'GET',
      '/api/metering/summary?from=2026-10-09&to=2026-10-11&groupBy=model',
      { headers: approver.headers },
    );
    expect(summary.totals.notionalUsd).toBe(16);
    await t.close();
  });

  it('without a rate card file usage is unpriced; the first card prices still-open uncovered days', async () => {
    const t = await meteringRuntime({ rateCardFile: '/nonexistent/rate-card.json' });
    const approver = t.user('approver');
    launch(t, { sessionId: 'ses_1', ownerId: approver.user.id });
    usage(t, 'ses_1', { input: 1_000_000 });
    const before = await t.json<MeteringSummaryDTO>('GET', '/api/metering/summary?groupBy=model', {
      headers: approver.headers,
    });
    expect(before.totals).toMatchObject({
      notionalUsd: 0,
      unpriced: true,
      unpricedTokens: 1_000_000,
      unpricedModels: ['claude-opus-5-5'],
    });
    expect(
      (await t.json<RateCardDTO>('GET', '/api/ratecard', { headers: approver.headers })).active,
    ).toBeNull();

    await createMeteringModule({ rateCardFile: RATE_CARD_FILE }).start!(t.rt.ctx);
    const after = await t.json<MeteringSummaryDTO>('GET', '/api/metering/summary?groupBy=model', {
      headers: approver.headers,
    });
    expect(after.totals).toMatchObject({ notionalUsd: 4, unpriced: false });
    await t.close();
  });
});
