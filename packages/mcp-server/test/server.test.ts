import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { createClient } from '@aoc/client';
import { AOC_MCP_TOOL_NAMES, AOC_MCP_TOOLS, type AocMcpToolName } from '@aoc/contracts';
import {
  AOC_MCP_SERVER_VERSION,
  DAEMON_UNREACHABLE,
  END_TURN_FOR_DECISION,
  createAocMcpServer,
  toolNames,
} from '../src';
import { daemonError, startFakeDaemon, unreachableUrl, type FakeDaemon, type Responder } from './fake-daemon';

const SESSION = 'ses_01J9MCPTEST';
const TOKEN = 'ingest-token-abc123';

const VALID: { [K in AocMcpToolName]: z.input<(typeof AOC_MCP_TOOLS)[K]['input']> } = {
  declare_plan: {
    summary: 'Build the AOC MCP server',
    phases: [
      {
        id: 'p1',
        name: 'Build',
        tasks: [{ id: 't1', title: 'Relay tool calls', size: 'm', acceptance: 'tests green' }],
      },
    ],
  },
  amend_plan: {
    reason: 'stdio entry needs its own task',
    add: [{ id: 't2', title: 'stdio entry', size: 's', phaseId: 'p1' }],
    remove: ['t9'],
    resize: [{ taskId: 't1', size: 'l' }],
  },
  task_done: {
    task_id: 't1',
    evidence: { kind: 'test', ref: 'test/server.test.ts > relays', detail: '42 passed' },
  },
  request_decision: {
    test: 'main',
    question: 'Merge the MCP server to main now?',
    options: [
      { id: 'merge', label: 'Merge now' },
      { id: 'wait', label: 'Wait for review', description: 'Hold until the lead reviews' },
    ],
    recommendation: { option_id: 'merge', rationale: 'All tests and typecheck are green' },
    context: 'Stage 1 deliverable',
  },
  playbook_step: { playbook_id: 'pb.release', step: 'run tests', state: 'done', note: 'all green' },
  report_diagnosis: {
    root_cause: 'Parser dereferences a null header',
    confidence: 0.8,
    fix_plan: 'Guard the null header and add a regression test',
    affected_areas: ['packages/parser'],
    root_cause_class: 'null-handling',
  },
  report_error: {
    summary: 'tsc runs out of memory on a deep union',
    root_cause_class: 'tooling',
    fix: 'widen the type',
    code_area: 'packages/x',
  },
  get_status: {},
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function daemon(responder?: Responder): Promise<FakeDaemon> {
  const d = await startFakeDaemon(responder);
  cleanups.push(() => d.close());
  return d;
}

async function connect(daemonUrl: string, opts: { timeoutMs?: number } = {}): Promise<Client> {
  const server = createAocMcpServer({
    client: createClient({ daemonUrl, token: TOKEN }),
    sessionId: SESSION,
    ...opts,
  });
  const mcp = new Client({ name: 'aoc-test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
  cleanups.push(async () => {
    await mcp.close();
    await server.close();
  });
  return mcp;
}

async function call(mcp: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await mcp.callTool({ name, arguments: args })) as CallToolResult;
}

function textOf(r: CallToolResult): string {
  return r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

describe('tool listing', () => {
  it('lists exactly the contract tools with their descriptions and zod-derived input schemas', async () => {
    const d = await daemon();
    const { tools } = await (await connect(d.url)).listTools();
    expect(tools.map((t) => t.name)).toEqual(AOC_MCP_TOOL_NAMES);
    for (const tool of tools) {
      const def = AOC_MCP_TOOLS[tool.name as AocMcpToolName];
      expect(tool.description).toBe(def.description);
      const shape: Record<string, z.ZodTypeAny> = def.input.shape;
      expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(Object.keys(shape));
      const required = Object.keys(shape).filter((k) => !shape[k]!.isOptional());
      expect(tool.inputSchema.required ?? []).toEqual(required);
    }
    expect(d.requests).toHaveLength(0);
  });

  it('toolNames() matches the registered tools', async () => {
    const d = await daemon();
    const { tools } = await (await connect(d.url)).listTools();
    expect(toolNames()).toEqual(tools.map((t) => t.name));
    expect(toolNames()).toEqual(AOC_MCP_TOOL_NAMES);
  });

  it('identifies as `aoc` with the package.json version', async () => {
    const d = await daemon();
    const mcp = await connect(d.url);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(AOC_MCP_SERVER_VERSION).toBe(pkg.version);
    expect(mcp.getServerVersion()).toMatchObject({ name: 'aoc', version: pkg.version });
  });

  it('refuses to build a server without a session id', () => {
    expect(() =>
      createAocMcpServer({ client: createClient({ daemonUrl: 'http://127.0.0.1:1' }), sessionId: '' }),
    ).toThrow(/sessionId/);
  });
});

describe('relaying valid calls', () => {
  it.each(AOC_MCP_TOOL_NAMES)(
    '%s → POST /ingest/mcp/<tool> with { sessionId, input } and the bearer token',
    async (tool) => {
      const d = await daemon(() => ({ status: 200, body: { ok: true } }));
      const r = await call(await connect(d.url), tool, VALID[tool]);
      expect(r.isError).toBeFalsy();
      expect(d.requests).toEqual([
        {
          method: 'POST',
          path: `/ingest/mcp/${tool}`,
          authorization: `Bearer ${TOKEN}`,
          contentType: 'application/json',
          body: { sessionId: SESSION, input: VALID[tool] },
        },
      ]);
    },
  );

  it('returns the daemon JSON as pretty text plus structuredContent', async () => {
    const reply = { ok: true, manifestVersion: 1, totalTasks: 1, totalWeight: 3 };
    const d = await daemon(() => ({ status: 200, body: reply }));
    const r = await call(await connect(d.url), 'declare_plan', VALID.declare_plan);
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: 'text', text: pretty(reply) }]);
    expect(r.structuredContent).toEqual(reply);
  });

  it('forwards the schema-parsed input: keys outside the contract never reach the daemon', async () => {
    const d = await daemon();
    const sneaky = {
      ...VALID.task_done,
      note: 'free text',
      evidence: { ...VALID.task_done.evidence, extra: 1 },
    };
    const r = await call(await connect(d.url), 'task_done', sneaky);
    expect(r.isError).toBeFalsy();
    expect(d.requests[0]!.body).toEqual({ sessionId: SESSION, input: VALID.task_done });
  });
});

describe('schema validation happens before any HTTP', () => {
  const invalid: Array<[AocMcpToolName, string, Record<string, unknown>]> = [
    ['declare_plan', 'no phases', { phases: [] }],
    [
      'declare_plan',
      'an unknown task size',
      { phases: [{ id: 'p1', name: 'B', tasks: [{ id: 't1', title: 'x', size: 'huge' }] }] },
    ],
    ['amend_plan', 'a too-short reason', { reason: 'x' }],
    ['task_done', 'missing evidence', { task_id: 't1' }],
    ['task_done', 'an unknown evidence kind', { task_id: 't1', evidence: { kind: 'vibes', ref: 'x' } }],
    ['task_done', 'an id with spaces', { task_id: 'task one', evidence: { kind: 'commit', ref: 'abc123' } }],
    [
      'request_decision',
      'a single option',
      { ...VALID.request_decision, options: [{ id: 'a', label: 'A' }] },
    ],
    ['request_decision', 'an unknown decision test', { ...VALID.request_decision, test: 'whim' }],
    ['playbook_step', 'an unknown state', { step: 'deploy', state: 'paused' }],
    ['report_diagnosis', 'confidence above 1', { ...VALID.report_diagnosis, confidence: 1.5 }],
    ['report_error', 'a missing summary', { fix: 'restart' }],
  ];

  it.each(invalid)('%s rejects %s', async (tool, _why, args) => {
    const d = await daemon();
    const r = await call(await connect(d.url), tool, args);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Input validation error');
    expect(d.requests).toHaveLength(0);
  });

  it('an unknown tool is an error and is never relayed', async () => {
    const d = await daemon();
    const r = await call(await connect(d.url), 'deploy_to_production', {});
    expect(r.isError).toBe(true);
    expect(d.requests).toHaveLength(0);
  });
});

describe('daemon error mapping', () => {
  it.each([
    [409, 'declare_plan', 'declare_plan already called — use amend_plan'],
    [422, 'task_done', 'task t1 is not in the manifest'],
    [403, 'report_diagnosis', 'report_diagnosis is only available to triage sessions'],
  ] as const)(
    'HTTP %i → isError carrying the daemon message (%s), not retried',
    async (status, tool, message) => {
      const d = await daemon(() => ({ status, body: daemonError('rejected', message) }));
      const r = await call(await connect(d.url), tool, VALID[tool]);
      expect(r.isError).toBe(true);
      expect(r.content).toEqual([{ type: 'text', text: message }]);
      expect(r.structuredContent).toEqual({ ok: false, error: message, details: { status } });
      expect(d.requests).toHaveLength(1);
    },
  );

  it('HTTP 401 → isError telling the agent to end its turn (nothing can be recorded)', async () => {
    const d = await daemon(() => ({
      status: 401,
      body: daemonError('unauthenticated', 'Ingest token required'),
    }));
    const r = await call(await connect(d.url), 'playbook_step', VALID.playbook_step);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Ingest token required');
    expect(textOf(r)).toContain('managed sessions fail loudly; end your turn');
  });

  it('HTTP 5xx on a write → isError (fail loudly), never retried', async () => {
    const d = await daemon(() => ({ status: 500, body: daemonError('internal', 'Internal error') }));
    const r = await call(await connect(d.url), 'task_done', VALID.task_done);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(
      'AOC daemon error (HTTP 500: Internal error) — managed sessions fail loudly; end your turn.',
    );
    expect(r.structuredContent).toMatchObject({ ok: false, details: { status: 500 } });
    expect(d.requests).toHaveLength(1);
  });

  it('get_status (idempotent) is retried once after a 5xx', async () => {
    const status = { ok: true, manifest: null, progress: null, decisions: [], lessons: [] };
    const d = await daemon((_req, nth) =>
      nth === 1 ? { status: 503, body: daemonError('busy', 'Busy') } : { status: 200, body: status },
    );
    const r = await call(await connect(d.url), 'get_status', {});
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual(status);
    expect(d.requests).toHaveLength(2);
  });

  it('get_status gives up after its single retry', async () => {
    const d = await daemon(() => ({ status: 503, body: daemonError('busy', 'Busy') }));
    const r = await call(await connect(d.url), 'get_status', {});
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('HTTP 503: Busy');
    expect(d.requests).toHaveLength(2);
  });

  it('a 2xx reply with ok:false is still an error', async () => {
    const reply = { ok: false, error: 'evidence commit abc123 not found', details: { ref: 'abc123' } };
    const d = await daemon(() => ({ status: 200, body: reply }));
    const r = await call(await connect(d.url), 'task_done', VALID.task_done);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(reply.error);
    expect(r.structuredContent).toEqual(reply);
  });

  it('a 2xx reply that is not a JSON object is never taken as success', async () => {
    const d = await daemon(() => ({ status: 200 }));
    const r = await call(await connect(d.url), 'declare_plan', VALID.declare_plan);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('managed sessions fail loudly; end your turn');
  });
});

describe('network failure', () => {
  it.each(['declare_plan', 'get_status'] as const)(
    '%s against an unreachable daemon → isError, fail loudly',
    async (tool) => {
      const r = await call(await connect(await unreachableUrl()), tool, VALID[tool]);
      expect(r.isError).toBe(true);
      expect(
        textOf(r).startsWith('AOC daemon unreachable — managed sessions fail loudly; end your turn'),
      ).toBe(true);
      expect(textOf(r).startsWith(DAEMON_UNREACHABLE)).toBe(true);
      expect(r.structuredContent).toMatchObject({ ok: false, details: { status: null } });
    },
  );

  it('a timeout counts as unreachable; writes get one attempt, get_status two', async () => {
    const d = await daemon(() => 'hang');
    const mcp = await connect(d.url, { timeoutMs: 200 });
    const write = await call(mcp, 'task_done', VALID.task_done);
    expect(write.isError).toBe(true);
    expect(textOf(write)).toBe(`${DAEMON_UNREACHABLE}. Cause: timeout.`);
    expect(d.requests).toHaveLength(1);
    const read = await call(mcp, 'get_status', {});
    expect(read.isError).toBe(true);
    expect(d.requests).toHaveLength(3);
  });
});

describe('turn-ending instructions', () => {
  it('request_decision success appends the end-your-turn instruction', async () => {
    const reply = {
      ok: true,
      decision_id: 'dec_01',
      instruction: 'Decision raised; wait for the human answer.',
    };
    const d = await daemon(() => ({ status: 200, body: reply }));
    const r = await call(await connect(d.url), 'request_decision', VALID.request_decision);
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe(
      `${pretty(reply)}\n\nEND YOUR TURN NOW. The supervisor will resume this session with the human answer.`,
    );
    expect(END_TURN_FOR_DECISION).toBe(
      'END YOUR TURN NOW. The supervisor will resume this session with the human answer.',
    );
    expect(r.structuredContent).toEqual(reply);
  });

  it('a rejected request_decision does not tell the agent to wait for an answer', async () => {
    const d = await daemon(() => ({
      status: 422,
      body: daemonError('invalid', 'recommendation.option_id must name one of the options'),
    }));
    const r = await call(await connect(d.url), 'request_decision', VALID.request_decision);
    expect(r.isError).toBe(true);
    expect(textOf(r)).not.toContain('END YOUR TURN');
  });

  const doneReply = (boundary: unknown) => ({
    ok: true,
    flagged: null,
    progress: { doneTasks: 1, totalTasks: 4, doneWeight: 3, totalWeight: 11, pct: 27 },
    phaseCompleted: null,
    boundary,
  });

  it.each(['credit_cap', 'rollover', 'stop_requested'] as const)(
    'task_done with boundary.continue=false (%s) appends the boundary instruction prominently',
    async (reason) => {
      const instruction = `Boundary reached (${reason}): commit your work and end your turn.`;
      const reply = doneReply({ continue: false, reason, instruction });
      const d = await daemon(() => ({ status: 200, body: reply }));
      const r = await call(await connect(d.url), 'task_done', VALID.task_done);
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toBe(
        `${pretty(reply)}\n\nSTOP — AOC task boundary (${reason}). Do not start another task.\n${instruction}`,
      );
      expect(r.structuredContent).toEqual(reply);
    },
  );

  it('task_done with boundary.continue=true adds nothing to the reply', async () => {
    const reply = doneReply({ continue: true });
    const d = await daemon(() => ({ status: 200, body: reply }));
    const r = await call(await connect(d.url), 'task_done', VALID.task_done);
    expect(textOf(r)).toBe(pretty(reply));
  });
});
