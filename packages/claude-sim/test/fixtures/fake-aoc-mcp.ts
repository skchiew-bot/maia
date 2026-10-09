/**
 * A tiny stand-in for the AOC MCP server, spawned by the sim over stdio in tests. Inputs are validated
 * against copies of the contract shapes (so built-in scenarios are proven to send valid payloads), every call
 * is appended to $FAKE_AOC_LOG, and task_done returns `boundary.continue = false` from the
 * $FAKE_AOC_BOUNDARY_AFTER-th call on.
 */
import fs from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/);
const size = z.enum(['xs', 's', 'm', 'l', 'xl']);
const task = z
  .object({ id, title: z.string().min(1).max(200), size, acceptance: z.string().max(1000).optional() })
  .strict();

const schemas: Record<string, z.ZodTypeAny> = {
  declare_plan: z
    .object({
      phases: z
        .array(z.object({ id, name: z.string().min(1).max(120), tasks: z.array(task).min(1) }).strict())
        .min(1),
      summary: z.string().max(2000).optional(),
    })
    .strict(),
  amend_plan: z
    .object({
      reason: z.string().min(3).max(1000),
      add: z.array(task.extend({ phaseId: id, phaseName: z.string().max(120).optional() })).optional(),
      remove: z.array(id).optional(),
      resize: z.array(z.object({ taskId: id, size })).optional(),
    })
    .strict(),
  task_done: z
    .object({
      task_id: id,
      evidence: z
        .object({
          kind: z.enum(['test', 'commit', 'diff']),
          ref: z.string().min(1).max(300),
          detail: z.string().max(2000).optional(),
        })
        .strict(),
    })
    .strict(),
  request_decision: z
    .object({
      test: z.enum(['main', 'production', 'irreversible', 'ambiguity', 'data']),
      question: z.string().min(5).max(2000),
      options: z
        .array(
          z
            .object({ id, label: z.string().min(1).max(200), description: z.string().max(1000).optional() })
            .strict(),
        )
        .min(2)
        .max(6),
      recommendation: z.object({ option_id: id, rationale: z.string().min(3).max(2000) }).strict(),
      context: z.string().max(4000).optional(),
    })
    .strict(),
  report_diagnosis: z
    .object({
      root_cause: z.string().min(5).max(4000),
      confidence: z.number().min(0).max(1),
      fix_plan: z.string().min(5).max(8000),
      affected_areas: z.array(z.string().max(300)).optional(),
      root_cause_class: z.string().max(120).optional(),
    })
    .strict(),
  get_status: z.object({}).strict(),
  echo: z.object({ text: z.string() }).strict(),
};

const logFile = process.env.FAKE_AOC_LOG;
const boundaryAfter = Number(process.env.FAKE_AOC_BOUNDARY_AFTER ?? 0);
let tasksDone = 0;

function log(entry: Record<string, unknown>): void {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
}

function reply(payload: Record<string, unknown>, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError };
}

const server = new Server({ name: 'aoc', version: '0.0.0-test' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.keys(schemas).map((name) => ({
    name,
    description: `fake ${name}`,
    inputSchema: { type: 'object' as const, additionalProperties: true },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const schema = schemas[name];
  if (!schema) return reply({ ok: false, error: `unknown tool ${name}` }, true);
  const parsed = schema.safeParse(args);
  log({ tool: name, args, valid: parsed.success, env: { AOC_SESSION: process.env.AOC_SESSION ?? null } });
  if (!parsed.success)
    return reply({ ok: false, error: 'invalid input', details: parsed.error.issues }, true);
  switch (name) {
    case 'declare_plan':
      return reply({ ok: true, manifestVersion: 1, totalTasks: 5, totalWeight: 19 });
    case 'task_done': {
      tasksDone += 1;
      const stop = boundaryAfter > 0 && tasksDone >= boundaryAfter;
      return reply({
        ok: true,
        flagged: null,
        progress: {
          doneTasks: tasksDone,
          totalTasks: 5,
          doneWeight: tasksDone,
          totalWeight: 19,
          pct: tasksDone * 20,
        },
        phaseCompleted: null,
        boundary: stop
          ? { continue: false, reason: 'credit_cap', instruction: 'Credit cap reached: end your turn now.' }
          : { continue: true },
      });
    }
    case 'request_decision':
      return reply({
        ok: true,
        decision_id: process.env.FAKE_AOC_DECISION_ID ?? 'dec_1',
        instruction: 'End your turn now.',
      });
    case 'echo':
      return { content: [{ type: 'text' as const, text: `echo: ${(args as { text: string }).text}` }] };
    default:
      return reply({ ok: true });
  }
});

process.stdin.on('end', () => process.exit(0));
await server.connect(new StdioServerTransport());
