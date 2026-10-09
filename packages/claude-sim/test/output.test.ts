import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runClaudeSim } from '../src/index';
import {
  hookSettings,
  makeSandbox,
  parseLines,
  readJsonLines,
  readTranscript,
  runSim,
  SESSION_A,
  simEnv,
  type Sandbox,
} from './helpers';

let box: Sandbox;
beforeEach(() => {
  box = makeSandbox();
});
afterEach(() => box.cleanup());

const STREAM = ['--output-format', 'stream-json', '--verbose'];
const YOLO = ['--dangerously-skip-permissions'];

function scenario(steps: unknown[]): Record<string, string> {
  const file = box.file('scenario.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'custom', steps }));
  return { CLAUDE_SIM_SCENARIO: file };
}

describe('stream-json', () => {
  it('emits init first and result last, with assistant/user messages mirroring the transcript', async () => {
    const run = await runSim(box, ['-p', '--session-id', SESSION_A, ...STREAM, ...YOLO, 'go']);
    expect(run.code).toBe(0);
    const messages = parseLines(run.stdout);
    expect(messages[0]).toMatchObject({
      type: 'system',
      subtype: 'init',
      cwd: box.cwd,
      session_id: SESSION_A,
      model: 'claude-sonnet-5-5',
      permissionMode: 'bypassPermissions',
      claude_code_version: '2.1.295',
      mcp_servers: [],
      uuid: expect.any(String),
    });
    expect(messages[0]!.tools).toEqual([
      'Agent',
      'Bash',
      'Edit',
      'Glob',
      'Grep',
      'NotebookEdit',
      'Read',
      'Skill',
      'WebFetch',
      'WebSearch',
      'Write',
    ]);
    const result = messages.at(-1)!;
    expect(result).toMatchObject({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: expect.stringContaining('All five tasks are done'),
      stop_reason: 'end_turn',
      terminal_reason: 'completed',
      session_id: SESSION_A,
      total_cost_usd: expect.any(Number),
      permission_denials: [],
    });
    expect(messages.filter((message) => message.type === 'result')).toHaveLength(1);

    const transcript = readTranscript(box, SESSION_A);
    const assistantLines = new Map(
      transcript.filter((line) => line.type === 'assistant').map((line) => [line.uuid, line]),
    );
    const assistant = messages.filter((message) => message.type === 'assistant');
    expect(assistant).toHaveLength(assistantLines.size);
    for (const message of assistant) {
      const line = assistantLines.get(message.uuid)!;
      expect(message.session_id).toBe(SESSION_A);
      expect(message.parent_tool_use_id).toBeNull();
      expect(message.message.content).toEqual(line.message.content);
      expect(message.message.id).toBe(line.message.id);
      // While streaming, stop_reason is null; the transcript carries the final one.
      expect(message.message.stop_reason).toBeNull();
    }
    const toolResults = transcript.filter(
      (line) => line.type === 'user' && Array.isArray(line.message.content),
    );
    const users = messages.filter((message) => message.type === 'user');
    expect(users.map((message) => message.uuid)).toEqual(toolResults.map((line) => line.uuid));
    expect(users.map((message) => message.tool_use_result)).toEqual(
      toolResults.map((line) => line.toolUseResult),
    );

    // One system/status "requesting" before every API request; one allowed rate_limit_event after the first.
    const requesting = messages.filter((message) => message.subtype === 'status');
    expect(requesting.every((message) => message.status === 'requesting')).toBe(true);
    expect(requesting).toHaveLength(result.num_turns);
    const firstAssistant = messages.findIndex((message) => message.type === 'assistant');
    expect(
      messages.findIndex((message) => message.type === 'system' && message.subtype === 'status'),
    ).toBeLessThan(firstAssistant);
    const allowed = messages.filter((message) => message.type === 'rate_limit_event');
    expect(allowed).toEqual([
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', resetsAt: expect.any(Number), rateLimitType: 'five_hour' },
        uuid: expect.any(String),
        session_id: SESSION_A,
      },
    ]);
    // Thinking progress frames add up to each think step's output tokens.
    const thinking = messages.filter((message) => message.subtype === 'thinking_tokens');
    expect(thinking.length).toBeGreaterThanOrEqual(18);
    expect(thinking.reduce((sum, message) => sum + message.estimated_tokens_delta, 0)).toBe(2210);
    expect(messages.some((message) => message.type === 'stream_event')).toBe(false);
  });

  it('with --include-partial-messages streams content_block_delta events spaced in time during think steps', async () => {
    const writes: { at: number; message: Record<string, any> }[] = [];
    let buffer = '';
    const stdout = {
      write(chunk: string) {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          writes.push({ at: performance.now(), message: JSON.parse(buffer.slice(0, newline)) });
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
        return true;
      },
    };
    const code = await runClaudeSim(
      ['-p', '--session-id', SESSION_A, ...STREAM, '--include-partial-messages', 'go'],
      simEnv(box, {
        CLAUDE_SIM_SPEED: '1',
        ...scenario([
          {
            kind: 'think',
            ms: 400,
            outputTokens: 120,
            thinking: 'Weighing the options before writing code.',
          },
          { kind: 'text', text: 'Here is the plan.' },
          { kind: 'endTurn' },
        ]),
      }),
      { cwd: box.cwd, stdout, stderr: { write: () => true }, homeDir: box.home },
    );
    expect(code).toBe(0);
    const events = writes.filter((write) => write.message.type === 'stream_event');
    expect(events.map((write) => write.message.event.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    const thinkingDeltas = events.filter((write) => write.message.event.delta?.type === 'thinking_delta');
    expect(thinkingDeltas).toHaveLength(3);
    expect(thinkingDeltas.map((write) => write.message.event.delta.thinking).join('')).toBe(
      'Weighing the options before writing code.',
    );
    expect(thinkingDeltas.map((write) => write.message.event.delta.estimated_tokens)).toEqual([40, 40, 40]);
    // Spread over the think step's 400ms rather than emitted in one burst.
    expect(thinkingDeltas[2]!.at - thinkingDeltas[0]!.at).toBeGreaterThanOrEqual(150);
    const textDeltas = events.filter((write) => write.message.event.delta?.type === 'text_delta');
    expect(textDeltas.map((write) => write.message.event.delta.text).join('')).toBe('Here is the plan.');
    expect(events[0]!.message).toMatchObject({
      session_id: SESSION_A,
      parent_tool_use_id: null,
      event: { message: { model: 'claude-sonnet-5-5' } },
    });
    expect(events.at(-2)!.message.event).toEqual({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 120 },
    });
  });

  it('streams tool_use input as input_json_delta', async () => {
    const run = await runSim(box, ['-p', ...STREAM, '--include-partial-messages', ...YOLO, 'go'], {
      env: scenario([{ kind: 'tool', name: 'Glob', input: { pattern: '*.md' } }, { kind: 'endTurn' }]),
    });
    const deltas = parseLines(run.stdout).filter(
      (message) => message.event?.delta?.type === 'input_json_delta',
    );
    expect(deltas.map((message) => message.event.delta.partial_json)).toEqual(['{"pattern":"*.md"}']);
  });
});

describe('output formats', () => {
  it('stream-json requires --verbose, like the real CLI', async () => {
    expect(await runSim(box, ['-p', '--output-format', 'stream-json', 'hi'])).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Error: When using --print, --output-format=stream-json requires --verbose\n',
    });
  });

  it('json prints one result object, or every message as an array with --verbose', async () => {
    const env = scenario([{ kind: 'text', text: 'Hello.' }, { kind: 'endTurn' }]);
    const single = await runSim(box, ['-p', '--output-format', 'json', 'hi'], { env });
    expect(JSON.parse(single.stdout)).toMatchObject({ type: 'result', result: 'Hello.', num_turns: 1 });
    const verbose = await runSim(box, ['-p', '--output-format', 'json', '--verbose', 'hi'], { env });
    const all = JSON.parse(verbose.stdout) as Record<string, any>[];
    expect(all[0]).toMatchObject({ type: 'system', subtype: 'init' });
    expect(all.at(-1)).toMatchObject({ type: 'result', result: 'Hello.' });
    expect(all.some((message) => message.type === 'assistant')).toBe(true);
  });

  it('text prints the final result', async () => {
    const run = await runSim(box, ['-p', 'hi'], {
      env: scenario([{ kind: 'text', text: 'Hello there.' }, { kind: 'endTurn' }]),
    });
    expect(run).toEqual({ code: 0, stdout: 'Hello there.\n', stderr: '' });
  });
});

describe('usage limit', () => {
  const NOW = Date.parse('2026-10-09T05:25:00.000Z');
  const RESET = Date.parse('2026-10-09T07:00:00.000Z') / 1000;

  it('emits the rejected rate_limit_event, a synthetic error message, StopFailure and an is_error result, then exits 1', async () => {
    const hookLog = box.file('hooks.jsonl');
    const settings = hookSettings({
      StopFailure: [{ matcher: 'rate_limit', command: 'cat >> "$HOOK_LOG"; echo >> "$HOOK_LOG"' }],
      Stop: [{ command: 'cat >> "$HOOK_LOG"; echo >> "$HOOK_LOG"' }],
    });
    const run = await runSim(
      box,
      [
        '-p',
        '--session-id',
        SESSION_A,
        ...STREAM,
        '--settings',
        settings,
        '--permission-mode',
        'acceptEdits',
        'go',
      ],
      {
        env: { CLAUDE_SIM_SCENARIO: 'throttle', TZ: 'Asia/Kuala_Lumpur', HOOK_LOG: hookLog },
        now: () => NOW,
      },
    );
    expect(run.code).toBe(1);
    const text = "You've hit your session limit · resets 3pm (Asia/Kuala_Lumpur)";
    const messages = parseLines(run.stdout);
    expect(
      messages
        .filter((message) => message.type === 'rate_limit_event')
        .map((message) => message.rate_limit_info),
    ).toEqual([
      { status: 'allowed', resetsAt: expect.any(Number), rateLimitType: 'five_hour' },
      { status: 'rejected', resetsAt: RESET, rateLimitType: 'five_hour' },
    ]);
    const result = messages.at(-1)!;
    expect(result).toMatchObject({
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 429,
      result: text,
      stop_reason: 'stop_sequence',
    });
    const lastAssistant = messages.filter((message) => message.type === 'assistant').at(-1)!;
    expect(lastAssistant).toMatchObject({
      error: 'rate_limit',
      message: { model: '<synthetic>', content: [{ type: 'text', text }] },
    });

    const line = readTranscript(box, SESSION_A)
      .filter((entry) => entry.type === 'assistant')
      .at(-1)!;
    expect(line).toMatchObject({
      isApiErrorMessage: true,
      error: 'rate_limit',
      apiError: 'usage_limit_reached',
      message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text }] },
    });
    const hooks = readJsonLines(hookLog);
    expect(hooks.map((input) => input.hook_event_name)).toEqual(['StopFailure']);
    expect(hooks[0]).toMatchObject({ error: 'rate_limit', last_assistant_message: text });

    const resumed = await runSim(
      box,
      ['-p', 'The limit has reset.', '--resume', SESSION_A, '--permission-mode', 'acceptEdits'],
      {
        now: () => NOW + 2 * 3_600_000,
      },
    );
    expect(resumed).toMatchObject({ code: 0, stdout: 'Logging and redaction are both done.\n' });
  });

  it('offers the legacy and classic message forms', async () => {
    const env = {
      TZ: 'Asia/Kuala_Lumpur',
      ...scenario([
        { kind: 'rateLimit', resetsInMinutes: 95, form: 'legacy' },
        { kind: 'rateLimit', resetsInMinutes: 95, form: 'classic' },
        { kind: 'rateLimit', resetsInMinutes: 60 * 30, limit: 'weekly' },
      ]),
    };
    const legacy = await runSim(box, ['-p', '--session-id', SESSION_A, 'go'], { env, now: () => NOW });
    expect(legacy).toMatchObject({ code: 1, stdout: `Claude AI usage limit reached|${RESET}\n` });
    const classic = await runSim(box, ['-p', '--resume', SESSION_A, 'go'], { env, now: () => NOW });
    expect(classic.stdout).toBe('5-hour limit reached ∙ resets 3pm\n');
    const weekly = await runSim(box, ['-p', '--resume', SESSION_A, 'go'], { env, now: () => NOW });
    expect(weekly.stdout).toBe("You've hit your weekly limit · resets Oct 10, 7:25pm (Asia/Kuala_Lumpur)\n");
  });
});

describe('limits', () => {
  it('--max-budget-usd stops the session once this invocation has spent the budget', async () => {
    const run = await runSim(
      box,
      [
        '-p',
        '--output-format',
        'json',
        '--model',
        'opus',
        '--max-budget-usd',
        '0.5',
        '--permission-mode',
        'acceptEdits',
        'go',
      ],
      {
        env: { CLAUDE_SIM_SCENARIO: 'credit-burn' },
      },
    );
    expect(run.code).toBe(1);
    const result = JSON.parse(run.stdout);
    expect(result).toMatchObject({
      subtype: 'error_max_budget_usd',
      is_error: true,
      errors: ['Reached maximum budget ($0.5)'],
      terminal_reason: 'budget_exhausted',
    });
    expect(result.total_cost_usd).toBeGreaterThanOrEqual(0.5);
  });

  it('--max-turns stops the session with error_max_turns', async () => {
    const run = await runSim(box, [
      '-p',
      '--output-format',
      'json',
      '--max-turns',
      '2',
      '--dangerously-skip-permissions',
      'go',
    ]);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({
      subtype: 'error_max_turns',
      is_error: true,
      num_turns: 2,
      terminal_reason: 'max_turns',
    });
  });
});
