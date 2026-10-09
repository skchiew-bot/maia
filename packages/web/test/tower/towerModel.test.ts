import { describe, expect, it } from 'vitest';
import type { TowerAttentionItem } from '@aoc/contracts';
import {
  anchorAge,
  approveOption,
  approveTarget,
  attentionKindLabel,
  breakglassDueIn,
  bulletScale,
  capOutlook,
  decisionBlockText,
  denyOption,
  flowDeltaRatio,
  flowTotals,
  foldAttention,
  formatSignalValue,
  hourLabel,
  latencyKindLabel,
  latencyMarks,
  niceCeil,
  oldestAttention,
  oldestTicketStage,
  orderModelMix,
  passkeyGateCount,
  periodEndOf,
  radarMarks,
  rankAttention,
  recommendedOptionIdOf,
  scopeLabel,
  shareText,
  splitFunnel,
  tierLabel,
} from '../../src/pages/tower/towerModel';
import { FIXTURE_IDS, FIXTURE_NOW, makeOpenDecisions, makeTowerSnapshot } from './fixture';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const snapshot = makeTowerSnapshot();
const cards = new Map(makeOpenDecisions().decisions.map((d) => [d.id, d]));
const item = (id: string) => snapshot.attention.find((a) => a.id === id)!;

describe('attention ranking and folding', () => {
  it('ranks by cost of delay, then by who has waited longest', () => {
    const a = { ...snapshot.attention[0]!, id: 'a', costOfDelay: { score: 50, basis: '' }, since: '2026-10-09T05:00:00Z' };
    const b = { ...a, id: 'b', since: '2026-10-09T04:00:00Z' };
    const c = { ...a, id: 'c', costOfDelay: { score: 90.5, basis: '' } };
    expect(rankAttention([a, b, c]).map((x) => x.id)).toEqual(['c', 'b', 'a']);
  });

  it('folds lower-cost items (score < 10) behind the disclosure, as in the mock', () => {
    const { visible, folded } = foldAttention(rankAttention(snapshot.attention));
    expect(visible).toHaveLength(11);
    expect(folded.map((f) => f.id)).toEqual([`decision:${FIXTURE_IDS.lesson}`]);
  });

  it('caps the visible rows and never folds the whole queue', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      ...snapshot.attention[0]!,
      id: `x${i}`,
      costOfDelay: { score: 90 - i, basis: '' },
    }));
    expect(foldAttention(many).visible).toHaveLength(12);
    const low = [{ ...snapshot.attention[0]!, costOfDelay: { score: 3, basis: '' } }];
    expect(foldAttention(low)).toEqual({ visible: low, folded: [] });
  });

  it('finds the oldest item and counts passkey gates', () => {
    expect(oldestAttention(snapshot.attention)?.id).toBe('ticket_waiting:tkt_1162');
    expect(passkeyGateCount(snapshot.attention)).toBe(2);
    expect(oldestAttention([])).toBeNull();
  });

  it('labels decision rows by the card kind when known', () => {
    const rollback = item(`decision:${FIXTURE_IDS.rollback}`);
    expect(attentionKindLabel(rollback, cards.get(FIXTURE_IDS.rollback))).toBe('Rollback gate');
    expect(attentionKindLabel(rollback, null)).toBe('Decision');
    expect(attentionKindLabel(item('ticket_waiting:tkt_1162'))).toBe('Customer waiting');
  });

});

describe('inline approve / deny options', () => {
  it('approve applies the recommendation (CEO decision 7)', () => {
    expect(approveOption(cards.get(FIXTURE_IDS.mainMerge)!)?.id).toBe('uat');
    expect(approveOption(cards.get(FIXTURE_IDS.lesson)!)?.id).toBe('bind');
  });

  it('without a recommendation, approve picks the option that plainly approves', () => {
    expect(approveOption(cards.get(FIXTURE_IDS.topup)!)?.id).toBe('approve');
    expect(approveOption({ options: [{ id: 'a', label: 'Option A' }, { id: 'b', label: 'Option B' }], recommendation: null })).toBeNull();
  });

  it('deny exists only for an explicit refusal distinct from approve', () => {
    expect(denyOption(cards.get(FIXTURE_IDS.topup)!)?.id).toBe('deny');
    expect(denyOption(cards.get(FIXTURE_IDS.lesson)!)?.id).toBe('reject');
    expect(denyOption(cards.get(FIXTURE_IDS.mainMerge)!)).toBeNull();
  });

  it('prefers the option the server recommends on the row, and works without the card', () => {
    const row = item(`decision:${FIXTURE_IDS.mainMerge}`);
    expect(recommendedOptionIdOf(row)).toBeNull();
    const withRec = { ...row, action: { ...row.action, recommendedOptionId: 'merge' } } as TowerAttentionItem;
    expect(approveTarget(withRec, cards.get(FIXTURE_IDS.mainMerge)!)).toEqual({ id: 'merge', label: 'Merge to main' });
    expect(approveTarget(withRec, null)).toEqual({ id: 'merge', label: null });
    expect(approveTarget(row, null)).toBeNull();
    expect(approveTarget(row, cards.get(FIXTURE_IDS.mainMerge)!)).toEqual({ id: 'uat', label: 'Hold for UAT first' });
  });

  it('explains why a viewer cannot resolve', () => {
    expect(decisionBlockText('role')).toBe('Needs the Approver role');
    expect(decisionBlockText('separation_of_duties')).toMatch(/someone else/);
    expect(decisionBlockText(null)).toBe('You cannot resolve this decision');
  });
});

describe('flow helpers', () => {
  it('totals the last 12 hours and compares verified flow with its baseline', () => {
    expect(flowTotals(snapshot.flow.tasksPerHour)).toEqual({ verified: 21, flagged: 2 });
    expect(flowDeltaRatio(21, 17.8)).toBeCloseTo(0.1798, 3);
    expect(flowDeltaRatio(3, 0)).toBeNull();
  });

  it('labels hours by the deployment wall clock when the server sends an offset', () => {
    expect(hourLabel('2026-10-09T13:00:00+08:00')).toBe('13');
    expect(hourLabel('2026-10-09T01:00:00+0800')).toBe('01');
    expect(hourLabel('9')).toBe('09');
    expect(hourLabel('13:00')).toBe('13');
    expect(hourLabel('noon')).toBe('noon');
    expect(hourLabel(snapshot.flow.tasksPerHour[11]!.hour)).toBe('13');
  });

  it('rounds axis tops to whole steps', () => {
    expect(niceCeil(5, 3)).toBe(6);
    expect(niceCeil(9, 2)).toBe(10);
    expect(niceCeil(0, 3)).toBe(3);
    expect(niceCeil(214, 1)).toBe(250);
    expect(bulletScale(152.38, 171.4)).toBe(250);
  });

  it('splits the ticket funnel into open stages and finished work, keeping the server bottleneck', () => {
    const f = splitFunnel(snapshot.flow.ticketFunnel);
    expect(f.openTotal).toBe(16);
    expect(f.bottleneck).toBe('uat');
    expect(f.terminal.map((s) => s.stage)).toEqual(['completed']);
    expect(oldestTicketStage(snapshot.flow.ticketFunnel)).toBe('uat');
  });

  it('scales decision latency to each SLA (SLA at the middle) and flags p90 off scale', () => {
    expect(latencyMarks({ p50Ms: 12 * MIN, p90Ms: 41 * MIN, slaMs: 30 * MIN })).toEqual({
      p50Pct: 20,
      p90Pct: (41 / 60) * 100,
      offScale: false,
    });
    expect(latencyMarks({ p50Ms: 2 * HOUR, p90Ms: 3 * HOUR, slaMs: HOUR }).offScale).toBe(true);
    expect(latencyMarks({ p50Ms: null, p90Ms: null, slaMs: HOUR })).toEqual({ p50Pct: null, p90Pct: null, offScale: false });
    expect(latencyKindLabel('go_live')).toBe('Go-live');
    expect(latencyKindLabel('custom_gate')).toBe('Custom gate');
  });
});

describe('anomaly radar', () => {
  it('indexes a value to its baseline on a 0–3× scale', () => {
    const m = radarMarks({ value: 8.7, baseline: 3.1 });
    expect(m.ratio).toBeCloseTo(2.806, 2);
    expect(m.barPct).toBeCloseTo(93.5, 1);
    expect(m.over).toBe(false);
    expect(m.showBaseline).toBe(true);
    expect(radarMarks({ value: 2, baseline: 0.4 })).toMatchObject({ barPct: 100, over: true });
  });

  it('never invents a ratio without a usable baseline', () => {
    expect(radarMarks({ value: 0, baseline: null })).toMatchObject({ ratio: null, barPct: null, note: 'no_baseline' });
    expect(radarMarks({ value: 0, baseline: 0 })).toMatchObject({ ratio: null, barPct: null, note: null });
    expect(radarMarks({ value: 2, baseline: 0 })).toMatchObject({ barPct: 100, over: true, note: 'zero_baseline' });
  });

  it('formats values by unit and scopes without exposing a person', () => {
    expect(formatSignalValue(8.7, '%')).toBe('8.7%');
    expect(formatSignalValue(31, '%')).toBe('31%');
    expect(formatSignalValue(0.4, 'count')).toBe('0.4');
    expect(formatSignalValue(0.314, 'ratio')).toBe('0.31');
    expect(scopeLabel('process_type:feature-build')).toEqual({ text: 'feature-build', kind: 'process type' });
    expect(scopeLabel('portfolio')).toEqual({ text: 'portfolio', kind: null });
  });
});

describe('spend and capacity', () => {
  it('orders the model mix by tier and never rounds a real share to 0%', () => {
    expect(orderModelMix([{ tier: 'haiku', usdToday: 1, pct: 1 }, { tier: 'opus', usdToday: 2, pct: 2 }]).map((m) => m.tier)).toEqual([
      'opus',
      'haiku',
    ]);
    expect(tierLabel('claude-sonnet-5-5')).toBe('Sonnet');
    expect(shareText(0.8)).toBe('<1%');
    expect(shareText(47.4)).toBe('47%');
  });

  it('projects the credit runway against the period end', () => {
    const now = FIXTURE_NOW;
    const end = periodEndOf(now);
    expect(new Date(end).getDate()).toBe(31);
    expect(capOutlook(new Date(now + 3 * HOUR).toISOString(), now, end).kind).toBe('today');
    const soon = capOutlook(new Date(now + 3 * DAY).toISOString(), now, end);
    expect(soon.kind).toBe('before_end');
    expect(soon.barPct).toBeLessThan(soon.endPct);
    expect(capOutlook(new Date(now + 40 * DAY).toISOString(), now, end)).toMatchObject({ kind: 'lasts', barPct: 100 });
    expect(capOutlook(null, now, end)).toMatchObject({ kind: 'lasts', at: null });
  });
});

describe('integrity clocks', () => {
  it('ages the anchor from its timestamp when known', () => {
    expect(anchorAge('2026-10-09T05:00:00.000Z', 99, Date.parse('2026-10-09T05:30:00.000Z'))).toBe(30 * MIN);
    expect(anchorAge(null, 1234, FIXTURE_NOW)).toBe(1234);
    expect(anchorAge(null, null, FIXTURE_NOW)).toBeNull();
  });

  it('counts down the 24 h post-incident window after a break-glass promotion', () => {
    expect(breakglassDueIn(new Date(FIXTURE_NOW - 4 * HOUR).toISOString(), FIXTURE_NOW)).toBe(20 * HOUR);
    expect(breakglassDueIn(new Date(FIXTURE_NOW - 30 * HOUR).toISOString(), FIXTURE_NOW)).toBe(-6 * HOUR);
  });
});
