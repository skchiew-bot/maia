/**
 * Claude Code transcript parsing shared by the sidecar (managed sessions) and the observed-session hook.
 * Assistant API responses are written as one JSONL line per content block, each repeating the same
 * `message.id` / `requestId` / `message.usage` — so usage is counted once per message id (as a delta
 * when a later line for the same id reports larger numbers).
 */
import { closeSync, existsSync, openSync, readSync, statSync, watch, type FSWatcher } from 'node:fs';
import { RATE_LIMIT_429, THROTTLE_PATTERNS, THROTTLE_RESET, type TranscriptLine, type TranscriptUsage, type UsageBatch } from '@aoc/contracts';

export function parseTranscriptLine(line: string): TranscriptLine | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const o = JSON.parse(t) as TranscriptLine;
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

interface Counted {
  input: number;
  output: number;
  cacheRead: number;
  cacheW5: number;
  cacheW1: number;
}

function usageOf(u: TranscriptUsage): Counted {
  const creation = u.cache_creation;
  const total = u.cache_creation_input_tokens ?? 0;
  const w1 = creation?.ephemeral_1h_input_tokens ?? 0;
  const w5 = creation ? (creation.ephemeral_5m_input_tokens ?? Math.max(0, total - w1)) : total;
  return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheW5: w5, cacheW1: w1 };
}

const ZERO: Counted = { input: 0, output: 0, cacheRead: 0, cacheW5: 0, cacheW1: 0 };

export class UsageAggregator {
  private readonly counted = new Map<string, Counted>();
  private readonly pending = new Map<string, UsageBatch & { ids: Set<string> }>();
  private lastContext = 0;
  sidechainMessages = 0;

  constructor(seen?: Record<string, Counted>) {
    if (seen) for (const [k, v] of Object.entries(seen)) this.counted.set(k, v);
  }

  /** Returns true when the line contributed new usage. */
  add(line: TranscriptLine): boolean {
    if (line.type !== 'assistant' || !line.message?.usage) return false;
    // Claude Code writes failed API calls (e.g. a plan limit) as synthetic messages with zero usage: no API
    // response happened, so they are neither metered nor the latest context size.
    if (isSynthetic(line)) return false;
    const id = line.message.id ?? line.requestId ?? line.uuid;
    if (!id) return false;
    const cur = usageOf(line.message.usage);
    const prev = this.counted.get(id) ?? ZERO;
    const delta: Counted = {
      input: Math.max(0, cur.input - prev.input),
      output: Math.max(0, cur.output - prev.output),
      cacheRead: Math.max(0, cur.cacheRead - prev.cacheRead),
      cacheW5: Math.max(0, cur.cacheW5 - prev.cacheW5),
      cacheW1: Math.max(0, cur.cacheW1 - prev.cacheW1),
    };
    this.counted.set(id, {
      input: Math.max(cur.input, prev.input),
      output: Math.max(cur.output, prev.output),
      cacheRead: Math.max(cur.cacheRead, prev.cacheRead),
      cacheW5: Math.max(cur.cacheW5, prev.cacheW5),
      cacheW1: Math.max(cur.cacheW1, prev.cacheW1),
    });
    if (!line.isSidechain) this.lastContext = cur.input + cur.cacheRead + cur.cacheW5 + cur.cacheW1;
    if (delta.input + delta.output + delta.cacheRead + delta.cacheW5 + delta.cacheW1 === 0) return false;
    if (line.isSidechain && !prev.input && !prev.output) this.sidechainMessages++;
    const model = line.message.model ?? 'unknown';
    const at = line.timestamp ?? new Date().toISOString();
    let b = this.pending.get(model);
    if (!b) {
      b = { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, messageIds: [], ids: new Set(), firstAt: at, lastAt: at, contextTokens: 0 };
      this.pending.set(model, b);
    }
    b.inputTokens += delta.input;
    b.outputTokens += delta.output;
    b.cacheReadTokens += delta.cacheRead;
    b.cacheWrite5mTokens += delta.cacheW5;
    b.cacheWrite1hTokens += delta.cacheW1;
    b.ids.add(id);
    if (at < b.firstAt) b.firstAt = at;
    if (at > b.lastAt) b.lastAt = at;
    return true;
  }

  get pendingMessages(): number {
    let n = 0;
    for (const b of this.pending.values()) n += b.ids.size;
    return n;
  }

  /** Pending batches (one per model), cleared. contextTokens = size of the latest main-chain message. */
  drain(): UsageBatch[] {
    const out: UsageBatch[] = [];
    for (const b of this.pending.values()) {
      const { ids, ...rest } = b;
      out.push({ ...rest, messageIds: [...ids], contextTokens: this.lastContext });
    }
    this.pending.clear();
    return out;
  }

  /** Persistable snapshot of what has been counted (restart safety). */
  snapshot(): Record<string, Counted> {
    return Object.fromEntries(this.counted);
  }
}

/** Incremental JSONL reader: byte offset, partial trailing lines, truncation/rotation, watch + poll. */
export class TranscriptTailer {
  private buf = '';
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

  /** Read any new bytes; returns bytes consumed. */
  poll(): number {
    if (!existsSync(this.path)) return 0;
    const st = statSync(this.path);
    if (st.size < this._offset) {
      this._offset = 0; // truncated or rotated
      this.buf = '';
    }
    if (st.size === this._offset) return 0;
    this.lastWriteAt = st.mtimeMs;
    const fd = openSync(this.path, 'r');
    let read = 0;
    try {
      const chunk = Buffer.alloc(Math.min(st.size - this._offset, 4 * 1024 * 1024));
      while (this._offset < st.size) {
        const n = readSync(fd, chunk, 0, Math.min(chunk.length, st.size - this._offset), this._offset);
        if (n <= 0) break;
        this._offset += n;
        read += n;
        this.buf += chunk.subarray(0, n).toString('utf8');
        let nl: number;
        while ((nl = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, nl);
          this.buf = this.buf.slice(nl + 1);
          if (line.trim()) this.onLine(line);
        }
      }
    } finally {
      closeSync(fd);
    }
    return read;
  }

  /** Bytes fully processed (excludes a buffered partial line) — safe to persist as a resume offset. */
  get committedOffset(): number {
    return this._offset - Buffer.byteLength(this.buf, 'utf8');
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
