import { describe, expect, it } from 'vitest';
import {
  budgetUse,
  budgetsFrom,
  diagnosisOf,
  funnelOf,
  gatesOf,
  latestPromotion,
  latestRound,
  stageSpans,
  timelineEvents,
} from '../../src/pages/tickets/model';
import { describeEvent } from '../../src/pages/tickets/events';
import { MIN, NOW, diagnosis, event, history, ticket, ticketList } from './fixtures';

const people = {
  nameOf: (id: string) => ({ usr_daniel: 'Daniel Lim', usr_ceo: 'Chiew Sin Kwang' })[id] ?? null,
  activeApprovers: null,
};

describe('ticket pipeline', () => {
  it('counts tickets per stage in flow order with time in stage; done stages are terminal', () => {
    const f = funnelOf(ticketList(), NOW);
    expect(f.map((s) => s.id)).toEqual([
      'received',
      'triage',
      'awaiting_human',
      'fix_plan_gate',
      'building',
      'uat',
      'go_live_gate',
      'completed',
      'closed',
    ]);
    const gate = f.find((s) => s.id === 'fix_plan_gate')!;
    expect(gate).toMatchObject({ count: 1, oldestAgeMs: 35 * MIN, medianAgeMs: 35 * MIN, terminal: false });
    expect(f.find((s) => s.id === 'closed')).toMatchObject({ count: 1, terminal: true });
    expect(f.find((s) => s.id === 'closed')!.oldestAgeMs).toBeUndefined();
  });
});

describe('gates', () => {
  it('reads the fix-plan gate, UAT and go-live from the stage', () => {
    expect(gatesOf(ticket({ ticketId: 't', stage: 'fix_plan_gate' }))).toEqual({
      fixPlan: 'waiting',
      uat: 'not_reached',
      goLive: 'not_reached',
    });
    expect(gatesOf(ticket({ ticketId: 't', stage: 'go_live_gate', openDecisionIds: ['d'] }))).toEqual({
      fixPlan: 'passed',
      uat: 'passed',
      goLive: 'waiting',
    });
    expect(gatesOf(ticket({ ticketId: 't', stage: 'closed', resolution: 'duplicate' })).fixPlan).toBe(
      'skipped',
    );
  });

  it('flags a ticket that passed UAT but never reached the go-live gate', () => {
    expect(gatesOf(ticket({ ticketId: 't', stage: 'uat', openDecisionIds: [] }))).toEqual({
      fixPlan: 'passed',
      uat: 'passed',
      goLive: 'blocked',
    });
    expect(gatesOf(ticket({ ticketId: 't', stage: 'uat', openDecisionIds: ['dec_uat'] })).uat).toBe(
      'waiting',
    );
  });

  it('reads a failed, refused or rejected promotion at the go-live gate from its outcome', () => {
    const atGate = ticket({ ticketId: 't', stage: 'go_live_gate', openDecisionIds: [] });
    expect(gatesOf(atGate, { status: 'failed' }).goLive).toBe('failed');
    expect(gatesOf(atGate, { status: 'refused' }).goLive).toBe('failed');
    expect(gatesOf(atGate, { status: 'rejected' }).goLive).toBe('rejected');
    expect(gatesOf(atGate, { status: 'requested' }).goLive).toBe('waiting');
    // A completed ticket stays passed whatever an older promotion recorded.
    expect(gatesOf(ticket({ ticketId: 't', stage: 'completed' }), { status: 'failed' }).goLive).toBe(
      'passed',
    );
  });
});

describe('diagnosis and budget', () => {
  it('picks the most confident diagnosis and checks agreement on the root-cause class', () => {
    const d = diagnosisOf([diagnosis('a', { confidence: 0.6 }), diagnosis('b', { confidence: 0.82 })]);
    expect(d.best!.sessionId).toBe('b');
    expect(d.agree).toBe(true);
    expect(diagnosisOf([diagnosis('a'), diagnosis('b', { rootCauseClass: 'race' })]).agree).toBe(false);
    expect(diagnosisOf([diagnosis('a', { status: 'running', confidence: null })])).toMatchObject({
      best: null,
      running: 1,
    });
  });

  it('measures the latest triage round against its recorded budget', () => {
    const budgets = budgetsFrom(history());
    const b = budgets.get('tkt_01M4FC3GS5VXC370PY64VM0XE8')!;
    expect(b).toMatchObject({ tokens: 400_000, minutes: 30, sessionIds: ['ses_tri_a', 'ses_tri_b'] });
    expect(budgetUse(ticket({ ticketId: 'tkt_01M4FC3GS5VXC370PY64VM0XE8' }), b)).toMatchObject({
      used: 21_902,
      cap: 800_000,
      perAgent: 400_000,
      agents: 2,
    });
    expect(budgetUse(ticket({ ticketId: 'x' }), undefined)).toBeNull();
  });
});

describe('ticket history', () => {
  it('turns stage events into spans to scale, the last one open until now', () => {
    const spans = stageSpans(history(), NOW);
    expect(spans.map((s) => [s.stage, s.end - s.start, s.current])).toEqual([
      ['received', 0, false],
      ['triage', 5 * MIN, false],
      ['fix_plan_gate', 35 * MIN, true],
    ]);
  });

  it('keeps ticket-level events for the timeline and writes them from metadata only', () => {
    const lines = timelineEvents(history()).map((e) => describeEvent(e, people, new Map()).text);
    expect(lines).toEqual([
      'Submitted by Daniel Lim · severity high · 0 attachment(s)',
      'Read-only triage started: 2 agent(s), budget 400K tokens and 30 min each',
      'Diagnosis from ses_tri_a: confidence 82% · class unit-mismatch',
      'Fix-plan sign-off requested',
      'Fix plan submitted to the fix-plan gate',
    ]);
    const signed = describeEvent(
      event('decision.resolved', NOW, {
        decisionId: 'dec_g',
        kind: 'go_live',
        optionId: 'approve',
        resolvedBy: 'usr_ceo',
        method: 'passkey',
      }),
      people,
      new Map(),
    );
    expect(signed.text).toBe('Go-live resolved: approve — by Chiew Sin Kwang, signed (passkey)');
  });
});

describe('go-live and triage rounds', () => {
  it('follows the latest promotion of the ticket, including one requested again after a failure', () => {
    const evts = [
      ...history(),
      event('promotion.requested', NOW - 5 * MIN, { promotionId: 'prm_1' }),
      event('ticket.golive_requested', NOW - 5 * MIN, { decisionId: 'dec_go', promotionId: 'prm_1' }),
      event('promotion.failed', NOW - 4 * MIN, { promotionId: 'prm_1', reason: 'execution_error' }),
    ];
    expect(latestPromotion(evts)).toMatchObject({
      promotionId: 'prm_1',
      status: 'failed',
      reason: 'execution_error',
    });
    const retry = {
      ...event('promotion.requested', NOW - MIN, { promotionId: 'prm_2', targetBranch: 'main' }),
      actor: { kind: 'human' as const, id: 'usr_ceo' },
    };
    expect(latestPromotion([...evts, retry])).toMatchObject({ promotionId: 'prm_2', status: 'requested' });
    expect(describeEvent(retry, people, new Map()).text).toBe(
      'Promotion prm_2 requested to main by Chiew Sin Kwang',
    );
    expect(latestPromotion(history())).toBeNull();
  });

  it('summarises the latest triage round only', () => {
    const t = ticket({
      ticketId: 'tkt_x',
      diagnoses: [
        diagnosis('old_a', { rootCauseClass: 'unknown', confidence: 0.3 }),
        diagnosis('new_a'),
        diagnosis('new_b'),
      ],
    });
    const round = latestRound(t.diagnoses, {
      tokens: 400_000,
      minutes: 30,
      sessionIds: ['new_a', 'new_b'],
      startedAt: '',
    });
    expect(round.map((d) => d.sessionId)).toEqual(['new_a', 'new_b']);
    expect(diagnosisOf(round)).toMatchObject({ reported: 2, agree: true });
    expect(latestRound(t.diagnoses, undefined)).toHaveLength(3);
  });
});
