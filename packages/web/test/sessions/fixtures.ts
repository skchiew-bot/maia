import type {
  ConsoleSnapshot,
  DecisionCardView,
  ManifestPhaseDTO,
  MeteringSessionDTO,
  ProgressDTO,
  RateCardDTO,
  RegistryTypesResponse,
  SessionActivityDTO,
  SessionDetail,
  SessionSummary,
  SessionTimeline,
  ThreadDetail,
} from '@aoc/contracts';

/** Fixed "now" for page tests: Fri 9 Oct 2026, 13:42 in Kuala Lumpur (05:42Z). */
export const NOW = Date.parse('2026-10-09T05:42:00.000Z');
export const MIN = 60_000;
export const iso = (ms: number) => new Date(ms).toISOString();
export const ago = (minutes: number) => iso(NOW - minutes * MIN);

export function progress(over: Partial<ProgressDTO> = {}): ProgressDTO {
  return {
    doneTasks: 2,
    totalTasks: 6,
    doneWeight: 5,
    totalWeight: 17,
    pct: 29.4,
    flaggedTasks: 0,
    etaMs: null,
    etaHiddenReason: 'fewer_than_3_done',
    ...over,
  };
}

export function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'ses_work',
    mode: 'managed',
    title: 'Add supervisor whisper suggestions',
    projectId: 'prj_cx',
    projectName: 'CX Copilot',
    threadId: 'thr_cx',
    phaseId: null,
    phaseName: null,
    currentPhase: { phaseId: 'build', name: 'Build', index: 2, count: 3 },
    processType: 'feature-build',
    model: 'claude-sonnet-5-5',
    ownerId: 'usr_aisyah',
    ownerName: 'Aisyah Rahman',
    lifecycle: 'running',
    liveness: { state: 'working', reason: 'recent_tool', since: ago(12) },
    apm: { windowMinutes: 30, points: Array.from({ length: 30 }, (_, i) => (i % 5) + 2), current: 6 },
    progress: progress(),
    contextTokens: 410_000,
    contextPct: 41,
    costTodayUsd: 28.22,
    costTodayRm: 118.94,
    openDecision: null,
    throttledUntil: null,
    lastActivityAt: ago(0),
    startedAt: ago(390),
    endedAt: null,
    outcome: null,
    ticketId: null,
    ...over,
  };
}

const allowed = { enabled: true, reason: null };

export function detail(over: Partial<SessionDetail> = {}): SessionDetail {
  return {
    ...summary(),
    claudeSessionId: '00000000-0000-4000-8000-000000000001',
    cwd: '/work/cx',
    readOnly: false,
    turns: 3,
    tokens: [
      {
        model: 'claude-sonnet-5-5',
        inputTokens: 1_240_000,
        outputTokens: 860_000,
        cacheReadTokens: 48_600_000,
        cacheWriteTokens: 2_910_000,
        notionalUsd: 28.08,
      },
    ],
    contextWindowTokens: 1_000_000,
    predecessorSessionId: 'ses_prev',
    successorSessionId: null,
    actions: {
      nudge: allowed,
      restart: { enabled: false, reason: 'Restart is for dead, stalled or idle sessions' },
      stop: allowed,
      rollover: { enabled: false, reason: 'Not at a clean task boundary: t4 in progress' },
      prompt: { enabled: false, reason: 'Prompts can be sent when the session is idle' },
    },
    ...over,
  };
}

export function snapshot(sessions: SessionSummary[]): ConsoleSnapshot {
  return {
    generatedAt: iso(NOW),
    today: '2026-10-09',
    kpis: {
      activeSessions: sessions.filter((s) => !['ended', 'retired', 'failed'].includes(s.lifecycle)).length,
      waitingOnYou: sessions.filter((s) => s.liveness?.state === 'waiting_on_you').length,
      oldestWaitingSince: null,
      throttled: sessions.filter((s) => s.liveness?.state === 'throttled').length,
      throttleIdleMsToday: 47 * MIN,
      tasksDoneToday: 23,
      tasksDoneWithEvidencePct: 91.3,
      notionalUsdToday: 152.38,
      notionalRmToday: 642.27,
    },
    sessions,
  };
}

export function decision(over: Partial<DecisionCardView> = {}): DecisionCardView {
  return {
    id: 'dec_1',
    kind: 'agent_decision',
    status: 'open',
    test: 'data',
    title: 'Backfill 41,208 claims tonight?',
    question: 'Overnight batches, one transaction now, or derive on read?',
    options: [
      { id: 'batches', label: 'Batches of 5,000, 01:00–04:00' },
      { id: 'now', label: 'One transaction now' },
    ],
    recommendation: { optionId: 'batches', rationale: 'Each batch reverses on its own.' },
    context: null,
    requiredRole: 'approver',
    requiresPasskey: false,
    requesterId: 'session:ses_wait',
    excludedApproverIds: [],
    eligibleUserIds: null,
    subjectType: 'session',
    subjectId: 'ses_wait',
    sessionId: 'ses_wait',
    projectId: 'prj_claims',
    createdAt: ago(134),
    dueAt: null,
    resolution: null,
    ageMs: 134 * MIN,
    overdue: false,
    closedAt: null,
    erased: false,
    escalation: null,
    withdrawal: null,
    viewer: { canResolve: true, reason: null, canWithdraw: false, canEscalate: false },
    ...over,
  };
}

export function manifest(): ManifestPhaseDTO[] {
  const task = (taskId: string, phaseId: string, title: string, size: 's' | 'm' | 'l', status: 'open' | 'done', extra = {}) => ({
    taskId,
    phaseId,
    title,
    acceptance: null,
    size,
    weight: size === 's' ? 2 : size === 'm' ? 3 : 5,
    status,
    declaredBy: 'ses_work',
    sessionId: 'ses_work',
    doneAt: status === 'done' ? ago(200) : null,
    evidence: status === 'done' ? { kind: 'commit' as const, ref: '1f0b7aa94c2e', verified: true } : null,
    flag: null,
    ...extra,
  });
  return [
    {
      phaseId: 'design',
      name: 'Design',
      order: 0,
      completedAt: ago(300),
      pinnedSha: '3f9a1c4e8b2d',
      pinnedTag: 'aoc/cx/design/1',
      tasks: [task('t1', 'design', 'Map the data contracts', 's', 'done')],
    },
    {
      phaseId: 'build',
      name: 'Build',
      order: 1,
      completedAt: null,
      pinnedSha: null,
      pinnedTag: null,
      tasks: [
        task('t2', 'build', 'Confidence badge on summary card', 'm', 'done', {
          flag: 'no_file_change',
          evidence: { kind: 'commit', ref: '9b07d3e11aa0', verified: true },
        }),
        task('t3', 'build', 'Agent notes quick-insert', 'l', 'open'),
      ],
    },
    {
      phaseId: 'verify',
      name: 'Verify',
      order: 2,
      completedAt: null,
      pinnedSha: null,
      pinnedTag: null,
      tasks: [task('t4', 'verify', 'Regression suite green', 's', 'open')],
    },
  ];
}

export function timeline(over: Partial<SessionTimeline> = {}): SessionTimeline {
  return {
    sessionId: 'ses_work',
    startAt: ago(390),
    endAt: null,
    now: iso(NOW),
    phases: [
      { phaseId: 'design', name: 'Design', startAt: ago(380), endAt: ago(300), doneWeight: 2, totalWeight: 2 },
      { phaseId: 'build', name: 'Build', startAt: ago(300), endAt: null, doneWeight: 3, totalWeight: 8 },
    ],
    marks: [
      { kind: 'decision', at: ago(240), label: 'Store summaries as JSONB?', refId: 'dec_old', severity: null },
      { kind: 'decision', at: ago(218), label: 'Resolved: jsonb', refId: 'dec_old', severity: null },
      { kind: 'drift', at: ago(150), label: 'off_plan_change', refId: 't3', severity: 'medium' },
      { kind: 'phase_complete', at: ago(300), label: 'Design', refId: 'design', severity: null },
      { kind: 'task_done', at: ago(200), label: 't2 · no_file_change', refId: 't2', severity: 'medium' },
      { kind: 'amendment', at: ago(55), label: 'v2: +1 −0 ~0', refId: 'evt_a', severity: null },
      { kind: 'tool', at: ago(10), label: 'Edit', refId: 'toolu_1', severity: null },
    ],
    progress: progress({ doneTasks: 2, totalTasks: 4, doneWeight: 5, totalWeight: 12, pct: 41.7, flaggedTasks: 1 }),
    manifest: manifest(),
    amendments: [
      {
        at: ago(55),
        by: 'usr_aisyah',
        byName: 'Aisyah Rahman',
        sessionId: 'ses_work',
        added: 1,
        removed: 0,
        resized: 0,
        prevTotalWeight: 10,
        newTotalWeight: 12,
        reason: 'CX ops lead UAT feedback',
      },
    ],
    ...over,
  };
}

export function activity(over: Partial<SessionActivityDTO> = {}): SessionActivityDTO {
  return {
    sessionId: 'ses_work',
    minutes: [
      { at: iso(NOW - 120 * MIN), count: 4 },
      { at: iso(NOW - 119 * MIN), count: 11 },
      { at: iso(NOW - 10 * MIN), count: 6 },
    ],
    totalToolCalls: 21,
    throttles: [{ startAt: ago(100), endAt: ago(77), resetAt: ago(77), idleMs: 23 * MIN }],
    ...over,
  };
}

export function metering(): MeteringSessionDTO {
  const row = {
    inputTokens: 1_240_000,
    outputTokens: 860_000,
    cacheReadTokens: 48_600_000,
    cacheWriteTokens: 2_910_000,
    cacheWrite5mTokens: 910_000,
    cacheWrite1hTokens: 2_000_000,
    totalTokens: 53_610_000,
    messages: 412,
    notionalUsd: 28.22,
    notionalRm: 118.94,
    rmComplete: true,
    unpriced: false,
    unpricedTokens: 0,
    unpricedModels: [],
    tierPricedModels: [],
  };
  return {
    costBasis: 'notional_api_equivalent',
    costLabel: 'Notional API-equivalent cost (decision support, not a bill)',
    sessionId: 'ses_work',
    ownerId: 'usr_aisyah',
    projectId: 'prj_cx',
    processType: 'feature-build',
    ticketId: null,
    totals: row,
    byModel: [{ key: 'claude-sonnet-5-5', label: null, ...row }],
    byTask: [],
    byDay: [],
    throttle: { hits: 1, idleMs: 23 * MIN, idleHours: 0.4, throttledNow: false },
    generatedAt: iso(NOW),
  };
}

export function rateCard(): RateCardDTO {
  return {
    costBasis: 'notional_api_equivalent',
    costLabel: 'Notional API-equivalent cost (decision support, not a bill)',
    today: '2026-10-09',
    active: {
      version: 3,
      effectiveFrom: '2026-10-01',
      status: 'active',
      currency: 'USD',
      rates: [
        {
          model: 'claude-sonnet-5-5',
          inputPerMTok: 2,
          outputPerMTok: 10,
          cacheReadPerMTok: 0.2,
          cacheWrite5mPerMTok: 2.5,
          cacheWrite1hPerMTok: 4,
        },
      ],
      tierFallback: { sonnet: 'claude-sonnet-5-5' },
      note: null,
      ratesHash: 'x',
      publishedAt: ago(10_000),
      publishedBy: 'metering',
      erased: false,
    },
    scheduled: [],
    lastClosedDay: '2026-10-08',
    earliestEffectiveFrom: '2026-10-10',
  };
}

export function registry(): RegistryTypesResponse {
  return {
    version: '1',
    versionHash: 'h',
    types: [
      {
        id: 'feature-build',
        name: 'Feature build',
        description: '',
        class: 'execution',
        model: 'opus',
        executionModel: 'sonnet',
        readOnly: false,
        credentialProfile: null,
        permissionMode: 'acceptEdits',
        tools: {},
        requiresPlan: true,
        rolloverContextPct: 70,
        risky: false,
        currentModel: 'sonnet',
        activePlaybookId: null,
      },
    ],
  };
}

export function thread(over: Partial<ThreadDetail> = {}): ThreadDetail {
  return {
    threadId: 'thr_cx',
    projectId: 'prj_cx',
    title: 'CX Copilot — main thread',
    activeWriterSessionId: 'ses_work',
    createdAt: ago(10_000),
    writers: [],
    sessionIds: ['ses_prev', 'ses_work'],
    progress: progress(),
    ...over,
  };
}
