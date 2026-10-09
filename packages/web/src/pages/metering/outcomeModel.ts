/**
 * Pure rules behind the Cost per outcome panel (§14.4): spend tied to the ticket fixed, the change shipped and the
 * phase completed. A portfolio lens only: nothing here knows a person, and nothing ranks outcomes by cost. Types
 * only from `@aoc/contracts`. Every figure, US$ and RM, is the daemon's (notional, never a bill; RM converted per
 * usage day at that day's stamped rate): this file only picks, groups and adds up those figures, it never converts.
 */
import type {
  CostPerOutcomeDTO,
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
  /** Outcomes with usage on a day that had no stamped FX rate: their RM is left out of the kind's RM figures. */
  rmIncomplete: number;
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
      rmIncomplete: cls.items.filter((i) => !i.rmComplete).length,
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

/** The daemon's RM as text, the same way. */
export function outcomeMyr(rm: number): string {
  return rm > 0 && rm < 0.005 ? `<${formatMyr(0.01)}` : formatMyr(rm);
}

/** Linear interpolation between closest ranks (type 7), as the daemon computes the median and p90. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = (sorted.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

type Costed = Pick<OutcomeCostItemDTO, 'notionalUsd' | 'notionalRm' | 'rmComplete'>;

function spread(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, v) => sum + v, 0);
  return {
    total,
    mean: sorted.length ? total / sorted.length : null,
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null,
  };
}

/**
 * The figures of some outcomes of a kind, worked out the way the daemon does it over all of them: US$ over every
 * outcome, RM over those whose RM is complete only. Adds up and orders the daemon's own per-outcome figures.
 */
export function statsOf(items: readonly Costed[]): OutcomeCostStatsDTO {
  const rmValues = items.flatMap((i) => (i.rmComplete && i.notionalRm !== null ? [i.notionalRm] : []));
  const usd = spread(items.map((i) => i.notionalUsd));
  const rm = spread(rmValues);
  return {
    count: items.length,
    totalUsd: usd.total,
    meanUsd: usd.mean,
    medianUsd: usd.median,
    p90Usd: usd.p90,
    minUsd: usd.min,
    maxUsd: usd.max,
    totalRm: rmValues.length ? rm.total : null,
    meanRm: rm.mean,
    medianRm: rm.median,
    p90Rm: rm.p90,
    minRm: rm.min,
    maxRm: rm.max,
    rmComplete: rmValues.length === items.length,
  };
}

export interface ProcessTypeCount {
  processType: string;
  /** Outcomes of every kind whose spend is mostly this process type. */
  count: number;
}

/** The process types the outcomes name, in name order (never by cost). Outcomes with no single type are in none. */
export function processTypes(dto: CostPerOutcomeDTO): ProcessTypeCount[] {
  const counts = new Map<string, number>();
  for (const k of OUTCOME_KINDS)
    for (const { processType } of dto[k.key].items)
      if (processType !== null) counts.set(processType, (counts.get(processType) ?? 0) + 1);
  return [...counts]
    .map(([processType, count]) => ({ processType, count }))
    .sort((a, b) => a.processType.localeCompare(b.processType));
}

/**
 * The process type to filter by: the chosen one while it is still on offer. The chips exist only when two or more
 * types are present, and a chosen type can drop out of the data (a new range, a refetch).
 */
export function activeProcessType(picked: string | null, types: readonly ProcessTypeCount[]): string | null {
  return types.length > 1 && types.some((t) => t.processType === picked) ? picked : null;
}

/** The outcomes of one process type with each kind's figures worked out from them; `dto` itself when none is chosen. */
export function withProcessType(dto: CostPerOutcomeDTO, processType: string | null): CostPerOutcomeDTO {
  if (processType === null) return dto;
  const only = (cls: OutcomeCostClassDTO): OutcomeCostClassDTO => {
    const items = cls.items.filter((i) => i.processType === processType);
    return { ...cls, items, stats: statsOf(items) };
  };
  return {
    ...dto,
    ticketsFixed: only(dto.ticketsFixed),
    changesShipped: only(dto.changesShipped),
    phasesCompleted: only(dto.phasesCompleted),
  };
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

export interface ProjectOutcomes {
  /** Null: outcomes whose sessions spanned several projects (or none). */
  projectId: string | null;
  name: string;
  byKind: Record<OutcomeClassKey, OutcomeCostStatsDTO>;
  /** Every kind together; its count and totals are the ones shown. */
  total: OutcomeCostStatsDTO;
}

const NO_PROJECT = 'Several projects';

/**
 * Outcomes grouped by project, in name order (never by cost: ranking corrupts behaviour toward cheap, easy wins).
 * Figures use the daemon's method, so a project with one kind of outcome matches that kind's own figure.
 */
export function byProject(
  dto: CostPerOutcomeDTO,
  nameOf: (projectId: string) => string | null,
): ProjectOutcomes[] {
  const groups = new Map<string | null, Record<OutcomeClassKey, OutcomeCostItemDTO[]>>();
  for (const k of OUTCOME_KINDS)
    for (const item of dto[k.key].items) {
      const g = groups.get(item.projectId) ?? { ticketsFixed: [], changesShipped: [], phasesCompleted: [] };
      g[k.key].push(item);
      groups.set(item.projectId, g);
    }
  const rows = [...groups].map(
    ([projectId, items]): ProjectOutcomes => ({
      projectId,
      name: projectId === null ? NO_PROJECT : (nameOf(projectId) ?? projectId),
      byKind: Object.fromEntries(
        OUTCOME_KINDS.map((k): [OutcomeClassKey, OutcomeCostStatsDTO] => [k.key, statsOf(items[k.key])]),
      ) as Record<OutcomeClassKey, OutcomeCostStatsDTO>,
      total: statsOf(Object.values(items).flat()),
    }),
  );
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

function span(lo: number | null, hi: number | null, text: (n: number) => string): string | null {
  if (lo === null || hi === null) return null;
  return lo === hi ? text(lo) : `${text(lo)} – ${text(hi)}`;
}

/** Lowest to highest cost of a kind; one figure when there is only one cost. */
export function rangeText(s: Pick<OutcomeCostStatsDTO, 'minUsd' | 'maxUsd'>): string {
  return span(s.minUsd, s.maxUsd, outcomeUsd) ?? '—';
}

/** The same in ringgit; null when no outcome of the kind has a complete RM. */
export function rangeMyrText(s: Pick<OutcomeCostStatsDTO, 'minRm' | 'maxRm'>): string | null {
  return span(s.minRm, s.maxRm, outcomeMyr);
}

/** Why `left` of `of` outcomes are missing from the RM figures: said the same way in the rows and the footnote. */
export function rmIncompleteText(left: number, of: number): string {
  const [has, are] = left === 1 ? ['has', 'is'] : ['have', 'are'];
  return `${left} of ${of} ${has} usage on a day with no stamped FX rate, so ${are} left out of the RM figures`;
}
