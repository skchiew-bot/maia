import { describe, expect, it } from 'vitest';
import { validateTopup } from '../../src/pages/credits/CreditDialogs';
import {
  TOPUP_SLA_MS,
  capState,
  daysInPeriod,
  forecast,
  grantTrail,
  headroomTotal,
  nextPeriod,
  orphanTopupDecisions,
  periodClock,
  periodLabel,
  recentPeriods,
  teamForecast,
  topupAging,
} from '../../src/pages/credits/creditsModel';
import { account, decision, topup } from './fixtures';

const OCT_9 = periodClock('2026-10', '2026-10-09');

describe('periods', () => {
  it('counts days, including leap years', () => {
    expect(daysInPeriod('2026-10')).toBe(31);
    expect(daysInPeriod('2026-02')).toBe(28);
    expect(daysInPeriod('2028-02')).toBe(29);
  });

  it('places the daemon day inside the current, a past and a future period', () => {
    expect(OCT_9).toEqual({ period: '2026-10', days: 31, elapsed: 9, daysLeft: 22, current: true, end: '2026-10-31' });
    expect(periodClock('2026-09', '2026-10-09')).toMatchObject({ elapsed: 30, daysLeft: 0, current: false, end: '2026-09-30' });
    expect(periodClock('2026-11', '2026-10-09')).toMatchObject({ elapsed: 0, daysLeft: 0, current: false });
  });

  it('steps across year boundaries', () => {
    expect(recentPeriods('2026-01', 3)).toEqual(['2026-01', '2025-12', '2025-11']);
    expect(nextPeriod('2026-12')).toBe('2027-01');
    expect(periodLabel('2026-10')).toBe('October 2026');
  });
});

describe('cap state', () => {
  const pending = { requestId: 'ctu_1', decisionId: 'dec_ctu_1', amountUsd: 50, createdAt: '2026-10-09T03:00:00.000Z', ageMs: 10_800_000 };

  it('names where the account stands at the next task boundary', () => {
    expect(capState(account({ userId: 'u', userName: 'U', exempt: true, capped: true }))).toBe('exempt');
    expect(capState(account({ userId: 'u', userName: 'U', capped: true, pendingTopup: pending }))).toBe('capped_waiting');
    expect(capState(account({ userId: 'u', userName: 'U', capped: true }))).toBe('capped');
    expect(capState(account({ userId: 'u', userName: 'U', autoGrantUsed: true }))).toBe('on_auto_grant');
    expect(capState(account({ userId: 'u', userName: 'U' }))).toBe('within');
  });

  it('counts the unused auto-grant as headroom only until it is used', () => {
    expect(headroomTotal(account({ userId: 'u', userName: 'U' }))).toBe(375);
    expect(headroomTotal(account({ userId: 'u', userName: 'U', autoGrantUsed: true, grantedUsd: 75, autoGrantAvailableUsd: 0 }))).toBe(375);
  });
});

describe('forecast', () => {
  it('projects the period at its average daily pace', () => {
    const f = forecast(account({ userId: 'u', userName: 'U', usedUsd: 18 }), OCT_9);
    expect(f.perDayUsd).toBe(2);
    expect(f.projectedUsd).toBe(62);
    expect(f.status).toBe('on_track');
  });

  it('warns when the pace nears the allocation', () => {
    expect(forecast(account({ userId: 'u', userName: 'U', usedUsd: 90 }), OCT_9).status).toBe('tight');
  });

  it('dates the cap when the pace exhausts allocation, grants and the auto-grant inside the period', () => {
    const f = forecast(account({ userId: 'u', userName: 'U', usedUsd: 135 }), OCT_9);
    expect(f.projectedUsd).toBe(465);
    expect(f).toMatchObject({ status: 'cap_before_end', capDate: '2026-10-25' });
  });

  it('does not project closed periods, capped or exempt accounts', () => {
    expect(forecast(account({ userId: 'u', userName: 'U', usedUsd: 200 }), periodClock('2026-09', '2026-10-09'))).toMatchObject({
      status: 'closed',
      projectedUsd: 200,
    });
    expect(forecast(account({ userId: 'u', userName: 'U', capped: true, usedUsd: 400 }), OCT_9).status).toBe('capped');
    expect(forecast(account({ userId: 'u', userName: 'U', exempt: true, usedUsd: 900 }), OCT_9).status).toBe('exempt');
  });

  it('lists people reaching the cap alphabetically for capacity planning, never by usage', () => {
    const team = teamForecast(
      [
        account({ userId: 'usr_z', userName: 'Zainab', usedUsd: 200 }),
        account({ userId: 'usr_a', userName: 'Aisyah', usedUsd: 150 }),
        account({ userId: 'usr_m', userName: 'Mei', usedUsd: 10 }),
      ],
      OCT_9,
    );
    expect(team.capBeforeEnd.map((a) => a.userName)).toEqual(['Aisyah', 'Zainab']);
    expect(team.allocatedUsd).toBe(900);
    expect(team.usedUsd).toBe(360);
  });
});

describe('top-ups', () => {
  it('ages a waiting request against the 1-hour SLA', () => {
    expect(TOPUP_SLA_MS).toBe(3_600_000);
    expect(topupAging(topup({ requestId: 'ctu_1', userId: 'u' }))).toEqual({ ageMs: 10_800_000, overdue: true, slaRatio: 3 });
    expect(topupAging(topup({ requestId: 'ctu_2', userId: 'u', ageMs: 1_800_000 })).overdue).toBe(false);
    expect(topupAging(topup({ requestId: 'ctu_3', userId: 'u', status: 'granted' })).overdue).toBe(false);
  });

  it("lets the decision's own due time win", () => {
    const d = decision({ id: 'dec_ctu_1', kind: 'credit_topup', dueAt: '2026-10-09T09:00:00.000Z', overdue: false });
    expect(topupAging(topup({ requestId: 'ctu_1', userId: 'u' }), d).overdue).toBe(false);
  });

  it('finds open top-up decisions with no request behind them, ignoring policy auto-grants', () => {
    const decisions = [
      decision({ id: 'dec_ctu_1', kind: 'credit_topup', subjectType: 'credit_topup', subjectId: 'ctu_1' }),
      decision({ id: 'dec_orphan', kind: 'credit_topup', subjectType: 'credit_topup', subjectId: 'ctu_gone' }),
      decision({ id: 'dec_auto', kind: 'credit_topup', subjectType: 'credit_account', subjectId: 'usr_a' }),
      decision({ id: 'dec_pb', kind: 'playbook_approval' }),
    ];
    expect(orphanTopupDecisions(decisions, [topup({ requestId: 'ctu_1', userId: 'u' })]).map((d) => d.id)).toEqual(['dec_orphan']);
  });

  it('builds one audit trail of grants and top-ups, newest first, with balances before and after', () => {
    const grant = (at: string, kind: 'auto' | 'topup', before: number) => ({
      kind,
      amountUsd: 50,
      at,
      approverId: kind === 'auto' ? null : 'usr_ceo',
      requestId: null,
      decisionId: `dec_${at}`,
      sessionId: null,
      taskId: null,
      balanceBefore: before,
      balanceAfter: before + 50,
    });
    const rows = grantTrail([
      account({ userId: 'usr_a', userName: 'Aisyah', grants: [grant('2026-10-03T00:00:00.000Z', 'auto', 0)] }),
      account({ userId: 'usr_b', userName: 'Bala', grants: [grant('2026-10-08T00:00:00.000Z', 'topup', 12.5)] }),
    ]);
    expect(rows.map((r) => [r.userName, r.kind, r.approverId, r.balanceBefore, r.balanceAfter])).toEqual([
      ['Bala', 'topup', 'usr_ceo', 12.5, 62.5],
      ['Aisyah', 'auto', null, 0, 50],
    ]);
  });

  it('validates a request the way the daemon will', () => {
    expect(validateTopup('50', 'One more evaluation pass')).toBeNull();
    expect(validateTopup('', 'reason')).toBe('Enter an amount of at least US$0.01.');
    expect(validateTopup('0', 'reason')).toBe('Enter an amount of at least US$0.01.');
    expect(validateTopup('abc', 'reason')).toBe('Enter an amount of at least US$0.01.');
    expect(validateTopup('100001', 'reason')).toBe('The amount is above the US$100,000 limit.');
    expect(validateTopup('50', '  x ')).toBe('Say what the extra credit is for (at least 3 characters).');
  });
});
