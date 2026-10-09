import { describe, expect, it } from 'vitest';
import { DECISION_KINDS } from '@aoc/contracts';
import {
  agePoints,
  cleanTitle,
  costOfDelay,
  decisionDueMs,
  decisionImpact,
  decisionSlaMs,
  displayScore,
  formatDuration,
  severityOf,
  ATTENTION_SCALE_MS,
  DECISION_SLA_MS,
  GATE_SLA_MS,
  IMPACT,
  TICKET_IMPACT,
  TICKET_SLA_MS,
} from '../src';
import { DAY, HOUR, MIN } from './helpers';

const severityAt = (impact: number, ageMs: number, slaMs: number) =>
  severityOf(displayScore(costOfDelay(impact, ageMs, slaMs)));

describe('cost of delay (pure)', () => {
  it('ageing is relative to the item’s own time scale: 20 points at 1×, 40 at 3×, 60 at 7×', () => {
    expect(agePoints(0, HOUR)).toBe(0);
    expect(agePoints(HOUR, HOUR)).toBe(20);
    expect(agePoints(3 * HOUR, HOUR)).toBe(40);
    expect(agePoints(14 * DAY, 2 * DAY)).toBe(60);
    expect(agePoints(-5 * MIN, HOUR)).toBe(0);
  });

  it('rank = impact × blast radius (clamped to 1..3) + ageing points', () => {
    expect(costOfDelay(70, 0, 30 * MIN)).toBe(70);
    expect(costOfDelay(70, 30 * MIN, 30 * MIN)).toBe(90);
    expect(costOfDelay(40, 0, HOUR, 1.55)).toBe(62);
    expect(costOfDelay(50, 0, HOUR, 5)).toBe(150);
    expect(costOfDelay(50, 0, HOUR, 0.2)).toBe(50);
  });

  it('publishes the rank as is up to 90, then approaches 100 (monotonic, never past it)', () => {
    expect([0, 25, 50, 75, 90].map(displayScore)).toEqual([0, 25, 50, 75, 90]);
    expect(displayScore(100)).toBe(95); // one tail half-distance above 90
    expect(displayScore(1e6)).toBe(100);
    const ranks = [0, 12, 45, 89.9, 90, 90.1, 130, 400, 2000];
    const shown = ranks.map(displayScore);
    expect([...shown].sort((a, b) => a - b)).toEqual(shown);
  });

  it('severity bands on the score: ≥75 critical, 50–74 high, 25–49 medium, <25 low', () => {
    expect([100, 75, 74.9, 50, 49.9, 25, 24.9, 0].map(severityOf)).toEqual([
      'critical',
      'critical',
      'high',
      'high',
      'medium',
      'medium',
      'low',
      'low',
    ]);
  });

  it('kinds of equal impact cross each band at the same fraction of their own SLA', () => {
    const slas = Object.values(DECISION_SLA_MS);
    for (const impact of [8, 12, 30, 45]) {
      for (const fraction of [0, 0.25, 0.5, 1, 2, 3, 7, 10]) {
        const bands = new Set(slas.map((sla) => severityAt(impact, fraction * sla, sla)));
        expect(bands.size).toBe(1);
      }
    }
    // Every kind that starts low reaches medium within its SLA and critical only between 5× and 10× of it.
    const lowStart = DECISION_KINDS.map((k) => decisionImpact(k, null)).filter(
      (i): i is number => i !== null && i < 25,
    );
    for (const impact of lowStart) {
      const reach = (band: number) => 2 ** ((band - impact) / 20) - 1; // in multiples of the SLA
      expect(reach(25)).toBeLessThan(1);
      expect(reach(75)).toBeGreaterThan(5);
      expect(reach(75)).toBeLessThan(10);
    }
  });

  it('a lesson binding (2-day SLA) is low at 22h, medium from ~39h and critical only past 9× its SLA', () => {
    const lesson = decisionImpact('lesson_binding', null)!;
    const sla = decisionSlaMs('lesson_binding');
    expect(severityAt(lesson, 22 * HOUR, sla)).toBe('low');
    expect(severityAt(lesson, 38 * HOUR, sla)).toBe('low');
    expect(severityAt(lesson, 39 * HOUR, sla)).toBe('medium');
    expect(severityAt(lesson, 6 * DAY, sla)).toBe('medium');
    expect(severityAt(lesson, 7 * DAY, sla)).toBe('high');
    expect(severityAt(lesson, 18 * DAY, sla)).toBe('high');
    expect(severityAt(lesson, 19 * DAY, sla)).toBe('critical');
    // The approved urgent gates: a rollback (30m SLA) is critical within 6 minutes.
    expect(severityAt(decisionImpact('rollback', null)!, 6 * MIN, decisionSlaMs('rollback'))).toBe(
      'critical',
    );
    expect(severityAt(decisionImpact('rollback', null)!, 5 * MIN, decisionSlaMs('rollback'))).toBe('high');
  });

  it('impacts per decision kind and sub-kind; top-ups fold into credit_blocked and UAT sign-off is never a decision item', () => {
    const impacts = Object.fromEntries(DECISION_KINDS.map((k) => [k, decisionImpact(k, null)]));
    expect(impacts).toEqual({
      agent_decision: 8,
      protected_operation: 12,
      fix_plan: 30,
      go_live: 45,
      rollback: 70,
      change_request: 10,
      break_glass: 80,
      playbook_approval: 8,
      lesson_binding: 8,
      credit_topup: null,
      fx_discrepancy: 11,
      triage_reconciliation: 20,
      low_confidence_diagnosis: 20,
      uat_signoff: null,
    });
    // Tests that bounce to the Approver (per the decision contract) weigh more than the builder's own calls.
    expect(
      ['main', 'production', 'irreversible', 'data', 'ambiguity'].map((t) =>
        decisionImpact('agent_decision', t as never),
      ),
    ).toEqual([12, 12, 12, 12, 8]);
    expect(IMPACT).toMatchObject({
      chain_broken: 80,
      session_dead: 50,
      session_stalled: 30,
      credit_blocked: 25,
    });
    expect(ATTENTION_SCALE_MS).toMatchObject({
      session_dead: HOUR,
      credit_blocked: HOUR,
      anchor_missed: DAY,
    });
    expect(TICKET_IMPACT).toEqual({ critical: 75, high: 40, medium: 25, low: 15 });
    expect(TICKET_SLA_MS).toEqual({ critical: 4 * HOUR, high: 2 * DAY, medium: 5 * DAY, low: 10 * DAY });
  });

  it('decision SLAs as approved (rollback 30m, agent decision 1h, top-up 1h, go-live 2h, fix plan 4h, lesson 2d); reference scales elsewhere', () => {
    expect(DECISION_SLA_MS).toEqual({
      rollback: 30 * MIN,
      agent_decision: HOUR,
      credit_topup: HOUR,
      go_live: 2 * HOUR,
      fix_plan: 4 * HOUR,
      lesson_binding: 2 * DAY,
    });
    expect(decisionSlaMs('go_live')).toBe(2 * HOUR);
    expect(decisionSlaMs('break_glass')).toBe(15 * MIN);
    expect(decisionSlaMs('protected_operation')).toBe(HOUR);
    expect(decisionSlaMs('change_request')).toBe(DAY);
    expect(GATE_SLA_MS).toBe(HOUR);
    // Due: the card's own due time, else the approved SLA; kinds without either are never late.
    expect(decisionDueMs('go_live', 1_000, null)).toBe(1_000 + 2 * HOUR);
    expect(decisionDueMs('go_live', 1_000, 5_000)).toBe(5_000);
    expect(decisionDueMs('break_glass', 1_000, null)).toBeNull();
    expect(decisionDueMs('break_glass', 1_000, 9_000)).toBe(9_000);
  });

  it('formats durations for basis sentences', () => {
    expect(formatDuration(0)).toBe('<1m');
    expect(formatDuration(59_000)).toBe('<1m');
    expect(formatDuration(31 * MIN)).toBe('31m');
    expect(formatDuration(2 * HOUR + 14 * MIN)).toBe('2h 14m');
    expect(formatDuration(2 * HOUR)).toBe('2h');
    expect(formatDuration(24 * HOUR)).toBe('24h');
    expect(formatDuration(72 * HOUR)).toBe('3d');
    expect(formatDuration(3 * DAY + 4 * HOUR + 10 * MIN)).toBe('3d 4h');
  });

  it('titles are PII-scrubbed and capped at 120 chars', () => {
    expect(cleanTitle('Fix plan for tkt_1: login fails for jane.doe@example.com, call +60 12-345 6789')).toBe(
      'Fix plan for tkt_1: login fails for [email], call [number]',
    );
    expect(cleanTitle('Fix 404 on page 12 (v2.3)\nsecond line')).toBe(
      'Fix 404 on page 12 (v2.3) second line',
    );
    const long = cleanTitle('x'.repeat(300));
    expect(long).toHaveLength(120);
    expect(long.endsWith('…')).toBe(true);
  });
});
