import type {
  AmendmentDTO,
  DecisionCardView,
  ManifestPhaseDTO,
  ManifestTaskDTO,
  MeteringSummaryRow,
  RateCardRate,
  SessionActivityDTO,
  SessionTimeline,
} from '@aoc/contracts';
import type { PhaseProgress } from '../../charts/types';

/**
 * Session view model (pure). Turns the ledger timeline, the activity read model and the decision cards into
 * what the hero draws. Every instant is clamped into the session's window: marks never fall off the strip.
 */

export type HeroMarkKind = 'drift' | 'rollback' | 'enhancement' | 'amendment' | 'phase' | 'flag';

export interface HeroPhase {
  id: string;
  /** "P2" — position in the plan. */
  code: string;
  name: string;
  start: number;
  end: number;
  active: boolean;
}

export interface HeroDecision {
  id: string;
  at: number;
  /** When it was answered (or withdrawn); null while still open — the wait line then runs to the end. */
  closedAt: number | null;
  title: string;
  test: string | null;
  outcome: string | null;
}

export interface HeroMark {
  id: string;
  kind: HeroMarkKind;
  at: number;
  label: string;
  detail?: string;
}

export interface HeroThrottle {
  start: number;
  end: number;
  open: boolean;
  resetAt: number | null;
}

export interface HeroStats {
  elapsedMs: number;
  toolCalls: number;
  activeMinutes: number;
  peak: { count: number; at: number } | null;
  decisions: number;
  openDecisions: number;
  decisionWaitMs: number;
  drift: number;
  rollbacks: number;
  throttledMs: number;
}

export interface HeroModel {
  start: number;
  /** Right edge: the end of the session, or the daemon's "now" while it runs. */
  end: number;
  ended: boolean;
  phases: HeroPhase[];
  minutes: { at: number; count: number }[];
  decisions: HeroDecision[];
  marks: HeroMark[];
  throttles: HeroThrottle[];
  stats: HeroStats;
}

const DRIFT_WORD: Record<string, string> = {
  off_plan_change: 'Change outside the plan',
  playbook_deviation: 'Playbook deviation',
  scope_growth: 'Scope growth',
  overrun: 'Task overrun',
};

export function driftWord(kind: string): string {
  return DRIFT_WORD[kind] ?? kind.replace(/_/g, ' ');
}

const parse = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

export function buildHero(
  timeline: SessionTimeline,
  activity: SessionActivityDTO | undefined,
  decisions: readonly DecisionCardView[] | undefined,
): HeroModel {
  const start = parse(timeline.startAt) ?? Date.now();
  const ended = timeline.endAt !== null;
  const end = Math.max(start + 60_000, parse(timeline.endAt) ?? parse(timeline.now) ?? start + 60_000);
  const clamp = (t: number) => Math.min(end, Math.max(start, t));

  // Phase bands, in plan order; an open band ends where the next one starts (or at the right edge).
  const order = new Map(timeline.manifest.map((p) => [p.phaseId, p.order]));
  const bands = [...timeline.phases].sort(
    (a, b) => (order.get(a.phaseId) ?? 0) - (order.get(b.phaseId) ?? 0) || a.startAt.localeCompare(b.startAt),
  );
  const phases: HeroPhase[] = bands.map((b, i) => {
    const s = clamp(parse(b.startAt) ?? start);
    const next = bands[i + 1];
    const e = clamp(parse(b.endAt) ?? (next ? (parse(next.startAt) ?? end) : end));
    return {
      id: b.phaseId,
      code: `P${(order.get(b.phaseId) ?? i) + 1}`,
      name: b.name,
      start: s,
      end: Math.max(s, e),
      active: !ended && b.endAt === null && i === bands.length - 1,
    };
  });

  const minutes = (activity?.minutes ?? [])
    .map((m) => ({ at: parse(m.at) ?? 0, count: m.count }))
    .filter((m) => m.at >= start - 60_000 && m.at <= end);

  // Decisions: request and answer times from the ledger marks, words from the decision cards.
  const byId = new Map<string, HeroDecision>();
  for (const m of timeline.marks) {
    if (m.kind !== 'decision' || !m.refId) continue;
    const at = parse(m.at);
    if (at === null) continue;
    const d = byId.get(m.refId) ?? { id: m.refId, at, closedAt: null, title: m.label, test: null, outcome: null };
    if (m.label.startsWith('Resolved: ')) {
      d.closedAt = at;
      d.outcome = m.label.slice('Resolved: '.length);
    } else {
      d.at = at;
      d.title = m.label;
    }
    byId.set(m.refId, d);
  }
  for (const card of decisions ?? []) {
    const at = parse(card.createdAt);
    if (at === null) continue;
    const d = byId.get(card.id) ?? { id: card.id, at, closedAt: null, title: card.title, test: null, outcome: null };
    d.title = card.title;
    d.test = card.test;
    const closed = parse(card.resolution?.resolvedAt) ?? (card.status === 'open' ? null : parse(card.closedAt));
    d.closedAt = closed ?? d.closedAt;
    const option = card.resolution ? card.options.find((o) => o.id === card.resolution!.optionId) : undefined;
    d.outcome = option?.label ?? (card.status === 'open' ? null : card.status === 'resolved' ? d.outcome : card.status);
    byId.set(card.id, d);
  }
  const heroDecisions = [...byId.values()]
    .map((d) => ({ ...d, at: clamp(d.at), closedAt: d.closedAt === null ? null : clamp(d.closedAt) }))
    .sort((a, b) => a.at - b.at);

  const marks: HeroMark[] = [];
  const rollbacks = new Map<string, HeroMark>();
  for (const [i, m] of timeline.marks.entries()) {
    const at = parse(m.at);
    if (at === null) continue;
    const id = `${m.kind}-${m.refId ?? i}-${i}`;
    switch (m.kind) {
      case 'drift':
        marks.push({ id, kind: 'drift', at: clamp(at), label: driftWord(m.label), detail: m.severity ? `${m.severity} severity` : undefined });
        break;
      case 'enhancement':
        marks.push({ id, kind: 'enhancement', at: clamp(at), label: m.label });
        break;
      case 'amendment':
        marks.push({ id, kind: 'amendment', at: clamp(at), label: `Manifest amended (${m.label})` });
        break;
      case 'phase_complete':
        marks.push({ id, kind: 'phase', at: clamp(at), label: `Phase complete: ${m.label}` });
        break;
      case 'task_done':
        if (m.severity) marks.push({ id, kind: 'flag', at: clamp(at), label: `Flagged close: ${m.label.replace(' · ', ', ').replace(/_/g, ' ')}` });
        break;
      case 'rollback': {
        const key = m.refId ?? id;
        const existing = rollbacks.get(key);
        if (existing) existing.detail = `${existing.detail} → ${m.label}`;
        else {
          const mark: HeroMark = { id, kind: 'rollback', at: clamp(at), label: 'Rollback', detail: m.label };
          rollbacks.set(key, mark);
          marks.push(mark);
        }
        break;
      }
      default:
        break;
    }
  }
  marks.sort((a, b) => a.at - b.at);

  const throttles: HeroThrottle[] = (activity?.throttles ?? []).map((t) => {
    const s = clamp(parse(t.startAt) ?? start);
    const e = t.endAt ? clamp(parse(t.endAt) ?? end) : end;
    return { start: s, end: Math.max(s, e), open: t.endAt === null, resetAt: parse(t.resetAt) };
  });

  let peak: HeroStats['peak'] = null;
  for (const m of minutes) if (!peak || m.count > peak.count) peak = { count: m.count, at: m.at };
  const toolCalls = activity?.totalToolCalls ?? timeline.marks.filter((m) => m.kind === 'tool').length;

  return {
    start,
    end,
    ended,
    phases,
    minutes,
    decisions: heroDecisions,
    marks,
    throttles,
    stats: {
      elapsedMs: end - start,
      toolCalls,
      activeMinutes: activity?.minutes.length ?? 0,
      peak,
      decisions: heroDecisions.length,
      openDecisions: heroDecisions.filter((d) => d.closedAt === null).length,
      decisionWaitMs: heroDecisions.reduce((n, d) => n + ((d.closedAt ?? end) - d.at), 0),
      drift: marks.filter((m) => m.kind === 'drift').length,
      rollbacks: rollbacks.size,
      throttledMs: throttles.reduce((n, t) => n + (t.end - t.start), 0),
    },
  };
}

/** Per-phase weighted completion for the stacked bar beneath the hero (§9). */
export function phaseProgress(manifest: readonly ManifestPhaseDTO[]): PhaseProgress[] {
  const sorted = [...manifest].sort((a, b) => a.order - b.order);
  const firstOpen = sorted.findIndex((p) => p.tasks.some((t) => t.status === 'open'));
  return sorted.map((p, i) => {
    const live = p.tasks.filter((t) => t.status !== 'removed');
    const done = live.filter((t) => t.status === 'done');
    return {
      id: p.phaseId,
      label: `P${p.order + 1} ${p.name}`,
      doneWeight: done.reduce((n, t) => n + t.weight, 0),
      declaredWeight: live.reduce((n, t) => n + t.weight, 0),
      doneTasks: done.length,
      declaredTasks: live.length,
      state: live.length > 0 && done.length === live.length ? 'done' : i === firstOpen ? 'active' : 'pending',
    };
  });
}

export type PhaseStatus = 'done' | 'active' | 'pending';

/** Status of a manifest phase for the plan list: done, in progress (the first with open work) or not started. */
export function phaseStatuses(manifest: readonly ManifestPhaseDTO[]): Map<string, PhaseStatus> {
  return new Map(phaseProgress(manifest).map((p) => [p.id, p.state ?? 'pending']));
}

/** Tasks closed with no file-changing tool call, or whose evidence did not verify (§4: flagged, R9). */
export function flaggedTasks(manifest: readonly ManifestPhaseDTO[]): ManifestTaskDTO[] {
  return manifest.flatMap((p) => p.tasks.filter((t) => t.flag !== null));
}

/** "28 → 29 tasks, 76 → 78 weight": how an amendment moved the denominator. */
export function amendmentDelta(a: AmendmentDTO, tasksAfter?: number): string {
  const net = a.added - a.removed;
  const tasks =
    tasksAfter !== undefined && net !== 0 ? `${tasksAfter - net} → ${tasksAfter} tasks, ` : '';
  return `${tasks}weight ${a.prevTotalWeight} → ${a.newTotalWeight}`;
}

export type TokenType = 'input' | 'output' | 'cacheRead' | 'cacheWrite';

export const TOKEN_TYPE_WORD: Record<TokenType, string> = {
  input: 'Input',
  output: 'Output',
  cacheRead: 'Cache read',
  cacheWrite: 'Cache write',
};

/**
 * Where the notional cost comes from, by token type: each model's tokens priced with the rate card, then
 * scaled so the parts add up to the daemon's own total (which was fixed per day at ingestion).
 */
export function costByTokenType(
  rows: readonly MeteringSummaryRow[],
  card: { rates: readonly RateCardRate[]; tierFallback: Partial<Record<string, string>> },
  totalUsd: number,
): { type: TokenType; usd: number }[] | null {
  const parts: Record<TokenType, number> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let priced = 0;
  const rateFor = (model: string): RateCardRate | undefined => {
    const exact = card.rates.find((x) => x.model === model);
    if (exact) return exact;
    const tier = Object.keys(card.tierFallback).find((t) => model.toLowerCase().includes(t));
    const fallback = tier ? card.tierFallback[tier] : undefined;
    return fallback ? card.rates.find((x) => x.model === fallback) : undefined;
  };
  for (const r of rows) {
    const rate = r.key ? rateFor(r.key) : undefined;
    if (!rate) continue;
    parts.input += (r.inputTokens * rate.inputPerMTok) / 1e6;
    parts.output += (r.outputTokens * rate.outputPerMTok) / 1e6;
    parts.cacheRead += (r.cacheReadTokens * rate.cacheReadPerMTok) / 1e6;
    parts.cacheWrite +=
      (r.cacheWrite5mTokens * rate.cacheWrite5mPerMTok + r.cacheWrite1hTokens * rate.cacheWrite1hPerMTok) / 1e6;
  }
  for (const v of Object.values(parts)) priced += v;
  if (priced <= 0 || totalUsd <= 0) return null;
  const scale = totalUsd / priced;
  return (Object.keys(parts) as TokenType[]).map((type) => ({ type, usd: parts[type] * scale }));
}
