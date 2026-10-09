import { describe, expect, it } from 'vitest';
import type { CostPerOutcomeDTO } from '@aoc/contracts';
import { launch, meteringRuntime, myt, taskDone, usage } from './helpers';
import type { TestRuntime } from '@aoc/kernel';

const SYS = { kind: 'system', id: 'test' } as const;

function closeTicket(t: TestRuntime, ticketId: string, resolution: 'fixed' | 'wont_fix'): void {
  t.rt.store.append({
    type: 'ticket.closed',
    actor: SYS,
    scope: { ticketId },
    meta: { ticketId, resolution },
    payload: {},
    source: 'api',
  });
}

/** Every key anywhere in a JSON value. */
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (out.add(k), keysOf(x, out));
  return out;
}

describe('cost per outcome (portfolio lens)', () => {
  it('ties notional spend to tickets fixed, changes shipped and phases completed, with medians and p90', async () => {
    const t = await meteringRuntime();
    const approver = t.user('approver');
    const alice = t.user('builder', 'Alice');

    // tkt_1: launched for the ticket ($4) + a triage session ($10)
    launch(t, { sessionId: 'ses_1', ownerId: alice.user.id, ticketId: 'tkt_1' });
    usage(t, 'ses_1', { input: 1_000_000 });
    launch(t, { sessionId: 'ses_2', ownerId: null, processType: 'bug-triage', model: 'claude-sonnet-5-5' });
    t.rt.store.append({
      type: 'ticket.triage_started',
      actor: SYS,
      meta: { ticketId: 'tkt_1', sessionIds: ['ses_2'], budgetTokens: 1000, budgetMinutes: 30 },
      source: 'intake',
    });
    usage(t, 'ses_2', { model: 'claude-sonnet-5-5', output: 1_000_000 });
    // tkt_2 + chg_1: one build session ($20)
    launch(t, { sessionId: 'ses_3', ownerId: alice.user.id });
    t.rt.store.append({
      type: 'ticket.build_started',
      actor: SYS,
      meta: { ticketId: 'tkt_2', sessionId: 'ses_3', changeId: 'chg_1' },
      source: 'intake',
    });
    usage(t, 'ses_3', { output: 1_000_000 });
    // ses_4 drafted chg_2 and started chg_3: its $2 is split evenly between them
    launch(t, { sessionId: 'ses_4', ownerId: alice.user.id });
    t.rt.store.append({
      type: 'change.drafted',
      actor: { kind: 'human', id: alice.user.id },
      meta: {
        changeId: 'chg_2',
        projectId: 'prj_a',
        scope: 'reversible_off_main',
        draftedBy: 'ai',
        sessionId: 'ses_4',
        breakglassId: null,
      },
      payload: {
        title: 't',
        impact: 'i',
        mitigation: 'm',
        rollbackPlan: 'r',
        rollbackRef: 'abc1234',
        acceptanceTest: 'a',
      },
      source: 'api',
    });
    t.rt.store.append({
      type: 'change.started',
      actor: SYS,
      meta: { changeId: 'chg_3', sessionId: 'ses_4' },
      source: 'supervisor',
    });
    usage(t, 'ses_4', { input: 500_000 });
    // phase prj_p/ph1: $4 attributed to its task + $8 unattributed in a session launched into the phase; ph2 work excluded
    launch(t, { sessionId: 'ses_5', ownerId: alice.user.id, projectId: 'prj_p', phaseId: 'ph1' });
    usage(t, 'ses_5', { input: 1_000_000 });
    taskDone(t, { sessionId: 'ses_5', taskId: 't1', projectId: 'prj_p', phaseId: 'ph1' });
    usage(t, 'ses_5', { input: 2_000_000 });
    launch(t, { sessionId: 'ses_6', ownerId: alice.user.id, projectId: 'prj_p', phaseId: 'ph2' });
    usage(t, 'ses_6', { input: 1_000_000 });
    taskDone(t, { sessionId: 'ses_6', taskId: 't9', projectId: 'prj_p', phaseId: 'ph2' });

    closeTicket(t, 'tkt_1', 'fixed');
    closeTicket(t, 'tkt_2', 'fixed');
    closeTicket(t, 'tkt_3', 'wont_fix');
    for (const changeId of ['chg_1', 'chg_2']) {
      t.rt.store.append({
        type: 'change.completed',
        actor: SYS,
        meta: { changeId, pinnedSha: 'abc1234', pinnedTag: null },
        source: 'supervisor',
      });
    }
    t.rt.store.append({
      type: 'phase.completed',
      actor: SYS,
      meta: { sessionId: 'ses_5', projectId: 'prj_p', phaseId: 'ph1', pinnedSha: null, pinnedTag: null },
      source: 'mcp',
    });
    t.clock.set(myt('2026-10-10', '09:00'));
    t.rt.store.append({
      type: 'phase.completed',
      actor: SYS,
      meta: { sessionId: 'ses_6', projectId: 'prj_p', phaseId: 'ph2', pinnedSha: null, pinnedTag: null },
      source: 'mcp',
    });

    const dto = await t.json<CostPerOutcomeDTO>(
      'GET',
      '/api/metering/cost-per-outcome?from=2026-10-09&to=2026-10-09',
      { headers: approver.headers },
    );
    expect(dto).toMatchObject({ lens: 'portfolio', costBasis: 'notional_api_equivalent' });
    expect(dto.notice).toMatch(/never a ranking of individuals/);
    expect(dto.ticketsFixed.items.map((i) => [i.refId, i.notionalUsd, i.sessions, i.projectId])).toEqual([
      ['tkt_1', 14, 2, 'prj_a'],
      ['tkt_2', 20, 1, 'prj_a'],
    ]);
    expect(dto.ticketsFixed.stats).toEqual({
      count: 2,
      totalUsd: 34,
      meanUsd: 17,
      medianUsd: 17,
      p90Usd: 19.4,
      minUsd: 14,
      maxUsd: 20,
    });
    expect(dto.changesShipped.items.map((i) => [i.refId, i.notionalUsd])).toEqual([
      ['chg_1', 20],
      ['chg_2', 1],
    ]);
    expect(dto.changesShipped.stats).toMatchObject({ count: 2, medianUsd: 10.5, p90Usd: 18.1 });
    expect(dto.phasesCompleted.items).toMatchObject([
      { refId: 'prj_p/ph1', projectId: 'prj_p', notionalUsd: 12, sessions: 1, unpriced: false },
    ]);
    expect(dto.phasesCompleted.stats).toMatchObject({ count: 1, medianUsd: 12, p90Usd: 12 });

    // portfolio only: no per-person field anywhere, and no person id leaks through values either
    const keys = [...keysOf(dto)];
    expect(keys.filter((k) => /actor|owner|user|person|people|developer|builder|requester/i.test(k))).toEqual(
      [],
    );
    expect(JSON.stringify(dto)).not.toContain(alice.user.id);

    const next = await t.json<CostPerOutcomeDTO>(
      'GET',
      '/api/metering/cost-per-outcome?from=2026-10-10&to=2026-10-10',
      { headers: approver.headers },
    );
    expect(next.phasesCompleted.items.map((i) => [i.refId, i.notionalUsd])).toEqual([['prj_p/ph2', 4]]);
    expect(next.ticketsFixed.stats).toEqual({
      count: 0,
      totalUsd: 0,
      meanUsd: null,
      medianUsd: null,
      p90Usd: null,
      minUsd: null,
      maxUsd: null,
    });

    expect(
      (await t.request('GET', '/api/metering/cost-per-outcome?mine=1', { headers: alice.headers })).status,
    ).toBe(400);
    expect(
      (await t.request('GET', '/api/metering/cost-per-outcome', { headers: t.user('requester').headers }))
        .status,
    ).toBe(403);
    expect(
      (await t.request('GET', '/api/metering/cost-per-outcome', { headers: alice.headers })).status,
    ).toBe(200);
    await t.close();
  });
});
