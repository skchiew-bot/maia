import { describe, expect, it } from 'vitest';
import type { CostPerOutcomeDTO } from '@aoc/contracts';
import type { TestRuntime } from '@aoc/kernel';
import {
  buildStarted,
  closeDays,
  closeTicket,
  launch,
  meteringRuntime,
  myt,
  phaseCompleted,
  StubFx,
  usage,
} from './helpers';

const live = (date: string, rate: number) => ({ rate, status: 'live' as const, sourceDate: date });

const outcomes = (t: TestRuntime, headers: Record<string, string>, from: string, to = from) =>
  t.json<CostPerOutcomeDTO>('GET', `/api/metering/cost-per-outcome?from=${from}&to=${to}`, { headers });

/**
 * Two days with different rates (10-08 at 4.00, 10-09 at 5.00). tkt_a spends US$4 on the first day, tkt_b US$20 on
 * the second and tkt_c US$2 on the first plus US$10 on the second, so no single rate prices all three.
 * 10-08 is closed (its stamp is 4.00) before the source rate for that day is later restated; 10-09 stays open.
 */
async function twoDayPortfolio(rates: Record<string, ReturnType<typeof live>>) {
  const t = await meteringRuntime({ now: myt('2026-10-08', '10:00'), fx: new StubFx(rates) });
  const approver = t.user('approver');
  launch(t, { sessionId: 'ses_a', ticketId: 'tkt_a' });
  usage(t, 'ses_a', { input: 1_000_000 }); // opus $4
  launch(t, { sessionId: 'ses_c', ticketId: 'tkt_c', model: 'claude-sonnet-5-5' });
  usage(t, 'ses_c', { model: 'claude-sonnet-5-5', input: 1_000_000 }); // sonnet $2
  t.clock.set(myt('2026-10-09', '00:20'));
  await closeDays(t);
  rates['2026-10-08'] = live('2026-10-08', 9.9);
  t.clock.set(myt('2026-10-09', '10:00'));
  launch(t, { sessionId: 'ses_b', ticketId: 'tkt_b' });
  usage(t, 'ses_b', { output: 1_000_000 }); // opus $20
  usage(t, 'ses_c', { model: 'claude-sonnet-5-5', output: 1_000_000 }); // sonnet $10
  for (const id of ['tkt_a', 'tkt_b', 'tkt_c']) closeTicket(t, id);
  return { t, approver };
}

describe('cost per outcome in ringgit', () => {
  it('converts every usage day at that day’s own stamped rate, never an average rate over a total', async () => {
    const { t, approver } = await twoDayPortfolio({
      '2026-10-08': live('2026-10-08', 4),
      '2026-10-09': live('2026-10-09', 5),
    });
    const dto = await outcomes(t, approver.headers, '2026-10-09');
    // The portfolio's blend (US$36 → RM 174, 4.8333) would misprice the one-day outcomes: tkt_a at 19.33, tkt_b at 96.67.
    expect(dto.ticketsFixed.items.map((i) => [i.refId, i.notionalUsd, i.notionalRm, i.rmComplete])).toEqual([
      ['tkt_a', 4, 16, true], // all on 10-08: closed, so its stamp (4.00) holds although the source later says 9.90
      ['tkt_b', 20, 100, true], // all on 10-09 at 5.00
      ['tkt_c', 12, 58, true], // 2 × 4.00 + 10 × 5.00
    ]);
    expect(dto.ticketsFixed.stats).toMatchObject({
      count: 3,
      totalUsd: 36,
      medianUsd: 12,
      totalRm: 174,
      meanRm: 58,
      medianRm: 58,
      p90Rm: 91.6,
      minRm: 16,
      maxRm: 100,
      rmComplete: true,
    });
    await t.close();
  });

  it('leaves out a day with usage and no stamped rate, and says the RM is incomplete', async () => {
    const t = await meteringRuntime({
      now: myt('2026-10-08', '10:00'),
      fx: new StubFx({ '2026-10-08': live('2026-10-08', 4) }), // 10-09 has no rate at all
    });
    const approver = t.user('approver');
    launch(t, { sessionId: 'ses_a', ticketId: 'tkt_a' });
    usage(t, 'ses_a', { input: 1_000_000 }); // $4 on 10-08
    launch(t, { sessionId: 'ses_b', ticketId: 'tkt_b' });
    usage(t, 'ses_b', { input: 1_000_000 }); // $4 on 10-08
    launch(t, { sessionId: 'ses_c', ticketId: 'tkt_c' });
    launch(t, { sessionId: 'ses_d', ticketId: 'tkt_d' });
    usage(t, 'ses_d', { model: 'mystery-model', input: 5_000 }); // 10-08, priced at US$0
    t.clock.set(myt('2026-10-09', '10:00'));
    usage(t, 'ses_b', { output: 1_000_000 }); // $20 on 10-09, no rate
    usage(t, 'ses_c', { output: 1_000_000 }); // $20 on 10-09, no rate
    usage(t, 'ses_d', { model: 'mystery-model', input: 5_000 }); // 10-09: nothing to convert
    launch(t, { sessionId: 'ses_e', ticketId: 'tkt_e' }); // no usage at all
    for (const id of ['tkt_a', 'tkt_b', 'tkt_c', 'tkt_d', 'tkt_e']) closeTicket(t, id);
    t.rt.store.append({
      type: 'change.started',
      actor: { kind: 'system', id: 'test' },
      meta: { changeId: 'chg_1', sessionId: 'ses_c' },
      source: 'supervisor',
    });
    t.rt.store.append({
      type: 'change.completed',
      actor: { kind: 'system', id: 'test' },
      meta: { changeId: 'chg_1', pinnedSha: 'abc1234', pinnedTag: null },
      source: 'supervisor',
    });

    const dto = await outcomes(t, approver.headers, '2026-10-09');
    expect(
      dto.ticketsFixed.items.map((i) => [i.refId, i.notionalUsd, i.notionalRm, i.rmComplete, i.unpriced]),
    ).toEqual([
      ['tkt_a', 4, 16, true, false],
      ['tkt_b', 24, 16, false, false], // the 10-09 day is left out of the RM, not priced at some other rate
      ['tkt_c', 20, null, false, false], // no day with a rate: no figure at all
      ['tkt_d', 0, 0, true, true], // unpriced usage costs US$0, so it needs no rate
      ['tkt_e', 0, 0, true, false], // nothing spent, nothing to convert
    ]);
    expect(dto.ticketsFixed.stats).toEqual({
      count: 5,
      totalUsd: 48,
      meanUsd: 9.6,
      medianUsd: 4,
      p90Usd: 22.4,
      minUsd: 0,
      maxUsd: 24,
      // only tkt_a, tkt_d and tkt_e have a complete RM: 16, 0 and 0
      totalRm: 16,
      meanRm: 5.333333,
      medianRm: 0,
      p90Rm: 12.8,
      minRm: 0,
      maxRm: 16,
      rmComplete: false,
    });
    expect(dto.changesShipped.items.map((i) => [i.refId, i.notionalUsd, i.notionalRm, i.rmComplete])).toEqual(
      [['chg_1', 20, null, false]],
    );
    expect(dto.changesShipped.stats).toMatchObject({
      count: 1,
      totalUsd: 20,
      totalRm: null,
      meanRm: null,
      medianRm: null,
      p90Rm: null,
      minRm: null,
      maxRm: null,
      rmComplete: false,
    });
    expect(dto.phasesCompleted.stats).toMatchObject({ count: 0, totalRm: null, rmComplete: true });
    await t.close();
  });

  it('converts a phase day by day too, and a session shared between outcomes by its share', async () => {
    const t = await meteringRuntime({
      now: myt('2026-10-08', '10:00'),
      fx: new StubFx({ '2026-10-08': live('2026-10-08', 4), '2026-10-09': live('2026-10-09', 5) }),
    });
    const approver = t.user('approver');
    launch(t, { sessionId: 'ses_p', projectId: 'prj_p', phaseId: 'ph1' });
    usage(t, 'ses_p', { input: 1_000_000 }); // $4 on 10-08 → RM 16
    launch(t, { sessionId: 'ses_s', ticketId: 'tkt_a' });
    buildStarted(t, { ticketId: 'tkt_b', sessionId: 'ses_s' }); // ses_s serves two tickets
    usage(t, 'ses_s', { input: 1_000_000 }); // $4 on 10-08, $2 to each ticket
    t.clock.set(myt('2026-10-09', '10:00'));
    usage(t, 'ses_p', { output: 500_000 }); // $10 on 10-09 → RM 50
    usage(t, 'ses_s', { output: 500_000 }); // $10 on 10-09, $5 to each ticket
    closeTicket(t, 'tkt_a');
    closeTicket(t, 'tkt_b');
    phaseCompleted(t, { sessionId: 'ses_p', projectId: 'prj_p', phaseId: 'ph1' });

    const dto = await outcomes(t, approver.headers, '2026-10-09');
    expect(dto.phasesCompleted.items).toMatchObject([
      { refId: 'prj_p/ph1', notionalUsd: 14, notionalRm: 66, rmComplete: true, sessions: 1 },
    ]);
    // each ticket: $2 at 4.00 + $5 at 5.00
    expect(dto.ticketsFixed.items).toMatchObject([
      { refId: 'tkt_a', notionalUsd: 7, notionalRm: 33, rmComplete: true },
      { refId: 'tkt_b', notionalUsd: 7, notionalRm: 33, rmComplete: true },
    ]);
    await t.close();
  });

  it('rebuilding the projection from the log reproduces every figure, ringgit and process type included', async () => {
    const rates = { '2026-10-08': live('2026-10-08', 4), '2026-10-09': live('2026-10-09', 5) };
    const { t, approver } = await twoDayPortfolio(rates);
    launch(t, { sessionId: 'ses_p', projectId: 'prj_p', phaseId: 'ph1', processType: 'docs' });
    usage(t, 'ses_p', { input: 1_000_000 });
    phaseCompleted(t, { sessionId: 'ses_p', projectId: 'prj_p', phaseId: 'ph1' });
    const read = async () => ({
      ...(await outcomes(t, approver.headers, '2026-10-09')),
      generatedAt: null,
    });
    const before = await read();
    expect(before.ticketsFixed.items.map((i) => i.notionalRm)).toEqual([16, 100, 58]);
    expect(before.phasesCompleted.items).toMatchObject([{ notionalRm: 20, processType: 'docs' }]);

    t.rt.store.rebuildProjections(['metering']);
    expect(await read()).toEqual(before);
    await t.close();
  });
});
