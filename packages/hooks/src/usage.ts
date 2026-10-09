/*
 * Observed-session usage. Reads a Claude Code transcript incrementally (one byte cursor per transcript file) with the
 * transcript parser the sidecar uses (@aoc/client): each message.id is counted once, as a delta if a later line
 * reports more. The cursor keeps the counts of the most recent messages, so a message whose lines straddle two
 * reads is still counted once.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readCompleteLines, UsageAggregator, type UsageSnapshot } from '@aoc/client';
import type { UsageBatch } from '@aoc/contracts';

export interface TranscriptCursor {
  /** Byte offset just past the last complete line already read. */
  offset: number;
  /** Counts of the most recently seen messages (bounded). */
  counted: UsageSnapshot;
}

export interface UsageReadResult {
  batches: UsageBatch[];
  messageIds: string[];
  cursor: TranscriptCursor;
}

const MAX_COUNTED = 512;

/** Usage from the complete lines after `cursor`; null when the transcript cannot be opened. */
export function readTranscriptUsage(
  transcriptPath: string,
  cursor: TranscriptCursor,
  now: Date,
): UsageReadResult | null {
  const agg = new UsageAggregator({ counted: cursor.counted, now: () => now });
  // A transcript shorter than the cursor was replaced or truncated: it is read again from the start, and the
  // remembered counts (plus the daemon's message-id dedupe) keep re-read messages from being counted twice.
  const r = readCompleteLines(transcriptPath, cursor.offset, (line) => agg.addRaw(line));
  if (!r) return null;
  const batches = agg.drain();
  return {
    batches,
    messageIds: batches.flatMap((b) => b.messageIds),
    cursor: { offset: r.offset, counted: agg.snapshot(MAX_COUNTED) },
  };
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
}): ObservedUsageRead | null {
  const file = cursorFile(o.stateDir, o.claudeSessionId, o.agentId);
  const read = readTranscriptUsage(o.transcriptPath, loadCursor(file, o.transcriptPath), o.now);
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
      counted?: unknown;
    };
    if (
      s.transcriptPath === transcriptPath &&
      typeof s.offset === 'number' &&
      Number.isSafeInteger(s.offset) &&
      s.offset >= 0
    ) {
      const counted =
        s.counted && typeof s.counted === 'object' && !Array.isArray(s.counted)
          ? (s.counted as UsageSnapshot)
          : {};
      return { offset: s.offset, counted };
    }
  } catch {
    // missing or unreadable state: read from the start
  }
  return { offset: 0, counted: {} };
}

export function saveCursor(file: string, transcriptPath: string, cursor: TranscriptCursor, now: Date): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({ version: 2, transcriptPath, ...cursor, updatedAt: now.toISOString() }),
    { mode: 0o600 },
  );
  renameSync(tmp, file);
}

/** Session/agent ids come from hook stdin; never let them steer the state path. */
function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}
