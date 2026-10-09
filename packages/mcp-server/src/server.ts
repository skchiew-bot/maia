/**
 * AOC MCP server — the agent's structured voice (§2). Every tool in the contract (`AOC_MCP_TOOLS`) is
 * registered with its zod schema, so the SDK rejects malformed input before anything reaches the daemon;
 * valid calls are relayed verbatim to aocd (`POST /ingest/mcp/<tool>`), which decides their effect.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AocClient } from '@aoc/client';
import {
  AOC_MCP_SERVER_NAME,
  AOC_MCP_TOOL_NAMES,
  AOC_MCP_TOOLS,
  INGEST_PATHS,
  type AocMcpToolName,
  type McpErrorResult,
  type McpIngestRequest,
} from '@aoc/contracts';
import pkg from '../package.json' with { type: 'json' };

export const AOC_MCP_SERVER_VERSION: string = pkg.version;
export const DAEMON_TIMEOUT_MS = 15_000;

const FAIL_LOUDLY = 'managed sessions fail loudly; end your turn';
export const DAEMON_UNREACHABLE = `AOC daemon unreachable — ${FAIL_LOUDLY}`;
export const END_TURN_FOR_DECISION =
  'END YOUR TURN NOW. The supervisor will resume this session with the human answer.';

/** Only reads are retried: a retried write could apply twice if the first attempt reached the daemon but its reply was lost. */
const IDEMPOTENT_TOOLS: ReadonlySet<AocMcpToolName> = new Set<AocMcpToolName>(['get_status']);

export interface AocMcpServerOptions {
  /** Ingest client carrying the session's ingest token (sent as `Authorization: Bearer`). */
  client: Pick<AocClient, 'post'>;
  sessionId: string;
  /** Per-attempt daemon timeout in ms (default 15 s). */
  timeoutMs?: number;
}

export function createAocMcpServer(opts: AocMcpServerOptions): McpServer {
  if (!opts.sessionId) throw new Error('createAocMcpServer: sessionId is required');
  const server = new McpServer({ name: AOC_MCP_SERVER_NAME, version: AOC_MCP_SERVER_VERSION });
  for (const tool of AOC_MCP_TOOL_NAMES) {
    const { description, input } = AOC_MCP_TOOLS[tool];
    // The handler only ever sees `input`-parsed arguments (unknown keys stripped); invalid calls never reach it.
    server.registerTool(tool, { description, inputSchema: input }, (parsed: unknown) =>
      relay(opts, tool, parsed),
    );
  }
  return server;
}

/** Tool names exactly as registered (contract order). */
export function toolNames(): AocMcpToolName[] {
  return [...AOC_MCP_TOOL_NAMES];
}

async function relay(
  opts: AocMcpServerOptions,
  tool: AocMcpToolName,
  input: unknown,
): Promise<CallToolResult> {
  const body: McpIngestRequest = { sessionId: opts.sessionId, input };
  const res = await opts.client.post<unknown>(INGEST_PATHS.mcp(tool), body, {
    retries: IDEMPOTENT_TOOLS.has(tool) ? 2 : 1, // AocClient counts attempts: one retry for reads, none for writes
    timeoutMs: opts.timeoutMs ?? DAEMON_TIMEOUT_MS,
  });
  return res.ok ? fromReply(tool, res.status, res.data) : fromFailure(res.status, res.error);
}

function fromFailure(status: number | null, error: string): CallToolResult {
  if (status === null) return toolError(`${DAEMON_UNREACHABLE}. Cause: ${error}.`, { status, cause: error });
  if (status >= 500)
    return toolError(`AOC daemon error (HTTP ${status}: ${error}) — ${FAIL_LOUDLY}.`, { status });
  // Without a valid ingest token nothing this session does can be recorded, so it must not carry on unaudited.
  if (status === 401)
    return toolError(`AOC rejected this session's ingest token (${error}) — ${FAIL_LOUDLY}.`, { status });
  // Other 4xx are the daemon refusing this call (e.g. "declare_plan already called — use amend_plan"): relay its words.
  return toolError(error, { status });
}

function fromReply(tool: AocMcpToolName, status: number, data: unknown): CallToolResult {
  if (!isRecord(data))
    return toolError(`AOC daemon sent an unreadable reply (HTTP ${status}) — ${FAIL_LOUDLY}.`, { status });
  if (data.ok === false) {
    const text = typeof data.error === 'string' && data.error ? data.error : pretty(data);
    return { isError: true, content: [{ type: 'text', text }], structuredContent: data };
  }
  const notice = tool === 'request_decision' ? END_TURN_FOR_DECISION : tool === 'task_done' ? boundaryStop(data) : null;
  if (!notice) return { content: [{ type: 'text', text: pretty(data) }], structuredContent: data };
  // Claude Code 2.1.295 shows the model JSON.stringify(structuredContent) and drops the text blocks of a result that
  // has one, so an order the agent must not miss travels in the structured data too, as its first key (real-CLI check).
  return {
    content: [{ type: 'text', text: `${pretty(data)}\n\n${notice}` }],
    structuredContent: { notice, ...data },
  };
}

/**
 * Credit caps and rollover are enforced only at task boundaries (§5, §10), so a stop order must be unmissable. A real
 * Haiku session that was asked for two things went on to the second one after "do not start another task"; what the
 * order has to say is that it outranks the prompt's remaining steps, and what to do instead (real-CLI check).
 */
function boundaryStop(result: Record<string, unknown>): string | null {
  const b = result.boundary;
  if (!isRecord(b) || b.continue !== false) return null;
  const reason = typeof b.reason === 'string' && b.reason ? b.reason : 'stop';
  const instruction =
    typeof b.instruction === 'string' && b.instruction.trim() ? b.instruction.trim() : 'End your turn now.';
  return (
    `STOP — AOC task boundary (${reason}). Do not start another task.\n${instruction}\n` +
    'This order outranks your plan and every step of your prompt that is not done yet; leaving them undone is expected. ' +
    'Make no further tool calls: say in one sentence what is done and what is left, then end your turn.'
  );
}

function toolError(message: string, details: unknown): CallToolResult {
  const body: McpErrorResult = { ok: false, error: message, details };
  return { isError: true, content: [{ type: 'text', text: message }], structuredContent: { ...body } };
}

function pretty(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
