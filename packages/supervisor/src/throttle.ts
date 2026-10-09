/**
 * Plan-limit detection (§4 Throttled, §10 idle-time metering). Signals in priority order (research §9.1):
 * 1. stream-json `rate_limit_event` with status `rejected`, 2. a `throttle.hit` ingested from hooks/sidecar
 * (StopFailure `rate_limit`), 3. `result.api_error_status === 429`, 4. limit text from Claude Code itself.
 */
import { addDays, localParts } from '@aoc/kernel';
import { RATE_LIMIT_429, THROTTLE_RESET, THROTTLE_TEXT_PATTERNS } from './claude-facts';

export interface ThrottleSignal {
  rank: 1 | 2 | 3 | 4;
  resetAt: number | null;
  message: string;
  source: 'stream' | 'transcript' | 'exit';
}

const LEGACY_EPOCH = /usage limit reached\|(\d{9,13})/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** CLI-generated text (error results, synthetic/API-error messages, stderr) that announces a usage limit. */
export function isLimitNotice(text: string): boolean {
  return THROTTLE_TEXT_PATTERNS.some((p) => p.test(text)) || RATE_LIMIT_429.test(text);
}

/**
 * A successful result's text is model-authored, and agents routinely write code that mentions these phrases,
 * so only the legacy exact form ("Claude AI usage limit reached|<epoch>") counts there.
 */
export function isLegacyLimitResult(text: string): boolean {
  return /^\s*Claude AI usage limit reached\|\d{9,13}\s*$/i.test(text);
}

/** Pick the strongest signal; its reset time falls back to the next signal that has one. */
export function strongestSignal(signals: ThrottleSignal[]): ThrottleSignal | null {
  if (!signals.length) return null;
  const sorted = [...signals].sort((a, b) => a.rank - b.rank);
  const best = sorted[0]!;
  return { ...best, resetAt: best.resetAt ?? sorted.find((s) => s.resetAt !== null)?.resetAt ?? null };
}

/**
 * Reset time of a limit notice as epoch ms, or null when it carries none. Wall-clock forms ("3pm", "12:50am
 * (America/Los_Angeles)", "Oct 14, 3pm", "Nov 13", "15:00") resolve to their next occurrence in the named zone,
 * else in `defaultZone` (the supervisor sets TZ on sessions so Claude Code renders in that zone).
 */
export function parseResetAt(text: string, nowMs: number, defaultZone: string): number | null {
  const legacy = LEGACY_EPOCH.exec(text);
  if (legacy) return epochToMs(Number(legacy[1]));
  const m = THROTTLE_RESET.exec(text);
  if (m) return resolveClause(m[1]!.trim(), zoneOr(m[2], defaultZone), nowMs);
  const h24 = /\bresets?\s+(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)(?!\s?[ap]m)(?:\s*\(([^)]+)\))?/i.exec(text);
  if (h24) return nextWallTime(nowMs, zoneOr(h24[3], defaultZone), Number(h24[1]), Number(h24[2]));
  const rel = /\bresets?\s+in\s+(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i.exec(text);
  if (rel && (rel[1] || rel[2])) return nowMs + (Number(rel[1] ?? 0) * 60 + Number(rel[2] ?? 0)) * 60_000;
  return null;
}

/** Epoch seconds (or ms for 13-digit values) → ms. */
export function epochToMs(n: number): number {
  return n > 1e12 ? n : n * 1000;
}

function resolveClause(clause: string, zone: string, nowMs: number): number | null {
  const time = /^(\d{1,2})(?::(\d{2}))?\s?(am|pm)$/i.exec(clause);
  if (time) {
    const h = hour24(Number(time[1]), time[3]!);
    return h === null ? null : nextWallTime(nowMs, zone, h, Number(time[2] ?? 0));
  }
  const date = /^([A-Za-z]{3}) (\d{1,2})(?:, (\d{4}))?(?:, (\d{1,2})(?::(\d{2}))?\s?(am|pm))?$/i.exec(clause);
  if (!date) return null;
  const month = MONTHS.indexOf(date[1]!.toLowerCase());
  const day = Number(date[2]);
  const h = date[4] ? hour24(Number(date[4]), date[6]!) : 0;
  if (month < 0 || h === null) return null;
  const minute = Number(date[5] ?? 0);
  if (date[3]) return wallToEpoch(Number(date[3]), month, day, h, minute, zone);
  const year = Number(localParts(nowMs, zone).date.slice(0, 4));
  const thisYear = wallToEpoch(year, month, day, h, minute, zone);
  // "Nov 13" seen in late December means next year's Nov 13 only when this year's is clearly past.
  return thisYear >= nowMs - 86_400_000 ? thisYear : wallToEpoch(year + 1, month, day, h, minute, zone);
}

function hour24(h: number, ampm: string): number | null {
  if (h < 1 || h > 12) return null;
  return (h % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0);
}

function nextWallTime(nowMs: number, zone: string, h: number, minute: number): number {
  const today = localParts(nowMs, zone).date;
  for (let i = 0; i < 3; i++) {
    const [y, mo, d] = addDays(today, i).split('-').map(Number) as [number, number, number];
    const t = wallToEpoch(y, mo - 1, d, h, minute, zone);
    if (t > nowMs) return t;
  }
  return nowMs + 86_400_000;
}

/** Wall-clock time in an IANA zone → epoch ms (two offset iterations settle DST edges). */
function wallToEpoch(y: number, month: number, d: number, h: number, minute: number, zone: string): number {
  const wall = Date.UTC(y, month, d, h, minute);
  let t = wall;
  for (let i = 0; i < 3; i++) t = wall - offsetMs(t, zone);
  return t;
}

function offsetMs(t: number, zone: string): number {
  const p = localParts(t, zone);
  const [y, mo, d] = p.date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = p.time.split(':').map(Number) as [number, number];
  return Date.UTC(y, mo - 1, d, hh, mm) - Math.floor(t / 60_000) * 60_000;
}

function zoneOr(zone: string | undefined, fallback: string): string {
  const z = zone?.trim();
  if (!z) return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return z;
  } catch {
    return fallback;
  }
}
