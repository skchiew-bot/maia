/**
 * Pure rules behind the operator Tickets pages (§7): stage order and wording, the pipeline funnel, gate states,
 * diagnosis summaries, diagnosis budget use and the ticket timeline. Types only from `@aoc/contracts`.
 */
import type {
  AuditEventHeaderDTO,
  InternalTicket,
  PublicTicketStatus,
  Severity,
  TicketDiagnosisDTO,
  TicketStage,
} from '@aoc/contracts';
import type { FunnelStage } from '../../charts/FunnelBar';

export const STAGES: readonly TicketStage[] = [
  'received',
  'triage',
  'awaiting_human',
  'fix_plan_gate',
  'building',
  'uat',
  'go_live_gate',
  'completed',
  'closed',
];

export const STAGE_LABEL: Record<TicketStage, string> = {
  received: 'Received',
  triage: 'Triage',
  awaiting_human: 'Awaiting human',
  fix_plan_gate: 'Fix-plan gate',
  building: 'Building',
  uat: 'UAT',
  go_live_gate: 'Go-live gate',
  completed: 'Completed',
  closed: 'Closed',
};

/** What happens in each stage and who it waits on. */
export const STAGE_HINT: Record<TicketStage, string> = {
  received: 'Waiting for read-only triage to start.',
  triage: 'Read-only triage agents are diagnosing within the diagnosis budget. No code is touched.',
  awaiting_human:
    'Triage could not settle the root cause (low confidence, disagreement or an exhausted budget). A Builder decides how to proceed.',
  fix_plan_gate: 'Nothing touches code until the Approver signs off the fix plan.',
  building: 'A managed build session implements the approved plan on a UAT branch.',
  uat: 'Waiting for the requester to test the fix on UAT and sign it off.',
  go_live_gate: "Promotion to main waits for the Approver's passkey-signed go-live decision.",
  completed: 'Promoted to main and closed as fixed.',
  closed: 'Closed without a fix.',
};

export const TERMINAL: ReadonlySet<TicketStage> = new Set(['completed', 'closed']);

export const PUBLIC_STATUS_LABEL: Record<PublicTicketStatus, string> = {
  received: 'Received',
  being_worked_on: 'Being worked on',
  ready_for_testing: 'Ready for your testing',
  completed: 'Completed',
  closed: 'Closed',
};

export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export const RESOLUTION_LABEL: Record<string, string> = {
  fixed: 'Fixed',
  wont_fix: "Won't fix",
  duplicate: 'Duplicate',
  cannot_reproduce: 'Cannot reproduce',
  withdrawn: 'Withdrawn by the requester',
};

/** Resolutions an operator may close with (`POST /api/tickets/:id/close`); "fixed" only comes from promotion. */
export const CLOSE_RESOLUTIONS = ['duplicate', 'cannot_reproduce', 'wont_fix', 'withdrawn'] as const;
export type CloseResolution = (typeof CLOSE_RESOLUTIONS)[number];

/** Time in the current stage: the projection stamps `updatedAt` on every stage and public-status change. */
export function timeInStageMs(t: Pick<InternalTicket, 'updatedAt'>, now: number): number {
  return Math.max(0, now - Date.parse(t.updatedAt));
}

function median(sorted: readonly number[]): number | undefined {
  if (!sorted.length) return undefined;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Tickets per stage in flow order, with oldest and median time in stage; done stages are terminal. */
export function funnelOf(tickets: readonly InternalTicket[], now: number): FunnelStage[] {
  return STAGES.map((stage) => {
    const inStage = tickets.filter((t) => t.stage === stage);
    const ages = inStage.map((t) => timeInStageMs(t, now)).sort((a, b) => a - b);
    const terminal = TERMINAL.has(stage);
    return {
      id: stage,
      label: STAGE_LABEL[stage],
      count: inStage.length,
      terminal,
      ...(terminal || !ages.length ? {} : { oldestAgeMs: ages[ages.length - 1], medianAgeMs: median(ages) }),
    };
  });
}

export type GateState = 'passed' | 'waiting' | 'blocked' | 'failed' | 'not_reached' | 'skipped';

export interface Gates {
  fixPlan: GateState;
  uat: GateState;
  goLive: GateState;
}

const AFTER_FIX_PLAN: ReadonlySet<TicketStage> = new Set(['building', 'uat', 'go_live_gate', 'completed']);

/**
 * The two human gates plus the requester's UAT sign-off (§7), read from the projected stage. A UAT result of
 * "fail" sends the ticket back to building, so a ticket still in UAT with nothing open has passed UAT and is
 * stuck before go-live (the go-live request did not start): that is `blocked`.
 */
export function gatesOf(t: Pick<InternalTicket, 'stage' | 'openDecisionIds' | 'resolution'>): Gates {
  const closedEarly = t.stage === 'closed';
  const fixPlan: GateState = AFTER_FIX_PLAN.has(t.stage)
    ? 'passed'
    : t.stage === 'fix_plan_gate'
      ? 'waiting'
      : closedEarly
        ? 'skipped'
        : 'not_reached';
  let uat: GateState =
    t.stage === 'go_live_gate' || t.stage === 'completed'
      ? 'passed'
      : closedEarly
        ? 'skipped'
        : 'not_reached';
  let goLive: GateState =
    t.stage === 'completed'
      ? 'passed'
      : t.stage === 'go_live_gate'
        ? 'waiting'
        : closedEarly
          ? 'skipped'
          : 'not_reached';
  if (t.stage === 'uat') {
    if (t.openDecisionIds.length) uat = 'waiting';
    else {
      uat = 'passed';
      goLive = 'blocked';
    }
  }
  return { fixPlan, uat, goLive };
}

export const GATE_WORD: Record<GateState, string> = {
  passed: 'passed',
  waiting: 'waiting',
  blocked: 'not started',
  failed: 'approved, promotion failed',
  not_reached: 'not reached',
  skipped: 'skipped',
};

export interface DiagnosisSummary {
  /** Highest-confidence reported diagnosis. */
  best: TicketDiagnosisDTO | null;
  reported: number;
  running: number;
  total: number;
  /** All reported diagnoses name the same root-cause class (null with fewer than two). */
  agree: boolean | null;
  tokens: number;
}

export function diagnosisOf(diagnoses: readonly TicketDiagnosisDTO[]): DiagnosisSummary {
  const reported = diagnoses.filter((d) => d.status === 'reported' && d.confidence !== null);
  const best = [...reported].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0] ?? null;
  const classes = reported.map((d) => (d.rootCauseClass ?? '').trim().toLowerCase());
  return {
    best,
    reported: reported.length,
    running: diagnoses.filter((d) => d.status === 'running').length,
    total: diagnoses.length,
    agree: reported.length < 2 ? null : classes.every(Boolean) && new Set(classes).size === 1,
    tokens: diagnoses.reduce((n, d) => n + d.tokens, 0),
  };
}

export interface TriageBudget {
  tokens: number;
  minutes: number;
  /** Sessions launched in that triage round. */
  sessionIds: string[];
  startedAt: string;
}

/** Diagnosis budgets recorded by `ticket.triage_started` (latest round per ticket). */
export function budgetsFrom(events: readonly AuditEventHeaderDTO[]): Map<string, TriageBudget> {
  const out = new Map<string, TriageBudget>();
  for (const e of events) {
    if (e.type !== 'ticket.triage_started') continue;
    const m = e.meta as {
      ticketId?: string;
      budgetTokens?: number;
      budgetMinutes?: number;
      sessionIds?: string[];
    };
    const ticketId = m.ticketId ?? e.scope.ticketId;
    if (!ticketId || typeof m.budgetTokens !== 'number') continue;
    const prev = out.get(ticketId);
    if (prev && prev.startedAt > e.ts) continue;
    out.set(ticketId, {
      tokens: m.budgetTokens,
      minutes: typeof m.budgetMinutes === 'number' ? m.budgetMinutes : 0,
      sessionIds: Array.isArray(m.sessionIds) ? m.sessionIds : [],
      startedAt: e.ts,
    });
  }
  return out;
}

/** Tokens used by the triage sessions of the latest round against that round's budget (per agent × agents). */
export function budgetUse(t: Pick<InternalTicket, 'diagnoses'>, budget: TriageBudget | undefined) {
  if (!budget) return null;
  const round = budget.sessionIds.length
    ? t.diagnoses.filter((d) => budget.sessionIds.includes(d.sessionId))
    : t.diagnoses;
  const used = round.reduce((n, d) => n + d.tokens, 0);
  const agents = Math.max(1, round.length || budget.sessionIds.length);
  return { used, cap: budget.tokens * agents, perAgent: budget.tokens, agents, minutes: budget.minutes };
}

export interface StageSpan {
  stage: TicketStage;
  start: number;
  end: number;
  /** Still in this stage. */
  current: boolean;
}

/** Event types that move a ticket between stages (mirrors the intake projector). */
function stageAfter(e: AuditEventHeaderDTO): TicketStage | null {
  const m = e.meta as { verdict?: string; resolution?: string };
  switch (e.type) {
    case 'intake.submitted':
      return 'received';
    case 'ticket.triage_started':
      return 'triage';
    case 'ticket.escalated_to_human':
      return 'awaiting_human';
    case 'ticket.fix_plan_submitted':
      return 'fix_plan_gate';
    case 'ticket.build_started':
      return 'building';
    case 'ticket.uat_ready':
      return 'uat';
    case 'ticket.uat_result':
      return m.verdict === 'fail' ? 'building' : null;
    case 'ticket.golive_requested':
      return 'go_live_gate';
    case 'ticket.closed':
      return m.resolution === 'fixed' ? 'completed' : 'closed';
    default:
      return null;
  }
}

/** Where the ticket's time went: consecutive stage spans from its event history, the last one open until `now`. */
export function stageSpans(events: readonly AuditEventHeaderDTO[], now: number): StageSpan[] {
  const spans: StageSpan[] = [];
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const stage = stageAfter(e);
    if (!stage) continue;
    const at = Date.parse(e.ts);
    const last = spans[spans.length - 1];
    if (last && last.stage === stage) continue;
    if (last) {
      last.end = at;
      last.current = false;
    }
    spans.push({ stage, start: at, end: now, current: true });
  }
  const last = spans[spans.length - 1];
  if (last && TERMINAL.has(last.stage)) {
    last.end = last.start;
    last.current = false;
  }
  return spans;
}

/** Ticket-level events worth a line in the timeline (session plumbing is summarised by launches and ends). */
const TIMELINE_TYPES: ReadonlySet<string> = new Set([
  'intake.submitted',
  'intake.attachment_stored',
  'intake.media_accessed',
  'ticket.triage_started',
  'ticket.diagnosis_reported',
  'ticket.escalated_to_human',
  'ticket.fix_plan_submitted',
  'ticket.build_started',
  'ticket.uat_ready',
  'ticket.uat_result',
  'ticket.golive_requested',
  'ticket.closed',
  'ticket.public_status_changed',
  'decision.requested',
  'decision.resolved',
  'decision.withdrawn',
  'decision.escalated',
  'promotion.requested',
  'promotion.completed',
  'promotion.refused',
  'promotion.failed',
  'session.ended',
]);

export function timelineEvents(events: readonly AuditEventHeaderDTO[]): AuditEventHeaderDTO[] {
  return events.filter((e) => TIMELINE_TYPES.has(e.type)).sort((a, b) => a.seq - b.seq);
}

export function shortTicketId(id: string): string {
  const rest = id.slice(id.indexOf('_') + 1);
  return rest.length > 8 ? `tkt_…${rest.slice(-6)}` : id;
}

export interface PromotionOutcome {
  promotionId: string;
  status: 'requested' | 'completed' | 'refused' | 'failed';
  reason: string | null;
  at: string;
}

/** The latest promotion on the ticket (go-live): requested, then completed, refused or failed. */
export function latestPromotion(events: readonly AuditEventHeaderDTO[]): PromotionOutcome | null {
  let out: PromotionOutcome | null = null;
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const m = e.meta as { promotionId?: string; reason?: string };
    if (!m.promotionId || !e.type.startsWith('promotion.')) continue;
    const status = e.type.slice('promotion.'.length);
    if (status !== 'requested' && status !== 'completed' && status !== 'refused' && status !== 'failed')
      continue;
    out = { promotionId: m.promotionId, status, reason: m.reason ?? null, at: e.ts };
  }
  return out;
}

/** The go-live decision raised for the ticket (its subject is the promotion, so it is not listed by ticket). */
export function goLiveDecisionId(events: readonly AuditEventHeaderDTO[]): string | null {
  let id: string | null = null;
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.type !== 'ticket.golive_requested') continue;
    const d = (e.meta as { decisionId?: unknown }).decisionId;
    id = typeof d === 'string' && d && d !== 'none' ? d : null;
  }
  return id;
}

/** Diagnoses of the latest triage round (re-triage starts a new round); all of them when the round is unknown. */
export function latestRound(
  diagnoses: readonly TicketDiagnosisDTO[],
  budget: TriageBudget | undefined,
): TicketDiagnosisDTO[] {
  if (!budget?.sessionIds.length) return [...diagnoses];
  const round = diagnoses.filter((d) => budget.sessionIds.includes(d.sessionId));
  return round.length ? round : [...diagnoses];
}
