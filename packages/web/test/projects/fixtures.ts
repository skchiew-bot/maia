/**
 * DTO fixtures for the Projects pages, trimmed from a seeded daemon's real responses and typed against the
 * contracts so a shape change breaks the build, not the page. "Now" is 2026-10-09T06:00:00Z.
 */
import type {
  DecisionCardView,
  DecisionListResponse,
  ManifestTaskDTO,
  MeteringCostRow,
  MeteringSummaryDTO,
  PlaybookDTO,
  ProgressDTO,
  ProjectDetail,
  ProjectHistory,
  ProjectRollup,
  ProjectSummary,
  ProjectTimeline,
  RegistryTypesResponse,
  SessionSummary,
  ThreadDetail,
} from '@aoc/contracts';

export const NOW = Date.parse('2026-10-09T06:00:00Z');
const H = 3_600_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

export const USERS = {
  weijie: 'usr_weijie',
  priya: 'usr_priya',
  aisyah: 'usr_aisyah',
};

function progress(p: Partial<ProgressDTO>): ProgressDTO {
  return {
    doneTasks: 0,
    totalTasks: 0,
    doneWeight: 0,
    totalWeight: 0,
    pct: 0,
    flaggedTasks: 0,
    etaMs: null,
    etaHiddenReason: 'fewer_than_3_done',
    ...p,
  };
}

export const SUMMARIES: ProjectSummary[] = [
  {
    projectId: 'prj_aoc',
    name: 'AOC Platform',
    slug: 'aoc-platform',
    repoPath: '/srv/repos/aoc-platform',
    progress: progress({
      doneTasks: 10,
      totalTasks: 10,
      doneWeight: 30,
      totalWeight: 30,
      pct: 100,
      etaHiddenReason: 'complete',
    }),
    activeSessions: 0,
    openDecisions: 0,
    lastActivityAt: iso(2 * H),
  },
  {
    projectId: 'prj_cx',
    name: 'CX Copilot',
    slug: 'cx-copilot',
    repoPath: '/srv/repos/cx-copilot',
    progress: progress({
      doneTasks: 3,
      totalTasks: 6,
      doneWeight: 8,
      totalWeight: 17,
      pct: 47.1,
      flaggedTasks: 1,
      etaMs: 5 * H,
      etaHiddenReason: null,
    }),
    activeSessions: 2,
    openDecisions: 1,
    lastActivityAt: iso(10 * 60_000),
  },
];

const rollupPhase = (
  p: Partial<ProjectRollup['phases'][number]> & { phaseId: string; name: string; order: number },
) => ({
  doneTasks: 0,
  totalTasks: 0,
  doneWeight: 0,
  totalWeight: 0,
  flaggedTasks: 0,
  flaggedWeight: 0,
  completedAt: null,
  pinnedTag: null,
  pinnedSha: null,
  ...p,
});

export const ROLLUPS: ProjectRollup[] = [
  {
    projectId: 'prj_aoc',
    phases: [
      rollupPhase({
        phaseId: 'docs',
        name: 'Docs',
        order: 0,
        doneTasks: 10,
        totalTasks: 10,
        doneWeight: 30,
        totalWeight: 30,
        completedAt: iso(3 * H),
        pinnedTag: 'aoc/aoc-platform/docs/40',
        pinnedSha: 'c381ede6a1b2',
      }),
    ],
    currentPhaseId: null,
    drift: { total: 0, last7d: 0, highLast7d: 0, lastAt: null },
    amendments: { count: 0, last7d: 0, lastAt: null },
  },
  {
    projectId: 'prj_cx',
    phases: [
      rollupPhase({
        phaseId: 'design',
        name: 'Design',
        order: 0,
        doneTasks: 2,
        totalTasks: 2,
        doneWeight: 5,
        totalWeight: 5,
        flaggedTasks: 1,
        flaggedWeight: 2,
        completedAt: iso(20 * H),
        pinnedTag: 'aoc/cx-copilot/design/12',
        pinnedSha: 'b5553275aa',
      }),
      rollupPhase({
        phaseId: 'build',
        name: 'Build',
        order: 1,
        doneTasks: 1,
        totalTasks: 3,
        doneWeight: 3,
        totalWeight: 10,
      }),
      rollupPhase({ phaseId: 'verify', name: 'Verify', order: 2, totalTasks: 1, totalWeight: 2 }),
    ],
    currentPhaseId: 'build',
    drift: { total: 3, last7d: 2, highLast7d: 1, lastAt: iso(H) },
    amendments: { count: 1, last7d: 1, lastAt: iso(2 * H) },
  },
];

function session(p: Partial<SessionSummary> & { sessionId: string }): SessionSummary {
  return {
    mode: 'managed',
    title: 'Session',
    projectId: 'prj_cx',
    projectName: 'CX Copilot',
    threadId: 'thr_cx_main',
    phaseId: null,
    phaseName: null,
    processType: 'feature-build',
    model: 'claude-sonnet-5-5',
    ownerId: USERS.weijie,
    ownerName: 'Tan Wei Jie',
    lifecycle: 'running',
    liveness: { state: 'working', reason: 'tool_activity', since: iso(5 * 60_000) },
    apm: { windowMinutes: 30, points: [], current: 0 },
    progress: progress({ doneTasks: 1, totalTasks: 4, doneWeight: 3, totalWeight: 12 }),
    contextTokens: 80_000,
    contextPct: 8,
    costTodayUsd: 1.4,
    openDecision: null,
    throttledUntil: null,
    lastActivityAt: iso(5 * 60_000),
    startedAt: iso(3 * H),
    ticketId: null,
    ...p,
  };
}

export const SESSIONS: SessionSummary[] = [
  session({
    sessionId: 'ses_01CXWAIT000001',
    title: 'Real-time CSAT sentiment overlay',
    lifecycle: 'waiting_decision',
    liveness: { state: 'waiting_on_you', reason: 'open_decision', since: iso(40 * 60_000) },
    openDecision: { decisionId: 'dec_1', kind: 'agent_decision', createdAt: iso(40 * 60_000) },
  }),
  session({
    sessionId: 'ses_01CXDEAD000002',
    title: 'Migrate interaction history',
    ownerId: USERS.priya,
    ownerName: 'Priya Nair',
    processType: 'migration',
    model: 'claude-opus-5-5',
    lifecycle: 'failed',
    liveness: { state: 'dead', reason: 'process_failed', since: iso(2 * H) },
  }),
  session({
    sessionId: 'ses_01CXOLD0000003',
    title: 'Map current flow',
    ownerId: USERS.aisyah,
    ownerName: 'Aisyah Rahman',
    lifecycle: 'ended',
    liveness: null,
    startedAt: iso(30 * H),
    lastActivityAt: iso(26 * H),
  }),
];

const row = (key: string, usd: number, rm: number): MeteringSummaryDTO['rows'][number] => ({
  ...cost(usd, rm),
  key,
  label: null,
});
function cost(usd: number, rm: number): MeteringCostRow {
  return {
    inputTokens: 1000,
    outputTokens: 2000,
    cacheReadTokens: 3000,
    cacheWriteTokens: 400,
    cacheWrite5mTokens: 100,
    cacheWrite1hTokens: 300,
    totalTokens: 6400,
    messages: 12,
    notionalUsd: usd,
    notionalRm: rm,
    rmComplete: true,
    unpriced: false,
    unpricedTokens: 0,
    unpricedModels: [],
    tierPricedModels: [],
  };
}

export const SPEND: MeteringSummaryDTO = {
  costBasis: 'notional_api_equivalent',
  costLabel: 'Notional API-equivalent cost (decision support, not a bill)',
  scope: 'org',
  groupBy: 'project',
  from: '2026-10-03',
  to: '2026-10-09',
  rows: [row('prj_cx', 8.17, 34.53), row('prj_aoc', 12, 50.81)],
  totals: cost(20.17, 85.34),
  closedDays: 6,
  openDays: 1,
  fxMissingDays: [],
  subscription: { usd: 225.8, rm: 955.26 },
  generatedAt: new Date(NOW).toISOString(),
};

function task(
  p: Partial<ManifestTaskDTO> & { taskId: string; phaseId: string; title: string },
): ManifestTaskDTO {
  return {
    acceptance: null,
    size: 's',
    weight: 2,
    status: 'open',
    declaredBy: 'ses_01CXOLD0000003',
    sessionId: 'ses_01CXOLD0000003',
    doneAt: null,
    evidence: null,
    flag: null,
    ...p,
  };
}

export const CX_DETAIL: ProjectDetail = {
  ...SUMMARIES[1]!,
  description: 'Agent-assist copilot for the contact centre',
  defaultBranch: 'main',
  createdAt: iso(48 * H),
  threads: [
    {
      threadId: 'thr_cx_main',
      projectId: 'prj_cx',
      title: 'CX Copilot — main thread',
      activeWriterSessionId: 'ses_01CXWAIT000001',
      createdAt: iso(40 * H),
    },
  ],
};

export const CX_TIMELINE: ProjectTimeline = {
  projectId: 'prj_cx',
  name: 'CX Copilot',
  progress: SUMMARIES[1]!.progress,
  phases: [],
  amendments: [],
  manifest: [
    {
      phaseId: 'design',
      name: 'Design',
      order: 0,
      completedAt: iso(20 * H),
      pinnedSha: 'b5553275aa11cc',
      pinnedTag: 'aoc/cx-copilot/design/12',
      tasks: [
        task({
          taskId: 't1',
          phaseId: 'design',
          title: 'Map current flow and data contracts',
          status: 'done',
          doneAt: iso(21 * H),
          evidence: { kind: 'commit', ref: '3558d66aa0', verified: true },
        }),
        task({
          taskId: 't2',
          phaseId: 'design',
          title: 'Write API contract + acceptance tests',
          size: 'm',
          weight: 3,
          status: 'done',
          doneAt: iso(20 * H),
          evidence: { kind: 'test', ref: 'api/t2.test.ts > passes', verified: true },
          flag: 'no_file_change',
        }),
      ],
    },
    {
      phaseId: 'build',
      name: 'Build',
      order: 1,
      completedAt: null,
      pinnedSha: null,
      pinnedTag: null,
      tasks: [
        task({
          taskId: 't3',
          phaseId: 'build',
          title: 'Implement service layer',
          size: 'm',
          weight: 3,
          status: 'done',
          doneAt: iso(H),
          declaredBy: USERS.weijie,
          sessionId: 'ses_01CXWAIT000001',
          evidence: { kind: 'diff', ref: 'diff:e07195bf548b', verified: true },
        }),
        task({
          taskId: 't4',
          phaseId: 'build',
          title: 'Wire UI and telemetry events',
          size: 'l',
          weight: 5,
          declaredBy: USERS.weijie,
          sessionId: 'ses_01CXWAIT000001',
        }),
        task({
          taskId: 't7',
          phaseId: 'build',
          title: 'Keyboard shortcuts for the overlay',
          declaredBy: USERS.weijie,
          sessionId: 'ses_01CXWAIT000001',
        }),
        task({
          taskId: 't5',
          phaseId: 'build',
          title: 'Edge cases',
          status: 'removed',
          declaredBy: USERS.weijie,
          sessionId: 'ses_01CXWAIT000001',
        }),
      ],
    },
    {
      phaseId: 'verify',
      name: 'Verify',
      order: 2,
      completedAt: null,
      pinnedSha: null,
      pinnedTag: null,
      tasks: [
        task({
          taskId: 't6',
          phaseId: 'verify',
          title: 'Regression suite green',
          declaredBy: USERS.weijie,
          sessionId: 'ses_01CXWAIT000001',
        }),
      ],
    },
  ],
};

export const CX_HISTORY: ProjectHistory = {
  projectId: 'prj_cx',
  scope: [
    {
      seq: 100,
      at: iso(30 * H),
      kind: 'declared',
      sessionId: 'ses_01CXOLD0000003',
      ownerId: USERS.aisyah,
      ownerName: 'Aisyah Rahman',
      manifestVersion: 1,
      added: 2,
      removed: 0,
      resized: 0,
      carriedOver: 0,
      weightDelta: 5,
      projectWeightBefore: 0,
      projectWeightAfter: 5,
      reason: null,
    },
    {
      seq: 200,
      at: iso(3 * H),
      kind: 'declared',
      sessionId: 'ses_01CXWAIT000001',
      ownerId: USERS.weijie,
      ownerName: 'Tan Wei Jie',
      manifestVersion: 1,
      added: 4,
      removed: 0,
      resized: 0,
      carriedOver: 0,
      weightDelta: 12,
      projectWeightBefore: 5,
      projectWeightAfter: 17,
      reason: null,
    },
    {
      seq: 300,
      at: iso(2 * H),
      kind: 'amended',
      sessionId: 'ses_01CXWAIT000001',
      ownerId: USERS.weijie,
      ownerName: 'Tan Wei Jie',
      manifestVersion: 2,
      added: 1,
      removed: 1,
      resized: 0,
      carriedOver: 0,
      weightDelta: 0,
      projectWeightBefore: 17,
      projectWeightAfter: 17,
      reason: 'UAT feedback from the CX ops lead: keyboard access to the overlay',
    },
  ],
  drift: [
    {
      seq: 250,
      at: iso(H),
      sessionId: 'ses_01CXWAIT000001',
      kind: 'off_plan_change',
      severity: 'high',
      taskId: null,
      detail: 'Edit changed files before a plan manifest was declared.',
    },
  ],
  enhancements: [],
  pins: [
    {
      phaseId: 'design',
      sessionId: 'ses_01CXOLD0000003',
      tag: 'aoc/cx-copilot/design/12',
      sha: 'b5553275aa11cc',
      at: iso(20 * H),
    },
  ],
};

export const CX_DECISION: DecisionCardView = {
  id: 'dec_1',
  kind: 'agent_decision',
  status: 'open',
  test: 'main',
  title: 'Merge the sentiment overlay to main?',
  question: 'Merge now or hold for UAT?',
  options: [
    { id: 'merge', label: 'Merge' },
    { id: 'uat', label: 'Hold for UAT' },
  ],
  recommendation: { optionId: 'uat', rationale: 'Blast radius.' },
  context: null,
  requiredRole: 'approver',
  requiresPasskey: false,
  requesterId: 'session:ses_01CXWAIT000001',
  excludedApproverIds: [],
  eligibleUserIds: null,
  subjectType: 'session',
  subjectId: 'ses_01CXWAIT000001',
  sessionId: 'ses_01CXWAIT000001',
  projectId: 'prj_cx',
  createdAt: iso(40 * 60_000),
  dueAt: null,
  resolution: null,
  ageMs: 40 * 60_000,
  overdue: false,
  closedAt: null,
  erased: false,
  escalation: null,
  withdrawal: null,
  viewer: { canResolve: true, reason: null, canWithdraw: true, canEscalate: false },
};

export const DECISIONS: DecisionListResponse = {
  generatedAt: new Date(NOW).toISOString(),
  decisions: [CX_DECISION],
};

export const THREAD: ThreadDetail = {
  ...CX_DETAIL.threads[0]!,
  writers: [
    { sessionId: 'ses_01CXOLD0000003', acquiredAt: iso(30 * H), releasedAt: iso(26 * H), reason: 'rollover' },
    { sessionId: 'ses_01CXWAIT000001', acquiredAt: iso(3 * H), releasedAt: null, reason: null },
  ],
  sessionIds: ['ses_01CXOLD0000003', 'ses_01CXWAIT000001'],
  progress: SUMMARIES[1]!.progress,
};

export const REGISTRY: RegistryTypesResponse = {
  version: '2026.10.1',
  versionHash: 'abc',
  types: [
    {
      id: 'feature-build',
      name: 'Feature build',
      description: 'Feature work.',
      class: 'execution',
      model: 'opus',
      executionModel: 'sonnet',
      readOnly: false,
      credentialProfile: 'git-feature',
      permissionMode: 'acceptEdits',
      tools: {},
      requiresPlan: true,
      rolloverContextPct: 70,
      risky: false,
      currentModel: 'sonnet',
      activePlaybookId: 'pbk_feature',
    },
  ],
};

export const PLAYBOOKS: PlaybookDTO[] = [
  {
    playbookId: 'pbk_feature',
    processType: 'feature-build',
    version: 1,
    title: 'Feature build playbook',
    steps: [],
    rationale: null,
    status: 'approved',
    active: true,
    method: 'llm',
    sourceSessionId: null,
    projectId: null,
    decisionId: 'dec_pb',
    proposedBy: USERS.priya,
    proposedAt: iso(100 * H),
    approvedAt: iso(90 * H),
    approvedBy: 'usr_ceo',
    rejectedAt: null,
    rejectedBy: null,
    retiredAt: null,
    retireReason: null,
    erased: false,
  },
];
