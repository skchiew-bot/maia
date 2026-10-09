/**
 * Control Tower (owner: mod-tower) — the Approver's landing view. Console answers "what are my agents doing";
 * the Control Tower answers "where is the operation at risk and what needs me, across every project":
 * exception-first, ranked by cost of delay, with inline intervention. Gaming/anomaly signals are portfolio-level
 * only — never per-person ranking (R11).
 */
import type { LivenessState } from '../domain';
import type { TicketStage } from './intake';

export const ATTENTION_KINDS = [
  'decision', // any open human-required decision (go-live, rollback, break-glass, agent test 1–5, top-up, lesson…)
  'session_dead',
  'session_stalled',
  'session_throttled',
  'credit_blocked', // developer at cap with a pending/absent top-up
  'post_incident_overdue',
  'breakglass_open',
  'chain_broken',
  'anchor_missed',
  'fx_discrepancy',
  'fx_carry_forward',
  'ticket_waiting', // customer waiting beyond the severity SLA
  'projection_degraded',
  'provenance_refused',
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export type AttentionSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface TowerAttentionItem {
  /** Stable key (e.g. `decision:dec_…`, `session_dead:ses_…`). */
  id: string;
  kind: AttentionKind;
  severity: AttentionSeverity;
  /** Short, PII-free title. */
  title: string;
  detail: string | null;
  projectId: string | null;
  projectName: string | null;
  /** When it started needing attention (a customer ticket: when the customer submitted it). */
  since: string;
  ageMs: number;
  /**
   * Ranking: higher = act first (the queue is already in this order). `score` is 0–100 on the approved bands
   * (≥75 critical, 50–74 high, 25–49 medium, <25 low): the item's impact (kind × blast radius) plus 20 points per
   * doubling of 1 + age ÷ its SLA (the approved SLA, else a reference scale), shown as is up to 90 and approaching
   * 100 above. `basis` explains it in words ("Go-live gate · 2h 14m · blocks a UAT-signed fix").
   */
  costOfDelay: { score: number; basis: string };
  action: {
    kind: 'resolve_decision' | 'nudge' | 'restart' | 'open';
    label: string;
    href: string;
    decisionId?: string;
    sessionId?: string;
    requiresPasskey?: boolean;
    /**
     * resolve_decision labelled Approve…: the option the inline Approve applies (the decision's recommendation).
     * null when the action opens the card instead (label "Review…": no recommendation, or a judgement call such as
     * an FX discrepancy) and for every other action kind.
     */
    recommendedOptionId: string | null;
  };
  chips: string[];
}

export interface TowerKpis {
  needsYou: number;
  oldestNeedsYouSince: string | null;
  tasksVerifiedToday: number;
  tasksVerifiedBaseline: number; // same-time-of-day 7-day average
  gateLatencyP50Ms: number | null;
  gateLatencyP90Ms: number | null;
  gateSlaMs: number;
  /** Open human gates (every decision kind except the requester's UAT sign-off) past their due time or approved SLA. */
  openPastSla: number;
  openTickets: number;
  oldestTicketSince: string | null;
  chainOk: boolean | null;
  anchorAgeMs: number | null;
}

export interface TowerFlow {
  /** Last 12 local hours, oldest → newest. */
  tasksPerHour: { hour: string; verified: number; flagged: number }[];
  baselinePerHour: number[];
  wipByProject: { projectId: string; name: string; activeSessions: number; openTasks: number; progressPct: number }[];
  ticketFunnel: { stage: TicketStage; count: number; oldestSince: string | null; medianAgeMs: number | null; bottleneck: boolean }[];
  /**
   * `slaMs` is the kind's approved SLA; kinds without one carry a reference scale for drawing (break-glass 15m,
   * protected operation 1h, others 1 day). `breaches` = open past due + resolved after due in 7d, where due is the
   * card's own due time, else its approved SLA — so kinds without an approved SLA breach only a set due time.
   */
  decisionLatency: { kind: string; open: number; resolved7d: number; p50Ms: number | null; p90Ms: number | null; slaMs: number; breaches: number }[];
}

export interface TowerFleet {
  byLiveness: Record<LivenessState, number> & { ended_today: number };
  /** 2h, 5-minute buckets, oldest → newest. */
  trend: { at: string; working: number; thinking: number; stalled: number; dead: number; throttled: number; waiting_on_you: number }[];
  stallRatePct: number;
  /**
   * The mock's marker: the same rate over the previous 7 local days, pooled (stalled session-days ÷ live
   * session-days); null when no session was live in those days.
   */
  stallRateAvg7dPct: number | null;
  throttleLostMsToday: number;
  rolloverPressure: number; // live sessions above 60% of their context window
}

export interface TowerSpend {
  notionalUsdToday: number;
  notionalRmToday: number | null;
  avg7dUsd: number;
  byProject: { projectId: string; name: string; usdToday: number }[];
  modelMix: { tier: string; usdToday: number; pct: number }[];
  discoveryRuns7d: number;
  executionRuns7d: number;
  savingsPct: number | null;
  /**
   * Capacity planning (credits): runway of builders with usage this period, soonest cap first; projectedCapAt
   * null = the balance lasts the period.
   */
  capForecast: { userId: string; name: string | null; balanceUsd: number; burnPerDayUsd: number; projectedCapAt: string | null }[];
}

export interface TowerIntegrity {
  chainOk: boolean | null;
  lastVerifiedAt: string | null;
  lastAnchorAt: string | null;
  anchorAgeMs: number | null;
  unanchoredEvents: number;
  breakglassOpen: number;
  postIncidentOverdue: number;
  provenanceRefusals7d: number;
  selfModBlocks7d: number;
  mappingStatus: 'provisional' | 'stamped' | 'unknown';
  degradedProjections: number;
  reactorFailures24h: number;
}

export const ANOMALY_SIGNALS = [
  'no_file_change_closes',
  'xs_heavy_manifests',
  'late_denominator_growth',
  'blind_affirm_rate',
  'discovery_with_playbook',
  'evidence_unverified',
  'self_approval_rate',
] as const;
export type AnomalySignal = (typeof ANOMALY_SIGNALS)[number];

export interface TowerAnomaly {
  signal: AnomalySignal;
  label: string;
  value: number;
  baseline: number | null;
  unit: '%' | 'count' | 'ratio';
  status: 'normal' | 'watch' | 'alert';
  /** 'portfolio', a process type or a project — NEVER a person (R11). */
  scope: string;
  explanation: string;
}

export interface TowerSnapshot {
  generatedAt: string;
  summary: string;
  kpis: TowerKpis;
  attention: TowerAttentionItem[];
  flow: TowerFlow;
  fleet: TowerFleet;
  spend: TowerSpend;
  integrity: TowerIntegrity;
  anomalies: TowerAnomaly[];
}
