import type {
  ConsoleSnapshot,
  DecisionCard,
  ProgressDTO,
  ProjectSummary,
  ProjectTimeline,
  SessionDetail,
  SessionSummary,
  User,
} from '@aoc/contracts';

export function progress(over: Partial<ProgressDTO> = {}): ProgressDTO {
  return {
    doneTasks: 3,
    totalTasks: 8,
    doneWeight: 9,
    totalWeight: 20,
    pct: 45,
    flaggedTasks: 0,
    etaMs: null,
    etaHiddenReason: 'fewer_than_3_done',
    ...over,
  };
}

export function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'ses_A',
    mode: 'managed',
    title: 'Fix login',
    projectId: 'prj_1',
    projectName: 'Alpha',
    threadId: 'thr_1',
    phaseId: 'ph_build',
    phaseName: 'Build',
    processType: 'feature-build',
    model: 'claude-opus-5-5',
    ownerId: 'usr_1',
    ownerName: 'Alice',
    lifecycle: 'running',
    liveness: { state: 'working', reason: 'recent_tool', since: '2026-10-09T09:58:00.000Z' },
    apm: { windowMinutes: 10, points: [], current: 0 },
    progress: progress(),
    contextTokens: 420_000,
    contextPct: 42,
    costTodayUsd: 1.5,
    openDecision: null,
    throttledUntil: null,
    lastActivityAt: '2026-10-09T09:59:00.000Z',
    startedAt: '2026-10-09T09:00:00.000Z',
    ticketId: null,
    ...over,
  };
}

export function detail(over: Partial<SessionDetail> = {}): SessionDetail {
  const allowed = { enabled: true, reason: null };
  return {
    ...session(),
    claudeSessionId: '00000000-0000-4000-8000-000000000000',
    cwd: '/work/alpha',
    readOnly: false,
    turns: 2,
    tokens: [
      {
        model: 'claude-opus-5-5',
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadTokens: 5000,
        cacheWriteTokens: 100,
        notionalUsd: 0.42,
      },
    ],
    contextWindowTokens: 1_000_000,
    predecessorSessionId: null,
    successorSessionId: null,
    actions: {
      nudge: allowed,
      restart: { enabled: false, reason: 'process is running' },
      stop: allowed,
      rollover: allowed,
      prompt: allowed,
    },
    ...over,
  };
}

export function snapshot(sessions: SessionSummary[]): ConsoleSnapshot {
  return {
    generatedAt: '2026-10-09T10:00:00.000Z',
    kpis: {
      activeSessions: sessions.length,
      waitingOnYou: 1,
      oldestWaitingSince: '2026-10-09T09:46:00.000Z',
      throttled: 0,
      throttleIdleMsToday: 0,
      tasksDoneToday: 7,
      tasksDoneWithEvidencePct: 86,
      notionalUsdToday: 12.345,
      notionalRmToday: 57.1,
    },
    sessions,
  };
}

export function card(over: Partial<DecisionCard> = {}): DecisionCard {
  return {
    id: 'dec_1',
    kind: 'agent_decision',
    status: 'open',
    test: 'irreversible',
    title: 'Pick a schema',
    question: 'Which schema?',
    options: [
      { id: 'a', label: 'Option A' },
      { id: 'b', label: 'Option B' },
    ],
    recommendation: { optionId: 'a', rationale: 'simpler' },
    context: null,
    requiredRole: 'builder',
    requiresPasskey: false,
    requesterId: 'usr_2',
    excludedApproverIds: [],
    eligibleUserIds: null,
    subjectType: 'session',
    subjectId: 'ses_A',
    sessionId: 'ses_A',
    projectId: 'prj_1',
    createdAt: '2026-10-09T09:30:00.000Z',
    dueAt: null,
    resolution: null,
    viewer: { canResolve: true, reason: null },
    ...over,
  };
}

export function user(over: Partial<User> = {}): User {
  return { id: 'usr_1', name: 'Alice', email: null, role: 'builder', flags: {}, active: true, ...over };
}

export function project(over: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    projectId: 'prj_1',
    name: 'Alpha',
    slug: 'alpha',
    repoPath: '/repos/alpha',
    progress: progress(),
    activeSessions: 2,
    openDecisions: 1,
    lastActivityAt: '2026-10-09T09:55:00.000Z',
    ...over,
  };
}

export function timeline(): ProjectTimeline {
  return {
    projectId: 'prj_1',
    name: 'Alpha',
    progress: progress({ doneTasks: 5, totalTasks: 9, doneWeight: 10, totalWeight: 20, pct: 50 }),
    phases: [
      {
        phaseId: 'ph_b',
        name: 'Build',
        order: 2,
        doneWeight: 4,
        totalWeight: 16,
        completedAt: null,
        segments: [
          { ownerId: 'usr_1', ownerName: 'Alice', doneWeight: 3, totalWeight: 10 },
          { ownerId: 'usr_2', ownerName: 'Bob', doneWeight: 1, totalWeight: 6 },
        ],
      },
      {
        phaseId: 'ph_d',
        name: 'Discovery',
        order: 1,
        doneWeight: 4,
        totalWeight: 4,
        completedAt: '2026-10-05T00:00:00.000Z',
        segments: [{ ownerId: 'usr_1', ownerName: 'Alice', doneWeight: 4, totalWeight: 4 }],
      },
    ],
    amendments: [
      {
        at: '2026-10-06T00:00:00.000Z',
        by: 'usr_2',
        byName: 'Bob',
        sessionId: 'ses_B',
        added: 2,
        removed: 0,
        resized: 1,
        prevTotalWeight: 16,
        newTotalWeight: 20,
        reason: 'scope',
      },
    ],
    manifest: [
      {
        phaseId: 'ph_d',
        name: 'Discovery',
        order: 1,
        completedAt: '2026-10-05T00:00:00.000Z',
        pinnedSha: 'abcdef1234567',
        pinnedTag: null,
        tasks: [
          {
            taskId: 't1',
            phaseId: 'ph_d',
            title: 'x',
            size: 'm',
            weight: 3,
            status: 'done',
            declaredBy: 'usr_1',
            sessionId: 'ses_A',
            doneAt: null,
            evidence: null,
            flag: null,
          },
          {
            taskId: 't2',
            phaseId: 'ph_d',
            title: 'y',
            size: 'xs',
            weight: 1,
            status: 'done',
            declaredBy: 'usr_1',
            sessionId: 'ses_A',
            doneAt: null,
            evidence: null,
            flag: null,
          },
          {
            taskId: 't3',
            phaseId: 'ph_d',
            title: 'z',
            size: 'xs',
            weight: 1,
            status: 'removed',
            declaredBy: 'usr_1',
            sessionId: 'ses_A',
            doneAt: null,
            evidence: null,
            flag: null,
          },
        ],
      },
    ],
  };
}
