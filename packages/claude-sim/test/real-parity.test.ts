/**
 * claude-sim against what the real CLI printed. The fixtures are scrubbed captures of Claude Code 2.1.295 driving a
 * managed AOC session (docs/research/fixtures/claude-code/aoc-*); the simulator runs the same shape of session. For
 * every line kind, a key the real CLI wrote and the simulator does not is either a known gap listed here, with the
 * reason it is harmless, or a failure — so a simulator that drifts from the real CLI, or a real CLI that grows a field,
 * cannot go unnoticed.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeAocConfig, hookSettings, makeSandbox, parseLines, readJsonLines, readTranscript, SESSION_A, runSim, spawnSim, type Sandbox } from './helpers';

const FIXTURES = fileURLToPath(new URL('../../../docs/research/fixtures/claude-code/', import.meta.url));
const jsonl = (file: string): Record<string, any>[] => parseLines(fs.readFileSync(FIXTURES + file, 'utf8'));

let box: Sandbox;
beforeEach(() => {
  box = makeSandbox();
});
afterEach(() => box.cleanup());

const kindOf = (o: Record<string, any>) => `${o.type}${o.subtype ? `/${o.subtype}` : ''}`;

/** Dotted key paths of an object down to `depth` levels (arrays and values are leaves). */
function paths(o: unknown, prefix = '', depth = 1): string[] {
  if (!o || typeof o !== 'object' || Array.isArray(o) || depth < 0) return [];
  return Object.entries(o).flatMap(([k, v]) => [`${prefix}${k}`, ...(depth > 0 ? paths(v, `${prefix}${k}.`, depth - 1) : [])]);
}

/** First line of each kind. */
function firstOfEach(lines: Record<string, any>[], kind: (o: Record<string, any>) => string): Map<string, Record<string, any>> {
  const out = new Map<string, Record<string, any>>();
  for (const l of lines) if (!out.has(kind(l))) out.set(kind(l), l);
  return out;
}

function gaps(real: Map<string, Record<string, any>>, sim: Map<string, Record<string, any>>, depth: number): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [kind, line] of real) {
    const other = sim.get(kind);
    if (!other) continue;
    const have = new Set(paths(other, '', depth));
    const missing = paths(line, '', depth).filter((p) => !have.has(p));
    if (missing.length) out[kind] = missing.sort();
  }
  return out;
}

const SCENARIO = {
  name: 'parity',
  steps: [
    { kind: 'think', ms: 100, outputTokens: 50 },
    { kind: 'mcp', server: 'aoc', tool: 'declare_plan', args: { phases: [{ id: 'p1', name: 'Hello', tasks: [{ id: 't1', title: 'Create hello.txt and commit it', size: 'xs' }] }] } },
    { kind: 'tool', name: 'Write', input: { file_path: 'hello.txt', content: 'hi\n' } },
    { kind: 'bash', command: 'git add hello.txt && git commit -q -m hello && git rev-parse HEAD', stdout: '29f85730199261e202d2b32ff56cafb81fa31596\n' },
    { kind: 'mcp', server: 'aoc', tool: 'task_done', args: { task_id: 't1', evidence: { kind: 'commit', ref: '29f85730199261e202d2b32ff56cafb81fa31596' } } },
    { kind: 'text', text: 'Committed.' },
    { kind: 'endTurn', final: true },
  ],
};

const ALL_HOOKS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolBatch', 'Stop', 'SessionEnd'];

async function simulate() {
  const scenario = box.file('parity.json');
  fs.writeFileSync(scenario, JSON.stringify(SCENARIO));
  const hookLog = box.file('hooks.jsonl');
  const settings = hookSettings(Object.fromEntries(ALL_HOOKS.map((e) => [e, [{ command: 'cat >> "$HOOK_LOG"; echo >> "$HOOK_LOG"' }]])));
  const run = await runSim(
    box,
    [
      '-p',
      `Create hello.txt containing 'hi' and commit it. [[scenario:${scenario}]]`,
      '--session-id',
      SESSION_A,
      '--output-format',
      'stream-json',
      '--verbose',
      '--mcp-config',
      fakeAocConfig(box.file('aoc.jsonl')),
      '--settings',
      settings,
      '--model',
      'claude-haiku-5-5',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'mcp__aoc',
      'Bash',
    ],
    { env: { HOOK_LOG: hookLog } },
  );
  expect(run.code).toBe(0);
  return { stream: parseLines(run.stdout), transcript: readTranscript(box, SESSION_A), hooks: readJsonLines(hookLog) };
}

describe('claude-sim mirrors the real CLI’s output shapes', () => {
  it('stream-json: every top-level field the real CLI printed per line kind, bar the listed gaps', async () => {
    const { stream } = await simulate();
    const real = jsonl('aoc-happy.stream-json.jsonl');
    expect(gaps(firstOfEach(real, kindOf), firstOfEach(stream, kindOf), 0)).toMatchInlineSnapshot(`
      {
        "assistant": [
          "request_id",
          "thinking_duration_ms",
          "timestamp",
        ],
        "result/success": [
          "fast_mode_disabled_reason",
          "fast_mode_state",
          "first_content_frame_ms",
          "queued_turn_count",
          "result_index",
          "safety_stops",
          "subagent_stats",
          "time_to_request_ms",
          "ttft_ms",
          "ttft_stream_ms",
        ],
        "system/init": [
          "analytics_disabled",
          "capabilities",
          "fast_mode_disabled_reason",
          "fast_mode_state",
          "memory_paths",
          "messaging_socket_path",
          "per_turn_effort_active",
          "product_feedback_disabled",
          "terminal_slash_commands",
          "view_mode",
        ],
        "user": [
          "tool_result_meta",
        ],
      }
    `);
  });

  it('stream-json: the nested shapes consumers read (message usage, result figures, rate limit)', async () => {
    const { stream } = await simulate();
    const real = jsonl('aoc-happy.stream-json.jsonl');
    expect(gaps(firstOfEach(real, kindOf), firstOfEach(stream, kindOf), 2)).toMatchInlineSnapshot(`
      {
        "assistant": [
          "message.container",
          "message.context_management",
          "message.diagnostics",
          "message.input_transformations",
          "message.stop_details",
          "message.usage.inference_geo",
          "request_id",
          "thinking_duration_ms",
          "timestamp",
        ],
        "result/success": [
          "fast_mode_disabled_reason",
          "fast_mode_state",
          "first_content_frame_ms",
          "modelUsage.claude-haiku-5-5.canonicalModel",
          "modelUsage.claude-haiku-5-5.costBasis",
          "modelUsage.claude-haiku-5-5.provider",
          "modelUsage.claude-haiku-5-5.thinkingTokens",
          "queued_turn_count",
          "result_index",
          "safety_stops",
          "subagent_stats",
          "subagent_stats.by_type",
          "subagent_stats.completed",
          "subagent_stats.failed",
          "subagent_stats.killed",
          "subagent_stats.killed.parent",
          "subagent_stats.killed.system",
          "subagent_stats.killed.user",
          "subagent_stats.max_depth",
          "subagent_stats.refused",
          "subagent_stats.refused.budget",
          "subagent_stats.refused.concurrency_limit",
          "subagent_stats.refused.depth_limit",
          "subagent_stats.requested",
          "subagent_stats.requested.background",
          "subagent_stats.requested.foreground",
          "subagent_stats.requested.unset",
          "subagent_stats.spawned",
          "subagent_stats.spawned_by_subagents",
          "subagent_stats.started_in_background",
          "time_to_request_ms",
          "ttft_ms",
          "ttft_stream_ms",
          "usage.fallback_credit",
          "usage.inference_geo",
          "usage.iterations",
          "usage.output_tokens_details",
          "usage.output_tokens_details.thinking_tokens",
          "usage.speed",
        ],
        "system/init": [
          "analytics_disabled",
          "capabilities",
          "fast_mode_disabled_reason",
          "fast_mode_state",
          "memory_paths",
          "memory_paths.auto",
          "messaging_socket_path",
          "per_turn_effort_active",
          "product_feedback_disabled",
          "terminal_slash_commands",
          "view_mode",
        ],
        "user": [
          "tool_result_meta",
          "tool_use_result.content",
          "tool_use_result.structuredContent",
          "tool_use_result.structuredContent.carriedOver",
          "tool_use_result.structuredContent.manifestVersion",
          "tool_use_result.structuredContent.ok",
          "tool_use_result.structuredContent.totalTasks",
          "tool_use_result.structuredContent.totalWeight",
        ],
      }
    `);
  });

  it('transcript: every top-level field per line kind', async () => {
    const { transcript } = await simulate();
    const real = jsonl('aoc-happy.transcript.jsonl');
    const kind = (o: Record<string, any>) => `${o.type}${o.attachment ? `/${o.attachment.type}` : ''}${o.subtype ? `/${o.subtype}` : ''}`;
    expect(gaps(firstOfEach(real, kind), firstOfEach(transcript, kind), 0)).toMatchInlineSnapshot(`
      {
        "assistant": [
          "apiBlockIndex",
          "effort",
          "perTurnEffort",
          "requestedModel",
          "thinkingDurationMs",
        ],
        "system/stop_hook_summary": [
          "hookAdditionalContext",
          "toolUseID",
        ],
        "user": [
          "promptSource",
          "turnOrigin",
          "turnPosition",
        ],
      }
    `);
  });

  it('hooks: every top-level field of each event’s stdin', async () => {
    const { hooks } = await simulate();
    const real = jsonl('aoc-happy.hooks.jsonl').map((h) => h.input);
    const kind = (o: Record<string, any>) => `${o.hook_event_name}${o.tool_name ? (String(o.tool_name).startsWith('mcp__') ? '/mcp' : `/${o.tool_name}`) : ''}`;
    expect(gaps(firstOfEach(real, kind), firstOfEach(hooks, kind), 0)).toMatchInlineSnapshot(`{}`);
  });

  it('a refused Bash call: the permission_denied line and the error the model reads', async () => {
    const scenario = box.file('denied.json');
    fs.writeFileSync(
      scenario,
      JSON.stringify({ name: 'denied', steps: [{ kind: 'bash', command: 'git add hello.txt && git commit -q -m hello', stdout: '' }, { kind: 'endTurn', final: true }] }),
    );
    const run = await runSim(box, ['-p', `go [[scenario:${scenario}]]`, '--session-id', SESSION_A, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']);
    const stream = parseLines(run.stdout);
    const real = jsonl('aoc-permission-denied.stream-json.jsonl');
    const denied = (lines: Record<string, any>[]) => lines.find((l) => kindOf(l) === 'system/permission_denied')!;
    expect(denied(stream)).toMatchObject({ tool_name: 'Bash', decision_reason_type: 'subcommandResults' });
    expect(Object.keys(denied(stream)).sort()).toEqual(Object.keys(denied(real)).sort());
    // The model is shown the same words as a tool error.
    const shown = (lines: Record<string, any>[]) => lines.filter((l) => l.type === 'user').map((l) => l.message.content[0]).find((b) => b.is_error);
    expect(shown(stream)).toMatchObject({ type: 'tool_result', is_error: true, content: denied(stream).message });
    expect(Object.keys(shown(stream)).sort()).toEqual(Object.keys(shown(real)).sort());
  });

  it('SIGINT while a tool runs: the user lines and the error_during_execution result', async () => {
    const scenario = box.file('slow.json');
    fs.writeFileSync(scenario, JSON.stringify({ name: 'slow', steps: [{ kind: 'bash', command: 'sleep 20', stdout: '', exec: true }, { kind: 'endTurn', final: true }] }));
    const hanging = spawnSim(box, ['-p', 'go', '--session-id', SESSION_A, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash'], {
      CLAUDE_SIM_EXEC: '1',
      CLAUDE_SIM_SCENARIO: scenario,
    });
    const deadline = Date.now() + 10_000;
    while (!hanging.stdout().includes('"name":"Bash"')) {
      if (Date.now() > deadline) throw new Error('the Bash call did not start');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    hanging.child.kill('SIGINT');
    const stream = parseLines((await hanging.done).stdout);
    const real = jsonl('aoc-nudge.turn-1.stream-json.jsonl');
    const last = (lines: Record<string, any>[]) => lines.at(-1)!;
    expect(kindOf(last(stream))).toBe('result/error_during_execution');
    const kind = kindOf(last(real));
    expect(gaps(new Map([[kind, last(real)]]), new Map([[kind, last(stream)]]), 1)).toMatchInlineSnapshot(`
      {
        "result/error_during_execution": [
          "fast_mode_disabled_reason",
          "fast_mode_state",
          "modelUsage.claude-haiku-5-5",
          "queued_turn_count",
          "result_index",
          "safety_stops",
          "subagent_stats",
          "subagent_stats.by_type",
          "subagent_stats.completed",
          "subagent_stats.failed",
          "subagent_stats.killed",
          "subagent_stats.max_depth",
          "subagent_stats.refused",
          "subagent_stats.requested",
          "subagent_stats.spawned",
          "subagent_stats.spawned_by_subagents",
          "subagent_stats.started_in_background",
          "usage.fallback_credit",
          "usage.inference_geo",
          "usage.iterations",
          "usage.output_tokens_details",
          "usage.speed",
        ],
      }
    `);
    // The rejected call and the interruption marker, as the real CLI wrote them.
    const tail = (lines: Record<string, any>[]) => lines.filter((l) => l.type === 'user').slice(-2);
    const content = (lines: Record<string, any>[]) => tail(lines).map((l) => l.message.content.map(({ tool_use_id: _id, ...block }: Record<string, unknown>) => block));
    expect(content(stream)).toEqual(content(real));
    expect(tail(stream).map((l) => l.tool_use_result)).toEqual(tail(real).map((l) => l.tool_use_result));
    expect(last(stream).terminal_reason).toBe(last(real).terminal_reason);
  });
});
