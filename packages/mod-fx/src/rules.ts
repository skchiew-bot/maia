/** Pure FX domain rules (§10): calendar, flagging, carry-forward streaks, day-over-day moves, reconciliation. */
import { FX_FLAGGED_REASONS, type FxReason } from '@aoc/contracts';
import { addDays, weekdayOf } from '@aoc/kernel';

export function isWeekend(date: string): boolean {
  const wd = weekdayOf(date);
  return wd === 0 || wd === 6;
}

export function isCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

/** Carried forward because something failed (weekend / holiday gaps are by design and not flagged). */
export function isFlagged(reason: FxReason): boolean {
  return FX_FLAGGED_REASONS.includes(reason);
}

/** The weekday before `date` (Friday for a Monday). */
export function previousWeekday(date: string): string {
  let d = addDays(date, -1);
  while (isWeekend(d)) d = addDays(d, -1);
  return d;
}

/** Weekdays from `from` through `through` (inclusive); `since` is the first of them. Weekends never count. */
export function weekdaysIn(from: string, through: string): { days: number; since: string | null } {
  let days = 0;
  let since: string | null = null;
  for (let d = from; d <= through; d = addDays(d, 1)) {
    if (isWeekend(d)) continue;
    days++;
    since ??= d;
  }
  return { days, since };
}

/** Day-over-day move in percent. */
export function movePct(rate: number, prior: number): number {
  return Math.abs(rate / prior - 1) * 100;
}

/** Distance in units of the 4th decimal once both figures are rounded to 4 dp (BNM publishes 4 dp; floats never compare raw). */
export function pipsApart(a: number, b: number): number {
  return Math.abs(Math.round(a * 1e4) - Math.round(b * 1e4));
}

/**
 * Whether a scraped rate matches the BNM published figure for the same date and session at 4 dp: within `tolerance`,
 * or exactly when `exact` (a move above the soft flag needs the API to corroborate it).
 */
export function reconciles(
  scraped: number,
  official: number,
  o: { tolerance: number; exact: boolean },
): boolean {
  return pipsApart(scraped, official) <= (o.exact ? 0 : o.tolerance * 1e4) + 1e-6;
}
