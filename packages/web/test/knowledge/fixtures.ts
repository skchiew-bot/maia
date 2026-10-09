import type { DecisionCardView, LessonDTO, LessonPayoffDTO } from '@aoc/contracts';

/** Fixtures mirror /api/learning/lessons and /api/decisions after the demo flow (ids shortened). */

export function payoff(p: Partial<LessonPayoffDTO> = {}): LessonPayoffDTO {
  return {
    measurable: true,
    exposuresBefore: 12,
    occurrencesBefore: 12,
    baselineRatePerExposure: 1,
    exposuresAfter: 2,
    recurrencesAfter: 0,
    expectedRecurrences: 2,
    repeatsPrevented: 2,
    avgOccurrenceCostUsd: 1.67,
    avgOccurrenceMs: 1_200_000,
    avgOccurrenceTokens: 0,
    usdSaved: 3.34,
    msSaved: 2_400_000,
    tokensSaved: 0,
    ...p,
  };
}

export function lesson(l: Partial<LessonDTO> & Pick<LessonDTO, 'lessonId' | 'rule'>): LessonDTO {
  return {
    classId: null,
    className: null,
    scopeType: 'process_type',
    scopeValue: 'migration',
    status: 'bound',
    origin: 'human',
    fix: 'Apply the fix.',
    rationale: 'Because it recurred.',
    decisionId: `dec_${l.lessonId}`,
    proposedAt: '2026-10-09T04:22:33.000Z',
    boundAt: '2026-10-09T04:22:36.000Z',
    rejectedAt: null,
    retiredAt: null,
    retireReason: null,
    usage: {
      appliedRuns: 2,
      usedRuns: 2,
      unusedRuns: 0,
      pendingRuns: 0,
      unusedStreak: 0,
      retireAfterUnusedRuns: 20,
    },
    payoff: payoff(),
    ...l,
  };
}

export const LESSONS: LessonDTO[] = [
  lesson({
    lessonId: 'les_docs',
    rule: 'Docs changes link the runbook section they update.',
    scopeValue: 'docs',
    status: 'retired',
    retiredAt: '2026-10-09T04:22:39.000Z',
    retireReason: 'manual',
    usage: {
      appliedRuns: 0,
      usedRuns: 0,
      unusedRuns: 0,
      pendingRuns: 0,
      unusedStreak: 0,
      retireAfterUnusedRuns: 20,
    },
    payoff: payoff({ measurable: false }),
  }),
  lesson({
    lessonId: 'les_criteria',
    rule: 'Restate the ticket acceptance criteria as plan tasks before writing code.',
    scopeValue: 'feature-build',
    classId: 'rcc_spec',
    className: 'Ambiguous acceptance criteria in tickets',
    status: 'rejected',
    boundAt: null,
    rejectedAt: '2026-10-09T04:22:36.000Z',
    payoff: null,
  }),
  lesson({
    lessonId: 'les_sql',
    rule: 'Write each migration as a reversible up/down pair.',
    classId: 'rcc_sql',
    className: 'Malformed SQL migrations on the cheap model',
  }),
  lesson({
    lessonId: 'les_env',
    rule: 'Config loaders must fail fast on a missing env var.',
    scopeType: 'code_area',
    scopeValue: 'src/config',
    classId: 'rcc_env',
    className: 'Missing env-var guard in config loader',
    usage: {
      appliedRuns: 15,
      usedRuns: 3,
      unusedRuns: 12,
      pendingRuns: 0,
      unusedStreak: 12,
      retireAfterUnusedRuns: 20,
    },
    payoff: payoff({ repeatsPrevented: -1.5, usdSaved: -2.5, msSaved: -900_000, exposuresAfter: 6 }),
  }),
  lesson({
    lessonId: 'les_pending',
    rule: 'Pin the Node version in every new service.',
    scopeValue: 'node-service',
    status: 'proposed',
    boundAt: null,
    payoff: null,
    usage: {
      appliedRuns: 0,
      usedRuns: 0,
      unusedRuns: 0,
      pendingRuns: 0,
      unusedStreak: 0,
      retireAfterUnusedRuns: 20,
    },
  }),
];

export function decision(
  d: Partial<DecisionCardView> & Pick<DecisionCardView, 'id' | 'subjectId'>,
): DecisionCardView {
  return {
    kind: 'lesson_binding',
    status: 'open',
    test: null,
    title: 'Bind lesson for process type migration',
    question: 'Bind this lesson?',
    options: [
      { id: 'bind', label: 'Bind lesson' },
      { id: 'reject', label: 'Reject' },
    ],
    recommendation: null,
    context: null,
    requiredRole: 'approver',
    requiresPasskey: false,
    requesterId: 'usr_priya',
    excludedApproverIds: ['usr_priya'],
    eligibleUserIds: null,
    subjectType: 'lesson',
    sessionId: null,
    projectId: null,
    createdAt: '2026-10-08T01:36:40.186Z',
    dueAt: null,
    resolution: null,
    ageMs: 93_680_738,
    overdue: false,
    closedAt: null,
    erased: false,
    escalation: null,
    withdrawal: null,
    viewer: { canResolve: true, reason: null, canWithdraw: true, canEscalate: false },
    ...d,
  };
}

export const DECISIONS: DecisionCardView[] = [
  decision({
    id: 'dec_les_pending',
    subjectId: 'les_pending',
    title: 'Bind lesson for process type node-service',
  }),
  decision({
    id: 'dec_orphan',
    subjectId: 'les_demo1',
    title: 'Bind lesson: guard required env vars',
    createdAt: '2026-10-07T01:00:00.000Z',
    viewer: { canResolve: false, reason: 'separation_of_duties', canWithdraw: false, canEscalate: false },
  }),
];
