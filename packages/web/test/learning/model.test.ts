import { describe, expect, it } from 'vitest';
import {
  dimensionShares,
  isLearningEvent,
  lifecycleStages,
  nextSteps,
  outwardCount,
  perOccurrenceUsd,
  prioritise,
  repeatingGroups,
  signatureGroups,
  stageIndex,
  summarise,
  trendFacets,
  verdictDetail,
} from '../../src/pages/learning/model';
import { combine } from '../../src/pages/learning/resources';
import { CLASSES, ERRORS, OFFENCES, TREND, offence } from './fixtures';

describe('repeat-offence lifecycle', () => {
  it('offers only the moves a person may make (the system detects, reopens and closes)', () => {
    expect(nextSteps('detected')).toEqual(['root_caused']);
    expect(nextSteps('root_caused')).toEqual(['fix_applied']);
    expect(nextSteps('reopened')).toEqual(['fix_applied', 'root_caused']);
    expect(nextSteps('fix_applied')).toEqual([]);
    expect(nextSteps('verified_closed')).toEqual([]);
  });

  it('places a reopened offence back at detection on the four-step track', () => {
    expect(stageIndex('detected')).toBe(0);
    expect(stageIndex('fix_applied')).toBe(2);
    expect(stageIndex('verified_closed')).toBe(3);
    expect(stageIndex('reopened')).toBe(0);
  });

  it('ranks open offences by cost of recurrence, never by count, and closed ones last', () => {
    const order = prioritise(OFFENCES).map((o) => o.offenceId);
    // the verified-closed class cost the most, the SQL class recurs the most: neither leads
    expect(order).toEqual(['off_env', 'off_spec', 'off_sql', 'off_old']);
  });

  it('summarises open cost, time and what needs a person', () => {
    const s = summarise([
      ...OFFENCES,
      offence({ offenceId: 'off_re', classId: 'c', className: 'c', state: 'reopened' }),
    ]);
    expect(s.open).toBe(4);
    expect(s.closed).toBe(1);
    expect(s.needsRootCause).toBe(2);
    expect(s.byState.fix_applied).toBe(1);
    expect(s.openCostUsd).toBeCloseTo(26.67 + 12.87 + 11.54 + 10, 6);
    expect(s.openOccurrences).toBe(5 + 4 + 6 + 4);
  });

  it('averages cost per occurrence without dividing by zero', () => {
    expect(perOccurrenceUsd({ costOfRecurrenceUsd: 12, occurrences: 4 })).toBe(3);
    expect(perOccurrenceUsd({ costOfRecurrenceUsd: 0, occurrences: 0 })).toBe(0);
  });

  it('counts offences per step with how long they have waited there', () => {
    const now = Date.parse('2026-10-09T04:36:34.171Z');
    const stages = lifecycleStages(OFFENCES, now);
    expect(stages.map((s) => [s.id, s.count])).toEqual([
      ['detected', 1],
      ['root_caused', 1],
      ['fix_applied', 1],
      ['verified_closed', 1],
    ]);
    expect(stages[0]).toMatchObject({ oldestAgeMs: 3_600_000, medianAgeMs: 3_600_000 });
    expect(stages[3]).toMatchObject({ terminal: true });
    expect(stages[3]!.oldestAgeMs).toBeUndefined();
  });
});

describe('recurrence trend facets', () => {
  it('orders facets by cost of recurrence and keeps a closed class as a flat zero', () => {
    const facets = trendFacets(TREND, OFFENCES);
    expect(facets.map((f) => f.id)).toEqual(['rcc_env', 'rcc_spec', 'rcc_sql', 'rcc_old']);
    expect(facets[0]!.weeks.map((w) => w.count)).toEqual([0, 0, 0, 0, 0, 0, 3, 2]);
    expect(facets[0]!.weeks[7]!.week).toBe('Oct 5');
    expect(facets[0]!.note).toBe('US$26.67 notional');
    expect(facets[3]!.weeks.every((w) => w.count === 0)).toBe(true);
    expect(facets[3]!.stage).toBe('verified_closed');
  });

  it('marks a reopened class in words (the chart has no reopened stage)', () => {
    const facets = trendFacets(TREND, [
      offence({
        offenceId: 'o',
        classId: 'rcc_env',
        className: 'Env',
        state: 'reopened',
        reopenCount: 2,
        costOfRecurrenceUsd: 5,
      }),
    ]);
    expect(facets[0]!.stage).toBeUndefined();
    expect(facets[0]!.note).toBe('Reopened ×2 · US$5.00 notional');
  });

  it('appends classes the trend counts before they have an offence', () => {
    const facets = trendFacets(TREND, OFFENCES.slice(0, 1));
    expect(facets.map((f) => f.id)).toEqual(['rcc_env', 'rcc_sql', 'rcc_spec']);
  });
});

describe('root-cause dimensions', () => {
  it('sums cost of recurrence per dimension, costliest first', () => {
    const shares = dimensionShares(CLASSES);
    expect(shares.map((s) => s.dimension)).toEqual(['tooling', 'guardrail', 'spec', 'model_capability']);
    expect(shares[0]).toMatchObject({ classes: 1, occurrences: 9, costUsd: 80, outward: true });
  });

  it('counts how many classes point outward, away from the model', () => {
    expect(outwardCount(dimensionShares(CLASSES))).toEqual({ outward: 3, known: 4 });
  });
});

describe('signature groups', () => {
  it('groups unassigned occurrences by signature and separates repeats from transient one-offs', () => {
    const groups = signatureGroups(ERRORS);
    expect(groups.map((g) => [g.signature, g.count])).toEqual([
      ['sig-module', 2],
      ['sig-once', 1],
    ]);
    const module = groups[0]!;
    expect(module.latestErrorId).toBe('err_3');
    expect(module.text).toBe('error: cannot find module <q>');
    expect(module.processTypes).toEqual(['bug-fix', 'docs']);
    expect(module.firstSeenAt).toBe('2026-10-09T04:20:00.000Z');
    expect(repeatingGroups(groups).map((g) => g.signature)).toEqual(['sig-module']);
  });
});

describe('model verdict wording', () => {
  it('names the model only for a model-capability verdict', () => {
    expect(verdictDetail('model_capability', 3)).toMatch(/cheaper tier only/);
    expect(verdictDetail('spec_context_tooling', 3)).toMatch(/spec, context or tooling/);
    expect(verdictDetail('inconclusive', 3)).toMatch(/3\+ runs on both/);
  });
});

describe('stream filter and resource combination', () => {
  it('refreshes on learning events only', () => {
    for (const t of ['error.observed', 'rootcause.assigned', 'offence.transitioned', 'lesson.bound']) {
      expect(isLearningEvent(t)).toBe(true);
    }
    expect(isLearningEvent('session.liveness_changed')).toBe(false);
  });

  it('combines resources: data once all loaded, first error, busy while any loads', () => {
    let reloaded = 0;
    const reload = () => {
      reloaded += 1;
    };
    const both = combine(
      { data: 1, error: undefined, loading: false, reload },
      { data: undefined, error: new Error('x'), loading: true, reload },
    );
    expect(both.data).toBeUndefined();
    expect(both.loading).toBe(true);
    expect((both.error as Error).message).toBe('x');
    both.reload();
    expect(reloaded).toBe(2);
    expect(
      combine(
        { data: 'a', error: undefined, loading: false, reload },
        { data: 2, error: undefined, loading: false, reload },
      ).data,
    ).toEqual(['a', 2]);
  });
});
