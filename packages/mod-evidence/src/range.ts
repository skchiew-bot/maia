import type { EvidencePackRange } from '@aoc/contracts';
import { addDays, localDate, localParts } from '@aoc/kernel';

export interface ResolvedRange extends EvidencePackRange {
  /** UTC epoch ms of local midnight starting `from`. */
  startMs: number;
  /** UTC epoch ms of local midnight after `to` (exclusive). */
  endMs: number;
}

const DAY_MS = 86_400_000;

export function isCalendarDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00.000Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
}

/** UTC offset of `tz` at an instant, at minute precision. */
function offsetMs(epochMs: number, tz: string): number {
  const p = localParts(epochMs, tz);
  return Date.parse(`${p.date}T${p.time}:00.000Z`) - Math.floor(epochMs / 60_000) * 60_000;
}

/** Epoch ms of 00:00 local time on `date` in `tz`. */
export function zonedStartOfDay(date: string, tz: string): number {
  const wall = Date.parse(`${date}T00:00:00.000Z`);
  const first = wall - offsetMs(wall, tz);
  return wall - offsetMs(first, tz);
}

/** Resolve inclusive local dates into an instant range; the range may not start after today or exceed `maxDays`. */
export function resolveRange(
  from: string,
  to: string,
  tz: string,
  nowMs: number,
  maxDays: number,
): { ok: true; range: ResolvedRange } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!isCalendarDate(from)) problems.push(`from: '${from}' is not a calendar date`);
  if (!isCalendarDate(to)) problems.push(`to: '${to}' is not a calendar date`);
  if (problems.length) return { ok: false, problems };
  if (from > to) return { ok: false, problems: ['from must not be after to'] };
  const today = localDate(nowMs, tz);
  if (to > today) problems.push(`to: ${to} is in the future (today is ${today} in ${tz})`);
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  if (days > maxDays) problems.push(`range spans ${days} days; the maximum is ${maxDays}`);
  if (problems.length) return { ok: false, problems };
  const startMs = zonedStartOfDay(from, tz);
  const endMs = zonedStartOfDay(addDays(to, 1), tz);
  return {
    ok: true,
    range: {
      from,
      to,
      timezone: tz,
      days,
      fromTs: new Date(startMs).toISOString(),
      toTsExclusive: new Date(endMs).toISOString(),
      complete: endMs <= nowMs,
      startMs,
      endMs,
    },
  };
}

/** Every date from `from` to `to` inclusive. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
