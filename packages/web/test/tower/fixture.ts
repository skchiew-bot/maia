/**
 * Control Tower fixture (TowerSnapshot + the open decision cards behind its queue). It tells the approved mock's
 * story ("Fri 9 Oct 2026, 13:42 MYT") on the demo seed's world: projects CX Copilot, Claims Intake Bot and AOC
 * Platform; Approver Chiew Sin Kwang; Builders Aisyah Rahman, Tan Wei Jie and Priya Nair. Three queue rows are
 * the seed's own open decisions (main-branch merge, Wei Jie's top-up, the env-var lesson) and four session rows
 * are the seed's live sessions, so the e2e script can rebind their ids to the running daemon (FIXTURE_IDS).
 *
 * Every timestamp is relative to `now`, so the same story renders at any clock (`makeTowerSnapshot(Date.now())`).
 */
import type {
  DecisionCardView,
  DecisionKind,
  DecisionListResponse,
  DecisionOption,
  TowerAttentionItem,
  TowerSnapshot,
} from '@aoc/contracts';

/** 13:42 Malaysia time on Fri 9 Oct 2026 — the mock's "now". */
export const FIXTURE_NOW = Date.parse('2026-10-09T05:42:00.000Z');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Ids the e2e script rebinds to the seeded daemon's real decisions and sessions. */
export const FIXTURE_IDS = {
  rollback: 'dec_fx_rollback_claims',
  goLive: 'dec_fx_golive_cx140',
  mainMerge: 'dec_fx_main_merge',
  topup: 'dec_fx_topup_weijie',
  nric: 'dec_fx_nric_masking',
  lesson: 'dec_fx_lesson_env',
  fxReview: 'dec_fx_usdmyr_1008',
  deadSession: 'ses_fx_runbook_docs',
  stalledSession: 'ses_fx_partition_migration',
  throttledSession: 'ses_fx_csat_overlay',
  waitingSession: 'ses_fx_dedupe_fix',
} as const;

export const FIXTURE_USERS = {
  ceo: { id: 'usr_fx_ceo', name: 'Chiew Sin Kwang' },
  aisyah: { id: 'usr_fx_aisyah', name: 'Aisyah Rahman' },
  weijie: { id: 'usr_fx_weijie', name: 'Tan Wei Jie' },
  priya: { id: 'usr_fx_priya', name: 'Priya Nair' },
} as const;

const PROJECTS = {
  cx: { id: 'prj_cxcopilot', name: 'CX Copilot' },
  claims: { id: 'prj_claims', name: 'Claims Intake Bot' },
  aoc: { id: 'prj_aoc', name: 'AOC Platform' },
} as const;

const focus = (id: string) => `/decisions?focus=${id}`;

/** Hours are local to the deployment (Asia/Kuala_Lumpur) and carry their offset, as the daemon sends them. */
const MYT_OFFSET_MS = 8 * HOUR;
const mytHour = (ms: number) => `${new Date(ms + MYT_OFFSET_MS).toISOString().slice(0, 19)}+08:00`;

export function makeTowerSnapshot(now: number = FIXTURE_NOW): TowerSnapshot {
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  const item = (
    i: Omit<TowerAttentionItem, 'since' | 'ageMs' | 'projectId' | 'projectName' | 'detail'> & {
      ago: number;
      project?: { id: string; name: string } | null;
      detail?: string | null;
    },
  ): TowerAttentionItem => {
    const { ago, project, detail, ...rest } = i;
    return {
      ...rest,
      detail: detail ?? null,
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      since: at(ago),
      ageMs: ago,
    };
  };

  const attention: TowerAttentionItem[] = [
    item({
      id: `decision:${FIXTURE_IDS.rollback}`,
      kind: 'decision',
      severity: 'critical',
      title: 'Roll claims-intake main back to p1-done (7c2e9d1)',
      detail: 'Acceptance tests passed on rollback/claims-p1-done; main is untouched until you approve.',
      project: PROJECTS.claims,
      ago: 47 * MIN,
      costOfDelay: { score: 94, basis: 'Rollback gate · 47m · INC-0093 open, about 38 duplicate claims an hour' },
      action: {
        kind: 'resolve_decision', recommendedOptionId: null,
        label: 'Approve with passkey',
        href: focus(FIXTURE_IDS.rollback),
        decisionId: FIXTURE_IDS.rollback,
        requiresPasskey: true,
      },
      chips: ['passkey', 'test main'],
    }),
    item({
      id: `decision:${FIXTURE_IDS.goLive}`,
      kind: 'decision',
      severity: 'critical',
      title: 'Promote CX Copilot v1.4.0 to production',
      project: PROJECTS.cx,
      ago: 65 * MIN,
      costOfDelay: { score: 81, basis: 'Go-live gate · 1h 05m · holds a UAT-signed fix for ticket #1171 (Sev 2)' },
      action: {
        kind: 'resolve_decision', recommendedOptionId: null,
        label: 'Approve with passkey',
        href: focus(FIXTURE_IDS.goLive),
        decisionId: FIXTURE_IDS.goLive,
        requiresPasskey: true,
      },
      chips: ['passkey', 'test production'],
    }),
    item({
      id: 'post_incident_overdue:chg_0219',
      kind: 'post_incident_overdue',
      severity: 'high',
      title: 'CR-0219 overdue after the 8 Oct break-glass hotfix',
      project: PROJECTS.claims,
      ago: 3 * HOUR + 30 * MIN,
      costOfDelay: { score: 66, basis: 'Break-glass follow-up · 3h 30m overdue · open audit finding until filed' },
      action: { kind: 'open', recommendedOptionId: null, label: 'Open record', href: '/changes/chg_0219' },
      chips: ['break-glass'],
    }),
    item({
      id: `session_dead:${FIXTURE_IDS.deadSession}`,
      kind: 'session_dead',
      severity: 'high',
      title: 'Rollback-runbook docs session exited with code 143',
      project: PROJECTS.aoc,
      ago: 21 * MIN,
      costOfDelay: { score: 58, basis: 'Dead session · 21m · the INC-0093 rollback drill needs this runbook' },
      action: {
        kind: 'restart', recommendedOptionId: null,
        label: 'Restart',
        href: `/sessions/${FIXTURE_IDS.deadSession}`,
        sessionId: FIXTURE_IDS.deadSession,
      },
      chips: [],
    }),
    item({
      id: 'ticket_waiting:tkt_1162',
      kind: 'ticket_waiting',
      severity: 'high',
      title: 'Ticket #1162: claim status not updating for agents',
      project: PROJECTS.claims,
      ago: 3 * DAY + 2 * HOUR,
      costOfDelay: { score: 52, basis: 'Ticket in UAT · 3d 2h · past the 2-day Sev 2 SLA, requester has not tested' },
      action: { kind: 'open', recommendedOptionId: null, label: 'Open ticket', href: '/tickets/tkt_1162' },
      chips: ['Sev 2'],
    }),
    item({
      id: `decision:${FIXTURE_IDS.mainMerge}`,
      kind: 'decision',
      severity: 'medium',
      title: 'Merge the retry-dedupe fix to main?',
      project: PROJECTS.claims,
      ago: 34 * MIN,
      costOfDelay: { score: 47, basis: 'Agent decision · 34m · the duplicate-claims fix waits on a main-branch merge' },
      action: {
        kind: 'resolve_decision', recommendedOptionId: null,
        label: 'Approve',
        href: focus(FIXTURE_IDS.mainMerge),
        decisionId: FIXTURE_IDS.mainMerge,
      },
      chips: ['test main'],
    }),
    item({
      id: `credit_blocked:${FIXTURE_USERS.weijie.id}`,
      kind: 'credit_blocked',
      severity: 'medium',
      title: 'Tan Wei Jie at credit cap; US$100 top-up pending',
      project: PROJECTS.cx,
      ago: 3 * HOUR,
      costOfDelay: { score: 43, basis: 'Credit cap · 3h · the CSAT overlay session stops at its next task boundary' },
      action: {
        kind: 'resolve_decision', recommendedOptionId: null,
        label: 'Approve top-up',
        href: focus(FIXTURE_IDS.topup),
        decisionId: FIXTURE_IDS.topup,
      },
      chips: ['policy'],
    }),
    item({
      id: `session_stalled:${FIXTURE_IDS.stalledSession}`,
      kind: 'session_stalled',
      severity: 'medium',
      title: 'Partitioned-table migration has produced no output',
      project: PROJECTS.cx,
      ago: 11 * MIN,
      costOfDelay: { score: 34, basis: 'Stalled · 11m · process alive but silent at 64% context' },
      action: {
        kind: 'nudge', recommendedOptionId: null,
        label: 'Nudge…',
        href: `/sessions/${FIXTURE_IDS.stalledSession}`,
        sessionId: FIXTURE_IDS.stalledSession,
      },
      chips: [],
    }),
    item({
      id: `session_throttled:${FIXTURE_IDS.throttledSession}`,
      kind: 'session_throttled',
      severity: 'low',
      title: 'CSAT sentiment overlay hit its plan limit',
      project: PROJECTS.cx,
      ago: 22 * MIN,
      costOfDelay: { score: 22, basis: 'Plan limit · idle 22m · resets 15:17; 47m lost to throttling today' },
      action: {
        kind: 'open', recommendedOptionId: null,
        label: 'Open',
        href: `/sessions/${FIXTURE_IDS.throttledSession}`,
        sessionId: FIXTURE_IDS.throttledSession,
      },
      chips: [],
    }),
    item({
      id: 'fx_discrepancy:2026-10-08',
      kind: 'fx_discrepancy',
      severity: 'low',
      title: '8 Oct USD/MYR: scraped 4.2210 vs BNM 4.2250',
      project: null,
      ago: 4 * HOUR + 37 * MIN,
      costOfDelay: { score: 16, basis: 'FX discrepancy · 4h 37m · 8 Oct RM rollups stay provisional until reviewed' },
      action: { kind: 'open', recommendedOptionId: null, label: 'Review', href: focus(FIXTURE_IDS.fxReview), decisionId: FIXTURE_IDS.fxReview },
      chips: ['re-fetched once'],
    }),
    item({
      id: `decision:${FIXTURE_IDS.nric}`,
      kind: 'decision',
      severity: 'low',
      title: 'Mask NRIC numbers at ingest, or on screen only',
      project: PROJECTS.cx,
      ago: 6 * MIN,
      costOfDelay: { score: 14, basis: 'PII decision · 6m · nric-masking discovery run paused' },
      action: { kind: 'resolve_decision', recommendedOptionId: null, label: 'Approve', href: focus(FIXTURE_IDS.nric), decisionId: FIXTURE_IDS.nric },
      chips: ['test data'],
    }),
    item({
      id: `decision:${FIXTURE_IDS.lesson}`,
      kind: 'decision',
      severity: 'low',
      title: 'Bind lesson: guard required env vars',
      project: null,
      ago: 26 * HOUR,
      costOfDelay: { score: 8, basis: 'Lesson binding · 1d 2h · about 14 min saved per config-loader run' },
      action: { kind: 'resolve_decision', recommendedOptionId: null, label: 'Approve', href: focus(FIXTURE_IDS.lesson), decisionId: FIXTURE_IDS.lesson },
      chips: ['policy'],
    }),
  ];

  // 24 five-minute buckets ending at the current bucket (oldest → newest).
  const bucket = Math.floor(now / (5 * MIN)) * 5 * MIN;
  const series = {
    working: [7, 6, 7, 7, 6, 6, 6, 6, 7, 7, 6, 8, 8, 7, 8, 7, 6, 5, 6, 5, 4, 4, 3, 2],
    thinking: [1, 2, 1, 1, 2, 1, 1, 2, 1, 1, 2, 1, 1, 2, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1],
    stalled: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1],
    dead: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
    throttled: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1],
    waiting_on_you: [1, 1, 1, 1, 1, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2],
  };
  const trend = series.working.map((_, i) => ({
    at: new Date(bucket - (23 - i) * 5 * MIN).toISOString(),
    working: series.working[i]!,
    thinking: series.thinking[i]!,
    stalled: series.stalled[i]!,
    dead: series.dead[i]!,
    throttled: series.throttled[i]!,
    waiting_on_you: series.waiting_on_you[i]!,
  }));

  // The last 12 local hours, ending with the hour that is still running.
  const hourStart = Math.floor(now / HOUR) * HOUR;
  const verified = [0, 0, 0, 0, 0, 1, 3, 5, 3, 3, 3, 3];
  const flagged = [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0];
  const tasksPerHour = verified.map((v, i) => ({
    hour: mytHour(hourStart - (11 - i) * HOUR),
    verified: v,
    flagged: flagged[i]!,
  }));

  return {
    generatedAt: new Date(now).toISOString(),
    summary:
      '12 items need you, led by two passkey gates (the Claims Intake rollback for INC-0093 and the CX Copilot v1.4.0 go-live); verified flow is 18% above baseline, tickets wait longest in UAT, and the ledger chain is verified.',
    kpis: {
      needsYou: attention.length,
      oldestNeedsYouSince: at(3 * DAY + 2 * HOUR),
      tasksVerifiedToday: 21,
      openPastSla: 3,
      tasksVerifiedBaseline: 17.8,
      gateLatencyP50Ms: 31 * MIN,
      gateLatencyP90Ms: HOUR + 58 * MIN,
      gateSlaMs: HOUR,
      openTickets: 16,
      oldestTicketSince: at(3 * DAY + 2 * HOUR),
      chainOk: true,
      anchorAgeMs: 11 * HOUR + 42 * MIN,
    },
    attention,
    flow: {
      tasksPerHour,
      baselinePerHour: [0, 0, 0, 0, 0.2, 0.8, 1.9, 2.9, 3.4, 2.8, 2.6, 3.2],
      wipByProject: [
        { projectId: PROJECTS.cx.id, name: PROJECTS.cx.name, activeSessions: 4, openTasks: 23, progressPct: 61 },
        { projectId: PROJECTS.claims.id, name: PROJECTS.claims.name, activeSessions: 2, openTasks: 31, progressPct: 48 },
        { projectId: PROJECTS.aoc.id, name: PROJECTS.aoc.name, activeSessions: 2, openTasks: 19, progressPct: 40 },
      ],
      ticketFunnel: [
        { stage: 'received', count: 3, oldestSince: at(2 * HOUR + 10 * MIN), medianAgeMs: 35 * MIN, bottleneck: false },
        { stage: 'triage', count: 3, oldestSince: at(5 * HOUR + 20 * MIN), medianAgeMs: 3 * HOUR + 5 * MIN, bottleneck: false },
        { stage: 'awaiting_human', count: 0, oldestSince: null, medianAgeMs: null, bottleneck: false },
        { stage: 'fix_plan_gate', count: 0, oldestSince: null, medianAgeMs: null, bottleneck: false },
        { stage: 'building', count: 5, oldestSince: at(2 * DAY + 6 * HOUR), medianAgeMs: 19 * HOUR, bottleneck: false },
        { stage: 'uat', count: 4, oldestSince: at(3 * DAY + 2 * HOUR), medianAgeMs: DAY + 7 * HOUR, bottleneck: true },
        { stage: 'go_live_gate', count: 1, oldestSince: at(65 * MIN), medianAgeMs: 65 * MIN, bottleneck: false },
        { stage: 'completed', count: 14, oldestSince: null, medianAgeMs: 2 * DAY + 9 * HOUR, bottleneck: false },
      ],
      decisionLatency: [
        { kind: 'rollback', open: 1, resolved7d: 6, p50Ms: 12 * MIN, p90Ms: 41 * MIN, slaMs: 30 * MIN, breaches: 2 },
        { kind: 'go_live', open: 1, resolved7d: 9, p50Ms: 38 * MIN, p90Ms: HOUR + 50 * MIN, slaMs: 2 * HOUR, breaches: 0 },
        { kind: 'agent_decision', open: 2, resolved7d: 31, p50Ms: 14 * MIN, p90Ms: HOUR + 40 * MIN, slaMs: HOUR, breaches: 3 },
        { kind: 'credit_topup', open: 1, resolved7d: 4, p50Ms: 22 * MIN, p90Ms: 48 * MIN, slaMs: HOUR, breaches: 0 },
        { kind: 'fix_plan', open: 0, resolved7d: 7, p50Ms: HOUR + 10 * MIN, p90Ms: 3 * HOUR + 20 * MIN, slaMs: 4 * HOUR, breaches: 0 },
        { kind: 'lesson_binding', open: 1, resolved7d: 2, p50Ms: 5 * HOUR, p90Ms: DAY + 2 * HOUR, slaMs: 2 * DAY, breaches: 0 },
      ],
    },
    fleet: {
      byLiveness: { waiting_on_you: 2, throttled: 1, dead: 1, stalled: 1, thinking: 1, working: 2, ended_today: 5 },
      trend,
      stallRatePct: 12.5,
      stallRateAvg7dPct: 9.8,
      throttleLostMsToday: 47 * MIN,
      rolloverPressure: 2,
    },
    spend: {
      notionalUsdToday: 152.38,
      notionalRmToday: 642.27,
      avg7dUsd: 171.4,
      byProject: [
        { projectId: PROJECTS.claims.id, name: PROJECTS.claims.name, usdToday: 65.32 },
        { projectId: PROJECTS.cx.id, name: PROJECTS.cx.name, usdToday: 57.92 },
        { projectId: PROJECTS.aoc.id, name: PROJECTS.aoc.name, usdToday: 29.14 },
      ],
      modelMix: [
        { tier: 'opus', usdToday: 72.17, pct: 47.4 },
        { tier: 'sonnet', usdToday: 78.93, pct: 51.8 },
        { tier: 'haiku', usdToday: 1.28, pct: 0.8 },
      ],
      discoveryRuns7d: 9,
      executionRuns7d: 61,
      savingsPct: 74,
      capForecast: [
        {
          userId: FIXTURE_USERS.weijie.id,
          name: FIXTURE_USERS.weijie.name,
          balanceUsd: 3.1,
          burnPerDayUsd: 21,
          projectedCapAt: new Date(now + 3.5 * HOUR).toISOString(),
        },
        {
          userId: FIXTURE_USERS.aisyah.id,
          name: FIXTURE_USERS.aisyah.name,
          balanceUsd: 41,
          burnPerDayUsd: 13.8,
          projectedCapAt: new Date(now + (41 / 13.8) * DAY).toISOString(),
        },
        {
          userId: FIXTURE_USERS.priya.id,
          name: FIXTURE_USERS.priya.name,
          balanceUsd: 118,
          burnPerDayUsd: 3.4,
          projectedCapAt: new Date(now + (118 / 3.4) * DAY).toISOString(),
        },
      ],
    },
    integrity: {
      chainOk: true,
      lastVerifiedAt: at(2 * MIN),
      lastAnchorAt: at(11 * HOUR + 42 * MIN),
      anchorAgeMs: 11 * HOUR + 42 * MIN,
      unanchoredEvents: 2316,
      breakglassOpen: 0,
      postIncidentOverdue: 1,
      provenanceRefusals7d: 2,
      selfModBlocks7d: 1,
      mappingStatus: 'provisional',
      degradedProjections: 0,
      reactorFailures24h: 1,
    },
    anomalies: [
      {
        signal: 'no_file_change_closes',
        label: 'No-file-change closes',
        value: 8.7,
        baseline: 3.1,
        unit: '%',
        status: 'watch',
        scope: 'portfolio',
        explanation: 'Tasks closed without any file-changing tool call: 2 of 23 today.',
      },
      {
        signal: 'xs_heavy_manifests',
        label: 'xs-heavy manifests',
        value: 12,
        baseline: 9,
        unit: '%',
        status: 'normal',
        scope: 'portfolio',
        explanation: 'Plans where most tasks are declared xs, which inflates task counts.',
      },
      {
        signal: 'late_denominator_growth',
        label: 'Denominator growth after start',
        value: 4.2,
        baseline: 3,
        unit: '%',
        status: 'normal',
        scope: 'portfolio',
        explanation: 'Weight added to a manifest after its first task_done.',
      },
      {
        signal: 'blind_affirm_rate',
        label: 'Blind affirm-without-edit',
        value: 31,
        baseline: 18,
        unit: '%',
        status: 'alert',
        scope: 'portfolio',
        explanation: 'AI-drafted change-record fields confirmed without a single edit (§14).',
      },
      {
        signal: 'discovery_with_playbook',
        label: 'Discovery despite a playbook',
        value: 2,
        baseline: 0.4,
        unit: 'count',
        status: 'watch',
        scope: 'bug-triage',
        explanation: 'Runs launched as discovery on Opus although an approved playbook covers the type.',
      },
      {
        signal: 'evidence_unverified',
        label: 'Evidence unverified',
        value: 4.3,
        baseline: 4,
        unit: '%',
        status: 'normal',
        scope: 'portfolio',
        explanation: 'task_done evidence AOC could not verify, such as an unknown test id or commit.',
      },
      {
        signal: 'self_approval_rate',
        label: 'Self-approval rate',
        value: 22,
        baseline: 20,
        unit: '%',
        status: 'normal',
        scope: 'portfolio',
        explanation: 'Reversible off-main changes approved by the builder who made them.',
      },
    ],
  };
}

export const towerFixture: TowerSnapshot = makeTowerSnapshot();

const option = (id: string, label: string, description?: string): DecisionOption =>
  description ? { id, label, description } : { id, label };

function card(
  now: number,
  c: {
    id: string;
    kind: DecisionKind;
    title: string;
    question: string;
    options: DecisionOption[];
    rec?: { optionId: string; rationale: string };
    test?: DecisionCardView['test'];
    passkey?: boolean;
    ago: number;
    projectId?: string | null;
    sessionId?: string | null;
    requesterId: string;
  },
): DecisionCardView {
  return {
    id: c.id,
    kind: c.kind,
    status: 'open',
    test: c.test ?? null,
    title: c.title,
    question: c.question,
    options: c.options,
    recommendation: c.rec ?? null,
    context: null,
    requiredRole: 'approver',
    requiresPasskey: Boolean(c.passkey),
    requesterId: c.requesterId,
    excludedApproverIds: [c.requesterId],
    eligibleUserIds: null,
    subjectType: c.sessionId ? 'session' : c.kind,
    subjectId: c.sessionId ?? c.id,
    sessionId: c.sessionId ?? null,
    projectId: c.projectId ?? null,
    createdAt: new Date(now - c.ago).toISOString(),
    dueAt: null,
    resolution: null,
    ageMs: c.ago,
    overdue: false,
    closedAt: null,
    erased: false,
    escalation: null,
    withdrawal: null,
    viewer: { canResolve: true, reason: null, canWithdraw: true, canEscalate: false },
  };
}

/** `GET /api/decisions?status=open` as the Approver sees it, matching the queue's decision rows. */
export function makeOpenDecisions(now: number = FIXTURE_NOW): DecisionListResponse {
  const approveReject = [option('approve', 'Approve'), option('reject', 'Reject')];
  return {
    generatedAt: new Date(now).toISOString(),
    decisions: [
      card(now, {
        id: FIXTURE_IDS.lesson,
        kind: 'lesson_binding',
        title: 'Bind lesson: guard required env vars',
        question: 'Bind "Config loaders must fail fast on missing env vars with a named error" for code area src/config?',
        options: [option('bind', 'Bind lesson'), option('reject', 'Reject')],
        rec: { optionId: 'bind', rationale: 'Agent recommendation based on blast radius and reversibility.' },
        ago: 26 * HOUR,
        requesterId: FIXTURE_USERS.priya.id,
      }),
      card(now, {
        id: FIXTURE_IDS.fxReview,
        kind: 'fx_discrepancy',
        title: 'USD/MYR 2026-10-08: scraped 4.2210 vs BNM 4.2250',
        question:
          'The BNM page and the BNM published figure still disagree after one re-fetch. Which USD/MYR rate should 2026-10-08 use?',
        options: [
          option('accept_official', 'Use the BNM published figure 4.2250', 'BNM Open API middle rate'),
          option('accept_scraped', 'Use the scraped figure 4.2210'),
          option('manual', 'Enter the rate manually'),
        ],
        rec: {
          optionId: 'accept_official',
          rationale: 'The BNM Open API is the published reference figure; the page scrape is the fragile source.',
        },
        ago: 4 * HOUR + 37 * MIN,
        requesterId: 'system:fx',
      }),
      card(now, {
        id: FIXTURE_IDS.topup,
        kind: 'credit_topup',
        title: 'Top-up request: Tan Wei Jie (+US$100)',
        question:
          'Wei Jie hit the monthly cap after the 25% auto-grant. Approve a US$100 top-up for the CSAT overlay work?',
        options: [option('approve', 'Approve US$100'), option('deny', 'Deny')],
        ago: 3 * HOUR,
        requesterId: FIXTURE_USERS.weijie.id,
      }),
      card(now, {
        id: FIXTURE_IDS.goLive,
        kind: 'go_live',
        title: 'Promote CX Copilot v1.4.0 to production',
        question: 'v1.4.0 passed UAT (ticket #1171 signed off). Promote it to production now?',
        options: approveReject,
        rec: { optionId: 'approve', rationale: 'UAT signed off; provenance traces through CR-0231 and gate G-77.' },
        passkey: true,
        ago: 65 * MIN,
        projectId: PROJECTS.cx.id,
        requesterId: FIXTURE_USERS.aisyah.id,
      }),
      card(now, {
        id: FIXTURE_IDS.rollback,
        kind: 'rollback',
        title: 'Roll claims-intake main back to p1-done (7c2e9d1)',
        question: 'Verification passed on rollback/claims-p1-done. Restore main to p1-done (7c2e9d1)?',
        options: approveReject,
        rec: { optionId: 'approve', rationale: 'Acceptance tests are green at 7c2e9d1; INC-0093 stops at the next deploy.' },
        test: 'main',
        passkey: true,
        ago: 47 * MIN,
        projectId: PROJECTS.claims.id,
        requesterId: FIXTURE_USERS.priya.id,
      }),
      card(now, {
        id: FIXTURE_IDS.mainMerge,
        kind: 'agent_decision',
        title: 'Merge the retry-dedupe fix to main?',
        question:
          'The fix for duplicate claim submissions is ready on fix/claims-dedupe with a regression test. Merge to main now or hold for UAT?',
        options: [option('merge', 'Merge to main'), option('uat', 'Hold for UAT first')],
        rec: { optionId: 'uat', rationale: 'Agent recommendation based on blast radius and reversibility.' },
        test: 'main',
        ago: 34 * MIN,
        projectId: PROJECTS.claims.id,
        sessionId: FIXTURE_IDS.waitingSession,
        requesterId: `session:${FIXTURE_IDS.waitingSession}`,
      }),
      card(now, {
        id: FIXTURE_IDS.nric,
        kind: 'agent_decision',
        title: 'Mask NRIC numbers at ingest, or on screen only',
        question: 'Mask NRIC numbers when transcripts are ingested (irreversible for stored text) or only when displayed?',
        options: [option('ingest', 'Mask at ingest'), option('screen', 'Mask on screen only')],
        rec: { optionId: 'ingest', rationale: 'PDPA: the raw number never reaches the body store.' },
        test: 'data',
        ago: 6 * MIN,
        projectId: PROJECTS.cx.id,
        requesterId: 'session:ses_fx_nric_discovery',
      }),
    ],
  };
}
