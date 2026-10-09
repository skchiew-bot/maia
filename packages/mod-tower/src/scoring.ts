/**
 * Cost-of-delay scoring (pure). raw = base(kind, sub-kind) × ageFactor × blastRadius, where
 * ageFactor = 1 + log2(1 + ageMinutes / 30): a fresh break-glass (100) outranks a lesson that has waited
 * a day (15 × 6.6 = 99), while a stall left for an hour (50 × 2.6) overtakes a fresh go-live gate (90).
 * The queue is ordered by raw; the published score is raw on the approved 0–100 scale (mock, 2026-10-09).
 */
import type { AttentionSeverity, DecisionKind, DecisionTest, Severity } from '@aoc/contracts';
import { DAY, HOUR, MINUTE } from './zoned';

/** Base cost of delay per open decision kind. credit_topup folds into credit_blocked; uat_signoff waits on the customer. */
export function decisionBase(kind: DecisionKind, test: DecisionTest | null): number | null {
  switch (kind) {
    case 'break_glass':
      return 100;
    case 'rollback':
      return 95;
    case 'go_live':
      return 90;
    case 'fix_plan':
      return 65;
    case 'agent_decision':
      return test === 'main' || test === 'production' || test === 'data' ? 60 : 35;
    case 'protected_operation':
      return 60;
    case 'triage_reconciliation':
    case 'low_confidence_diagnosis':
      return 50;
    case 'change_request':
      return 40;
    case 'fx_discrepancy':
      return 20;
    case 'lesson_binding':
    case 'playbook_approval':
      return 15;
    case 'credit_topup':
    case 'uat_signoff':
      return null;
  }
}

export const BASE = {
  chain_broken: 100,
  breakglass_open: 100,
  post_incident_overdue: 85,
  anchor_missed: 80,
  session_dead: 70,
  projection_degraded: 60,
  provenance_refused: 55,
  session_stalled: 50,
  credit_blocked: 45,
  credit_blocked_per_session: 10,
  session_throttled: 30,
  fx_discrepancy: 20,
  fx_carry_forward: 15,
} as const;

export const TICKET_BASE: Record<Severity, number> = { critical: 90, high: 70, medium: 40, low: 20 };
/** How long a customer may wait (from submission) before the ticket needs attention. */
export const TICKET_SLA_MS: Record<Severity, number> = {
  critical: HOUR,
  high: 4 * HOUR,
  medium: 24 * HOUR,
  low: 72 * HOUR,
};
/** Blast-radius bump when an item blocks a customer ticket of this severity. */
export const TICKET_BLAST: Record<Severity, number> = { critical: 0.5, high: 0.3, medium: 0.15, low: 0.05 };

/** Nightly anchor + slack: no anchor for this long → anchor_missed. */
export const ANCHOR_MAX_AGE_MS = 26 * HOUR;

export function ageFactor(ageMs: number): number {
  return 1 + Math.log2(1 + Math.max(0, ageMs) / MINUTE / 30);
}

export const MAX_BLAST_RADIUS = 3;

/** Raw cost of delay (unbounded, unrounded): the ranking key. */
export function costOfDelay(base: number, ageMs: number, blastRadius = 1): number {
  const radius = Math.min(MAX_BLAST_RADIUS, Math.max(1, blastRadius));
  return base * ageFactor(ageMs) * radius;
}

/**
 * Raw cost → the published 0–100 score (approved scale). Linear (× 5/6) up to raw 90, so the approved bands
 * 75/50/25 are exactly raw 90/60/30 — a fresh go-live gate is critical; above that a tail approaches 100, halving
 * the remaining distance every 60 raw, so the most urgent items stay distinguishable. Monotonic: order is kept.
 */
const LINEAR_UNTIL = 90;
const TAIL_HALF_RAW = 60;
export function displayScore(raw: number): number {
  const r = Math.max(0, raw);
  const score = r <= LINEAR_UNTIL ? (r * 5) / 6 : 75 + 25 * (1 - 2 ** (-(r - LINEAR_UNTIL) / TAIL_HALF_RAW));
  return Math.round(score * 10) / 10;
}

/** Approved bands on the 0–100 score: ≥75 critical, 50–74 high, 25–49 medium, <25 low. */
export function severityOf(score: number): AttentionSeverity {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

/** Decision SLA per kind (latency chart and breach counts), as approved with the mock; 24h where none was set. */
export function decisionSlaMs(kind: string): number {
  switch (kind) {
    case 'break_glass':
      return 15 * MINUTE;
    case 'rollback':
      return 30 * MINUTE;
    case 'agent_decision':
    case 'protected_operation':
    case 'credit_topup':
      return HOUR;
    case 'go_live':
      return 2 * HOUR;
    case 'fix_plan':
      return 4 * HOUR;
    case 'lesson_binding':
      return 2 * DAY;
    default:
      return DAY;
  }
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
