import type {
  ErrorOccurrenceDTO,
  ModelDimensionReportDTO,
  OffenceDTO,
  RecurrenceTrendDTO,
  RootCauseClassDTO,
} from '@aoc/contracts';

/** Fixtures mirror the shapes /api/learning/* returned for the seeded demo (ids shortened). */

export function offence(
  o: Partial<OffenceDTO> & Pick<OffenceDTO, 'offenceId' | 'classId' | 'className'>,
): OffenceDTO {
  return {
    dimension: 'guardrail',
    state: 'detected',
    occurrences: 4,
    occurrencesSinceFix: 0,
    highPriorityOccurrences: 0,
    costOfRecurrenceUsd: 10,
    costMs: 600_000,
    costTokens: 0,
    detectedAt: '2026-10-09T03:36:34.171Z',
    lastTransitionAt: '2026-10-09T03:36:34.171Z',
    fixAppliedAt: null,
    verifyDueAt: null,
    verifiedClosedAt: null,
    reopenCount: 0,
    fix: null,
    history: [
      {
        from: null,
        to: 'detected',
        at: '2026-10-09T03:36:34.171Z',
        occurrences: o.occurrences ?? 4,
        costOfRecurrenceUsd: o.costOfRecurrenceUsd ?? 10,
        note: null,
      },
    ],
    ...o,
  };
}

export const OFFENCES: OffenceDTO[] = [
  offence({
    offenceId: 'off_env',
    classId: 'rcc_env',
    className: 'Missing env-var guard in config loader',
    dimension: 'guardrail',
    occurrences: 5,
    highPriorityOccurrences: 2,
    costOfRecurrenceUsd: 26.67,
    costMs: 3_895_522,
  }),
  offence({
    offenceId: 'off_spec',
    classId: 'rcc_spec',
    className: 'Ambiguous acceptance criteria in tickets',
    dimension: 'spec',
    state: 'root_caused',
    occurrences: 4,
    costOfRecurrenceUsd: 12.87,
    costMs: 2_168_605,
  }),
  offence({
    offenceId: 'off_sql',
    classId: 'rcc_sql',
    className: 'Malformed SQL migrations on the cheap model',
    dimension: 'model_capability',
    state: 'fix_applied',
    occurrences: 6,
    costOfRecurrenceUsd: 11.54,
    costMs: 4_760_732,
    fix: 'Route migration runs to Sonnet.',
    fixAppliedAt: '2026-10-09T04:00:00.000Z',
    verifyDueAt: '2026-10-23T04:00:00.000Z',
  }),
  offence({
    offenceId: 'off_old',
    classId: 'rcc_old',
    className: 'Flaky fixture clock in billing tests',
    dimension: 'tooling',
    state: 'verified_closed',
    occurrences: 9,
    costOfRecurrenceUsd: 80,
    costMs: 9_000_000,
    fix: 'Inject the clock.',
    verifiedClosedAt: '2026-10-08T03:10:00.000Z',
  }),
];

export const CLASSES: RootCauseClassDTO[] = OFFENCES.map((o, i) => ({
  classId: o.classId,
  name: o.className,
  description: null,
  dimension: o.dimension,
  origin: 'human',
  createdAt: '2026-09-27T03:36:34.171Z',
  occurrences: o.occurrences,
  highPriorityOccurrences: o.highPriorityOccurrences,
  costOfRecurrenceUsd: o.costOfRecurrenceUsd,
  lastSeenAt: `2026-10-0${5 + (i % 3)}T07:36:34.171Z`,
  offence: { offenceId: o.offenceId, state: o.state },
}));

const WEEKS = [
  '2026-08-17',
  '2026-08-24',
  '2026-08-31',
  '2026-09-07',
  '2026-09-14',
  '2026-09-21',
  '2026-09-28',
  '2026-10-05',
];

/** The API sorts by count: the SQL class (6) comes first, though it is the cheapest open offence. */
export const TREND: RecurrenceTrendDTO = {
  weeks: WEEKS,
  classes: [
    {
      classId: 'rcc_sql',
      name: 'Malformed SQL migrations on the cheap model',
      dimension: 'model_capability',
      counts: [0, 0, 0, 0, 0, 1, 3, 2],
      total: 6,
      offenceState: 'fix_applied',
    },
    {
      classId: 'rcc_env',
      name: 'Missing env-var guard in config loader',
      dimension: 'guardrail',
      counts: [0, 0, 0, 0, 0, 0, 3, 2],
      total: 5,
      offenceState: 'detected',
    },
    {
      classId: 'rcc_spec',
      name: 'Ambiguous acceptance criteria in tickets',
      dimension: 'spec',
      counts: [0, 0, 0, 0, 0, 0, 2, 2],
      total: 4,
      offenceState: 'root_caused',
    },
  ],
  unclassified: [0, 0, 0, 0, 0, 15, 76, 58],
};

export const MODEL: ModelDimensionReportDTO = {
  generatedAt: '2026-10-09T05:00:00.000Z',
  minRunsPerTier: 3,
  classes: [
    {
      classId: 'rcc_sql',
      name: 'Malformed SQL migrations on the cheap model',
      dimension: 'model_capability',
      occurrences: 6,
      verdict: 'model_capability',
      summary:
        'model capability: recurs on the cheaper tier only — targeted per-process-type upgrade for migration (haiku → sonnet)',
      recommendations: ['targeted per-process-type upgrade for migration (haiku → sonnet)'],
      byTier: [
        { tier: 'haiku', runs: 4, occurrences: 6 },
        { tier: 'sonnet', runs: 5, occurrences: 0 },
      ],
      byProcessType: [
        {
          processType: 'migration',
          verdict: 'model_capability',
          tiers: [
            { tier: 'haiku', runs: 4, occurrences: 6 },
            { tier: 'sonnet', runs: 5, occurrences: 0 },
          ],
          cheaperTier: 'haiku',
          strongerTier: 'sonnet',
          recommendation: 'targeted per-process-type upgrade for migration (haiku → sonnet)',
        },
      ],
    },
    {
      classId: 'rcc_env',
      name: 'Missing env-var guard in config loader',
      dimension: 'guardrail',
      occurrences: 5,
      verdict: 'spec_context_tooling',
      summary: 'spec/context/tooling, not the model',
      recommendations: [],
      byTier: [
        { tier: 'sonnet', runs: 10, occurrences: 4 },
        { tier: 'opus', runs: 3, occurrences: 1 },
      ],
      byProcessType: [],
    },
  ],
};

export function error(
  e: Partial<ErrorOccurrenceDTO> & Pick<ErrorOccurrenceDTO, 'errorId'>,
): ErrorOccurrenceDTO {
  return {
    observedAt: '2026-10-09T04:00:00.000Z',
    source: 'tool',
    priority: 'normal',
    signature: 'sig-other',
    template: null,
    message: 'Error',
    fix: null,
    rootCauseHint: null,
    codeArea: null,
    processType: 'docs',
    modelTier: 'haiku',
    projectId: 'prj_aoc',
    classId: null,
    className: null,
    assignedBy: null,
    confidence: null,
    cost: { usd: 0.05, ms: 60_000, tokens: 1000, basis: 'metering', weightedUsd: 0.05, provisional: false },
    ...e,
  };
}

export const ERRORS: ErrorOccurrenceDTO[] = [
  error({
    errorId: 'err_3',
    observedAt: '2026-10-09T04:31:00.000Z',
    signature: 'sig-module',
    template: 'error: cannot find module <q>',
    message: 'Error: Cannot find module "../config"',
  }),
  error({
    errorId: 'err_2',
    observedAt: '2026-10-09T04:20:00.000Z',
    signature: 'sig-module',
    template: 'error: cannot find module <q>',
    message: 'Error: Cannot find module "../config"',
    processType: 'bug-fix',
    modelTier: 'sonnet',
  }),
  error({
    errorId: 'err_1',
    observedAt: '2026-10-09T04:00:00.000Z',
    signature: 'sig-once',
    message: 'ECONNRESET once',
  }),
  error({
    errorId: 'err_0',
    observedAt: '2026-10-08T04:00:00.000Z',
    signature: 'sig-env',
    message: 'Missing env var X',
    classId: 'rcc_env',
    className: 'Missing env-var guard in config loader',
    assignedBy: 'human',
    priority: 'high',
    source: 'uat',
  }),
];
