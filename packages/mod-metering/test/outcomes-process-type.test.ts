import { describe, expect, it } from 'vitest';
import type { CostPerOutcomeDTO } from '@aoc/contracts';
import { buildStarted, closeTicket, launch, meteringRuntime, phaseCompleted, usage } from './helpers';

const processTypes = (dto: CostPerOutcomeDTO) =>
  Object.fromEntries(
    [...dto.ticketsFixed.items, ...dto.phasesCompleted.items].map((i) => [i.refId, i.processType]),
  );

describe('process type of an outcome', () => {
  it('is the one that carries most of its spend, a session shared between outcomes counting by its share', async () => {
    const t = await meteringRuntime();
    const approver = t.user('approver');
    // ses_big (feature, $10) serves both tickets: $5 each. ses_fix (bug-fix, $6) serves tkt_x only.
    launch(t, { sessionId: 'ses_big', ticketId: 'tkt_x', processType: 'feature' });
    buildStarted(t, { ticketId: 'tkt_y', sessionId: 'ses_big' });
    usage(t, 'ses_big', { output: 500_000 });
    launch(t, { sessionId: 'ses_fix', ticketId: 'tkt_x', processType: 'bug-fix' });
    usage(t, 'ses_fix', { input: 1_500_000 });
    closeTicket(t, 'tkt_x');
    closeTicket(t, 'tkt_y');

    const dto = await t.json<CostPerOutcomeDTO>('GET', '/api/metering/cost-per-outcome', {
      headers: approver.headers,
    });
    expect(dto.ticketsFixed.items.map((i) => [i.refId, i.notionalUsd])).toEqual([
      ['tkt_x', 11],
      ['tkt_y', 5],
    ]);
    // unweighted, feature ($10) would outrank bug-fix ($6) on tkt_x
    expect(processTypes(dto)).toEqual({ tkt_x: 'bug-fix', tkt_y: 'feature' });
    await t.close();
  });

  it('is null when the leading process types tie, when usage of no known process type leads, and when nothing was spent', async () => {
    const t = await meteringRuntime();
    const approver = t.user('approver');
    launch(t, { sessionId: 'ses_1', ticketId: 'tkt_tie', processType: 'feature' });
    usage(t, 'ses_1', { input: 1_000_000 });
    launch(t, { sessionId: 'ses_2', ticketId: 'tkt_tie', processType: 'bug-fix' });
    usage(t, 'ses_2', { input: 1_000_000 });

    launch(t, { sessionId: 'ses_3', ticketId: 'tkt_unknown', processType: 'feature' });
    usage(t, 'ses_3', { input: 1_000_000 }); // $4
    usage(t, 'ses_observed', { input: 2_000_000 }); // $8, a session the platform never described
    buildStarted(t, { ticketId: 'tkt_unknown', sessionId: 'ses_observed' });

    launch(t, { sessionId: 'ses_4', ticketId: 'tkt_idle', processType: 'feature' });
    for (const id of ['tkt_tie', 'tkt_unknown', 'tkt_idle']) closeTicket(t, id);

    const dto = await t.json<CostPerOutcomeDTO>('GET', '/api/metering/cost-per-outcome', {
      headers: approver.headers,
    });
    expect(dto.ticketsFixed.items.map((i) => [i.refId, i.notionalUsd])).toEqual([
      ['tkt_idle', 0],
      ['tkt_tie', 8],
      ['tkt_unknown', 12],
    ]);
    expect(processTypes(dto)).toEqual({ tkt_tie: null, tkt_unknown: null, tkt_idle: null });
    await t.close();
  });

  it('names a phase by the process type that spent most inside it', async () => {
    const t = await meteringRuntime();
    const approver = t.user('approver');
    launch(t, { sessionId: 'ses_1', projectId: 'prj_p', phaseId: 'ph1', processType: 'discovery' });
    usage(t, 'ses_1', { input: 1_000_000 }); // $4
    launch(t, { sessionId: 'ses_2', projectId: 'prj_p', phaseId: 'ph1', processType: 'feature-build' });
    usage(t, 'ses_2', { output: 600_000 }); // $12
    launch(t, { sessionId: 'ses_3', projectId: 'prj_p', phaseId: 'ph2', processType: 'discovery' });
    usage(t, 'ses_3', { output: 5_000_000 }); // another phase: no part of ph1
    phaseCompleted(t, { sessionId: 'ses_2', projectId: 'prj_p', phaseId: 'ph1' });

    const dto = await t.json<CostPerOutcomeDTO>('GET', '/api/metering/cost-per-outcome', {
      headers: approver.headers,
    });
    expect(dto.phasesCompleted.items).toMatchObject([
      { refId: 'prj_p/ph1', notionalUsd: 16, sessions: 2, processType: 'feature-build' },
    ]);
    await t.close();
  });

  it('states the rule and the ringgit basis in the response’s method text', async () => {
    const t = await meteringRuntime();
    const dto = await t.json<CostPerOutcomeDTO>('GET', '/api/metering/cost-per-outcome', {
      headers: t.user('approver').headers,
    });
    expect(dto.method.processType).toMatch(/largest share of the outcome’s notional spend/);
    expect(dto.method.processType).toMatch(/tie/);
    expect(dto.method.fx).toMatch(/that day’s stamped/);
    expect(dto.method.fx).toMatch(/4 decimal/);
    expect(dto.method.fx).toMatch(/never an average/i);
    await t.close();
  });
});
