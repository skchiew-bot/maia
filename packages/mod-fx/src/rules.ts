/** Pure FX domain rules (§10): calendar, flagging, carry-forward streaks, reconciliation. */
import { FX_FLAGGED_REASONS, type FxRateStatus, type FxReason } from '@aoc/contracts';
import { weekdayOf } from '@aoc/kernel';
import type { OfficialRate } from './source';

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

/**
 * Consecutive carried-forward weekdays ending at the newest record (rows newest first). Weekends neither count nor
 * break the streak; a live weekday ends it. `since` is the earliest weekday of the streak.
 */
export function carryForwardStreak(rowsNewestFirst: { date: string; status: FxRateStatus }[]): {
  days: number;
  since: string | null;
} {
  let days = 0;
  let since: string | null = null;
  for (const r of rowsNewestFirst) {
    if (isWeekend(r.date)) continue;
    if (r.status === 'live') break;
    days++;
    since = r.date;
  }
  return { days, since };
}

export type Reconciliation = 'reconciled' | 'unavailable' | 'not_comparable' | 'mismatch';

/**
 * Scraped vs the BNM published figure. An API that is down — or still on an older publication than the page —
 * cannot contradict the scrape, so the scraped value stands (validation pass).
 */
export function reconcile(
  scraped: { usdMyr: number; publishedDate: string },
  official: OfficialRate | null,
  tolerance: number,
): Reconciliation {
  if (!official) return 'unavailable';
  if (official.date !== null && official.date < scraped.publishedDate) return 'not_comparable';
  return Math.abs(scraped.usdMyr - official.rate) <= tolerance + 1e-9 ? 'reconciled' : 'mismatch';
}
