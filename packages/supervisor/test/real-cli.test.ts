/**
 * The stream parser against what Claude Code 2.1.295 actually printed to a managed AOC session (scrubbed captures in
 * docs/research/fixtures/claude-code/aoc-*, see "Verified against the real CLI" in the integration note). Simulators
 * drift; these lines do not.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isLegacyLimitResult, isLimitNotice } from '../src/throttle';
import { readStreamLine, type StreamFacts } from '../src/stream';

const FIXTURES = fileURLToPath(new URL('../../../docs/research/fixtures/claude-code/', import.meta.url));
const rawLines = (file: string): string[] => readFileSync(FIXTURES + file, 'utf8').split('\n').filter(Boolean);
const parsed = (file: string) => rawLines(file).map((line) => ({ line, json: JSON.parse(line) as Record<string, any>, facts: readStreamLine(line) }));
const kindOf = (o: Record<string, any>) => `${o.type}${o.subtype ? `/${o.subtype}` : ''}`;
const texts = (facts: StreamFacts[]) => facts.flatMap((f) => f.items.map((i) => i.text));

const STREAMS = [
  'aoc-happy.stream-json.jsonl',
  'aoc-decision.turn-1.stream-json.jsonl',
  'aoc-decision.turn-2.stream-json.jsonl',
  'aoc-guard-push.stream-json.jsonl',
  'aoc-nudge.turn-1.stream-json.jsonl',
  'aoc-nudge.turn-2.stream-json.jsonl',
  'aoc-nudge.turn-3.stream-json.jsonl',
  'aoc-permission-denied.stream-json.jsonl',
  'aoc-triage.stream-json.jsonl',
];

describe('stream-json as a real managed session printed it', () => {
  it('a happy turn: MCP connected, plan, work, task_done, then a success result with the process figures', () => {
    const lines = parsed('aoc-happy.stream-json.jsonl');
    const all = lines.map((l) => l.facts);

    expect(all.find((f) => f.init)!.init).toEqual({ model: 'claude-haiku-5-5', mcpServers: [{ name: 'aoc', status: 'connected' }] });
    expect(texts(all)[0]).toBe('Session started · model claude-haiku-5-5 · MCP aoc:connected');
    // Operator view: the tool calls in order; bookkeeping (status, thinking_tokens, hook_*) says nothing.
    expect(all.flatMap((f) => f.items.filter((i) => i.kind === 'tool_use').map((i) => i.toolName))).toEqual([
      'mcp__aoc__declare_plan',
      'Write',
      'Bash',
      'mcp__aoc__task_done',
    ]);
    for (const l of lines.filter((x) => ['system/status', 'system/thinking_tokens', 'system/hook_started', 'system/hook_response'].includes(kindOf(x.json)))) {
      expect(l.facts.items).toEqual([]);
    }
    expect(all.some((f) => f.conversation)).toBe(true);

    const result = lines.at(-1)!;
    expect(kindOf(result.json)).toBe('result/success');
    expect(result.facts.result).toMatchObject({ isError: false, subtype: 'success', apiErrorStatus: null });
    // result.modelUsage is what G-44 holds the sidecar's transcript figures against.
    const usage = result.json.modelUsage['claude-haiku-5-5'];
    expect(result.facts.result!.modelUsage).toEqual({
      'claude-haiku-5-5': { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadInputTokens, cacheWrite: usage.cacheCreationInputTokens },
    });
    // Context size follows the latest assistant message.
    const last = lines.filter((l) => l.json.type === 'assistant').at(-1)!;
    const u = last.json.message.usage;
    expect(last.facts.contextTokens).toBe(u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens);
  });

  it('allowed_warning is an ordinary rate_limit_event of a healthy account: a fact, never a throttle signal', () => {
    const events = STREAMS.flatMap((f) => parsed(f)).filter((l) => l.json.type === 'rate_limit_event');
    expect(events.length).toBeGreaterThanOrEqual(STREAMS.length);
    for (const e of events) {
      expect(e.facts.rateLimit).toEqual({ status: e.json.rate_limit_info.status, resetsAtMs: e.json.rate_limit_info.resetsAt * 1000, window: e.json.rate_limit_info.rateLimitType });
      expect(e.facts.rateLimit!.status).not.toBe('rejected');
    }
    expect(events.some((e) => e.json.rate_limit_info.status === 'allowed_warning')).toBe(true);
  });

  it('SIGINT is a clean end of turn: an error_during_execution result that the operator reads as an interruption', () => {
    const lines = parsed('aoc-nudge.turn-1.stream-json.jsonl');
    const result = lines.at(-1)!;
    expect(result.json).toMatchObject({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', stop_reason: 'tool_use' });
    expect(result.facts.result).toMatchObject({ isError: true, subtype: 'error_during_execution' });
    // Not the CLI's internal "[ede_diagnostic] ..." line.
    expect(result.facts.items).toEqual([{ kind: 'result', text: 'Turn interrupted (aborted_tools)' }]);
    // The rejected tool call and the interruption marker precede it, as the model and the transcript see them.
    const before = lines.slice(-3, -1).flatMap((l) => l.facts.items.map((i) => i.text));
    expect(before[0]).toContain("The user doesn't want to proceed with this tool use");
    expect(before.at(-1)).toBe('[Request interrupted by user for tool use]');
    // The interrupted turn still reports the process's figures: they are checked like any other turn's.
    expect(result.facts.result!.modelUsage!['claude-haiku-5-5']!.output).toBeGreaterThan(0);
  });

  it('background-task and VCS bookkeeping lines (seen around long Bash calls and commits) are not operator output', () => {
    const quiet = ['system/vcs_state_changed', 'system/task_started', 'system/task_notification', 'system/background_tasks_changed'];
    const seen = new Set<string>();
    for (const l of ['aoc-nudge.turn-2.stream-json.jsonl', 'aoc-nudge.turn-3.stream-json.jsonl'].flatMap((f) => parsed(f))) {
      const kind = kindOf(l.json);
      if (!quiet.includes(kind)) continue;
      seen.add(kind);
      expect(l.facts.items, kind).toEqual([]);
    }
    expect([...seen].sort()).toEqual(['system/task_notification', 'system/task_started', 'system/vcs_state_changed']);
  });

  it('print mode cannot prompt: a refused Bash call is a permission_denied line plus a tool_result the model reads', () => {
    const lines = parsed('aoc-permission-denied.stream-json.jsonl');
    const denied = lines.filter((l) => kindOf(l.json) === 'system/permission_denied');
    expect(denied.map((l) => [l.json.tool_name, l.json.decision_reason_type])).toEqual([
      ['Bash', 'subcommandResults'],
      ['Bash', 'other'],
    ]);
    expect(denied.map((l) => l.facts.items[0]!.text)).toEqual([
      expect.stringMatching(/^permission_denied: This Bash command contains multiple operations\. The following part requires approval: git add/),
      'permission_denied: This command requires approval',
    ]);
    // The model is told the same thing as a tool error, and the turn still ends with an ordinary success result.
    expect(texts(lines.map((l) => l.facts))).toContain('This command requires approval');
    expect(lines.at(-1)!.facts.result).toMatchObject({ isError: false, subtype: 'success' });
  });

  it('a PreToolUse JSON deny reaches the model as "PreToolUse:<Tool> hook error: <reason>" and the turn ends normally', () => {
    const lines = parsed('aoc-guard-push.stream-json.jsonl');
    const shown = texts(lines.map((l) => l.facts)).find((t) => t.startsWith('PreToolUse:Bash hook error:'))!;
    expect(shown).toMatch(/^PreToolUse:Bash hook error: AOC blocked a protected operation \(test 1: Touches main \/ protected branch\): git push/);
    expect(shown).toContain('End your turn');
    expect(lines.at(-1)!.facts.result).toMatchObject({ isError: false, subtype: 'success' });
  });

  it('a read-only triage run is parsed like any other (reads, MCP calls, a success result)', () => {
    const all = parsed('aoc-triage.stream-json.jsonl').map((l) => l.facts);
    const tools = all.flatMap((f) => f.items.filter((i) => i.kind === 'tool_use').map((i) => i.toolName));
    expect(tools).toContain('mcp__aoc__report_diagnosis');
    expect(tools).not.toContain('Write');
    expect(tools).not.toContain('Edit');
    expect(all.at(-1)!.result).toMatchObject({ isError: false, subtype: 'success' });
  });

  it('nothing a healthy session prints is mistaken for a plan usage limit (throttle detection on real output)', () => {
    for (const file of STREAMS) {
      const lines = parsed(file);
      // CLI-generated text (synthetic or API-error messages) is what the limit patterns are applied to; a healthy run has none.
      expect(lines.map((l) => l.facts.cliText).filter(Boolean), file).toEqual([]);
      for (const f of lines.map((l) => l.facts)) {
        if (f.rateLimit) expect(f.rateLimit.status, file).not.toBe('rejected');
        if (f.result) {
          expect(f.result.apiErrorStatus, file).toBeNull();
          expect(isLegacyLimitResult(f.result.text), file).toBe(false);
        }
      }
      // Model-authored text and tool output mention commits, tests and permissions, never a limit notice.
      for (const text of texts(lines.map((l) => l.facts))) expect(isLimitNotice(text), `${file}: ${text.slice(0, 80)}`).toBe(false);
    }
  });
});
