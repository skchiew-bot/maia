/** Wire protocol between hooks / sidecar / MCP server / CLI and aocd (`/ingest/*`). aocd is the sole writer. */
import type { HookInput, HookOutput } from './claude-code';
import type { AocMcpToolName } from './mcp';

export const INGEST_PATHS = {
  hook: '/ingest/hook',
  spool: '/ingest/spool',
  heartbeat: '/ingest/heartbeat',
  activity: '/ingest/activity',
  usage: '/ingest/usage',
  throttle: '/ingest/throttle',
  process: '/ingest/process',
  mcp: (tool: AocMcpToolName) => `/ingest/mcp/${tool}` as const,
} as const;

/**
 * Env vars AOC sets on the processes it starts: managed claude sessions (inherited by hooks and the model's own Bash;
 * passed explicitly to the MCP server), the supervisor's promotion executor and @aoc/llm's own CLI calls.
 */
export const AOC_ENV = {
  sessionId: 'AOC_SESSION_ID',
  projectId: 'AOC_PROJECT_ID',
  threadId: 'AOC_THREAD_ID',
  processType: 'AOC_PROCESS_TYPE',
  daemonUrl: 'AOC_DAEMON_URL',
  ingestToken: 'AOC_INGEST_TOKEN',
  mode: 'AOC_MODE', // managed | observed
  spoolDir: 'AOC_SPOOL_DIR',
  readOnly: 'AOC_READ_ONLY',
  /** Change record a managed session works under (git prepare-commit-msg adds an `AOC-Change` trailer). */
  changeId: 'AOC_CHANGE_ID',
  /** Intake ticket a managed session works on (`AOC-Ticket` trailer). */
  ticketId: 'AOC_TICKET_ID',
  /** "1" only in the supervisor's promotion executor (never a session env): the pre-push guard lets it through. */
  supervisorPush: 'AOC_SUPERVISOR_PUSH',
  /** "1" on @aoc/llm's own claude CLI calls (FX extraction, distillation): not a session, observed hooks skip them. */
  internalLlm: 'AOC_INTERNAL_LLM',
} as const;

export interface HookIngestRequest {
  mode: 'managed' | 'observed';
  /** AOC session id (managed: from env). Observed sessions are keyed by claude session id. */
  aocSessionId: string | null;
  hook: HookInput;
  sentAt: string;
  idempotencyKey: string;
}
/** The daemon decides the hook's effect; the hook binary only relays it (enforcement is centralised in guards). */
export interface HookIngestResponse {
  exitCode: 0 | 2;
  stdout?: HookOutput;
  stderr?: string;
}

export interface SpoolItem {
  path: string; // e.g. /ingest/hook
  body: unknown;
  queuedAt: string;
}
export interface SpoolFlushRequest {
  items: SpoolItem[];
}
/** What the daemon did with one replayed item. */
export type SpoolItemResult = 'accepted' | 'duplicate' | 'rejected';
export interface SpoolFlushResponse {
  accepted: number;
  duplicates: number;
  rejected: number;
  /** Per-item outcomes in request order (same length as `items`). Optional: clients fall back to the counts. */
  results?: SpoolItemResult[];
}

export interface HeartbeatRequest {
  sessionId: string;
  pid: number | null;
  alive: boolean;
  at: string;
  transcriptBytes: number;
  lastTranscriptWriteAt: string | null;
}
export interface ActivityRequest {
  sessionId: string;
  kind: 'stream' | 'transcript';
  at: string;
}
export interface UsageBatch {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  messageIds: string[];
  firstAt: string;
  lastAt: string;
  /** input + cache_read + cache_write of the LAST message (≈ current context size). */
  contextTokens: number;
}
export interface UsageRequest {
  sessionId: string;
  batches: UsageBatch[];
  idempotencyKey: string;
}
export interface ThrottleRequest {
  sessionId: string;
  resetAt: string | null;
  message: string;
  source: 'stream' | 'transcript' | 'exit';
}
export interface ProcessEventRequest {
  sessionId: string;
  event: 'exited';
  exitCode: number | null;
  signal: string | null;
  at: string;
}
export interface McpIngestRequest<TInput = unknown> {
  sessionId: string;
  input: TInput;
}
