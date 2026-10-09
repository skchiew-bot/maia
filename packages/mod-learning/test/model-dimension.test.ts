import { describe, expect, it } from 'vitest';
import type { ModelDimensionReportDTO } from '@aoc/contracts';
import { classVerdict, processVerdict } from '../src';
import { addSession, assignTo, createClass, learningRuntime, report } from './helpers';

describe('model as a tested root-cause dimension (pure)', () => {
  it('model capability only when it recurs on the cheaper tier, never on the stronger one, with ≥3 runs on both', () => {
    const v = processVerdict(
      'test-repair',
      { haiku: { runs: 4, occurrences: 3 }, sonnet: { runs: 3, occurrences: 0 } },
      3,
    );
    expect(v).toMatchObject({ verdict: 'model_capability', cheaperTier: 'haiku', strongerTier: 'sonnet' });
    expect(v.recommendation).toBe('targeted per-process-type upgrade for test-repair (haiku → sonnet)');
    // the cheapest stronger tier that qualifies is recommended
    expect(
      processVerdict(
        'docs',
        {
          haiku: { runs: 5, occurrences: 2 },
          sonnet: { runs: 3, occurrences: 0 },
          opus: { runs: 9, occurrences: 0 },
        },
        3,
      ).strongerTier,
    ).toBe('sonnet');
  });

  it('recurring on both tiers means spec/context/tooling, not the model', () => {
    expect(
      processVerdict('bug-fix', { haiku: { runs: 4, occurrences: 2 }, opus: { runs: 3, occurrences: 1 } }, 3),
    ).toMatchObject({
      verdict: 'spec_context_tooling',
      recommendation: null,
    });
  });

  it('insufficient runs on either tier is inconclusive', () => {
    expect(
      processVerdict(
        'bug-fix',
        { haiku: { runs: 4, occurrences: 3 }, sonnet: { runs: 2, occurrences: 0 } },
        3,
      ).verdict,
    ).toBe('inconclusive');
    expect(
      processVerdict(
        'bug-fix',
        { haiku: { runs: 2, occurrences: 2 }, sonnet: { runs: 6, occurrences: 0 } },
        3,
      ).verdict,
    ).toBe('inconclusive');
    expect(processVerdict('bug-fix', { haiku: { runs: 9, occurrences: 4 } }, 3).verdict).toBe('inconclusive');
    // one occurrence on the cheap tier is not a recurrence there
    expect(
      processVerdict('bug-fix', { haiku: { runs: 9, occurrences: 1 }, opus: { runs: 9, occurrences: 0 } }, 3)
        .verdict,
    ).toBe('inconclusive');
    expect(
      classVerdict([
        { verdict: 'model_capability', cheaperTier: 'haiku', strongerTier: 'opus', recommendation: 'x' },
        { verdict: 'spec_context_tooling', cheaperTier: 'haiku', strongerTier: 'opus', recommendation: null },
      ]),
    ).toBe('spec_context_tooling');
  });
});

describe('GET /api/learning/model-dimension', () => {
  it('reports runs and occurrences by tier per class with the three verdicts and a targeted (never blanket) upgrade', async () => {
    const t = await learningRuntime();
    const h = t.user('builder').headers;
    const capability = await createClass(
      t,
      h,
      'Multi-file refactor loses track of imports',
      'model_capability',
    );
    const notModel = await createClass(t, h, 'Docs build needs an undocumented env var', 'environment');
    const unclear = await createClass(t, h, 'Flaky snapshot ordering', 'tooling');

    // test-repair: 4 haiku runs (3 hit the class), 3 sonnet runs (none do) → model capability
    for (let i = 0; i < 4; i++) addSession(t, `ses_th${i}`, 'test-repair', 'claude-haiku-5-5');
    for (let i = 0; i < 3; i++) addSession(t, `ses_ts${i}`, 'test-repair', 'claude-sonnet-5-5');
    for (let i = 0; i < 3; i++)
      await assignTo(
        t,
        h,
        report(t, `cannot find name 'helper${i}'`, { sessionId: `ses_th${i}` }),
        capability,
      );

    // docs: hits both haiku and sonnet runs → not the model
    for (let i = 0; i < 3; i++) addSession(t, `ses_dh${i}`, 'docs', 'claude-haiku-5-5');
    for (let i = 0; i < 3; i++) addSession(t, `ses_ds${i}`, 'docs', 'sonnet');
    await assignTo(t, h, report(t, 'DOCS_BASE_URL is not defined', { sessionId: 'ses_dh0' }), notModel);
    await assignTo(t, h, report(t, 'DOCS_BASE_URL is not defined', { sessionId: 'ses_ds1' }), notModel);

    // migration: recurs on haiku, but only one opus run → inconclusive
    for (let i = 0; i < 3; i++) addSession(t, `ses_mh${i}`, 'migration', 'claude-haiku-5-5');
    addSession(t, 'ses_mo0', 'migration', 'claude-opus-5-5');
    await assignTo(t, h, report(t, 'snapshot order differs', { sessionId: 'ses_mh0' }), unclear);
    await assignTo(t, h, report(t, 'snapshot order differs', { sessionId: 'ses_mh1' }), unclear);

    const r = await t.json<ModelDimensionReportDTO>('GET', '/api/learning/model-dimension', { headers: h });
    expect(r.minRunsPerTier).toBe(3);
    const by = new Map(r.classes.map((c) => [c.classId, c]));
    const cap = by.get(capability)!;
    expect(cap.verdict).toBe('model_capability');
    expect(cap.recommendations).toEqual([
      'targeted per-process-type upgrade for test-repair (haiku → sonnet)',
    ]);
    expect(cap.byTier).toEqual([
      { tier: 'haiku', runs: 4, occurrences: 3 },
      { tier: 'sonnet', runs: 3, occurrences: 0 },
    ]);
    expect(cap.byProcessType).toHaveLength(1);
    expect(by.get(notModel)).toMatchObject({
      verdict: 'spec_context_tooling',
      summary: 'spec/context/tooling, not the model',
      recommendations: [],
    });
    expect(by.get(unclear)).toMatchObject({ verdict: 'inconclusive', recommendations: [] });
    expect(by.get(unclear)!.summary).toMatch(/^inconclusive/);
    expect(r.classes[0]!.classId).toBe(capability); // actionable verdicts first
    expect(JSON.stringify(r)).not.toMatch(/blanket|all process types/);
    await t.close();
  });
});
