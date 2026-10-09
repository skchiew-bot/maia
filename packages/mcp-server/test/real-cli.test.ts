/**
 * The MCP server against what Claude Code 2.1.295 showed a real model (scrubbed captures in
 * docs/research/fixtures/claude-code/aoc-*): the tool result Claude Code printed is `JSON.stringify(structuredContent)`
 * of what this server returned, so the bytes of the tool_result in the stream are the server's output.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { createClient } from '@aoc/client';
import { createAocMcpServer } from '../src';
import { startFakeDaemon, type FakeDaemon } from './fake-daemon';

const FIXTURES = fileURLToPath(new URL('../../../docs/research/fixtures/claude-code/', import.meta.url));

/** The MCP tool results of a captured stream, in order: [tool name, content the model read]. */
function mcpResults(file: string): [string, string][] {
  const lines = readFileSync(FIXTURES + file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
  const calls = new Map<string, string>();
  for (const l of lines)
    if (l.type === 'assistant')
      for (const b of l.message.content)
        if (b.type === 'tool_use' && String(b.name).startsWith('mcp__aoc__'))
          calls.set(b.id, String(b.name).slice('mcp__aoc__'.length));
  return lines
    .filter((l) => l.type === 'user' && Array.isArray(l.message.content))
    .flatMap((l) =>
      l.message.content
        .filter((b: Record<string, any>) => b.type === 'tool_result' && calls.has(b.tool_use_id))
        .map(
          (b: Record<string, any>) => [calls.get(b.tool_use_id)!, b.content as string] as [string, string],
        ),
    );
}

/** What the model is shown for a call whose daemon reply is `reply`: the structured data, as Claude Code stringifies it. */
async function shownFor(tool: string, args: Record<string, unknown>, reply: unknown): Promise<string> {
  const daemon: FakeDaemon = await startFakeDaemon(() => ({ status: 200, body: reply }));
  const server = createAocMcpServer({
    client: createClient({ daemonUrl: daemon.url, token: 'ingest-token' }),
    sessionId: 'ses_X',
  });
  const client = new Client({ name: 'claude-code', version: '2.1.295' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const result = (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
    return JSON.stringify(result.structuredContent);
  } finally {
    await client.close();
    await server.close();
    await daemon.close();
  }
}

describe('what the model was shown', () => {
  it('a task_done that stops the session: the server returns, byte for byte, what the obeying model read', async () => {
    const results = mcpResults('aoc-boundary-obeyed.stream-json.jsonl');
    const [, shown] = results.find(([tool]) => tool === 'task_done')!;
    const { notice, ...daemonReply } = JSON.parse(shown) as { notice: string } & Record<string, unknown>;
    expect(notice).toMatch(/^STOP — AOC task boundary \(stop_requested\)/);
    // The wording was verified on a real model: a plainer one was ignored (aoc-boundary-ignored). Changing it means
    // running `pnpm --filter @aoc/e2e real-cli:full` (boundary) again, then re-capturing this fixture.
    expect(
      await shownFor('task_done', { task_id: 't1', evidence: { kind: 'test', ref: 'test.js' } }, daemonReply),
    ).toBe(shown);
  });

  it('every other plan and task result a real model read is the daemon reply, unchanged, as one JSON object', async () => {
    const ARGS: Record<string, Record<string, unknown>> = {
      declare_plan: { phases: [{ id: 'p', name: 'P', tasks: [{ id: 't', title: 'T', size: 'xs' }] }] },
      task_done: { task_id: 't', evidence: { kind: 'commit', ref: 'abc1234' } },
    };
    let checked = 0;
    for (const file of ['aoc-happy.stream-json.jsonl', 'aoc-nudge.turn-2.stream-json.jsonl']) {
      for (const [tool, shown] of mcpResults(file).filter(([t]) => t in ARGS)) {
        expect(await shownFor(tool, ARGS[tool]!, JSON.parse(shown)), `${file}: ${tool}`).toBe(shown);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });
});
