/**
 * Transcript following and plan-limit detection for the sidecar. Line reading, usage aggregation (dedupe by
 * message.id) and the subagent layout are shared with the observed-session hook through @aoc/client.
 */
import { statSync, watch, type FSWatcher } from 'node:fs';
import { readCompleteLines } from '@aoc/client';
import { RATE_LIMIT_429, THROTTLE_PATTERNS, THROTTLE_RESET, type TranscriptLine } from '@aoc/contracts';

/** Follows a JSONL transcript: complete lines only, truncation/rotation, fs.watch plus polling. */
export class TranscriptTailer {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private _offset: number;
  lastWriteAt: number | null = null;

  constructor(
    readonly path: string,
    private readonly onLine: (line: string) => void,
    opts: { offset?: number } = {},
  ) {
    this._offset = opts.offset ?? 0;
  }

  /** Byte offset after the last complete line read: safe to persist as a resume offset. */
  get offset(): number {
    return this._offset;
  }

  get size(): number {
    try {
      return statSync(this.path).size;
    } catch {
      return 0;
    }
  }

  /** Reads new complete lines (a line still being written waits for the next poll); returns the bytes consumed. */
  poll(): number {
    const before = this._offset;
    const r = readCompleteLines(this.path, before, this.onLine);
    if (!r) return 0;
    if (r.restarted || r.size > before) this.lastWriteAt = r.mtimeMs;
    this._offset = r.offset;
    return r.restarted ? r.offset : r.offset - before;
  }

  start(pollMs = 1000): void {
    this.poll();
    try {
      this.watcher = watch(this.path, () => this.poll());
    } catch {
      this.watcher = null; // file may not exist yet — polling covers it
    }
    this.timer = setInterval(() => this.poll(), pollMs);
    this.timer.unref();
  }

  stop(): void {
    this.watcher?.close();
    if (this.timer) clearInterval(this.timer);
    this.watcher = null;
    this.timer = null;
  }
}

/** Visible text of a transcript line (assistant/system text blocks or string content). */
export function textOf(line: TranscriptLine): string {
  const c = line.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  const content = (line as { content?: unknown }).content;
  return typeof content === 'string' ? content : '';
}

const WARNING = /You['’]ve used \d+% of|Approaching (?:your )?(?:session|5-hour|weekly)? ?limit/i;
const MAX_NOTICE_CHARS = 2000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Wall-clock parts of `epochMs` in `tz` (falls back to the host zone for unknown zones). */
function zoneParts(epochMs: number, tz: string | undefined) {
  try {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date(epochMs))
        .map((x) => [x.type, x.value]),
    );
    return { y: +p.year!, mo: +p.month!, d: +p.day!, h: +p.hour!, mi: +p.minute!, tz };
  } catch {
    const d = new Date(epochMs);
    return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), tz: undefined };
  }
}

/** Epoch ms of a wall-clock time in `tz` (iterative offset correction; exact outside DST gaps). */
function fromZoned(y: number, mo: number, d: number, h: number, mi: number, tz: string | undefined): number {
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const p = zoneParts(guess, tz);
    const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    guess += Date.UTC(y, mo - 1, d, h, mi) - asUtc;
  }
  return guess;
}

/**
 * Parse a plan usage-limit message (text fallback — the supervisor prefers stream-json rate_limit_event).
 * resetAt is ISO, or null when no reset time is stated. Warnings ("You've used 90% …") are not throttles.
 */
export function parseThrottle(full: string, now: Date = new Date()): { resetAt: string | null } | null {
  // Limit notices are short; the contract patterns backtrack quadratically on long runs (e.g. of digits).
  const text = full.length > MAX_NOTICE_CHARS ? full.slice(0, MAX_NOTICE_CHARS) : full;
  if (WARNING.test(text)) return null;
  const limited = THROTTLE_PATTERNS.some((p) => p.test(text)) || RATE_LIMIT_429.test(text);
  if (!limited) return null;
  const epoch = text.match(/\|(\d{9,13})\b/);
  if (epoch) {
    const n = Number(epoch[1]);
    return { resetAt: new Date(epoch[1]!.length >= 13 ? n : n * 1000).toISOString() };
  }
  const rel = text.match(/resets?\s+in\s+(\d+)\s*(h|hr|hrs|hours?|m|mins?|minutes?)\b/i);
  if (rel) {
    const n = Number(rel[1]);
    return { resetAt: new Date(now.getTime() + (/^h/i.test(rel[2]!) ? n * 3600_000 : n * 60_000)).toISOString() };
  }
  const m = text.match(THROTTLE_RESET);
  if (m) {
    const tz = m[2]?.trim();
    const spec = m[1]!.trim();
    const cur = zoneParts(now.getTime(), tz);
    const md = spec.match(/^([A-Z][a-z]{2}) (\d{1,2})(?:, (\d{4}))?(?:, (.+))?$/i);
    const clockText = md ? (md[4] ?? '') : spec;
    let h = 0;
    let mi = 0;
    const c = clockText.match(/(\d{1,2})(?::(\d{2}))?\s?(am|pm)/i);
    if (c) {
      h = Number(c[1]) % 12 + (c[3]!.toLowerCase() === 'pm' ? 12 : 0);
      mi = Number(c[2] ?? 0);
    }
    if (md) {
      const mo = MONTHS.indexOf(md[1]!.toLowerCase()) + 1;
      if (mo > 0) return { resetAt: new Date(fromZoned(md[3] ? +md[3] : cur.y, mo, +md[2]!, h, mi, tz)).toISOString() };
    } else if (c) {
      let at = fromZoned(cur.y, cur.mo, cur.d, h, mi, tz);
      if (at <= now.getTime()) at += 24 * 3600_000;
      return { resetAt: new Date(at).toISOString() };
    }
  }
  return { resetAt: null };
}

/** An assistant line Claude Code made up itself (API error message), not a model response. */
function isSynthetic(line: TranscriptLine): boolean {
  return (line as { isApiErrorMessage?: boolean }).isApiErrorMessage === true || line.message?.model === '<synthetic>';
}

export function detectThrottle(line: TranscriptLine, now?: Date): { resetAt: string | null; message: string } | null {
  if (line.type !== 'assistant' && line.type !== 'system') return null;
  // Real assistant answers that merely mention limits are not throttles; API-error messages are synthetic.
  if (line.type === 'assistant' && line.message?.usage && !isSynthetic(line)) return null;
  const text = textOf(line);
  if (!text) return null;
  const r = parseThrottle(text, now);
  return r ? { ...r, message: text.slice(0, 500) } : null;
}
