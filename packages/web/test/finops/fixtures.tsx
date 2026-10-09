/**
 * FinOps test fixtures, shaped like the daemon's real responses (captured from a seeded demo daemon) and cut down
 * to what each test needs.
 */
import { configure, render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type {
  CreditAccount,
  CreditTopupRequest,
  DecisionCardView,
  FxRateDTO,
  FxStatusDTO,
  MeteringDayDTO,
  MeteringSubscriptionDTO,
  MeteringSummaryRow,
  MeteringThrottleDTO,
  PlaybookDTO,
  ProcessTypeView,
  ProjectSummary,
  RateCardVersionDTO,
  RegistryEntry,
  RegistryRunDTO,
  RegistryTrendPoint,
  SessionSummary,
} from '@aoc/contracts';
import { AuthProvider, EventStreamProvider, type AuthUser } from '../../src/api';
import { ClockProvider, ToastProvider, fixedClock } from '../../src/components';
import { FakeEventSource, FakeEventSourceCtor, jsonResponse, mockFetch } from '../helpers';

export const NOW = Date.parse('2026-10-09T06:00:00.000Z');
export const APPROVER: AuthUser = { id: 'usr_ceo', name: 'Chiew Sin Kwang', role: 'approver', flags: {} };
export const BUILDER: AuthUser = { id: 'usr_weijie', name: 'Tan Wei Jie', role: 'builder', flags: {} };

// A full page renders charts and tables from several resources; on a loaded machine the default 1s wait for
// it to settle is too tight, which would make these tests fail for reasons unrelated to the page.
configure({ asyncUtilTimeout: 5_000 });

/** Renders a page as the shell does: router, signed-in user, toasts, a fixed clock and a fake event stream. */
export function renderPage(ui: ReactElement, user: AuthUser): RenderResult {
  FakeEventSource.reset();
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider initialUser={user}>
        <EventStreamProvider eventSource={FakeEventSourceCtor}>
          <ToastProvider>
            <ClockProvider clock={fixedClock(NOW)}>{ui}</ClockProvider>
          </ToastProvider>
        </EventStreamProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** Pushes one chained event down the fake `/api/stream`, as the daemon does after a commit. */
export function streamEvent(type: string, seq = 1): void {
  FakeEventSource.last.emit('aoc', { seq, type, ts: new Date(NOW).toISOString(), scope: {}, meta: {} });
}

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

/**
 * Routes `METHOD /path` (query ignored) to JSON bodies or ready-made Responses; unknown routes answer 404.
 * Records every call.
 */
export function routeFetch(routes: Record<string, unknown | ((call: Call) => unknown)>) {
  const calls: Call[] = [];
  const fn = mockFetch((url, init) => {
    const u = new URL(url, 'http://aoc.test');
    const method = (init.method ?? 'GET').toUpperCase();
    const call: Call = {
      method,
      path: u.pathname,
      query: u.searchParams,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const route = routes[`${method} ${u.pathname}`];
    if (route === undefined) return failure(404, 'not_found', 'No route');
    const value = typeof route === 'function' ? (route as (c: Call) => unknown)(call) : route;
    return value instanceof Response ? value : jsonResponse(value);
  });
  const count = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).length;
  return { fn, calls, count };
}

/** A daemon error response (`{ error: { code, message } }`). */
export function failure(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, { status });
}

// ── registry ───────────────────────────────────────────────────────────────
export const WEEKS = ['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05'];

export function trend(values: readonly (number | null)[], unpriced: readonly number[] = []): RegistryTrendPoint[] {
  return WEEKS.map((weekStart, i) => {
    const v = values[i] ?? null;
    return {
      weekStart,
      runs: v === null ? 0 : 2,
      discoveryRuns: v === null ? 0 : 2,
      executionRuns: 0,
      avgCostUsd: v,
      unpricedRuns: unpriced[i] ?? 0,
    };
  });
}

export function entry(over: Partial<RegistryEntry> & Pick<RegistryEntry, 'processType' | 'name'>): RegistryEntry {
  return {
    description: '',
    class: 'execution',
    model: 'opus',
    executionModel: 'sonnet',
    currentModel: 'opus',
    readOnly: false,
    risky: false,
    discovery: { runs: 0, completedRuns: 0, avgCostUsd: null, totalCostUsd: 0 },
    execution: { runs: 0, completedRuns: 0, avgCostUsd: null, totalCostUsd: 0 },
    activeRuns: 0,
    savingsPct: null,
    realizedSavingsUsd: null,
    opportunity: { usd: 0, basis: 'none', windowRuns: 0, executionCostUsd: null },
    efficiency: {
      discovery: { avgTokens: null, avgDurationMs: null },
      execution: { avgTokens: null, avgDurationMs: null },
    },
    savings: { realizedRm: null, opportunityRm: null, tokensSaved: null, timeSavedMs: null },
    trend: trend([]),
    playbook: {
      status: 'none',
      activePlaybookId: null,
      activeVersion: null,
      approvedAt: null,
      pendingPlaybookId: null,
      pendingDecisionId: null,
      versions: 0,
    },
    lessonsInScope: 0,
    openRepeatOffences: null,
    costBasis: 'metered',
    ...over,
  };
}

/** The seeded demo's economics: two types with a projected execution path, one discovery-class, one idle. */
export const ENTRIES: RegistryEntry[] = [
  entry({
    processType: 'feature-build',
    name: 'Feature build',
    currentModel: 'sonnet',
    discovery: { runs: 8, completedRuns: 8, avgCostUsd: 2.6482, totalCostUsd: 21.1855 },
    activeRuns: 2,
    opportunity: { usd: 10.5928, basis: 'projected', windowRuns: 8, executionCostUsd: 1.3241 },
    efficiency: {
      discovery: { avgTokens: 8_346_102, avgDurationMs: 5_510_119 },
      execution: { avgTokens: null, avgDurationMs: null },
    },
    savings: { realizedRm: null, opportunityRm: 44.8507, tokensSaved: null, timeSavedMs: null },
    trend: trend([null, null, null, null, null, 0, 2.9702, 3.3645], [0, 0, 0, 0, 0, 1, 2, 0]),
    playbook: {
      status: 'approved',
      activePlaybookId: 'pbk_fb',
      activeVersion: 1,
      approvedAt: '2026-10-09T03:40:36.441Z',
      pendingPlaybookId: null,
      pendingDecisionId: null,
      versions: 1,
    },
  }),
  entry({
    processType: 'bug-fix',
    name: 'Bug fix',
    discovery: { runs: 4, completedRuns: 4, avgCostUsd: 1.2756, totalCostUsd: 5.1023 },
    activeRuns: 1,
    opportunity: { usd: 2.5512, basis: 'projected', windowRuns: 4, executionCostUsd: 0.6378 },
    savings: { realizedRm: null, opportunityRm: 10.7872, tokensSaved: null, timeSavedMs: null },
    trend: trend([null, null, null, null, null, null, 0, 1.7008], [0, 0, 0, 0, 0, 0, 1, 0]),
    playbook: {
      status: 'proposed',
      activePlaybookId: null,
      activeVersion: null,
      approvedAt: null,
      pendingPlaybookId: 'pbk_bf',
      pendingDecisionId: 'dec_bf',
      versions: 1,
    },
  }),
  entry({
    processType: 'discovery',
    name: 'Discovery build',
    class: 'discovery',
    executionModel: null,
    discovery: { runs: 8, completedRuns: 8, avgCostUsd: 2.3989, totalCostUsd: 19.1913 },
    opportunity: { usd: 0, basis: 'none', windowRuns: 8, executionCostUsd: null },
    trend: trend([null, null, null, null, null, 0, 0.961, 7.193], [0, 0, 0, 0, 0, 1, 3, 0]),
  }),
  entry({ processType: 'migration', name: 'Data / schema migration', class: 'discovery', executionModel: null, risky: true, activeRuns: 1 }),
];

export function processType(over: Partial<ProcessTypeView> & Pick<ProcessTypeView, 'id' | 'name'>): ProcessTypeView {
  return {
    description: '',
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
    currentModel: 'opus',
    activePlaybookId: null,
    ...over,
  };
}

export const TYPES = {
  version: '2026.10.1',
  versionHash: 'e41fc27467779e3ec96003d4085e7a95389bed6d2ecf30965881e0fb99c748c2',
  types: [
    processType({ id: 'discovery', name: 'Discovery build', class: 'discovery', executionModel: null }),
    processType({ id: 'feature-build', name: 'Feature build', currentModel: 'sonnet', activePlaybookId: 'pbk_fb' }),
    processType({
      id: 'bug-triage',
      name: 'Bug triage (read-only)',
      class: 'triage',
      executionModel: null,
      readOnly: true,
      credentialProfile: null,
      permissionMode: 'dontAsk',
      builtinTools: ['Read', 'Glob', 'Grep'],
      diagnosisBudget: { tokens: 400_000, minutes: 30 },
    }),
  ],
};

export function playbook(over: Partial<PlaybookDTO> & Pick<PlaybookDTO, 'playbookId' | 'processType'>): PlaybookDTO {
  return {
    version: 1,
    title: 'Playbook',
    steps: [{ id: 's1', title: 'Reproduce / map the change surface' }],
    rationale: null,
    status: 'approved',
    active: true,
    method: 'llm',
    sourceSessionId: null,
    projectId: null,
    decisionId: `dec_${over.playbookId}`,
    proposedBy: 'usr_priya',
    proposedAt: '2026-09-30T01:30:15.959Z',
    approvedAt: '2026-10-09T03:40:36.441Z',
    approvedBy: 'usr_ceo',
    rejectedAt: null,
    rejectedBy: null,
    retiredAt: null,
    retireReason: null,
    erased: false,
    ...over,
  };
}

export const PLAYBOOKS: PlaybookDTO[] = [
  playbook({ playbookId: 'pbk_fb', processType: 'feature-build', title: 'Feature build playbook v1' }),
  playbook({
    playbookId: 'pbk_bf',
    processType: 'bug-fix',
    title: 'Bug fix: 3-step playbook',
    status: 'proposed',
    active: false,
    method: 'fallback',
    decisionId: 'dec_bf',
    proposedBy: 'usr_aisyah',
    proposedAt: '2026-10-09T05:00:00.000Z',
    approvedAt: null,
    approvedBy: null,
    sourceSessionId: 'ses_bf1',
  }),
];

export function decision(over: Partial<DecisionCardView> & Pick<DecisionCardView, 'id' | 'kind'>): DecisionCardView {
  return {
    status: 'open',
    test: null,
    title: 'Decision',
    question: 'Approve?',
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject' },
    ],
    recommendation: null,
    context: null,
    requiredRole: 'approver',
    requiresPasskey: false,
    requesterId: 'usr_aisyah',
    excludedApproverIds: ['usr_aisyah'],
    eligibleUserIds: null,
    subjectType: 'playbook',
    subjectId: 'pbk_bf',
    sessionId: null,
    projectId: null,
    createdAt: '2026-10-09T05:00:00.000Z',
    dueAt: null,
    resolution: null,
    ageMs: 3_600_000,
    overdue: false,
    closedAt: null,
    erased: false,
    escalation: null,
    withdrawal: null,
    viewer: { canResolve: true, reason: null, canWithdraw: true, canEscalate: false },
    ...over,
  };
}

export function run(over: Partial<RegistryRunDTO> & Pick<RegistryRunDTO, 'runId' | 'processType'>): RegistryRunDTO {
  return {
    lastSessionId: over.runId,
    sessions: 1,
    projectId: 'prj_claims',
    model: 'claude-sonnet-5-5',
    kind: 'discovery',
    launchedAt: '2026-10-08T09:53:00.000Z',
    endedAt: '2026-10-08T10:24:00.000Z',
    outcome: 'completed',
    finished: true,
    costUsd: 1.3885,
    costBasis: 'metered',
    tokens: 2_758_298,
    durationMs: 1_891_649,
    playbookId: null,
    ...over,
  };
}

export const RUNS: RegistryRunDTO[] = [
  run({ runId: 'ses_live', processType: 'feature-build', finished: false, outcome: null, endedAt: null, durationMs: null }),
  run({ runId: 'ses_bf1', processType: 'bug-fix', playbookId: 'pbk_bf' }),
  run({ runId: 'ses_docs1', processType: 'docs', costUsd: 0.069, tokens: 3_067_961 }),
  run({ runId: 'ses_old', processType: 'feature-build', costUsd: 0, tokens: 6_992_432, launchedAt: '2026-09-25T09:35:00.000Z' }),
];

// ── metering ───────────────────────────────────────────────────────────────
export function day(over: Partial<MeteringDayDTO> & Pick<MeteringDayDTO, 'date'>): MeteringDayDTO {
  return {
    status: 'closed',
    fx: { rate: 4.2291, status: 'live', sourceDate: over.date },
    rateCardVersion: 1,
    throttleIdleMs: 0,
    throttleHits: 0,
    subscriptionUsd: 32.258065,
    closedAt: '2026-10-09T00:15:00.000Z',
    inputTokens: 1000,
    outputTokens: 40_000,
    cacheReadTokens: 900_000,
    cacheWriteTokens: 50_000,
    cacheWrite5mTokens: 10_000,
    cacheWrite1hTokens: 40_000,
    totalTokens: 991_000,
    messages: 40,
    notionalUsd: 9.455654,
    notionalRm: 39.988905,
    rmComplete: true,
    unpriced: false,
    unpricedTokens: 0,
    unpricedModels: [],
    tierPricedModels: [],
    ...over,
  };
}

export const DAYS: MeteringDayDTO[] = [
  day({ date: '2026-09-30', rateCardVersion: 0, notionalUsd: 0, notionalRm: 0, subscriptionUsd: 0, unpriced: true, unpricedTokens: 21_400_000, unpricedModels: ['claude-opus-5-5'] }),
  day({ date: '2026-10-01' }),
  day({ date: '2026-10-02', notionalUsd: 13.23512, notionalRm: 56.152643, fx: { rate: 4.2427, status: 'live', sourceDate: '2026-10-02' } }),
  day({ date: '2026-10-03', notionalUsd: 0, notionalRm: 0, fx: { rate: 4.2427, status: 'inherited', sourceDate: '2026-10-02' } }),
  day({ date: '2026-10-09', status: 'open', closedAt: null, notionalUsd: 8.466081, notionalRm: 35.806445, throttleIdleMs: 7_020_000, throttleHits: 1, fx: { rate: 4.2294, status: 'live', sourceDate: '2026-10-09' } }),
];

const sum = (k: keyof MeteringDayDTO) => DAYS.reduce((a, d) => a + (d[k] as number), 0);
export const DAILY = {
  costBasis: 'notional_api_equivalent',
  costLabel: 'Notional API-equivalent cost (decision support, not a bill)',
  scope: 'org',
  from: '2026-09-10',
  to: '2026-10-09',
  days: [day({ date: '2026-09-29', status: 'unmetered', notionalUsd: 0, notionalRm: 0, totalTokens: 0 }), ...DAYS],
  totals: {
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cacheReadTokens: sum('cacheReadTokens'),
    cacheWriteTokens: sum('cacheWriteTokens'),
    cacheWrite5mTokens: sum('cacheWrite5mTokens'),
    cacheWrite1hTokens: sum('cacheWrite1hTokens'),
    totalTokens: 26_355_000,
    messages: 200,
    notionalUsd: sum('notionalUsd'),
    notionalRm: sum('notionalRm'),
    rmComplete: true,
    unpriced: true,
    unpricedTokens: 21_400_000,
    unpricedModels: ['claude-opus-5-5'],
    tierPricedModels: [],
    throttleIdleMs: 7_020_000,
    throttleHits: 1,
    subscriptionUsd: 161.290325,
  },
  lastClosedDay: '2026-10-08',
  generatedAt: '2026-10-09T06:00:00.000Z',
};

export const VERSION_1: RateCardVersionDTO = {
  version: 1,
  effectiveFrom: '2026-10-01',
  status: 'active',
  currency: 'USD',
  rates: [
    { model: 'claude-opus-5-5', inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWrite5mPerMTok: 5, cacheWrite1hPerMTok: 8 },
    { model: 'claude-haiku-5-5', inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWrite5mPerMTok: 0.125, cacheWrite1hPerMTok: 0.2 },
  ],
  tierFallback: { opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5' },
  note: 'Notional API-equivalent list prices per million tokens.',
  ratesHash: '79bde081930be71952fb229ddcb568ce660b092d57d526f88fdce83f754798f4',
  publishedAt: '2026-09-25T01:30:15.959Z',
  publishedBy: 'metering',
  erased: false,
};

export const RATE_CARD = {
  costBasis: 'notional_api_equivalent',
  costLabel: 'Notional API-equivalent cost (decision support, not a bill)',
  today: '2026-10-09',
  active: VERSION_1,
  scheduled: [],
  lastClosedDay: '2026-10-08',
  earliestEffectiveFrom: '2026-10-10',
};

export function fxRate(over: Partial<FxRateDTO> & Pick<FxRateDTO, 'date' | 'rate'>): FxRateDTO {
  return {
    pair: 'USD/MYR',
    status: 'live',
    sourceDate: over.date,
    extractor: 'haiku',
    validation: 'pass',
    reason: 'fetched',
    flagged: false,
    recordedAt: `${over.date}T04:30:00.000Z`,
    recordedBy: 'scheduler:fx',
    revisions: 1,
    closed: true,
    sourceUrl: 'https://www.bnm.gov.my/exchange-rates',
    rawExcerpt: null,
    evidence: null,
    notes: null,
    session: null,
    official: null,
    officialDate: null,
    problems: [],
    ...over,
  };
}

export const FX_RATES = [
  fxRate({ date: '2026-10-02', rate: 4.2427, session: '1700' }),
  fxRate({ date: '2026-10-03', rate: 4.2427, status: 'inherited', sourceDate: '2026-10-02', extractor: 'none', validation: 'not_applicable', reason: 'weekend_or_holiday' }),
  fxRate({ date: '2026-10-09', rate: 4.2294, closed: false, session: '1700' }),
];

export const FX_STATUS: FxStatusDTO = {
  today: '2026-10-09',
  enabled: true,
  runAtLocalTime: '18:00',
  todayRecord: FX_RATES[2]!,
  current: { rate: 4.2294, status: 'live', sourceDate: '2026-10-09' },
  lastLive: { date: '2026-10-09', rate: 4.2294 },
  carryForward: { days: 0, since: null, alertAfterDays: 3, alerted: false },
  openDiscrepancy: null,
  openDiscrepancyCount: 0,
};

export function costRow(over: Partial<MeteringSummaryRow> & Pick<MeteringSummaryRow, 'key'>): MeteringSummaryRow {
  return {
    label: null,
    inputTokens: 1000,
    outputTokens: 40_000,
    cacheReadTokens: 900_000,
    cacheWriteTokens: 50_000,
    cacheWrite5mTokens: 10_000,
    cacheWrite1hTokens: 40_000,
    totalTokens: 991_000,
    messages: 40,
    notionalUsd: 10,
    notionalRm: 42.29,
    rmComplete: true,
    unpriced: false,
    unpricedTokens: 0,
    unpricedModels: [],
    tierPricedModels: [],
    ...over,
  };
}

/** `/api/metering/summary` for one grouping; rows arrive largest first, as the daemon sends them. */
export function summary(groupBy: string, rows: MeteringSummaryRow[]) {
  return {
    costBasis: 'notional_api_equivalent',
    costLabel: DAILY.costLabel,
    scope: 'org',
    groupBy,
    from: DAILY.from,
    to: DAILY.to,
    rows,
    totals: { ...DAILY.totals },
    closedDays: 4,
    openDays: 1,
    fxMissingDays: [],
    subscription: { usd: 161.290325, rm: 682.13 },
    generatedAt: DAILY.generatedAt,
  };
}

export const SUMMARIES: Record<string, ReturnType<typeof summary>> = {
  project: summary('project', [
    costRow({ key: 'prj_aoc', notionalUsd: 18.4, unpriced: true, unpricedTokens: 12_000_000, unpricedModels: ['claude-opus-5-5'] }),
    costRow({ key: 'prj_claims', notionalUsd: 12.756855 }),
  ]),
  actor: summary('actor', [
    costRow({ key: 'usr_weijie', label: 'Tan Wei Jie', notionalUsd: 21 }),
    costRow({ key: 'usr_aisyah', label: 'Aisyah Rahman', notionalUsd: 10.156855 }),
  ]),
};

export const THROTTLE: MeteringThrottleDTO = {
  scope: 'org',
  from: DAILY.from,
  to: DAILY.to,
  days: DAYS.map((d) => ({ date: d.date, status: d.status, hits: d.throttleHits, idleMs: d.throttleIdleMs, idleHours: d.throttleIdleMs / 3_600_000 })),
  bySession: [{ sessionId: 'ses_cx1', ownerId: 'usr_weijie', projectId: 'prj_cxcopilot', hits: 1, idleMs: 7_020_000, idleHours: 1.95, throttledNow: false }],
  byOwner: [{ ownerId: 'usr_weijie', ownerName: 'Tan Wei Jie', hits: 1, idleMs: 7_020_000, idleHours: 1.95 }],
  totals: { hits: 1, idleMs: 7_020_000, idleHours: 1.95, throttledNow: 0 },
  generatedAt: DAILY.generatedAt,
};

const SUBSCRIPTION_V1 = {
  plan: 'max',
  seats: 5,
  monthlyUsdPerSeat: 200,
  monthlyUsd: 1000,
  effectiveFrom: '2026-10-01',
  status: 'active' as const,
  updatedAt: '2026-09-25T04:04:56.019Z',
  updatedBy: 'metering',
};
export const SUBSCRIPTION: MeteringSubscriptionDTO = {
  basis: 'actual_subscription',
  note: 'Actual plan spend (prorated per day), shown separately from the notional API-equivalent cost.',
  today: '2026-10-09',
  active: SUBSCRIPTION_V1,
  dailyUsdToday: 32.258065,
  scheduled: [],
  history: [SUBSCRIPTION_V1],
};

export function project(projectId: string, name: string): ProjectSummary {
  return {
    projectId,
    name,
    slug: projectId.replace('prj_', ''),
    repoPath: null,
    progress: { doneTasks: 0, totalTasks: 0, doneWeight: 0, totalWeight: 0, pct: 0, flaggedTasks: 0, etaMs: null, etaHiddenReason: null },
    activeSessions: 0,
    openDecisions: 0,
    lastActivityAt: null,
  };
}
export const PROJECTS = [project('prj_aoc', 'AOC Platform'), project('prj_claims', 'Claims Intake Bot'), project('prj_cxcopilot', 'CX Copilot')];

// ── credits ────────────────────────────────────────────────────────────────
export function account(over: Partial<CreditAccount> & Pick<CreditAccount, 'userId' | 'userName'>): CreditAccount {
  return {
    period: '2026-10',
    allocationUsd: 300,
    allocationSource: 'allocated',
    usedUsd: 0,
    grantedUsd: 0,
    balanceUsd: 300,
    autoGrantUsed: false,
    autoGrantAvailableUsd: 75,
    capped: false,
    exempt: false,
    pendingTopup: null,
    grants: [],
    ...over,
  };
}

export function topup(over: Partial<CreditTopupRequest> & Pick<CreditTopupRequest, 'requestId' | 'userId'>): CreditTopupRequest {
  return {
    userName: null,
    period: '2026-10',
    amountUsd: 50,
    reason: 'CSAT sentiment overlay needs one more evaluation pass.',
    sessionId: null,
    taskId: null,
    decisionId: `dec_${over.requestId}`,
    status: 'pending',
    createdAt: '2026-10-09T03:00:00.000Z',
    ageMs: 3 * 3_600_000,
    resolvedAt: null,
    resolvedBy: null,
    balanceBefore: null,
    balanceAfter: null,
    ...over,
  };
}

export function session(over: Partial<SessionSummary> & Pick<SessionSummary, 'sessionId'>): SessionSummary {
  return {
    mode: 'managed',
    title: 'Session',
    projectId: 'prj_cxcopilot',
    projectName: 'CX Copilot',
    threadId: null,
    phaseId: null,
    phaseName: null,
    processType: 'feature-build',
    model: 'claude-sonnet-5-5',
    ownerId: BUILDER.id,
    ownerName: BUILDER.name,
    lifecycle: 'running',
    liveness: null,
    apm: { windowMinutes: 30, points: [], current: 0 },
    progress: null,
    contextTokens: null,
    contextPct: null,
    costTodayUsd: 0,
    openDecision: null,
    throttledUntil: null,
    lastActivityAt: null,
    startedAt: '2026-10-09T03:00:00.000Z',
    ticketId: null,
    ...over,
  };
}

const grant = (over: Partial<CreditAccount['grants'][number]> & Pick<CreditAccount['grants'][number], 'kind' | 'amountUsd' | 'at' | 'balanceBefore'>) => ({
  approverId: null,
  requestId: null,
  decisionId: null,
  sessionId: null,
  taskId: null,
  balanceAfter: over.balanceBefore + over.amountUsd,
  ...over,
});

/** The team for October, as the daemon lists it: by name. One capped and waiting, one on pace to cap. */
export const ACCOUNTS: CreditAccount[] = [
  account({ userId: 'usr_aisyah', userName: 'Aisyah Rahman', usedUsd: 135, balanceUsd: 165 }),
  account({ userId: APPROVER.id, userName: APPROVER.name, allocationUsd: 500, usedUsd: 40, balanceUsd: 460, autoGrantAvailableUsd: 125 }),
  account({
    userId: 'usr_priya',
    userName: 'Priya Nair',
    usedUsd: 375,
    grantedUsd: 75,
    balanceUsd: 0,
    autoGrantUsed: true,
    autoGrantAvailableUsd: 0,
    capped: true,
    pendingTopup: { requestId: 'ctu_priya', decisionId: 'dec_ctu_priya', amountUsd: 50, createdAt: '2026-10-09T03:00:00.000Z', ageMs: 3 * 3_600_000 },
    grants: [grant({ kind: 'auto', amountUsd: 75, at: '2026-10-07T02:00:00.000Z', balanceBefore: 0, decisionId: 'dec_auto_priya', sessionId: 'ses_pr1', taskId: 'T3' })],
  }),
  account({
    userId: BUILDER.id,
    userName: BUILDER.name,
    usedUsd: 105.33,
    grantedUsd: 125,
    balanceUsd: 319.67,
    autoGrantUsed: true,
    autoGrantAvailableUsd: 0,
    grants: [
      grant({ kind: 'auto', amountUsd: 75, at: '2026-10-05T02:00:00.000Z', balanceBefore: 0, decisionId: 'dec_auto_wj' }),
      grant({ kind: 'topup', amountUsd: 50, at: '2026-10-08T09:00:00.000Z', balanceBefore: 269.67, approverId: APPROVER.id, requestId: 'ctu_wj', decisionId: 'dec_ctu_wj', sessionId: 'ses_cx1', taskId: 'T7' }),
    ],
  }),
];

export const TOPUPS: CreditTopupRequest[] = [
  topup({ requestId: 'ctu_priya', userId: 'usr_priya', userName: 'Priya Nair', sessionId: 'ses_pr1', taskId: 'T3' }),
  topup({
    requestId: 'ctu_wj',
    userId: BUILDER.id,
    userName: BUILDER.name,
    reason: 'Second evaluation pass on the sentiment overlay.',
    sessionId: 'ses_cx1',
    taskId: 'T7',
    status: 'granted',
    createdAt: '2026-10-08T08:30:00.000Z',
    ageMs: 1_800_000,
    resolvedAt: '2026-10-08T09:00:00.000Z',
    resolvedBy: APPROVER.id,
    balanceBefore: 269.67,
    balanceAfter: 319.67,
  }),
];
