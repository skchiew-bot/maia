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

/** Env vars the supervisor sets on managed claude processes (inherited by hooks; passed explicitly to the MCP server). */
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
} as const;

/**
 * The sidecar prints this line on stdout once it handles SIGTERM (report what is left, then exit): the supervisor
 * stops a finished turn's sidecar no earlier, or the signal would kill it before it reported anything.
 */
export const SIDECAR_READY_LINE = 'aoc-sidecar ready';

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
export interface SpoolFlushResponse {
  accepted: number;
  duplicates: number;
  rejected: number;
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
