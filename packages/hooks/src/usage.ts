/*
 * Observed-session usage. Reads a Claude Code transcript incrementally (one byte cursor per transcript file) and turns
 * new assistant messages into UsageBatches, counting each message.id once (the transcript repeats message.id and
 * usage on every content-block line). The parser is a minimal stand-in for @aoc/sidecar's UsageAggregator and sits
 * behind `UsageReader` so it can be swapped once the sidecar lands.
 */
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { TranscriptLine, TranscriptUsage, UsageBatch } from '@aoc/contracts';

export interface TranscriptCursor {
  /** Byte offset just past the last complete line already read. */
  offset: number;
  /** Bounded tail of counted message ids, so a message whose lines straddle two reads is counted once. */
  recentMessageIds: string[];
}

export interface UsageReadResult {
  batches: UsageBatch[];
  messageIds: string[];
  cursor: TranscriptCursor;
}

/** The seam the observed path depends on. */
export interface UsageReader {
  /** Usage from complete lines after `cursor`; null when the transcript cannot be opened. */
  read(transcriptPath: string, cursor: TranscriptCursor, now: Date): UsageReadResult | null;
}

const MAX_RECENT_IDS = 512;
const CHUNK_BYTES = 1 << 20;

export const transcriptUsageReader: UsageReader = {
  read: (transcriptPath, cursor, now) => readTranscriptUsage(transcriptPath, cursor, now.toISOString()),
};

/** Groups assistant usage by model, skipping already-counted ids and Claude Code's zero-usage `<synthetic>` messages. */
export function aggregateUsage(
  lines: Iterable<TranscriptLine>,
  alreadyCounted: Iterable<string> = [],
  fallbackAt = new Date(0).toISOString(),
): { batches: UsageBatch[]; messageIds: string[] } {
  const acc = new UsageAccumulator(alreadyCounted, fallbackAt);
  for (const line of lines) acc.add(line);
  return acc.result();
}

export function readTranscriptUsage(
  transcriptPath: string,
  cursor: TranscriptCursor,
  fallbackAt: string,
): UsageReadResult | null {
  let fd: number;
  try {
    fd = openSync(transcriptPath, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    // Shorter than the cursor → the file was replaced or truncated: start over. The id tail (and the daemon's
    // message-id dedupe) keep re-read messages from being counted twice.
    let base = cursor.offset <= size ? cursor.offset : 0;
    const acc = new UsageAccumulator(cursor.recentMessageIds, fallbackAt);
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
        acc.addRaw((pending.length ? Buffer.concat([...pending, tail]) : tail).toString('utf8'));
        pending = [];
        start = nl + 1;
      }
      if (start > 0) base = pos + start;
      // Only complete lines are consumed; a line still being written is re-read next time.
      if (start < n) pending.push(Buffer.from(data.subarray(start)));
      pos += n;
    }
    const { batches, messageIds } = acc.result();
    return {
      batches,
      messageIds,
      cursor: {
        offset: base,
        recentMessageIds: [...cursor.recentMessageIds, ...messageIds].slice(-MAX_RECENT_IDS),
      },
    };
  } finally {
    closeSync(fd);
  }
}

export interface ObservedUsageRead {
  batches: UsageBatch[];
  messageIds: string[];
  /** Persists the advanced cursor; call once the batches were delivered or spooled. */
  commit(): void;
}

export function readObservedUsage(o: {
  stateDir: string;
  claudeSessionId: string;
  agentId: string | null;
  transcriptPath: string;
  now: Date;
  reader?: UsageReader;
}): ObservedUsageRead | null {
  const file = cursorFile(o.stateDir, o.claudeSessionId, o.agentId);
  const read = (o.reader ?? transcriptUsageReader).read(
    o.transcriptPath,
    loadCursor(file, o.transcriptPath),
    o.now,
  );
  if (!read) return null;
  return {
    batches: read.batches,
    messageIds: read.messageIds,
    commit: () => saveCursor(file, o.transcriptPath, read.cursor, o.now),
  };
}

/** ~/.aoc/state/<claude-session>.json (main transcript) or <claude-session>.agent-<id>.json (subagent transcript). */
export function cursorFile(stateDir: string, claudeSessionId: string, agentId: string | null): string {
  const session = safeName(claudeSessionId);
  return join(stateDir, agentId ? `${session}.agent-${safeName(agentId)}.json` : `${session}.json`);
}

export function loadCursor(file: string, transcriptPath: string): TranscriptCursor {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as {
      transcriptPath?: unknown;
      offset?: unknown;
      recentMessageIds?: unknown;
    };
    if (
      s.transcriptPath === transcriptPath &&
      typeof s.offset === 'number' &&
      Number.isSafeInteger(s.offset) &&
      s.offset >= 0
    ) {
      const ids = Array.isArray(s.recentMessageIds)
        ? s.recentMessageIds.filter((x): x is string => typeof x === 'string')
        : [];
      return { offset: s.offset, recentMessageIds: ids };
    }
  } catch {
    // missing or unreadable state: read from the start
  }
  return { offset: 0, recentMessageIds: [] };
}

export function saveCursor(file: string, transcriptPath: string, cursor: TranscriptCursor, now: Date): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({ version: 1, transcriptPath, ...cursor, updatedAt: now.toISOString() }),
    { mode: 0o600 },
  );
  renameSync(tmp, file);
}

/** Session/agent ids come from hook stdin; never let them steer the state path. */
function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}

class UsageAccumulator {
  private readonly seen: Set<string>;
  private readonly byModel = new Map<string, UsageBatch>();
  private readonly ids: string[] = [];

  constructor(
    alreadyCounted: Iterable<string>,
    private readonly fallbackAt: string,
  ) {
    this.seen = new Set(alreadyCounted);
  }

  addRaw(raw: string): void {
    // Cheap pre-filter: most bytes are user/tool-result lines that never carry usage.
    if (!raw.includes('"usage"') || !raw.includes('"assistant"')) return;
    try {
      this.add(JSON.parse(raw) as TranscriptLine);
    } catch {
      // not JSON: ignore the line
    }
  }

  add(line: TranscriptLine): void {
    const m = line?.message;
    const id = m?.id;
    if (line?.type !== 'assistant' || !m?.usage || typeof id !== 'string' || !id) return;
    if (m.model === '<synthetic>' || this.seen.has(id)) return;
    this.seen.add(id);
    this.ids.push(id);
    const t = tokens(m.usage);
    const model = typeof m.model === 'string' && m.model ? m.model : 'unknown';
    const at = typeof line.timestamp === 'string' && line.timestamp ? line.timestamp : this.fallbackAt;
    let b = this.byModel.get(model);
    if (!b) {
      b = {
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        messageIds: [],
        firstAt: at,
        lastAt: at,
        contextTokens: 0,
      };
      this.byModel.set(model, b);
    }
    b.inputTokens += t.input;
    b.outputTokens += t.output;
    b.cacheReadTokens += t.cacheRead;
    b.cacheWrite5mTokens += t.cacheWrite5m;
    b.cacheWrite1hTokens += t.cacheWrite1h;
    b.messageIds.push(id);
    if (at < b.firstAt) b.firstAt = at;
    if (at > b.lastAt) b.lastAt = at;
    b.contextTokens = t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
  }

  result(): { batches: UsageBatch[]; messageIds: string[] } {
    return { batches: [...this.byModel.values()], messageIds: [...this.ids] };
  }
}

function tokens(u: TranscriptUsage) {
  const e5m = count(u.cache_creation?.ephemeral_5m_input_tokens);
  const e1h = count(u.cache_creation?.ephemeral_1h_input_tokens);
  // Transcripts without the TTL split carry only the total: the remainder is billed as 5-minute writes (default TTL).
  const unsplit = Math.max(0, count(u.cache_creation_input_tokens) - e5m - e1h);
  return {
    input: count(u.input_tokens),
    output: count(u.output_tokens),
    cacheRead: count(u.cache_read_input_tokens),
    cacheWrite5m: e5m + unsplit,
    cacheWrite1h: e1h,
  };
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}
