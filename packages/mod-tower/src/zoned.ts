/** Wall-clock helpers for the configured timezone (local days, local hours, period boundaries). */
import { localParts } from '@aoc/kernel';

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

const wallMs = (date: string, time: string) => Date.parse(`${date}T${time}:00.000Z`);

/** Epoch ms of a local wall-clock time (`YYYY-MM-DD`, `HH:MM`) in `tz`. */
export function zonedEpoch(date: string, time: string, tz: string): number {
  const target = wallMs(date, time);
  let t = target;
  for (let i = 0; i < 3; i++) {
    const p = localParts(t, tz);
    const diff = target - wallMs(p.date, p.time);
    if (diff === 0) break;
    t += diff;
  }
  return t;
}

export function startOfLocalDay(epochMs: number, tz: string): number {
  return zonedEpoch(localParts(epochMs, tz).date, '00:00', tz);
}

export function startOfLocalHour(epochMs: number, tz: string): number {
  const p = localParts(epochMs, tz);
  return zonedEpoch(p.date, `${p.time.slice(0, 2)}:00`, tz);
}

/** Local period (YYYY-MM) bounds: [start of the 1st, start of the next month). */
export function localPeriodBounds(
  epochMs: number,
  tz: string,
): { period: string; start: number; end: number } {
  const date = localParts(epochMs, tz).date;
  const [y, m] = date.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return {
    period: date.slice(0, 7),
    start: zonedEpoch(`${date.slice(0, 7)}-01`, '00:00', tz),
    end: zonedEpoch(next, '00:00', tz),
  };
}

/** ISO-8601 with the zone's offset, e.g. `2026-10-09T13:00:00+08:00` (unambiguous and shows local time). */
export function isoWithOffset(epochMs: number, tz: string): string {
  const minute = Math.floor(epochMs / MINUTE) * MINUTE;
  const p = localParts(minute, tz);
  const offsetMin = Math.round((wallMs(p.date, p.time) - minute) / MINUTE);
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  return `${p.date}T${p.time}:00${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** Local `HH:MM`. */
export function localClock(epochMs: number, tz: string): string {
  return localParts(epochMs, tz).time;
}
