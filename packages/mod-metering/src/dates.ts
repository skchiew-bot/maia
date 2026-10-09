/** Local-calendar helpers for metering days (all metering days are local dates in config.timezone). */
import { addDays, localDate, localParts } from '@aoc/kernel';

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
/** Average days per month (365.25 / 12), used for monthly run-rates. */
export const DAYS_PER_MONTH = 30.4375;

export function isValidDate(d: string): boolean {
  return DATE_RE.test(d) && addDays(d, 0) === d;
}

/** Inclusive list of dates from..to (empty when from > to). */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Inclusive number of days from..to (0 when from > to). */
export function dayCount(from: string, to: string): number {
  if (from > to) return 0;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

export function daysInMonth(date: string): number {
  return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate();
}

export const maxDate = (a: string, b: string): string => (a > b ? a : b);
export const minDate = (a: string, b: string): string => (a < b ? a : b);

/** Offset of local wall time from UTC at an instant (minute precision is exact for every real timezone). */
function tzOffsetMs(epochMs: number, tz: string): number {
  const p = localParts(epochMs, tz);
  return Date.parse(`${p.date}T${p.time}:00Z`) - Math.floor(epochMs / 60_000) * 60_000;
}

/** Epoch ms of the local midnight that starts `date` in `tz`. */
export function localDayStartMs(date: string, tz: string): number {
  const wall = Date.parse(`${date}T00:00:00Z`);
  return wall - tzOffsetMs(wall - tzOffsetMs(wall, tz), tz);
}

/** Split [startMs, endMs) into milliseconds per local date. */
export function splitByLocalDay(startMs: number, endMs: number, tz: string): Map<string, number> {
  const out = new Map<string, number>();
  let t = startMs;
  while (t < endMs) {
    const d = localDate(t, tz);
    const next = localDayStartMs(addDays(d, 1), tz);
    const end = Math.min(endMs, next > t ? next : t + DAY_MS);
    out.set(d, (out.get(d) ?? 0) + (end - t));
    t = end;
  }
  return out;
}

export type ForwardOnlyCheck =
  { ok: true } | { ok: false; reason: 'not_after_today' | 'closed_day'; earliest: string };

/** Earliest date a new rate-card version may take effect: tomorrow, and after the last closed rollup day (R12). */
export function earliestEffectiveFrom(today: string, lastClosedDay: string | null): string {
  const tomorrow = addDays(today, 1);
  return lastClosedDay ? maxDate(tomorrow, addDays(lastClosedDay, 1)) : tomorrow;
}

/** Forward-only rule for rate edits: today, past days and closed days are never repriced. */
export function checkForwardOnly(
  effectiveFrom: string,
  today: string,
  lastClosedDay: string | null,
): ForwardOnlyCheck {
  const earliest = earliestEffectiveFrom(today, lastClosedDay);
  if (lastClosedDay && effectiveFrom <= lastClosedDay) return { ok: false, reason: 'closed_day', earliest };
  if (effectiveFrom <= today) return { ok: false, reason: 'not_after_today', earliest };
  return { ok: true };
}
