import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CostState } from './usage';

/**
 * Writes Claude Code's JSONL transcript format. Every chained line carries the same envelope as the real
 * CLI (parentUuid → uuid chain, isSidechain, timestamp, userType, entrypoint, cwd, sessionId, version,
 * gitBranch); bookkeeping lines (queue-operation, last-prompt, cost-state) are unchained, like Claude Code's.
 */

export interface TranscriptIdentity {
  sessionId: string;
  cwd: string;
  version: string;
  gitBranch: string;
}

export type TranscriptLine = Record<string, unknown>;

export class TranscriptWriter {
  private leaf: string | null;

  constructor(
    readonly file: string,
    private readonly identity: TranscriptIdentity,
    private readonly persist: boolean,
    leafUuid: string | null,
  ) {
    this.leaf = leafUuid;
    if (persist) fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  /** uuid of the last chained line (the next line's parentUuid). */
  get leafUuid(): string | null {
    return this.leaf;
  }

  /**
   * Append a line that joins the parentUuid chain: `{parentUuid, isSidechain, ...head, uuid, timestamp,
   * ...extra, envelope}`. `parentUuid` can be overridden (a compact boundary starts a new chain root).
   */
  chained(
    uuid: string,
    timestamp: string,
    head: TranscriptLine,
    extra: TranscriptLine = {},
    parentUuid: string | null = this.leaf,
  ): TranscriptLine {
    const line: TranscriptLine = {
      parentUuid,
      isSidechain: false,
      ...head,
      uuid,
      timestamp,
      ...extra,
      userType: 'external',
      entrypoint: 'sdk-cli',
      cwd: this.identity.cwd,
      sessionId: this.identity.sessionId,
      version: this.identity.version,
      gitBranch: this.identity.gitBranch,
    };
    this.leaf = uuid;
    this.append(line);
    return line;
  }

  /** Append a bookkeeping line outside the chain. */
  unchained(line: TranscriptLine): void {
    this.append(line);
  }

  private append(line: TranscriptLine): void {
    if (this.persist) fs.appendFileSync(this.file, `${JSON.stringify(line)}\n`);
  }
}

const ModelCostSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  thinkingTokens: z.number().default(0),
  cacheReadInputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  webSearchRequests: z.number().default(0),
  costUSD: z.number(),
});
const CostStateLineSchema = z.object({
  type: z.literal('cost-state'),
  totalCostUSD: z.number(),
  totalAPIDuration: z.number(),
  totalAPIDurationWithoutRetries: z.number(),
  totalToolDuration: z.number(),
  totalLinesAdded: z.number(),
  totalLinesRemoved: z.number(),
  totalDuration: z.number(),
  startTime: z.number(),
  modelUsage: z.record(ModelCostSchema),
  hasUnknownModelCost: z.boolean(),
});

export interface LastResponse {
  model: string;
  usage: {
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    output_tokens: number;
  };
  timestamp: string;
}

/** What a resumed session needs from its existing transcript. */
export interface TranscriptSummary {
  /** uuid of the last chained line (the next line's parentUuid). */
  leafUuid: string | null;
  /** Last `cost-state` line: the cumulative ledger a resumed session continues from. */
  costState: CostState | null;
  /** Last real (non-synthetic) model response. */
  lastResponse: LastResponse | null;
}

export function readTranscriptSummary(file: string): TranscriptSummary {
  const summary: TranscriptSummary = { leafUuid: null, costState: null, lastResponse: null };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return summary;
  }
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let line: Record<string, any>;
    try {
      line = JSON.parse(raw) as Record<string, any>;
    } catch {
      continue; // a torn last line (crash mid-write)
    }
    if (typeof line.uuid === 'string') summary.leafUuid = line.uuid;
    if (line.type === 'cost-state') {
      const parsed = CostStateLineSchema.safeParse(line);
      if (parsed.success) {
        const { type: _type, ...state } = parsed.data;
        summary.costState = state;
      }
    }
    const message = line.message;
    if (
      line.type === 'assistant' &&
      message?.usage &&
      message.model !== '<synthetic>' &&
      typeof line.timestamp === 'string'
    ) {
      summary.lastResponse = {
        model: String(message.model),
        usage: message.usage,
        timestamp: line.timestamp,
      };
    }
  }
  return summary;
}

/** --fork-session: copy the history into the new session's file, re-stamped with the new session id. */
export function forkTranscript(from: string, to: string, newSessionId: string): void {
  const out: string[] = [];
  for (const raw of fs.readFileSync(from, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    try {
      const line = JSON.parse(raw) as Record<string, unknown>;
      if ('sessionId' in line) line.sessionId = newSessionId;
      out.push(JSON.stringify(line));
    } catch {
      // skip torn lines
    }
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, out.length > 0 ? `${out.join('\n')}\n` : '');
}
