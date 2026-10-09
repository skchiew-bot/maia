/**
 * Cost-of-delay scoring (pure), calibrated on the approved mock (mocks/README.md, 2026-10-09):
 *
 *   rank  = impact × blastRadius + 20 · log2(1 + age ÷ timeScale)
 *   score = rank up to 90, then 100 − 10 · 2^(−(rank − 90) / 10)   (approaches 100, keeps the order)
 *
 * Impact is what a kind holds up when it is fresh (customer impact, blocked work, idle spend, audit exposure).
 * Age enters only as a share of the item's own time scale — its approved SLA where there is one — so kinds of
 * equal impact cross each severity band (75/50/25) at the same fraction of their SLA: every item gains 20
 * points at its SLA, 40 at 3× and 60 at 7×. A lesson binding (impact 8, SLA 2 days) is still low at 22h, medium
 * from about 39h and critical only past 9× its SLA; a rollback (70, SLA 30m) is critical within 6 minutes.
 * With these values the mock's twelve-item queue comes out in the same order and bands, each score within 1.5.
 */
import {
  DECISION_TEST_INFO,
  type AttentionSeverity,
  type DecisionKind,
  type DecisionTest,
  type Severity,
} from '@aoc/contracts';
import { DAY, HOUR, MINUTE } from './zoned';

/** Points an item gains per doubling of (1 + age ÷ time scale). */
export const AGEING_POINTS = 20;
export const MAX_BLAST_RADIUS = 3;

/** Impact of an open decision. credit_topup folds into credit_blocked; uat_signoff waits on the customer. */
export function decisionImpact(kind: DecisionKind, test: DecisionTest | null): number | null {
  switch (kind) {
    case 'break_glass':
      return 80; // production is down
    case 'rollback':
      return 70;
    case 'go_live':
      return 45;
    case 'fix_plan':
      return 30;
    case 'triage_reconciliation':
    case 'low_confidence_diagnosis':
      return 20;
    case 'agent_decision':
      // Tests that bounce to the Approver (main, production, irreversible, data) hold more than a builder's call.
      return test && DECISION_TEST_INFO[test].bouncesToApprover ? 12 : 8;
    case 'protected_operation':
      return 12;
    case 'fx_discrepancy':
      return 11;
    case 'change_request':
      return 10;
    case 'lesson_binding':
    case 'playbook_approval':
      return 8;
    case 'credit_topup':
    case 'uat_signoff':
      return null;
  }
}

/** Impact of the other attention kinds (credit: per builder plus per blocked session). */
export const IMPACT = {
  chain_broken: 80,
  breakglass_open: 80,
  post_incident_overdue: 62,
  session_dead: 50,
  anchor_missed: 50,
  projection_degraded: 40,
  provenance_refused: 35,
  session_stalled: 30,
  credit_blocked: 25,
  credit_blocked_per_session: 6,
  session_throttled: 12,
  fx_discrepancy: 11,
  fx_carry_forward: 8,
} as const;

/** Time scale of the non-decision kinds: how long until an item has gained its first 20 points. */
export const ATTENTION_SCALE_MS = {
  breakglass_open: 15 * MINUTE,
  session_dead: HOUR,
  session_stalled: HOUR,
  session_throttled: HOUR,
  credit_blocked: HOUR, // the approved credit top-up SLA
  chain_broken: HOUR,
  projection_degraded: 4 * HOUR,
  provenance_refused: 4 * HOUR,
  post_incident_overdue: DAY, // the break-glass allowance; the item exists only once it has run out
  anchor_missed: DAY, // the nightly cadence
  fx_discrepancy: DAY,
  fx_carry_forward: DAY,
} as const;

/**
 * A customer ticket waiting past its severity SLA: the item appears at the breach (a critical one as critical) and
 * ages on that SLA from there.
 */
export const TICKET_IMPACT: Record<Severity, number> = { critical: 75, high: 40, medium: 25, low: 15 };
/**
 * How long a customer may wait from submission. High (Sev 2) is the mock's 2 days; the others are proposed on the
 * same footing and await confirmation.
 */
export const TICKET_SLA_MS: Record<Severity, number> = {
  critical: 4 * HOUR,
  high: 2 * DAY,
  medium: 5 * DAY,
  low: 10 * DAY,
};
/** Blast-radius bump when an item blocks a customer ticket of this severity. */
export const TICKET_BLAST: Record<Severity, number> = { critical: 0.5, high: 0.3, medium: 0.15, low: 0.05 };

/** Nightly anchor + slack: no anchor for this long → anchor_missed. */
export const ANCHOR_MAX_AGE_MS = 26 * HOUR;

/** Ageing points: 20 at one time scale, 40 at three, 60 at seven. */
export function agePoints(ageMs: number, scaleMs: number): number {
  return AGEING_POINTS * Math.log2(1 + Math.max(0, ageMs) / scaleMs);
}

/** The ranking key (unbounded, unrounded). */
export function costOfDelay(impact: number, ageMs: number, scaleMs: number, blastRadius = 1): number {
  const radius = Math.min(MAX_BLAST_RADIUS, Math.max(1, blastRadius));
  return impact * radius + agePoints(ageMs, scaleMs);
}

/**
 * Rank → the published 0–100 score: unchanged up to 90 (so the approved bands apply to the rank itself), then
 * halving the remaining distance to 100 every 10 points, so the most urgent items stay distinguishable.
 */
const LINEAR_UNTIL = 90;
const TAIL_HALF = 10;
export function displayScore(rank: number): number {
  const r = Math.max(0, rank);
  const score = r <= LINEAR_UNTIL ? r : 100 - (100 - LINEAR_UNTIL) * 2 ** (-(r - LINEAR_UNTIL) / TAIL_HALF);
  return Math.min(100, Math.round(score * 10) / 10);
}

/** Approved bands on the 0–100 score: ≥75 critical, 50–74 high, 25–49 medium, <25 low. */
export function severityOf(score: number): AttentionSeverity {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

/**
 * Decision SLAs approved by the CEO with the mock (mocks/README.md, decision 3, 2026-10-09). They drive breaches,
 * "open past SLA" and the gate-latency KPI; kinds without one never count as past an SLA (as in the Decisions inbox).
 */
export const DECISION_SLA_MS: Partial<Record<DecisionKind, number>> = {
  rollback: 30 * MINUTE,
  agent_decision: HOUR,
  credit_topup: HOUR,
  go_live: 2 * HOUR,
  fix_plan: 4 * HOUR,
  lesson_binding: 2 * DAY,
};

/**
 * Time scale of a decision kind: its approved SLA, else a reference scale (break-glass 15m — production is down,
 * protected operation 1h like an agent decision, otherwise 1 day). It ages the score and scales the latency chart;
 * only approved SLAs (or a card's own due time) count breaches.
 */
export function decisionSlaMs(kind: string): number {
  const approved = DECISION_SLA_MS[kind as DecisionKind];
  if (approved !== undefined) return approved;
  if (kind === 'break_glass') return 15 * MINUTE;
  if (kind === 'protected_operation') return HOUR;
  return DAY;
}

/** When an open card is due: its own `dueAt`, else requested + the approved SLA; null when neither exists. */
export function decisionDueMs(kind: string, requestedMs: number, dueMs: number | null): number | null {
  if (dueMs !== null) return dueMs;
  const sla = DECISION_SLA_MS[kind as DecisionKind];
  return sla === undefined ? null : requestedMs + sla;
}

/** SLA shown beside the human gate-latency KPI (the approved mock's 1h). */
export const GATE_SLA_MS = HOUR;

/** "2h 14m", "31m", "<1m", "3d 4h". Whole days only from 48h so "24h" stays readable. */
export function formatDuration(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / MINUTE);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  if (ms < 48 * HOUR) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h}h ${rest}m` : `${h}h`;
  }
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  return h ? `${d}d ${h}h` : `${d}d`;
}

export const TITLE_MAX = 120;

/**
 * Attention titles must be PII-free: free-text titles (decision payloads can quote a requester's ticket title)
 * lose e-mail addresses and long digit runs (phone / IC / account numbers) and are capped at 120 chars.
 */
export function cleanTitle(text: string): string {
  const scrubbed = text
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .replace(/[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi, '[email]')
    .replace(/\+?\d[\d\s-]{6,}\d/g, (m) => (m.replace(/\D/g, '').length >= 8 ? '[number]' : m))
    .trim();
  return scrubbed.length > TITLE_MAX ? `${scrubbed.slice(0, TITLE_MAX - 1).trimEnd()}…` : scrubbed;
}
