/**
 * Claude Code transcript parsing shared by the sidecar (managed sessions) and the observed-session hook: one JSONL
 * line reader, one usage aggregator and one subagent-transcript layout.
 *
 * An assistant API response is written as one line per content block, each repeating the same `message.id`,
 * `requestId` and `message.usage`, so usage is counted once per message id (as a delta when a later line for the
 * same id reports larger numbers). Subagents write their own files; their usage never reaches the main transcript.
 */
import { closeSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { TranscriptLine, TranscriptUsage, UsageBatch } from '@aoc/contracts';

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

// ── incremental line reading ────────────────────────────────────────────────

export interface LineReadResult {
  /** Byte offset just past the last complete line: where the next read starts. */
  offset: number;
  size: number;
  mtimeMs: number;
  /** The file was shorter than the requested offset (truncated or replaced), so it was read from the start. */
  restarted: boolean;
}

const CHUNK_BYTES = 1 << 20;

/**
 * Calls `onLine` for every complete, non-blank line after `offset`. A trailing line still being written is left for
 * the next read, and lines are split on bytes, so multi-byte text spanning read chunks stays intact.
 * Null when the file cannot be opened.
 */
export function readCompleteLines(
  path: string,
  offset: number,
  onLine: (line: string) => void,
): LineReadResult | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    const size = st.size;
    const restarted = offset > size;
    let base = restarted ? 0 : offset;
    const buf = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK_BYTES, size - base)));
    let pending: Buffer[] = []; // bytes of a line that spans chunks
    let pos = base;
    while (pos < size) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (n <= 0) break;
      const data = buf.subarray(0, n);
      let start = 0;
      for (let nl = data.indexOf(0x0a); nl !== -1; nl = data.indexOf(0x0a, start)) {
        const tail = data.subarray(start, nl);
        const line = (pending.length ? Buffer.concat([...pending, tail]) : tail).toString('utf8');
        pending = [];
        start = nl + 1;
        if (line.trim()) onLine(line);
      }
      if (start > 0) base = pos + start;
      if (start < n) pending.push(Buffer.from(data.subarray(start)));
      pos += n;
    }
    return { offset: base, size, mtimeMs: st.mtimeMs, restarted };
  } finally {
    closeSync(fd);
  }
}

// ── subagent transcripts ────────────────────────────────────────────────────

/** `<transcript without .jsonl>/subagents`, where Claude Code writes one `agent-<id>.jsonl` per subagent. */
export function subagentTranscriptDir(transcriptPath: string): string {
  return join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
}

/** `…/agent-<id>.jsonl` → `<id>`, the id hooks report as `agent_id`. */
export function agentIdOfTranscript(path: string): string {
  return basename(path, '.jsonl').replace(/^agent-/, '');
}

export interface SubagentTranscript {
  agentId: string;
  /** File name inside the subagents directory. */
  file: string;
  path: string;
}

/** The subagent transcripts that exist so far for a session transcript (empty when there are none). */
export function listSubagentTranscripts(transcriptPath: string): SubagentTranscript[] {
  const dir = subagentTranscriptDir(transcriptPath);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((file) => ({ agentId: agentIdOfTranscript(file), file, path: join(dir, file) }));
}

// ── usage ───────────────────────────────────────────────────────────────────

/** Tokens already counted for one message id. */
export interface CountedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheW5: number;
  cacheW1: number;
}
/** What an aggregator has counted, by message id (persisted for restart safety). */
export type UsageSnapshot = Record<string, CountedUsage>;

export interface UsageAggregatorOptions {
  /** Snapshot of an earlier aggregator: those messages only add what grew since. */
  counted?: UsageSnapshot;
  /** Timestamp for lines that carry none (default: the current time). */
  now?: () => Date;
}

const ZERO: CountedUsage = { input: 0, output: 0, cacheRead: 0, cacheW5: 0, cacheW1: 0 };

export class UsageAggregator {
  private readonly counted = new Map<string, CountedUsage>();
  private readonly pending = new Map<string, UsageBatch & { ids: Set<string> }>();
  private readonly now: () => Date;
  private lastContext = 0;
  /** Subagent (sidechain) messages that contributed usage. */
  sidechainMessages = 0;

  constructor(o: UsageAggregatorOptions = {}) {
    for (const [id, c] of Object.entries(o.counted ?? {})) this.counted.set(id, countedOf(c));
    this.now = o.now ?? (() => new Date());
  }

  /** Returns true when the line contributed new usage. */
  add(line: TranscriptLine): boolean {
    if (line?.type !== 'assistant') return false;
    const m = line.message;
    // `<synthetic>` messages are Claude Code's own (API errors, interruptions): no API call was made.
    if (!m?.usage || m.model === '<synthetic>') return false;
    const id = firstString(m.id, line.requestId, line.uuid);
    if (!id) return false;
    const cur = usageOf(m.usage);
    if (!line.isSidechain) this.lastContext = cur.input + cur.cacheRead + cur.cacheW5 + cur.cacheW1;
    const prev = this.counted.get(id) ?? ZERO;
    const delta: CountedUsage = {
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
    if (delta.input + delta.output + delta.cacheRead + delta.cacheW5 + delta.cacheW1 === 0) return false;
    if (line.isSidechain && !prev.input && !prev.output) this.sidechainMessages++;
    const model = typeof m.model === 'string' && m.model ? m.model : 'unknown';
    const at =
      typeof line.timestamp === 'string' && line.timestamp ? line.timestamp : this.now().toISOString();
    let b = this.pending.get(model);
    if (!b) {
      b = {
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        messageIds: [],
        ids: new Set(),
        firstAt: at,
        lastAt: at,
        contextTokens: 0,
      };
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

  /** `add` for a raw line. Most bytes are tool output that cannot carry usage, so those skip JSON.parse. */
  addRaw(raw: string): boolean {
    if (!raw.includes('"usage"') || !raw.includes('"assistant"')) return false;
    const line = parseTranscriptLine(raw);
    return line ? this.add(line) : false;
  }

  get pendingMessages(): number {
    let n = 0;
    for (const b of this.pending.values()) n += b.ids.size;
    return n;
  }

  /**
   * Pending batches (one per model), cleared. Every batch carries the same contextTokens: the size of the latest
   * main-chain (non-sidechain) message seen, or 0 when there was none (e.g. a subagent transcript on its own).
   */
  drain(): UsageBatch[] {
    const out: UsageBatch[] = [];
    for (const b of this.pending.values()) {
      const { ids, ...rest } = b;
      out.push({ ...rest, messageIds: [...ids], contextTokens: this.lastContext });
    }
    this.pending.clear();
    return out;
  }

  /** What has been counted; `limit` keeps only the most recently first-seen messages. */
  snapshot(limit?: number): UsageSnapshot {
    const entries = [...this.counted];
    return Object.fromEntries(limit === undefined ? entries : entries.slice(-limit));
  }
}

function usageOf(u: TranscriptUsage): CountedUsage {
  const w5 = count(u.cache_creation?.ephemeral_5m_input_tokens);
  const w1 = count(u.cache_creation?.ephemeral_1h_input_tokens);
  // Without (or beyond) the TTL split only the total is known: the remainder is billed as 5-minute writes, the
  // default TTL.
  const rest = Math.max(0, count(u.cache_creation_input_tokens) - w5 - w1);
  return {
    input: count(u.input_tokens),
    output: count(u.output_tokens),
    cacheRead: count(u.cache_read_input_tokens),
    cacheW5: w5 + rest,
    cacheW1: w1,
  };
}

/** A restored snapshot entry comes from a state file: anything that is not a usable count is 0. */
function countedOf(c: unknown): CountedUsage {
  const o = (c && typeof c === 'object' ? c : {}) as Partial<Record<keyof CountedUsage, unknown>>;
  return {
    input: count(o.input),
    output: count(o.output),
    cacheRead: count(o.cacheRead),
    cacheW5: count(o.cacheW5),
    cacheW1: count(o.cacheW1),
  };
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function firstString(...vs: unknown[]): string | null {
  for (const v of vs) if (typeof v === 'string' && v) return v;
  return null;
}
