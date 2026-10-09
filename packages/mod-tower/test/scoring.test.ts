import { describe, expect, it } from 'vitest';
import { DECISION_KINDS } from '@aoc/contracts';
import {
  ageFactor,
  cleanTitle,
  costOfDelay,
  decisionBase,
  decisionSlaMs,
  displayScore,
  formatDuration,
  GATE_SLA_MS,
  severityOf,
  TICKET_BASE,
  TICKET_SLA_MS,
} from '../src';
import { DAY, HOUR, MIN } from './helpers';

describe('cost of delay (pure)', () => {
  it('ageFactor = 1 + log2(1 + ageMinutes / 30)', () => {
    expect(ageFactor(0)).toBe(1);
    expect(ageFactor(30 * MIN)).toBe(2);
    expect(ageFactor(90 * MIN)).toBe(3);
    expect(ageFactor(-5 * MIN)).toBe(1);
  });

  it('raw cost = base × ageFactor × blastRadius (radius clamped to 1..3)', () => {
    expect(costOfDelay(100, 0)).toBe(100);
    expect(costOfDelay(15, DAY)).toBeCloseTo(99.22, 2); // a lesson that waited a day still ranks below a fresh break-glass
    expect(costOfDelay(50, HOUR)).toBeCloseTo(129.25, 2); // an hour-old stall overtakes a fresh go-live gate (90)
    expect(costOfDelay(50, 0, 5)).toBe(150);
    expect(costOfDelay(50, 0, 0.2)).toBe(50);
  });

  it('publishes raw cost on the approved 0–100 scale: bands 75/50/25 are raw 90/60/30, then a monotonic tail', () => {
    expect([0, 30, 60, 90].map(displayScore)).toEqual([0, 25, 50, 75]);
    expect(displayScore(150)).toBe(87.5); // one tail half-distance above 90
    expect(displayScore(1e6)).toBe(100);
    const raws = [0, 12, 45, 89.9, 90, 90.1, 130, 400, 2000];
    const shown = raws.map(displayScore);
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

  it('bases per decision kind and sub-kind; top-ups fold into credit_blocked and UAT sign-off is never a decision item', () => {
    const bases = Object.fromEntries(DECISION_KINDS.map((k) => [k, decisionBase(k, null)]));
    expect(bases).toEqual({
      agent_decision: 35,
      protected_operation: 60,
      fix_plan: 65,
      go_live: 90,
      rollback: 95,
      change_request: 40,
      break_glass: 100,
      playbook_approval: 15,
      lesson_binding: 15,
      credit_topup: null,
      fx_discrepancy: 20,
      triage_reconciliation: 50,
      low_confidence_diagnosis: 50,
      uat_signoff: null,
    });
    expect(
      ['main', 'production', 'data', 'irreversible', 'ambiguity'].map((t) =>
        decisionBase('agent_decision', t as never),
      ),
    ).toEqual([60, 60, 60, 35, 35]);
    expect(TICKET_BASE).toEqual({ critical: 90, high: 70, medium: 40, low: 20 });
    expect(TICKET_SLA_MS).toEqual({ critical: HOUR, high: 4 * HOUR, medium: 24 * HOUR, low: 72 * HOUR });
  });

  it('decision SLAs as approved (rollback 30m, agent decision 1h, top-up 1h, go-live 2h, fix plan 4h, lesson 2d)', () => {
    expect(decisionSlaMs('rollback')).toBe(30 * MIN);
    expect(decisionSlaMs('agent_decision')).toBe(HOUR);
    expect(decisionSlaMs('credit_topup')).toBe(HOUR);
    expect(decisionSlaMs('go_live')).toBe(2 * HOUR);
    expect(decisionSlaMs('fix_plan')).toBe(4 * HOUR);
    expect(decisionSlaMs('lesson_binding')).toBe(2 * DAY);
    expect(decisionSlaMs('break_glass')).toBe(15 * MIN);
    expect(decisionSlaMs('protected_operation')).toBe(HOUR);
    expect(decisionSlaMs('change_request')).toBe(DAY);
    expect(GATE_SLA_MS).toBe(HOUR);
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
