/**
 * Attention queue: every exception that needs a human — including items another human could clear (approved
 * default) — ranked by cost of delay, not age, each with its intervention inline.
 */
import {
  DECISION_TEST_INFO,
  MODEL_CONTEXT_TOKENS,
  PASSKEY_KINDS,
  TESTED_DECISION_KINDS,
  modelTierOf,
  type AttentionKind,
  type DecisionKind,
  type DecisionTest,
  type Severity,
  type TicketStage,
  type TowerAttentionItem,
} from '@aoc/contracts';
import { localPeriod } from '@aoc/kernel';
import { all, iso, one, projectName, type ReadCtx } from './read';
import {
  ANCHOR_MAX_AGE_MS,
  ATTENTION_SCALE_MS,
  DECISION_SLA_MS,
  IMPACT,
  TICKET_BLAST,
  TICKET_IMPACT,
  TICKET_SLA_MS,
  cleanTitle,
  costOfDelay,
  decisionDueMs,
  decisionImpact,
  decisionSlaMs,
  displayScore,
  formatDuration,
  severityOf,
} from './scoring';
import { localClock } from './zoned';

export const DECISION_LABEL: Record<DecisionKind, string> = {
  agent_decision: 'Agent decision',
  protected_operation: 'Protected operation',
  fix_plan: 'Fix-plan gate',
  go_live: 'Go-live gate',
  rollback: 'Rollback gate',
  change_request: 'Change request',
  break_glass: 'Break-glass promotion',
  playbook_approval: 'Playbook approval',
  lesson_binding: 'Lesson binding',
  credit_topup: 'Credit top-up',
  fx_discrepancy: 'FX discrepancy',
  triage_reconciliation: 'Triage disagreement',
  low_confidence_diagnosis: 'Low-confidence diagnosis',
  uat_signoff: 'UAT sign-off',
};

/** Judgement calls with several real options: the inline action opens them for review instead of approving. */
const REVIEW_KINDS: ReadonlySet<DecisionKind> = new Set<DecisionKind>([
  'fx_discrepancy',
  'triage_reconciliation',
  'low_confidence_diagnosis',
]);

const STAGE_LABEL: Record<TicketStage, string> = {
  received: 'waiting for triage',
  triage: 'in triage',
  awaiting_human: 'awaiting a human',
  fix_plan_gate: 'at the fix-plan gate',
  building: 'in build',
  uat: 'in UAT, waiting on the requester',
  go_live_gate: 'at the go-live gate',
  completed: 'completed',
  closed: 'closed',
};

const REFUSAL_LABEL: Record<string, string> = {
  provenance_gap: 'provenance gap',
  uat_missing: 'UAT sign-off missing',
  gate_missing: 'gate missing',
  tests_failed: 'tests failed',
  not_fast_forward: 'not a fast-forward',
};

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const usd = (n: number) => `$${n.toFixed(2)}`;
const decisionHref = (id: string) => `/decisions?id=${encodeURIComponent(id)}`;

type Action = TowerAttentionItem['action'];
/** A non-decision action: nothing to apply inline. */
const go = (kind: 'open' | 'nudge' | 'restart', label: string, href: string, sessionId?: string): Action => ({
  kind,
  label,
  href,
  ...(sessionId ? { sessionId } : {}),
  recommendedOptionId: null,
});
/**
 * Inline resolution. Approve applies the decision's recommended option (approved default), so without one — or for a
 * judgement call that needs reading — the action opens the card for review instead.
 */
function resolve(
  decisionId: string,
  passkey: boolean,
  recommended: string | null,
  approveLabel = passkey ? 'Approve with passkey' : 'Approve',
  reviewLabel = 'Review',
): Action {
  return {
    kind: 'resolve_decision',
    label: recommended ? approveLabel : reviewLabel,
    href: decisionHref(decisionId),
    decisionId,
    requiresPasskey: passkey,
    recommendedOptionId: recommended,
  };
}

interface Draft {
  id: string;
  kind: AttentionKind;
  title: string;
  detail: string | null;
  projectId: string | null;
  since: number;
  /** Where ageing starts when it is not `since` (a ticket ages from its SLA breach, shown from submission). */
  ageFrom?: number;
  impact: number;
  /** Time scale the age is measured against: the approved SLA where there is one. */
  scaleMs: number;
  /** Multiplier ≥ 1: how much else this item holds up (customer tickets, UAT-signed fixes). */
  blast: number;
  /** Score basis in words, given the formatted age: kind · age · what the delay is blocking. */
  basis: (age: string) => string[];
  action: Action;
  chips: string[];
}

interface DecisionRow {
  decision_id: string;
  kind: DecisionKind;
  test: DecisionTest | null;
  project_id: string | null;
  requester_id: string | null;
  requires_passkey: number;
  recommended_option_id: string | null;
  requested_ms: number;
  due_ms: number | null;
  ticket_id: string | null;
  session_ticket_id: string | null;
  session_type: string | null;
}

interface TicketRow {
  ticket_id: string;
  project_id: string | null;
  severity: Severity;
  submitted_ms: number;
  stage: TicketStage;
  uat_passed: number;
}

interface SessionRow {
  session_id: string;
  project_id: string | null;
  ticket_id: string | null;
  process_type: string | null;
  liveness: 'dead' | 'stalled' | 'throttled';
  liveness_since_ms: number | null;
  launched_ms: number;
  throttle_started_ms: number | null;
  throttle_reset_at: string | null;
  context_tokens: number | null;
  context_model: string | null;
}

/** Facts from the integrity read that also drive attention items. */
export interface IntegrityFacts {
  chainOk: boolean | null;
  brokenSinceMs: number | null;
  firstBadSeq: number | null;
  anchorMs: number | null;
  anchorFailedMs: number | null;
  anchorFailReason: string | null;
  unanchoredEvents: number;
  firstEventMs: number | null;
  degraded: { name: string; failedSeq: number | null }[];
}

export function buildAttention(r: ReadCtx, integrity: IntegrityFacts): TowerAttentionItem[] {
  const drafts: Draft[] = [];
  const tickets = new Map(
    all<TicketRow>(
      r,
      "SELECT ticket_id, project_id, severity, submitted_ms, stage, uat_passed FROM twr_tickets WHERE stage NOT IN ('completed','closed')",
    ).map((t) => [t.ticket_id, t]),
  );
  /** Tickets whose wait an item already carries (as blast radius), so they get no duplicate ticket item. */
  const ticketsCarried = new Set<string>();

  // ── open decisions ─────────────────────────────────────────────────────────
  const fxDecisionIds = new Set(
    all<{ decision_id: string }>(r, 'SELECT decision_id FROM twr_fx_discrepancies').map((x) => x.decision_id),
  );
  const creditDecisions: DecisionRow[] = [];
  for (const d of all<DecisionRow>(
    r,
    `SELECT d.decision_id, d.kind, d.test, d.project_id, d.requester_id, d.requires_passkey, d.recommended_option_id,
       d.requested_ms, d.due_ms, COALESCE(l.ticket_id, CASE WHEN d.subject_type = 'ticket' THEN d.subject_id END) AS ticket_id,
       s.ticket_id AS session_ticket_id, s.process_type AS session_type
     FROM twr_decisions d
     LEFT JOIN twr_ticket_links l ON l.decision_id = d.decision_id
     LEFT JOIN twr_sessions s ON s.session_id = d.session_id
     WHERE d.status = 'open'`,
  )) {
    if (d.kind === 'uat_signoff') continue; // the customer's step: the waiting ticket is listed instead
    if (d.kind === 'credit_topup') {
      creditDecisions.push(d);
      continue;
    }
    if (d.kind === 'fx_discrepancy' && fxDecisionIds.has(d.decision_id)) continue; // listed from the FX events
    const ticket = tickets.get(d.ticket_id ?? d.session_ticket_id ?? '');
    if (ticket) ticketsCarried.add(ticket.ticket_id);
    const customer = customerStake(r, ticket, d.kind);
    const passkey = d.requires_passkey === 1 || PASSKEY_KINDS.has(d.kind);
    const testInfo = TESTED_DECISION_KINDS.has(d.kind) && d.test ? DECISION_TEST_INFO[d.test] : null;
    const label = testInfo ? `${DECISION_LABEL[d.kind]} (test ${testInfo.no}: ${d.test})` : DECISION_LABEL[d.kind];
    const due = decisionDueMs(d.kind, d.requested_ms, d.due_ms);
    const pastSla = due !== null && r.now > due;
    const sla = DECISION_SLA_MS[d.kind];
    const title = r.svc.decisionTitle(d.decision_id);
    drafts.push({
      id: `decision:${d.decision_id}`,
      kind: d.kind === 'fx_discrepancy' ? 'fx_discrepancy' : 'decision',
      title: title ? cleanTitle(title) || label : label,
      detail: [testInfo?.label ?? null, customer.detail].filter(Boolean).join(' · ') || null,
      projectId: d.project_id ?? ticket?.project_id ?? null,
      since: d.requested_ms,
      impact: decisionImpact(d.kind, d.test)!,
      scaleMs: decisionSlaMs(d.kind),
      blast: 1 + customer.blast,
      basis: (age) => [
        label,
        age,
        ...customer.blocks,
        ...(d.session_type ? [`holds a ${d.session_type} session`] : []),
        ...customer.extras,
        ...(pastSla
          ? [
              d.due_ms === null && sla !== undefined
                ? `past the ${formatDuration(sla)} SLA`
                : 'past its due time',
            ]
          : []),
      ],
      action: resolve(d.decision_id, passkey, REVIEW_KINDS.has(d.kind) ? null : d.recommended_option_id),
      chips: [
        ...(passkey ? ['Passkey'] : []),
        ...(d.test ? [`test ${d.test}`] : []),
        ...customer.chips,
        ...(pastSla ? ['Past SLA'] : []),
      ],
    });
  }

  // ── break-glass without a visible decision; overdue post-incident records ─
  for (const b of all<{
    breakglass_id: string;
    project_id: string | null;
    decision_id: string;
    invoked_ms: number;
  }>(
    r,
    `SELECT b.breakglass_id, b.project_id, b.decision_id, b.invoked_ms FROM twr_breakglass b
     LEFT JOIN twr_decisions d ON d.decision_id = b.decision_id
     WHERE b.approved_ms IS NULL AND b.rejected_ms IS NULL AND d.decision_id IS NULL AND b.decision_id IS NOT NULL`,
  )) {
    drafts.push({
      id: `breakglass_open:${b.breakglass_id}`,
      kind: 'breakglass_open',
      title: 'Break-glass promotion awaiting approval',
      detail: 'Production is down; emergency promotion requested',
      projectId: b.project_id,
      since: b.invoked_ms,
      impact: IMPACT.breakglass_open,
      scaleMs: ATTENTION_SCALE_MS.breakglass_open,
      blast: 1,
      basis: (age) => ['Break-glass promotion', age, 'production down'],
      action: resolve(b.decision_id, true, null),
      chips: ['Passkey', 'Production'],
    });
  }
  for (const b of all<{
    breakglass_id: string;
    project_id: string | null;
    change_id: string | null;
    due_ms: number | null;
    overdue_ms: number;
  }>(
    r,
    `SELECT b.breakglass_id, b.project_id, b.change_id, b.due_ms, b.overdue_ms FROM twr_breakglass b
     LEFT JOIN twr_changes c ON c.change_id = b.change_id
     WHERE b.overdue_ms IS NOT NULL AND c.completed_ms IS NULL`,
  )) {
    drafts.push({
      id: `post_incident_overdue:${b.breakglass_id}`,
      kind: 'post_incident_overdue',
      title: 'Post-incident change record overdue',
      detail: b.change_id
        ? `Change ${b.change_id}, due within 24h of the break-glass`
        : 'Due within 24h of the break-glass',
      projectId: b.project_id,
      since: b.due_ms ?? b.overdue_ms,
      impact: IMPACT.post_incident_overdue,
      scaleMs: ATTENTION_SCALE_MS.post_incident_overdue,
      blast: 1,
      basis: (age) => ['Post-incident record', `${age} overdue`, 'open audit finding until filed'],
      action: go(
        'open',
        'Open record',
        b.change_id ? `/changes?id=${encodeURIComponent(b.change_id)}` : '/changes',
      ),
      chips: ['Break-glass'],
    });
  }

  // ── credit caps (top-up decisions fold in here: 25 + 6 per blocked session) ─
  drafts.push(...creditItems(r, creditDecisions));

  // ── managed sessions (observed ones are read-only: nothing to intervene on) ─
  for (const s of all<SessionRow>(
    r,
    `SELECT session_id, project_id, ticket_id, process_type, liveness, liveness_since_ms, launched_ms, throttle_started_ms, throttle_reset_at,
       context_tokens, COALESCE(context_model, model) AS context_model
     FROM twr_sessions WHERE ended_ms IS NULL AND mode != 'observed' AND liveness IN ('dead','stalled','throttled')`,
  )) {
    const ticket = tickets.get(s.ticket_id ?? '');
    if (ticket) ticketsCarried.add(ticket.ticket_id);
    const customer = customerStake(r, ticket, null);
    const type = s.process_type ?? 'unknown type';
    const href = `/sessions/${encodeURIComponent(s.session_id)}`;
    const detail = [`Session ${s.session_id}`, customer.detail].filter(Boolean).join(' · ');
    if (s.liveness === 'throttled') {
      const resetMs = s.throttle_reset_at ? Date.parse(s.throttle_reset_at) : NaN;
      const reset = Number.isNaN(resetMs) ? null : `resets ${localClock(resetMs, r.tz)}`;
      drafts.push({
        id: `session_throttled:${s.session_id}`,
        kind: 'session_throttled',
        title: `Throttled session: ${type}${reset ? ` (${reset})` : ''}`,
        detail,
        projectId: s.project_id,
        since: s.throttle_started_ms ?? s.liveness_since_ms ?? s.launched_ms,
        impact: IMPACT.session_throttled,
        scaleMs: ATTENTION_SCALE_MS.session_throttled,
        blast: 1 + customer.blast,
        basis: (age) => ['Plan limit', `idle ${age}`, reset ?? 'reset time unknown', ...customer.extras],
        action: go('open', 'Open', href, s.session_id),
        chips: [...(reset ? [capital(reset)] : []), ...customer.chips],
      });
      continue;
    }
    const dead = s.liveness === 'dead';
    const context = contextPct(s);
    drafts.push({
      id: `session_${s.liveness}:${s.session_id}`,
      kind: dead ? 'session_dead' : 'session_stalled',
      title: `${dead ? 'Dead' : 'Stalled'} session: ${type}`,
      detail,
      projectId: s.project_id,
      since: s.liveness_since_ms ?? s.launched_ms,
      impact: dead ? IMPACT.session_dead : IMPACT.session_stalled,
      scaleMs: dead ? ATTENTION_SCALE_MS.session_dead : ATTENTION_SCALE_MS.session_stalled,
      blast: 1 + customer.blast,
      basis: (age) => [
        dead ? 'Dead session' : 'Stalled session',
        age,
        ...(!dead && context !== null ? [`process alive but silent at ${context}% context`] : []),
        ...customer.extras,
      ],
      action: dead ? go('restart', 'Restart', href, s.session_id) : go('nudge', 'Nudge…', href, s.session_id),
      chips: customer.chips,
    });
  }

  // ── customers waiting beyond their severity SLA — on us, or on the requester in UAT ─
  for (const t of tickets.values()) {
    if (ticketsCarried.has(t.ticket_id)) continue;
    const sla = TICKET_SLA_MS[t.severity];
    if (r.now - t.submitted_ms <= sla) continue;
    const sev = capital(t.severity);
    drafts.push({
      id: `ticket_waiting:${t.ticket_id}`,
      kind: 'ticket_waiting',
      title: `${sev} ticket ${STAGE_LABEL[t.stage]}`,
      detail: `Ticket ${t.ticket_id}`,
      projectId: t.project_id,
      since: t.submitted_ms,
      ageFrom: t.submitted_ms + sla,
      impact: TICKET_IMPACT[t.severity],
      scaleMs: sla,
      blast: 1,
      basis: (age) => [`${sev} ticket`, age, `past the ${formatDuration(sla)} SLA`, STAGE_LABEL[t.stage]],
      action: go('open', 'Open ticket', `/tickets/${encodeURIComponent(t.ticket_id)}`),
      chips: [sev, 'SLA breached'],
    });
  }

  // ── integrity ──────────────────────────────────────────────────────────────
  if (integrity.chainOk === false) {
    drafts.push({
      id: 'chain_broken',
      kind: 'chain_broken',
      title: 'Audit chain verification failed',
      detail: integrity.firstBadSeq !== null ? `First bad event seq ${integrity.firstBadSeq}` : null,
      projectId: null,
      since: integrity.brokenSinceMs ?? r.now,
      impact: IMPACT.chain_broken,
      scaleMs: ATTENTION_SCALE_MS.chain_broken,
      blast: 1,
      basis: (age) => [
        'Chain broken',
        age,
        ...(integrity.firstBadSeq !== null
          ? [`first bad seq ${integrity.firstBadSeq.toLocaleString('en-US')}`]
          : []),
      ],
      action: go('open', 'Open audit', '/audit'),
      chips: ['Integrity'],
    });
  }
  const anchorRef = integrity.anchorMs ?? integrity.firstEventMs;
  if (anchorRef !== null && r.now - anchorRef > ANCHOR_MAX_AGE_MS) {
    const failed = integrity.anchorFailedMs !== null && integrity.anchorFailedMs > (integrity.anchorMs ?? 0);
    drafts.push({
      id: 'anchor_missed',
      kind: 'anchor_missed',
      title: 'Nightly chain anchor missed',
      detail:
        failed && integrity.anchorFailReason ? `Last attempt failed: ${integrity.anchorFailReason}` : null,
      projectId: null,
      since: anchorRef + ANCHOR_MAX_AGE_MS,
      impact: IMPACT.anchor_missed,
      scaleMs: ATTENTION_SCALE_MS.anchor_missed,
      blast: 1,
      basis: () => [
        'Anchor missed',
        integrity.anchorMs !== null
          ? `last anchor ${formatDuration(r.now - integrity.anchorMs)} ago`
          : 'never anchored',
        `${plural(integrity.unanchoredEvents, 'event')} unanchored`,
      ],
      action: go('open', 'Open audit', '/audit'),
      chips: ['Integrity', ...(failed ? ['Anchor failing'] : [])],
    });
  }
  for (const p of integrity.degraded) {
    const failedTs = p.failedSeq !== null ? r.store.get(p.failedSeq)?.ts : undefined;
    drafts.push({
      id: `projection_degraded:${p.name}`,
      kind: 'projection_degraded',
      title: `Projection degraded: ${p.name}`,
      detail: 'Read model is stale until rebuilt from the log',
      projectId: null,
      since: failedTs ? Date.parse(failedTs) : r.now,
      impact: IMPACT.projection_degraded,
      scaleMs: ATTENTION_SCALE_MS.projection_degraded,
      blast: 1,
      basis: (age) => [
        'Projection degraded',
        age,
        ...(p.failedSeq !== null ? [`failed at seq ${p.failedSeq.toLocaleString('en-US')}`] : []),
      ],
      action: go('open', 'Open audit', '/audit'),
      chips: ['Integrity'],
    });
  }
  // A refusal stays open until a newer promotion of the same project supersedes it.
  for (const p of all<{
    promotion_id: string;
    project_id: string | null;
    refused_ms: number;
    reason: string;
    orphan_count: number | null;
  }>(
    r,
    `SELECT p.promotion_id, p.project_id, p.refused_ms, p.reason, p.orphan_count FROM twr_promotions p
     WHERE p.refused_ms IS NOT NULL AND p.closed_ms IS NULL
       AND NOT EXISTS (SELECT 1 FROM twr_promotions q WHERE q.project_id = p.project_id AND q.promotion_id != p.promotion_id
                       AND COALESCE(q.requested_ms, q.refused_ms, 0) > COALESCE(p.requested_ms, p.refused_ms))`,
  )) {
    const reason = REFUSAL_LABEL[p.reason] ?? p.reason;
    drafts.push({
      id: `provenance_refused:${p.promotion_id}`,
      kind: 'provenance_refused',
      title: `Promotion refused: ${reason}`,
      detail: `Promotion ${p.promotion_id}`,
      projectId: p.project_id,
      since: p.refused_ms,
      impact: IMPACT.provenance_refused,
      scaleMs: ATTENTION_SCALE_MS.provenance_refused,
      blast: 1,
      basis: (age) => [
        'Promotion refused',
        age,
        reason,
        ...(p.orphan_count ? [plural(p.orphan_count, 'orphan commit')] : []),
      ],
      action: go('open', 'Open promotion', `/changes?promotionId=${encodeURIComponent(p.promotion_id)}`),
      chips: ['Provenance'],
    });
  }
  for (const f of all<{ decision_id: string; date: string; raised_ms: number }>(
    r,
    `SELECT f.decision_id, f.date, f.raised_ms FROM twr_fx_discrepancies f LEFT JOIN twr_decisions d ON d.decision_id = f.decision_id
     WHERE f.resolved = 0 AND (d.status IS NULL OR d.status = 'open')`,
  )) {
    drafts.push({
      id: `fx_discrepancy:${f.decision_id}`,
      kind: 'fx_discrepancy',
      title: `FX discrepancy for ${f.date}`,
      detail: 'Scraped USD/MYR rate disagrees with the BNM figure',
      projectId: null,
      since: f.raised_ms,
      impact: IMPACT.fx_discrepancy,
      scaleMs: ATTENTION_SCALE_MS.fx_discrepancy,
      blast: 1,
      basis: (age) => ['FX discrepancy', age, `${f.date} RM rollups stay provisional until reviewed`],
      action: resolve(f.decision_id, false, null),
      chips: ['FX'],
    });
  }
  const fx = one<{
    fx_alert_ms: number | null;
    fx_alert_days: number | null;
    fx_last_live_ms: number | null;
  }>(r, 'SELECT fx_alert_ms, fx_alert_days, fx_last_live_ms FROM twr_state WHERE id = 1');
  if (fx?.fx_alert_ms != null && (fx.fx_last_live_ms ?? 0) < fx.fx_alert_ms) {
    const days = fx.fx_alert_days ?? 0;
    drafts.push({
      id: 'fx_carry_forward',
      kind: 'fx_carry_forward',
      // The alert counts weekdays without a live rate (holidays count, weekends do not).
      title: `No live USD/MYR rate for ${plural(days, 'weekday')}`,
      detail: 'Manual check of the BNM rate requested',
      projectId: null,
      since: fx.fx_alert_ms,
      impact: IMPACT.fx_carry_forward,
      scaleMs: ATTENTION_SCALE_MS.fx_carry_forward,
      blast: 1,
      basis: (age) => ['FX carried forward', plural(days, 'weekday'), `alert ${age} old`],
      action: go('open', 'Check rate', '/fx'),
      chips: ['FX'],
    });
  }

  return drafts
    .filter((d) => !r.projectId || d.projectId === r.projectId)
    .map((d) => finish(r, d))
    .sort(
      (a, b) =>
        b.rank - a.rank || a.item.since.localeCompare(b.item.since) || a.item.id.localeCompare(b.item.id),
    )
    .map((x) => x.item);
}

/** Ranked by the unbounded rank (the published 0–100 score saturates near 100); the item carries the score. */
function finish(r: ReadCtx, d: Draft): { rank: number; item: TowerAttentionItem } {
  const ageMs = Math.max(0, r.now - d.since);
  const rank = costOfDelay(d.impact, r.now - (d.ageFrom ?? d.since), d.scaleMs, d.blast);
  const score = displayScore(rank);
  return {
    rank,
    item: {
      id: d.id,
      kind: d.kind,
      severity: severityOf(score),
      title: d.title,
      detail: d.detail,
      projectId: d.projectId,
      projectName: projectName(r, d.projectId),
      since: iso(d.since),
      ageMs,
      costOfDelay: { score, basis: d.basis(formatDuration(ageMs)).join(' · ') },
      action: d.action,
      chips: d.chips,
    },
  };
}

function contextPct(s: SessionRow): number | null {
  if (s.context_tokens === null) return null;
  const tier = s.context_model ? modelTierOf(s.context_model) : 'unknown';
  const window = tier === 'unknown' ? 1_000_000 : (MODEL_CONTEXT_TOKENS[tier] ?? 1_000_000);
  return Math.round((s.context_tokens / window) * 100);
}

/** What an item holds up for a customer: severity, a UAT-signed fix behind a go-live gate, a breached SLA. */
function customerStake(
  r: ReadCtx,
  t: TicketRow | undefined,
  kind: DecisionKind | null,
): { blast: number; blocks: string[]; extras: string[]; chips: string[]; detail: string | null } {
  if (!t) return { blast: 0, blocks: [], extras: [], chips: [], detail: null };
  const sla = TICKET_SLA_MS[t.severity];
  const breached = r.now - t.submitted_ms > sla;
  const uatSigned = kind === 'go_live' && t.uat_passed === 1;
  return {
    blast: TICKET_BLAST[t.severity] + (uatSigned ? 0.25 : 0) + (breached ? 0.25 : 0),
    blocks: uatSigned ? ['blocks a UAT-signed fix'] : [],
    extras: [`${t.severity} ticket`, ...(breached ? [`customer past the ${formatDuration(sla)} SLA`] : [])],
    chips: [
      `${capital(t.severity)} ticket`,
      ...(uatSigned ? ['UAT signed'] : []),
      ...(breached ? ['SLA breached'] : []),
    ],
    detail: `Ticket ${t.ticket_id} ${STAGE_LABEL[t.stage]}`,
  };
}

interface CreditUserRow {
  user_id: string;
  period: string | null;
  capped_since_ms: number | null;
  pending_decision_id: string | null;
  pending_since_ms: number | null;
  pending_usd: number | null;
}

interface CreditState {
  capped: number | null;
  pendingDecision: string | null;
  pendingSince: number | null;
  pendingUsd: number | null;
}

/**
 * One item per builder at the cap or waiting for a top-up. The title stays PII-free; the builder's name goes in
 * the detail, because the Approver acts on that person's request.
 */
function creditItems(r: ReadCtx, openTopups: DecisionRow[]): Draft[] {
  const period = localPeriod(r.now, r.tz);
  const users = new Map<string, CreditState>();
  for (const u of all<CreditUserRow>(
    r,
    `SELECT user_id, period, capped_since_ms, pending_decision_id, pending_since_ms, pending_usd FROM twr_credit_users
     WHERE capped_since_ms IS NOT NULL OR pending_decision_id IS NOT NULL`,
  )) {
    const capped = u.period === period ? u.capped_since_ms : null;
    if (capped === null && !u.pending_decision_id) continue;
    users.set(u.user_id, {
      capped,
      pendingDecision: u.pending_decision_id,
      pendingSince: u.pending_since_ms,
      pendingUsd: u.pending_usd,
    });
  }
  // An open top-up decision the credit events did not explain still means someone is waiting for funds.
  for (const d of openTopups) {
    const key = d.requester_id ?? d.decision_id;
    const u = users.get(key);
    if (u?.pendingDecision === d.decision_id) continue;
    if (u && !u.pendingDecision)
      Object.assign(u, { pendingDecision: d.decision_id, pendingSince: d.requested_ms });
    else if (!u)
      users.set(key, {
        capped: null,
        pendingDecision: d.decision_id,
        pendingSince: d.requested_ms,
        pendingUsd: null,
      });
  }
  const recommended = new Map(
    all<{ decision_id: string; recommended_option_id: string | null }>(
      r,
      "SELECT decision_id, recommended_option_id FROM twr_decisions WHERE kind = 'credit_topup' AND status = 'open'",
    ).map((d) => [d.decision_id, d.recommended_option_id]),
  );
  const blocked = all<{ user_id: string; session_id: string; project_id: string | null }>(
    r,
    'SELECT b.user_id, b.session_id, s.project_id FROM twr_credit_blocked b LEFT JOIN twr_sessions s ON s.session_id = b.session_id',
  );

  const out: Draft[] = [];
  for (const [userId, u] of users) {
    const sessions = u.capped !== null ? blocked.filter((b) => b.user_id === userId) : [];
    const projects = [...new Set(sessions.map((s) => s.project_id).filter((p): p is string => !!p))];
    const projectId =
      r.projectId && projects.includes(r.projectId)
        ? r.projectId
        : projects.length === 1
          ? projects[0]!
          : null;
    const n = sessions.length;
    const pending = u.pendingDecision;
    const topup = pending
      ? `top-up${u.pendingUsd !== null ? ` of ${usd(u.pendingUsd)}` : ''} pending`
      : 'no top-up requested';
    out.push({
      id: `credit_blocked:${userId}`,
      kind: 'credit_blocked',
      title: u.capped !== null ? `Builder at credit cap; ${topup}` : `Credit ${topup}`,
      detail:
        [r.svc.userName(userId), n ? `${plural(n, 'session')} held at a task boundary` : null]
          .filter(Boolean)
          .join(' · ') || null,
      projectId,
      since: Math.min(u.capped ?? Infinity, u.pendingSince ?? Infinity),
      impact: IMPACT.credit_blocked + IMPACT.credit_blocked_per_session * n,
      scaleMs: ATTENTION_SCALE_MS.credit_blocked,
      blast: 1,
      basis: (age) =>
        u.capped !== null
          ? [
              'Credit cap',
              age,
              `${plural(n, 'session')} blocked`,
              pending ? 'top-up pending' : 'no top-up requested',
            ]
          : ['Credit top-up', age, 'waiting for approval'],
      action: pending
        ? resolve(pending, false, recommended.get(pending) ?? null, 'Approve top-up', 'Review top-up')
        : go('open', 'Open credits', `/credits?userId=${encodeURIComponent(userId)}`),
      chips: [...(n ? [`${n} blocked`] : []), ...(pending ? ['Top-up pending'] : [])],
    });
  }
  return out;
}
