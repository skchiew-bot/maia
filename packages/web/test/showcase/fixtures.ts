import type {
  ConsoleSnapshot,
  DecisionCardView,
  ManifestPhaseDTO,
  ProjectSummary,
  SessionSummary,
} from '@aoc/contracts';

export const NOW = Date.parse('2026-10-09T05:42:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const progress = { doneTasks: 0, totalTasks: 0, doneWeight: 0, totalWeight: 0, pct: 0, flaggedTasks: 0, etaMs: null, etaHiddenReason: null };

export function session(overrides: Partial<SessionSummary> & { sessionId: string }): SessionSummary {
  return {
    mode: 'managed',
    title: `Session ${overrides.sessionId}`,
    projectId: 'prj_cx',
    projectName: 'CX Copilot',
    threadId: null,
    phaseId: null,
    phaseName: null,
    processType: 'feature-build',
    model: 'claude-sonnet-5',
    ownerId: 'usr_1',
    ownerName: 'Aisyah Rahman',
    lifecycle: 'running',
    liveness: { state: 'working', reason: 'tool_activity', since: ago(5) },
    apm: { windowMinutes: 30, points: [], current: 0 },
    progress,
    contextTokens: null,
    contextPct: null,
    costTodayUsd: 0,
    openDecision: null,
    throttledUntil: null,
    lastActivityAt: ago(1),
    startedAt: ago(60),
    ticketId: null,
    ...overrides,
  };
}

export const SESSIONS: SessionSummary[] = [
  session({ sessionId: 'ses_work', title: 'Greeting command' }),
  session({
    sessionId: 'ses_wait',
    title: 'Normalise policy numbers',
    projectId: 'prj_claims',
    projectName: 'Claims Intake Bot',
    lifecycle: 'waiting_decision',
    liveness: { state: 'waiting_on_you', reason: 'open_decision', since: ago(34) },
    openDecision: { decisionId: 'dec_s', kind: 'agent_decision', createdAt: ago(34) },
  }),
  session({
    sessionId: 'ses_thr',
    title: 'CSAT overlay',
    lifecycle: 'throttled',
    liveness: { state: 'throttled', reason: 'plan_limit', since: ago(22) },
    throttledUntil: '2026-10-09T07:17:00Z',
  }),
  session({ sessionId: 'ses_obs', title: 'Observed · aoc', mode: 'observed', projectId: 'prj_aoc', projectName: 'AOC Platform', liveness: { state: 'stalled', reason: 'no_progress', since: ago(12) } }),
  session({ sessionId: 'ses_done', title: 'Finished fix', lifecycle: 'ended', liveness: null }),
];

export const CONSOLE: ConsoleSnapshot = {
  generatedAt: new Date(NOW).toISOString(),
  kpis: {
    activeSessions: 4,
    waitingOnYou: 1,
    oldestWaitingSince: ago(34),
    throttled: 1,
    throttleIdleMsToday: 22 * 60_000,
    tasksDoneToday: 21,
    tasksDoneWithEvidencePct: 85.7,
    notionalUsdToday: 9.33,
    notionalRmToday: 39.49,
  },
  sessions: SESSIONS,
};

export const PROJECTS: ProjectSummary[] = [
  { projectId: 'prj_cx', name: 'CX Copilot', slug: 'cx', repoPath: null, progress: { ...progress, pct: 76.8 }, activeSessions: 2, openDecisions: 1, lastActivityAt: ago(1) },
  { projectId: 'prj_claims', name: 'Claims Intake Bot', slug: 'claims', repoPath: null, progress: { ...progress, pct: 83.6 }, activeSessions: 1, openDecisions: 1, lastActivityAt: ago(1) },
  { projectId: 'prj_aoc', name: 'AOC Platform', slug: 'aoc', repoPath: null, progress: { ...progress, pct: 98.1 }, activeSessions: 1, openDecisions: 0, lastActivityAt: ago(1) },
];

function task(taskId: string, phaseId: string, weight: number, status: 'open' | 'done' | 'removed') {
  return { taskId, phaseId, title: taskId, size: 'm' as const, weight, status, declaredBy: 'usr_1', sessionId: 'x', doneAt: null, evidence: null, flag: null };
}

/** Feature plan: Design (5) → Build (10) → Verify (2); `done` task ids are complete. */
export function manifest(done: string[]): ManifestPhaseDTO[] {
  const st = (id: string) => (done.includes(id) ? 'done' : 'open');
  return [
    { phaseId: 'build', name: 'Build', order: 1, completedAt: null, pinnedSha: null, pinnedTag: null, tasks: [task('t3', 'build', 5, st('t3')), task('t4', 'build', 3, st('t4')), task('t5', 'build', 2, st('t5'))] },
    { phaseId: 'design', name: 'Design', order: 0, completedAt: null, pinnedSha: null, pinnedTag: null, tasks: [task('t1', 'design', 2, st('t1')), task('t2', 'design', 3, st('t2')), task('tx', 'design', 8, 'removed')] },
    { phaseId: 'verify', name: 'Verify', order: 2, completedAt: null, pinnedSha: null, pinnedTag: null, tasks: [task('t6', 'verify', 2, st('t6'))] },
  ];
}

export function decision(overrides: Partial<DecisionCardView> & { id: string; kind: DecisionCardView['kind'] }): DecisionCardView {
  return {
    status: 'open',
    test: null,
    title: 'x',
    question: 'x',
    options: [],
    recommendation: null,
    context: null,
    requiredRole: 'approver',
    requiresPasskey: false,
    requesterId: 'system:intake',
    excludedApproverIds: [],
    eligibleUserIds: null,
    subjectType: 'ticket',
    subjectId: 'tkt_1',
    sessionId: null,
    projectId: null,
    createdAt: ago(10),
    dueAt: null,
    resolution: null,
    ageMs: 600_000,
    overdue: false,
    closedAt: null,
    erased: false,
    escalation: null,
    withdrawal: null,
    viewer: { canResolve: true, reason: null, canWithdraw: true, canEscalate: false },
    ...overrides,
  };
}

export const DECISIONS: DecisionCardView[] = [
  decision({ id: 'dec_s', kind: 'agent_decision', sessionId: 'ses_wait', projectId: 'prj_claims', createdAt: ago(34) }),
  decision({ id: 'dec_fix', kind: 'fix_plan', projectId: 'prj_cx', createdAt: ago(15) }),
  decision({ id: 'dec_top', kind: 'credit_topup', createdAt: ago(200) }),
];
