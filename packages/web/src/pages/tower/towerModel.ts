/**
 * Pure rules for the Control Tower page: labels, ranking/folding of the attention queue, which decision option
 * an inline Approve or Deny applies, and the scales the page's small charts use. No React, no clock reads —
 * every function takes `now` when it needs one, so tests are deterministic.
 */
import type {
  AnomalySignal,
  AttentionKind,
  AttentionSeverity,
  DecisionBlockReason,
  DecisionCardView,
  DecisionKind,
  DecisionOption,
  TicketStage,
  TowerAnomaly,
  TowerAttentionItem,
  TowerFlow,
  TowerSpend,
} from '@aoc/contracts';

export const SEVERITY_WORD: Record<AttentionSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const ATTENTION_KIND_LABEL: Record<AttentionKind, string> = {
  decision: 'Decision',
  session_dead: 'Dead session',
  session_stalled: 'Stalled session',
  session_throttled: 'Throttled session',
  credit_blocked: 'Credit blocked',
  post_incident_overdue: 'Post-incident record',
  breakglass_open: 'Break-glass open',
  chain_broken: 'Chain broken',
  anchor_missed: 'Anchor missed',
  fx_discrepancy: 'FX discrepancy',
  fx_carry_forward: 'FX carried forward',
  ticket_waiting: 'Customer waiting',
  projection_degraded: 'Projection degraded',
  provenance_refused: 'Provenance refused',
};

/** Queue label for a decision row: gates read as gates ("Rollback gate"), everything else by its kind. */
const DECISION_ROW_LABEL: Record<DecisionKind, string> = {
  agent_decision: 'Agent decision',
  protected_operation: 'Protected operation',
  fix_plan: 'Fix-plan gate',
  go_live: 'Go-live gate',
  rollback: 'Rollback gate',
  change_request: 'Change request',
  break_glass: 'Break-glass gate',
  playbook_approval: 'Playbook approval',
  lesson_binding: 'Lesson binding',
  credit_topup: 'Credit top-up',
  fx_discrepancy: 'FX discrepancy',
  triage_reconciliation: 'Triage reconciliation',
  low_confidence_diagnosis: 'Low-confidence diagnosis',
  uat_signoff: 'UAT sign-off',
};

/** Decision-latency row names (§ mock: "Rollback", "Go-live", "Fix plan"). */
const LATENCY_KIND_LABEL: Partial<Record<string, string>> = {
  agent_decision: 'Agent decision',
  protected_operation: 'Protected operation',
  fix_plan: 'Fix plan',
  go_live: 'Go-live',
  rollback: 'Rollback',
  change_request: 'Change request',
  break_glass: 'Break-glass',
  playbook_approval: 'Playbook',
  lesson_binding: 'Lesson binding',
  credit_topup: 'Credit top-up',
  fx_discrepancy: 'FX discrepancy',
  triage_reconciliation: 'Triage reconciliation',
  low_confidence_diagnosis: 'Low-confidence diagnosis',
  uat_signoff: 'UAT sign-off',
};

const TICKET_STAGE_LABEL: Record<TicketStage, string> = {
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

/** Stages that accumulate finished work: never part of the open pipeline. */
const TERMINAL_STAGES: ReadonlySet<TicketStage> = new Set<TicketStage>(['completed', 'closed']);

export const ANOMALY_STATUS_WORD: Record<TowerAnomaly['status'], string> = {
  normal: 'Normal',
  watch: 'Watch',
  alert: 'Alert',
};

/** `snake_case` machine label → "Sentence case" text, for kinds this page has no label for. */
function humanize(label: string): string {
  const s = label.replace(/[_-]+/g, ' ').trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : label;
}

function decisionKindLabel(kind: string): string {
  return (DECISION_ROW_LABEL as Partial<Record<string, string>>)[kind] ?? humanize(kind);
}

export function latencyKindLabel(kind: string): string {
  return LATENCY_KIND_LABEL[kind] ?? humanize(kind);
}

export function ticketStageLabel(stage: string): string {
  return (TICKET_STAGE_LABEL as Partial<Record<string, string>>)[stage] ?? humanize(stage);
}

/** The uppercase kind word on a queue row; decisions use the card's kind when it is known. */
export function attentionKindLabel(item: TowerAttentionItem, card?: DecisionCardView | null): string {
  if (item.kind === 'decision' && card) return decisionKindLabel(card.kind);
  return ATTENTION_KIND_LABEL[item.kind] ?? humanize(item.kind);
}

/** Server order is the ranking; the client re-sorts defensively (score desc, then waiting longest, then id). */
export function rankAttention(items: readonly TowerAttentionItem[]): TowerAttentionItem[] {
  return [...items].sort(
    (a, b) =>
      b.costOfDelay.score - a.costOfDelay.score ||
      Date.parse(a.since) - Date.parse(b.since) ||
      a.id.localeCompare(b.id),
  );
}

/** Below this score an item is "lower-cost" and folds behind a disclosure so the queue stays scannable. */
const FOLD_BELOW_SCORE = 10;
/** Even high-cost items fold past this many rows. */
const MAX_VISIBLE_ROWS = 12;

export function foldAttention(
  ranked: readonly TowerAttentionItem[],
  opts: { foldBelow?: number; maxVisible?: number } = {},
): { visible: TowerAttentionItem[]; folded: TowerAttentionItem[] } {
  const foldBelow = opts.foldBelow ?? FOLD_BELOW_SCORE;
  const maxVisible = opts.maxVisible ?? MAX_VISIBLE_ROWS;
  const visible: TowerAttentionItem[] = [];
  const folded: TowerAttentionItem[] = [];
  for (const item of ranked) {
    if (visible.length < maxVisible && item.costOfDelay.score >= foldBelow) visible.push(item);
    else folded.push(item);
  }
  // Never hide the whole queue behind the fold.
  if (visible.length === 0 && folded.length > 0) visible.push(folded.shift()!);
  return { visible, folded };
}

/** Earliest `since` across the queue — the item that has waited longest. */
export function oldestAttention(items: readonly TowerAttentionItem[]): TowerAttentionItem | null {
  let best: TowerAttentionItem | null = null;
  for (const it of items) if (!best || Date.parse(it.since) < Date.parse(best.since)) best = it;
  return best;
}

export function passkeyGateCount(items: readonly TowerAttentionItem[]): number {
  return items.filter((it) => it.action.requiresPasskey).length;
}

const APPROVE_IDS = new Set(['approve', 'approved', 'accept', 'accept_official', 'bind', 'grant', 'allow', 'yes']);
const APPROVE_LABEL = /^(approve|accept|bind|grant|allow)\b/i;
const DENY_IDS = new Set(['deny', 'reject', 'decline', 'refuse', 'no']);
const DENY_LABEL = /^(deny|reject|decline|refuse)\b/i;

/**
 * The option an inline Approve applies: the card's recommendation (CEO decision 7, 2026-10-09), else the
 * option that plainly approves. `null` means the card has no single "approve" choice — send the user to the
 * decision page instead of guessing.
 */
export function approveOption(card: Pick<DecisionCardView, 'options' | 'recommendation'>): DecisionOption | null {
  const rec = card.recommendation ? card.options.find((o) => o.id === card.recommendation!.optionId) : undefined;
  return (
    rec ??
    card.options.find((o) => APPROVE_IDS.has(o.id.toLowerCase())) ??
    card.options.find((o) => APPROVE_LABEL.test(o.label)) ??
    null
  );
}

/** The option an inline Deny applies, only when the card has an explicit refusal distinct from Approve. */
export function denyOption(card: Pick<DecisionCardView, 'options' | 'recommendation'>): DecisionOption | null {
  const approve = approveOption(card);
  const deny =
    card.options.find((o) => DENY_IDS.has(o.id.toLowerCase())) ?? card.options.find((o) => DENY_LABEL.test(o.label));
  return deny && deny.id !== approve?.id ? deny : null;
}

/** Why the signed-in user cannot resolve a card, in words. */
export function decisionBlockText(reason: DecisionBlockReason | string | null): string {
  switch (reason) {
    case 'role':
      return 'Needs the Approver role';
    case 'separation_of_duties':
      return 'You raised this request, so someone else must decide it';
    case 'not_eligible':
      return 'You are not an eligible approver for this decision';
    case 'not_open':
      return 'This decision is already closed';
    case 'inactive':
      return 'Your account is inactive';
    default:
      return 'You cannot resolve this decision';
  }
}

/** Last-12-hour totals behind the flow chart. */
export function flowTotals(rows: TowerFlow['tasksPerHour']): { verified: number; flagged: number } {
  let verified = 0;
  let flagged = 0;
  for (const r of rows) {
    verified += r.verified;
    flagged += r.flagged;
  }
  return { verified, flagged };
}

/** Relative change of verified flow against its same-time-of-day baseline; null without a baseline. */
export function flowDeltaRatio(today: number, baseline: number): number | null {
  return baseline > 0 ? (today - baseline) / baseline : null;
}

/**
 * Two-digit hour for an x-axis label. The daemon sends each hour as a local ISO time with its offset
 * (`2026-10-09T13:00:00+08:00`): the wall-clock hour in the deployment's time zone is the label, wherever the
 * viewer is. A UTC (`Z`) instant is shown in the viewer's zone; a bare "13" / "13:00" as given.
 */
export function hourLabel(hour: string): string {
  const trimmed = hour.trim();
  const plain = /^(\d{1,2})(?::\d{2})?$/.exec(trimmed);
  if (plain) return plain[1]!.padStart(2, '0');
  const withOffset = /^\d{4}-\d{2}-\d{2}T(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?[+-]\d{2}:?\d{2}$/.exec(trimmed);
  if (withOffset) return withOffset[1]!;
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    const t = Date.parse(trimmed);
    if (Number.isFinite(t)) return String(new Date(t).getHours()).padStart(2, '0');
  }
  return trimmed;
}

/** A round axis top ≥ `value` that splits into `ticks` whole steps (1, 2, 5 × 10ⁿ). */
export function niceCeil(value: number, ticks = 3): number {
  if (!(value > 0)) return ticks;
  const raw = value / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw - 1e-9) ?? 10 * mag;
  return Number((step * ticks).toPrecision(12));
}

export interface FunnelSplit {
  open: TowerFlow['ticketFunnel'];
  terminal: TowerFlow['ticketFunnel'];
  openTotal: number;
  /** Stage flagged by the server; the page never re-derives it. */
  bottleneck: TicketStage | null;
}

export function splitFunnel(funnel: TowerFlow['ticketFunnel']): FunnelSplit {
  const open = funnel.filter((s) => !TERMINAL_STAGES.has(s.stage));
  const terminal = funnel.filter((s) => TERMINAL_STAGES.has(s.stage));
  return {
    open,
    terminal,
    openTotal: open.reduce((n, s) => n + s.count, 0),
    bottleneck: open.find((s) => s.bottleneck)?.stage ?? null,
  };
}

/** Stage holding the oldest open ticket (for "oldest 3d 2h in UAT"). */
export function oldestTicketStage(funnel: TowerFlow['ticketFunnel']): TicketStage | null {
  let best: { stage: TicketStage; at: number } | null = null;
  for (const s of funnel) {
    if (TERMINAL_STAGES.has(s.stage) || !s.oldestSince) continue;
    const at = Date.parse(s.oldestSince);
    if (Number.isFinite(at) && (!best || at < best.at)) best = { stage: s.stage, at };
  }
  return best?.stage ?? null;
}

export interface LatencyMarks {
  /** Positions on a 0 → 2×SLA track, as percentages (SLA sits at 50%). */
  p50Pct: number | null;
  p90Pct: number | null;
  /** p90 beyond 2×SLA: the whisker is clipped and marked "off scale". */
  offScale: boolean;
}

/** Each decision kind is scaled to its own SLA, so every SLA line sits in the same place. */
export function latencyMarks(row: { p50Ms: number | null; p90Ms: number | null; slaMs: number }): LatencyMarks {
  const span = row.slaMs > 0 ? row.slaMs * 2 : null;
  const pct = (ms: number | null) =>
    ms === null || span === null ? null : Math.max(0, Math.min(100, (ms / span) * 100));
  return {
    p50Pct: pct(row.p50Ms),
    p90Pct: pct(row.p90Ms),
    offScale: span !== null && row.p90Ms !== null && row.p90Ms > span,
  };
}

/** Radar scale: value indexed to its baseline on 0–3×; the baseline sits at a third. */
const RADAR_MAX_RATIO = 3;

export interface RadarMarks {
  /** value ÷ baseline, when the baseline is a usable (positive) number. */
  ratio: number | null;
  /** Bar length on the 0–3× track (0–100), or null when nothing can be drawn honestly. */
  barPct: number | null;
  /** Beyond 3× — or any value above a zero baseline — drawn full with an arrowhead. */
  over: boolean;
  /** Draw the baseline marker (only meaningful against a positive baseline). */
  showBaseline: boolean;
  note: 'no_baseline' | 'zero_baseline' | null;
}

export function radarMarks(a: Pick<TowerAnomaly, 'value' | 'baseline'>): RadarMarks {
  if (a.baseline === null) return { ratio: null, barPct: null, over: false, showBaseline: false, note: 'no_baseline' };
  if (a.baseline <= 0) {
    return a.value > 0
      ? { ratio: null, barPct: 100, over: true, showBaseline: false, note: 'zero_baseline' }
      : { ratio: null, barPct: null, over: false, showBaseline: false, note: null };
  }
  const ratio = a.value / a.baseline;
  return {
    ratio,
    barPct: Math.max(0, Math.min(1, ratio / RADAR_MAX_RATIO)) * 100,
    over: ratio > RADAR_MAX_RATIO,
    showBaseline: true,
    note: null,
  };
}

/** `process_type:feature-build` → "feature-build" (a process type). Scopes are never a person (R11). */
export function scopeLabel(scope: string): { text: string; kind: string | null } {
  const m = /^([a-z_]+):(.+)$/.exec(scope.trim());
  return m ? { text: m[2]!, kind: humanize(m[1]!).toLowerCase() } : { text: scope, kind: null };
}

function trimmed(n: number, decimals: number): string {
  return Number(n.toFixed(decimals)).toLocaleString('en-US', { maximumFractionDigits: decimals });
}

/** Percentages below 10 keep one decimal (8.7%), larger ones are whole (31%); counts stay as counted. */
export function formatSignalValue(value: number, unit: TowerAnomaly['unit']): string {
  if (!Number.isFinite(value)) return '—';
  if (unit === '%') return `${trimmed(value, Math.abs(value) < 10 ? 1 : 0)}%`;
  if (unit === 'ratio') return trimmed(value, 2);
  return trimmed(value, Math.abs(value) < 10 ? 1 : 0);
}

export function formatRatio(ratio: number): string {
  return `${ratio.toFixed(1)}×`;
}

/** Stable display order for the signals; unknown signals keep their server order after them. */
export function orderAnomalies(rows: readonly TowerAnomaly[], order: readonly AnomalySignal[]): TowerAnomaly[] {
  const idx = (s: string) => {
    const i = (order as readonly string[]).indexOf(s);
    return i === -1 ? order.length : i;
  };
  return rows.map((r, i) => ({ r, i })).sort((a, b) => idx(a.r.signal) - idx(b.r.signal) || a.i - b.i).map((x) => x.r);
}

/** Ordinal grey ramp for the model mix: darkest = highest tier (the mock's legend). */
const TIER_ORDER = ['opus', 'sonnet', 'haiku'];

export function orderModelMix(mix: TowerSpend['modelMix']): TowerSpend['modelMix'] {
  const rank = (tier: string) => {
    const i = TIER_ORDER.findIndex((t) => tier.toLowerCase().includes(t));
    return i === -1 ? TIER_ORDER.length : i;
  };
  return [...mix].sort((a, b) => rank(a.tier) - rank(b.tier) || b.usdToday - a.usdToday);
}

export function tierLabel(tier: string): string {
  const known = TIER_ORDER.find((t) => tier.toLowerCase().includes(t));
  return known ? known[0]!.toUpperCase() + known.slice(1) : humanize(tier);
}

/** Share text that never rounds a real amount to "0%". */
export function shareText(pct: number): string {
  if (!Number.isFinite(pct)) return '—';
  if (pct > 0 && pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
}

const DAY_MS = 86_400_000;

/** Last instant of the calendar month containing `now` (credit allocations are monthly), local time. */
export function periodEndOf(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() - 1;
}

function endOfDay(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1;
}

export type CapOutlookKind = 'today' | 'before_end' | 'lasts';

export interface CapOutlook {
  kind: CapOutlookKind;
  /** Projected cap instant, when the server gave one. */
  at: number | null;
  /** Bar length on the runway track (0–100). */
  barPct: number;
  /** Period-end marker position on the same track (0–100). */
  endPct: number;
}

/**
 * Credit runway: a bar from today to the projected cap on a track that runs a little past the period end, so
 * "caps before the period ends" reads as a bar stopping short of the marker.
 */
export function capOutlook(projectedCapAt: string | null, now: number, periodEnd: number): CapOutlook {
  const window = Math.max(DAY_MS, (periodEnd - now) * 1.18);
  const endPct = Math.max(0, Math.min(100, ((periodEnd - now) / window) * 100));
  const at = projectedCapAt === null ? null : Date.parse(projectedCapAt);
  if (at === null || !Number.isFinite(at)) return { kind: 'lasts', at: null, barPct: 100, endPct };
  const barPct = Math.max(0, Math.min(100, ((at - now) / window) * 100));
  const kind: CapOutlookKind = at <= endOfDay(now) ? 'today' : at <= periodEnd ? 'before_end' : 'lasts';
  return { kind, at, barPct: kind === 'lasts' ? 100 : barPct, endPct };
}

/** Bullet bar scale: one round step above both today's value and its comparison marker. */
export function bulletScale(value: number, marker: number): number {
  return niceCeil(Math.max(value, marker) * 1.25, 1);
}

/** Post-incident change records are due 24h after a break-glass promotion (§8). */
const POST_INCIDENT_WINDOW_MS = 24 * 3600_000;

export function breakglassDueIn(since: string, now: number): number {
  return Date.parse(since) + POST_INCIDENT_WINDOW_MS - now;
}

/** The nightly off-host anchor is late once the newest one is older than this (§13, R2). */
export const ANCHOR_WARN_MS = 26 * 3600_000;

/** Anchor age from its timestamp when known (ticks with the clock), else the server's figure. */
export function anchorAge(lastAnchorAt: string | null, anchorAgeMs: number | null, now: number): number | null {
  const t = lastAnchorAt === null ? Number.NaN : Date.parse(lastAnchorAt);
  return Number.isFinite(t) ? Math.max(0, now - t) : anchorAgeMs;
}

/** `17.8`, `18`: one decimal only when it carries information. */
export function formatBaseline(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** The row action as served, plus the recommended option the backend is adding (optional until it lands). */
type ActionWithRecommendation = TowerAttentionItem['action'] & { recommendedOptionId?: string | null };

export function recommendedOptionIdOf(item: TowerAttentionItem): string | null {
  const id = (item.action as ActionWithRecommendation).recommendedOptionId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** Decisions open on the Decisions page with the card selected (`?focus=`; it runs the passkey ceremony). */
export function decisionHref(decisionId: string): string {
  return `/decisions?focus=${encodeURIComponent(decisionId)}`;
}

/** Where a row's title leads: the decision card for decision rows, otherwise the subject the server names. */
export function subjectHref(item: TowerAttentionItem): string {
  return item.action.decisionId ? decisionHref(item.action.decisionId) : item.action.href;
}

/**
 * What an inline Approve applies: the option the server recommends when it names one, else the card's rule
 * (`approveOption`). Without the card only a server-named option can be applied (its label is then unknown).
 */
export function approveTarget(
  item: TowerAttentionItem,
  card: Pick<DecisionCardView, 'options' | 'recommendation'> | null,
): { id: string; label: string | null } | null {
  const rec = recommendedOptionIdOf(item);
  if (card) {
    const option = (rec ? card.options.find((o) => o.id === rec) : undefined) ?? approveOption(card);
    return option ? { id: option.id, label: option.label } : null;
  }
  return rec ? { id: rec, label: null } : null;
}
