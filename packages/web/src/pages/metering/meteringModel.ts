/**
 * Pure view-model rules for Metering (§10): notional cost, FX stamps, unpriced usage, token types, throttle and
 * the migration range. Nothing here reads the clock or the network.
 */
import type {
  FxRateDTO,
  FxStatusDTO,
  MeteringCostRow,
  MeteringDailyDTO,
  MeteringDayDTO,
  MeteringFxStamp,
  MigrationRecommendationDTO,
} from '@aoc/contracts';
import { formatShortDate, formatUsd } from '../../lib/format';

export const RANGE_OPTIONS = [
  { value: '7', label: '7 days' },
  { value: '14', label: '14 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
] as const;
export type RangeValue = (typeof RANGE_OPTIONS)[number]['value'];

/** Calendar day `YYYY-MM-DD` shifted by `days`. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Inclusive `days`-long range ending on the daemon's `today` (never the browser's clock). */
export function rangeFor(today: string, days: number): { from: string; to: string } {
  return { from: addDays(today, -(days - 1)), to: today };
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** `Fri Oct 9` for a calendar day (no timezone shift). */
export function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${formatShortDate(date)}`;
}

/** A day's FX stamp in words: "live", "inherited from Oct 2", "missing". */
export function fxStampText(fx: MeteringFxStamp): string {
  if (fx.status === 'missing' || fx.rate === null) return 'missing';
  if (fx.status === 'live') return 'live';
  return fx.sourceDate ? `inherited from ${formatShortDate(fx.sourceDate)}` : 'inherited';
}

/** Days of the range that metering covered (before the first metered day there is nothing to show). */
export function meteredDays(daily: MeteringDailyDTO): MeteringDayDTO[] {
  return daily.days.filter((d) => d.status !== 'unmetered');
}

export interface UnpricedSummary {
  tokens: number;
  /** Share of all tokens in the range. */
  share: number;
  models: string[];
  days: string[];
}

/** Usage that matched no rate (counted at US$0) — it never becomes priced on closed days (R12). */
export function unpricedSummary(daily: MeteringDailyDTO): UnpricedSummary | null {
  const t = daily.totals;
  if (!t.unpriced || t.unpricedTokens <= 0) return null;
  return {
    tokens: t.unpricedTokens,
    share: t.totalTokens > 0 ? t.unpricedTokens / t.totalTokens : 0,
    models: [...t.unpricedModels].sort(),
    days: daily.days.filter((d) => d.unpriced).map((d) => d.date),
  };
}

/** "Sep 25–30" for consecutive days, else a comma list of runs. */
export function dayRanges(days: readonly string[]): string {
  if (days.length === 0) return '';
  const sorted = [...days].sort();
  const runs: [string, string][] = [];
  for (const d of sorted) {
    const last = runs[runs.length - 1];
    if (last && addDays(last[1], 1) === d) last[1] = d;
    else runs.push([d, d]);
  }
  return runs
    .map(([a, b]) =>
      a === b ? formatShortDate(a) : a.slice(0, 7) === b.slice(0, 7) ? `${formatShortDate(a)}–${Number(b.slice(8))}` : `${formatShortDate(a)}–${formatShortDate(b)}`,
    )
    .join(', ');
}

export interface TokenTypeRow {
  id: 'input' | 'output' | 'cacheRead' | 'cacheWrite5m' | 'cacheWrite1h';
  label: string;
  tokens: number;
  share: number;
}

export function tokenTypes(t: MeteringCostRow): TokenTypeRow[] {
  const rows: Omit<TokenTypeRow, 'share'>[] = [
    { id: 'input', label: 'Input', tokens: t.inputTokens },
    { id: 'output', label: 'Output', tokens: t.outputTokens },
    { id: 'cacheRead', label: 'Cache read', tokens: t.cacheReadTokens },
    { id: 'cacheWrite5m', label: 'Cache write · 5 min', tokens: t.cacheWrite5mTokens },
    { id: 'cacheWrite1h', label: 'Cache write · 1 hour', tokens: t.cacheWrite1hTokens },
  ];
  const total = rows.reduce((a, r) => a + r.tokens, 0);
  return rows.map((r) => ({ ...r, share: total > 0 ? r.tokens / total : 0 }));
}

/** Indexes where the rate-card version changes (a new version took effect that day). */
export function rateCardBoundaries(days: readonly MeteringDayDTO[]): { index: number; version: number }[] {
  const out: { index: number; version: number }[] = [];
  days.forEach((d, i) => {
    const prev = days[i - 1];
    if (d.rateCardVersion > 0 && (!prev || prev.rateCardVersion !== d.rateCardVersion))
      out.push({ index: i, version: d.rateCardVersion });
  });
  return out;
}

export type FxPointKind = 'live' | 'carried' | 'flagged' | 'manual';

/** Live, carried forward by design (weekend / holiday), carried forward because something failed, or set by hand. */
export function fxPointKind(r: FxRateDTO): FxPointKind {
  if (r.extractor === 'manual' || r.reason === 'manual_override') return 'manual';
  if (r.status === 'live') return 'live';
  return r.flagged ? 'flagged' : 'carried';
}

const REASON_TEXT: Record<string, string> = {
  fetched: 'fetched and validated',
  weekend_or_holiday: 'weekend or holiday: carried forward by design',
  source_unreadable: 'BNM source unreadable: carried forward',
  validation_failed: 'failed self-validation: carried forward',
  discrepancy_pending: 'discrepancy pending review: carried forward',
  manual_override: 'set by an Approver',
};
export const fxReasonText = (reason: string): string => REASON_TEXT[reason] ?? reason.replace(/_/g, ' ');

const EXTRACTOR_TEXT: Record<string, string> = {
  haiku: 'Haiku',
  sonnet: 'Sonnet (after Haiku failed self-validation)',
  api: 'BNM Open API',
  manual: 'manual entry',
  none: 'not fetched',
};
export const fxExtractorText = (e: string): string => EXTRACTOR_TEXT[e] ?? e;

/**
 * The BNM session a rate came from, as recorded with it ("1700", "12:00 noon"). Labelled from the data, never
 * assumed: null when the record does not say.
 */
export function fxSessionLabel(session: string | null | undefined): string | null {
  const s = session?.trim();
  if (!s) return null;
  return /^\d{4}$/.test(s) ? `session ${s}` : s.slice(0, 40);
}

export interface CarryForwardState {
  level: 'none' | 'watch' | 'alert';
  days: number;
  since: string | null;
  threshold: number;
}

/** Consecutive carried-forward weekdays against the manual-check threshold. */
export function carryForwardState(status: FxStatusDTO): CarryForwardState {
  const { days, since, alertAfterDays } = status.carryForward;
  return {
    level: days === 0 ? 'none' : days >= alertAfterDays ? 'alert' : 'watch',
    days,
    since,
    threshold: alertAfterDays,
  };
}

/** A shared axis for the migration range that always includes zero (benefit vs cost reads off one line). */
export function migrationAxis(m: MigrationRecommendationDTO): { min: number; max: number } {
  const v = (['low', 'base', 'high'] as const).map((k) => m.range[k].netMonthlyBenefitUsd);
  const lo = Math.min(0, ...v);
  const hi = Math.max(0, ...v);
  const pad = (hi - lo || 1) * 0.08;
  return { min: lo - (lo < 0 ? pad : 0), max: hi + (hi > 0 ? pad : 0) };
}

export const VERDICT_TEXT: Record<MigrationRecommendationDTO['verdict'], string> = {
  enterprise_favoured_across_range: 'Enterprise is cheaper across the whole range',
  current_plan_favoured_across_range: 'The current plan is cheaper across the whole range',
  depends_on_assumptions: 'It depends on the assumptions: the range crosses zero',
};

/** An axis tick in US$: whole dollars when round or large, else cents. */
export const axisUsd = (v: number): string => formatUsd(v, { decimals: Number.isInteger(v) || v >= 100 ? 0 : 2 });

/** A round axis top and step (at most four steps) for values up to `max`: 22.9 → 0…30 in tens. */
export function niceAxis(max: number): { top: number; step: number } {
  if (!(max > 0)) return { top: 1, step: 0.5 };
  const exp = 10 ** Math.floor(Math.log10(max));
  const step = [0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10].map((s) => s * exp).find((s) => max / s <= 4) ?? 10 * exp;
  return { top: Math.ceil(max / step - 1e-9) * step, step };
}

/** Hours with one decimal ("0.4 h"), minutes below an hour ("23 min"). */
export function formatIdle(ms: number): string {
  if (!(ms > 0)) return '0 min';
  const min = ms / 60_000;
  if (min < 60) return `${Math.round(min)} min`;
  // Round in tenths of an hour: (117 / 60).toFixed(1) would read 1.9 h through binary rounding.
  return `${(Math.round(min / 6) / 10).toFixed(1)} h`;
}
