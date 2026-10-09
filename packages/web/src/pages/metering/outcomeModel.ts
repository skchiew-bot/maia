/**
 * Pure rules behind the Cost per outcome panel (§14.4): spend tied to the ticket fixed, the change shipped and the
 * phase completed. A portfolio lens only: nothing here knows a person, and nothing ranks outcomes by cost. Types
 * only from `@aoc/contracts`; the figures are the daemon's notional US$ (never a bill).
 */
import type {
  CostPerOutcomeDTO,
  MeteringCostRow,
  OutcomeCostClassDTO,
  OutcomeCostItemDTO,
  OutcomeCostStatsDTO,
} from '@aoc/contracts';
import { formatMyr, formatUsd } from '../../lib/format';
import { niceAxis } from './meteringModel';

export type OutcomeClassKey = 'ticketsFixed' | 'changesShipped' | 'phasesCompleted';
export type OutcomeKind = OutcomeCostClassDTO['kind'];

export interface OutcomeKindInfo {
  key: OutcomeClassKey;
  kind: OutcomeKind;
  /** The chart row: "Tickets fixed". */
  label: string;
  /** One outcome in a list: "Ticket fixed". */
  one: string;
  /** What an empty row says. */
  none: string;
}

/** The three outcome kinds, in the order the chart and the tables list them. */
export const OUTCOME_KINDS: readonly OutcomeKindInfo[] = [
  {
    key: 'ticketsFixed',
    kind: 'ticket_fixed',
    label: 'Tickets fixed',
    one: 'Ticket fixed',
    none: 'No ticket was closed as fixed in this range.',
  },
  {
    key: 'changesShipped',
    kind: 'change_shipped',
    label: 'Changes shipped',
    one: 'Change shipped',
    none: 'No change request completed in this range.',
  },
  {
    key: 'phasesCompleted',
    kind: 'phase_completed',
    label: 'Phases completed',
    one: 'Phase completed',
    none: 'No project phase completed in this range.',
  },
];

export interface OutcomeClassView {
  info: OutcomeKindInfo;
  stats: OutcomeCostStatsDTO;
  items: readonly OutcomeCostItemDTO[];
  /** Outcomes whose spend includes usage no rate priced (counted at US$0, so the cost is understated). */
  unpriced: number;
}

/** The kinds with their figures, in display order. */
export function outcomeClasses(dto: CostPerOutcomeDTO): OutcomeClassView[] {
  return OUTCOME_KINDS.map((info) => {
    const cls = dto[info.key];
    return {
      info,
      stats: cls.stats,
      items: cls.items,
      unpriced: cls.items.filter((i) => i.unpriced).length,
    };
  });
}

/** Nothing completed in the range, of any kind. */
export function noOutcomes(dto: CostPerOutcomeDTO): boolean {
  return OUTCOME_KINDS.every((k) => dto[k.key].stats.count === 0);
}

/** Notional US$ as text; a cost under half a cent says so instead of reading as zero. */
export function outcomeUsd(usd: number): string {
  return usd > 0 && usd < 0.005 ? '<US$0.01' : formatUsd(usd);
}

/** Ringgit alongside, `≈` because the daemon prices outcomes in US$ only (see `blendedRate`). */
export function outcomeRm(usd: number, rate: number | null): string | null {
  if (rate === null) return null;
  const rm = usd * rate;
  return `≈ ${rm > 0 && rm < 0.005 ? '<RM 0.01' : formatMyr(rm)}`;
}

export interface RateBasis {
  /** RM per US$. */
  rate: number;
  /** The rollup figures it comes from, printed with it so the rate can be checked. */
  usd: number;
  rm: number;
}

/**
 * RM per US$ for the range, from the daemon's own rollups: the days' RM (each at its stamped BNM rate) over their
 * US$. Outcome costs come from the API in US$ only, so their RM is this blend: indicative, and exact for the whole
 * portfolio (total × blend = the rollups' RM). Null when some day with usage had no rate, or nothing was metered.
 * Never today's rate alone (the approved FX rule: closed days keep the rate they were stamped with).
 */
export function blendedRate(
  totals: Pick<MeteringCostRow, 'notionalUsd' | 'notionalRm' | 'rmComplete'> | undefined,
): RateBasis | null {
  if (!totals || !totals.rmComplete || totals.notionalRm === null || !(totals.notionalUsd > 0)) return null;
  return { rate: totals.notionalRm / totals.notionalUsd, usd: totals.notionalUsd, rm: totals.notionalRm };
}

/** Linear interpolation between closest ranks (type 7), as the daemon computes the median and p90. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = (sorted.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

export interface OutcomeAxis {
  /** Right end of the scale (the largest cost of any kind, rounded up to a tick). */
  top: number;
  ticks: number[];
}

/** One scale for all three kinds, so a phase and a ticket are comparable at a glance. */
export function outcomeAxis(dto: CostPerOutcomeDTO): OutcomeAxis {
  const max = Math.max(0, ...OUTCOME_KINDS.map((k) => dto[k.key].stats.maxUsd ?? 0));
  const { top, step } = niceAxis(max);
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Number(v.toPrecision(10)));
  return { top, ticks };
}

/** Position on the axis as a percentage of its width. */
export function axisPct(usd: number, top: number): number {
  return Math.min(100, Math.max(0, (usd / (top || 1)) * 100));
}

/** The page an outcome opens: the ticket, the change record, or the phase on its project's master timeline. */
export function outcomeHref(kind: OutcomeKind, item: Pick<OutcomeCostItemDTO, 'refId' | 'projectId'>): string {
  switch (kind) {
    case 'ticket_fixed':
      return `/tickets/${encodeURIComponent(item.refId)}`;
    case 'change_shipped':
      return `/changes/${encodeURIComponent(item.refId)}`;
    case 'phase_completed': {
      const [projectId, ...rest] = item.refId.split('/');
      return `/projects/${encodeURIComponent(item.projectId ?? projectId!)}#prj-mt-phase-${rest.join('/')}`;
    }
  }
}

/** A phase's name: the `refId` is `projectId/phaseId`. */
export function phaseIdOf(item: Pick<OutcomeCostItemDTO, 'refId'>): string {
  return item.refId.slice(item.refId.indexOf('/') + 1);
}

export interface KindFigures {
  count: number;
  medianUsd: number | null;
  totalUsd: number;
}

export interface ProjectOutcomes {
  /** Null: outcomes whose sessions spanned several projects (or none). */
  projectId: string | null;
  name: string;
  byKind: Record<OutcomeClassKey, KindFigures>;
  count: number;
  totalUsd: number;
}

const NO_PROJECT = 'Several projects';

/**
 * Outcomes grouped by project, in name order (never by cost: ranking corrupts behaviour toward cheap, easy wins).
 * Medians use the daemon's method, so a project with one kind of outcome matches that kind's own figure.
 */
export function byProject(
  dto: CostPerOutcomeDTO,
  nameOf: (projectId: string) => string | null,
): ProjectOutcomes[] {
  const groups = new Map<string | null, Record<OutcomeClassKey, number[]>>();
  for (const k of OUTCOME_KINDS)
    for (const item of dto[k.key].items) {
      const g = groups.get(item.projectId) ?? { ticketsFixed: [], changesShipped: [], phasesCompleted: [] };
      g[k.key].push(item.notionalUsd);
      groups.set(item.projectId, g);
    }
  const rows = [...groups].map(([projectId, costs]): ProjectOutcomes => {
    const byKind = Object.fromEntries(
      OUTCOME_KINDS.map((k): [OutcomeClassKey, KindFigures] => {
        const sorted = [...costs[k.key]].sort((a, b) => a - b);
        return [
          k.key,
          { count: sorted.length, medianUsd: percentile(sorted, 0.5), totalUsd: sorted.reduce((s, c) => s + c, 0) },
        ];
      }),
    ) as Record<OutcomeClassKey, KindFigures>;
    const all = Object.values(byKind);
    return {
      projectId,
      name: projectId === null ? NO_PROJECT : (nameOf(projectId) ?? projectId),
      byKind,
      count: all.reduce((s, f) => s + f.count, 0),
      totalUsd: all.reduce((s, f) => s + f.totalUsd, 0),
    };
  });
  return rows.sort(
    (a, b) => Number(a.projectId === null) - Number(b.projectId === null) || a.name.localeCompare(b.name),
  );
}

export interface OutcomeRow {
  key: string;
  info: OutcomeKindInfo;
  item: OutcomeCostItemDTO;
  href: string;
}

/** Every outcome of every kind, newest first: ordered by completion, never by cost (the daemon's own rule). */
export function outcomeRows(dto: CostPerOutcomeDTO): OutcomeRow[] {
  return OUTCOME_KINDS.flatMap((info) =>
    dto[info.key].items.map((item) => ({
      key: `${info.kind}:${item.refId}`,
      info,
      item,
      href: outcomeHref(info.kind, item),
    })),
  ).sort((a, b) => Date.parse(b.item.completedAt) - Date.parse(a.item.completedAt));
}

/** `2 outcomes`, `1 outcome`. */
export const outcomeCount = (n: number): string => `${n} outcome${n === 1 ? '' : 's'}`;

/** Lowest to highest cost of a kind; one figure when there is only one cost. */
export function rangeText(s: Pick<OutcomeCostStatsDTO, 'minUsd' | 'maxUsd'>): string {
  if (s.minUsd === null || s.maxUsd === null) return '—';
  return s.minUsd === s.maxUsd ? outcomeUsd(s.minUsd) : `${outcomeUsd(s.minUsd)} – ${outcomeUsd(s.maxUsd)}`;
}
