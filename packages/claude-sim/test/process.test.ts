import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { simCommand } from '../src/index';
import {
  fakeAocConfig,
  hookSettings,
  makeSandbox,
  parseLines,
  readJsonLines,
  readTranscript,
  SESSION_A,
  spawnSim,
  transcriptFile,
  type Sandbox,
} from './helpers';

let box: Sandbox;
beforeEach(() => {
  box = makeSandbox();
});
afterEach(() => box.cleanup());

/** Wait until `predicate` holds (polling), failing after `ms`. */
async function until(predicate: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await delay(20);
  }
}

describe('the claude-sim executable', () => {
  it('simCommand() spawns the launcher', async () => {
    const { command, args } = simCommand();
    expect(command).toBe(process.execPath);
    expect(args).toHaveLength(1);
    expect(fs.existsSync(args[0]!)).toBe(true);
    const run = await spawnSim(box, ['--version']).done;
    expect(run).toMatchObject({ code: 0, stdout: '2.1.295 (Claude Code)\n' });
  });

  it('runs a governed session end to end over real stdio: hooks, MCP, stream-json, resume', async () => {
    const log = box.file('aoc.jsonl');
    const hookLog = box.file('hooks.jsonl');
    const settings = hookSettings({
      PreToolUse: [{ matcher: 'Edit|Write', command: 'cat >> "$HOOK_LOG"; echo >> "$HOOK_LOG"' }],
      SessionEnd: [{ command: 'cat >> "$HOOK_LOG"; echo >> "$HOOK_LOG"' }],
    });
    const args = [
      '--settings',
      settings,
      '--mcp-config',
      fakeAocConfig(log, { FAKE_AOC_DECISION_ID: 'dec_e2e' }),
      '--allowedTools',
      'mcp__aoc',
      '--permission-mode',
      'acceptEdits',
    ];
    const first = await spawnSim(
      box,
      [
        '-p',
        '[[scenario:decision]] ship the greeting',
        '--session-id',
        SESSION_A,
        '--output-format',
        'stream-json',
        '--verbose',
        ...args,
      ],
      {
        HOOK_LOG: hookLog,
      },
    ).done;
    expect(first.code).toBe(0);
    const messages = parseLines(first.stdout);
    expect(messages[0]).toMatchObject({
      type: 'system',
      subtype: 'init',
      mcp_servers: [{ name: 'aoc', status: 'connected', source: 'dynamic' }],
    });
    expect(messages.at(-1)).toMatchObject({
      type: 'result',
      result: "Decision dec_e2e is waiting for an answer, so I'm ending my turn.",
    });

    const second = await spawnSim(
      box,
      [
        '-p',
        'Decision dec_e2e answered: option b',
        '--resume',
        SESSION_A,
        '--output-format',
        'json',
        ...args,
      ],
      {
        HOOK_LOG: hookLog,
      },
    ).done;
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({
      session_id: SESSION_A,
      result: expect.stringContaining('on hold'),
    });
    expect(readJsonLines(log).map((call) => call.tool)).toEqual([
      'declare_plan',
      'task_done',
      'request_decision',
      'amend_plan',
      'task_done',
    ]);
    const hooks = readJsonLines(hookLog);
    expect(
      hooks.filter((input) => input.hook_event_name === 'PreToolUse').map((input) => input.tool_name),
    ).toEqual(['Write', 'Write']);
    expect(hooks.filter((input) => input.hook_event_name === 'SessionEnd')).toHaveLength(2);
  });

  it('crash: exits with the step code and prints no result line', async () => {
    const run = await spawnSim(
      box,
      ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', 'build'],
      {
        CLAUDE_SIM_SCENARIO: 'crash',
      },
    ).done;
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('simulated crash');
    const messages = parseLines(run.stdout);
    expect(messages.length).toBeGreaterThan(3);
    expect(messages.some((message) => message.type === 'result')).toBe(false);
  });

  it('hang: no output while hanging; SIGTERM exits 143 without a result, SessionEnd still fires', async () => {
    const hookLog = box.file('hooks.jsonl');
    const settings = hookSettings({ SessionEnd: [{ command: 'cat >> "$HOOK_LOG"; echo >> "$HOOK_LOG"' }] });
    const hanging = spawnSim(
      box,
      [
        '-p',
        'import the rows',
        '--session-id',
        SESSION_A,
        '--output-format',
        'stream-json',
        '--verbose',
        '--settings',
        settings,
        '--permission-mode',
        'acceptEdits',
      ],
      { CLAUDE_SIM_SCENARIO: 'stall', HOOK_LOG: hookLog },
    );
    // Once the Write before the hang has its tool result, the session must go completely silent.
    await until(() =>
      parseLines(hanging.stdout()).some((message) => message.tool_use_result?.type === 'create'),
    );
    const stdoutBefore = hanging.stdout();
    const transcript = transcriptFile(box, SESSION_A);
    const transcriptBefore = fs.readFileSync(transcript, 'utf8');
    await delay(1500);
    expect(hanging.stdout()).toBe(stdoutBefore);
    expect(fs.readFileSync(transcript, 'utf8')).toBe(transcriptBefore);

    hanging.child.kill('SIGTERM');
    const result = await hanging.done;
    expect(result.code).toBe(143);
    expect(parseLines(result.stdout).some((message) => message.type === 'result')).toBe(false);
    expect(readJsonLines(hookLog).map((input) => input.reason)).toEqual(['other']);
    expect(readTranscript(box, SESSION_A).some((line) => line.type === 'cost-state')).toBe(false);
  }, 30_000);

  // Real Claude Code 2.1.295: SIGINT is not SIGTERM. The turn ends cleanly — the pending tool call is rejected, the
  // interruption is written down, a result of subtype error_during_execution is printed, the cost state is saved,
  // SessionEnd fires, no Stop hook runs, and the exit status is 0 (the supervisor relies on this for nudges and stops).
  it('hang: SIGINT ends the turn cleanly (error_during_execution, aborted_streaming, exit 0) and the session resumes', async () => {
    const hookLog = box.file('hooks.jsonl');
    const settings = hookSettings({
      Stop: [{ command: 'cat >> "$HOOK_LOG"; echo >> "$HOOK_LOG"' }],
      SessionEnd: [{ command: 'cat >> "$HOOK_LOG"; echo >> "$HOOK_LOG"' }],
    });
    const common = ['--session-id', SESSION_A, '--output-format', 'stream-json', '--verbose', '--settings', settings, '--permission-mode', 'acceptEdits'];
    const hanging = spawnSim(box, ['-p', 'import the rows', ...common], { CLAUDE_SIM_SCENARIO: 'stall', HOOK_LOG: hookLog });
    await until(() => parseLines(hanging.stdout()).some((message) => message.tool_use_result?.type === 'create'));
    hanging.child.kill('SIGINT');
    const run = await hanging.done;
    expect(run.code).toBe(0);
    const messages = parseLines(run.stdout);
    const result = messages.find((message) => message.type === 'result')!;
    expect(result).toMatchObject({
      subtype: 'error_during_execution',
      is_error: true,
      stop_reason: 'tool_use',
      terminal_reason: 'aborted_streaming',
      errors: [expect.stringContaining('[ede_diagnostic]')],
    });
    expect(result).not.toHaveProperty('result');
    expect(messages.at(-1)).toBe(result);
    expect(messages.filter((message) => message.type === 'user').at(-1)!.message.content).toEqual([
      { type: 'text', text: '[Request interrupted by user]' },
    ]);
    // SessionEnd fires, Stop does not; the cost state is saved.
    expect(readJsonLines(hookLog).map((input) => input.hook_event_name)).toEqual(['SessionEnd']);
    expect(readTranscript(box, SESSION_A).filter((line) => line.type === 'cost-state')).toHaveLength(1);

    // The same conversation carries on with a resume.
    const resumed = await spawnSim(box, ['-p', 'continue', '--resume', SESSION_A, '--output-format', 'stream-json', '--verbose', '--settings', settings, '--permission-mode', 'acceptEdits'], {
      CLAUDE_SIM_SCENARIO: 'stall',
      HOOK_LOG: hookLog,
      CLAUDE_SIM_SPEED: '0.001',
    }).done;
    expect(parseLines(resumed.stdout)[0]).toMatchObject({ session_id: SESSION_A });
  }, 30_000);

  it('a SIGINT while a tool call is pending rejects it: the model reads "User rejected tool use", terminal reason aborted_tools', async () => {
    fs.writeFileSync(
      box.file('slow-tool.json'),
      JSON.stringify({ name: 'slow-tool', steps: [{ kind: 'bash', command: 'sleep 20; echo late', stdout: 'late', exec: true }, { kind: 'endTurn', final: true }] }),
    );
    const hanging = spawnSim(
      box,
      ['-p', 'go', '--session-id', SESSION_A, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'],
      { CLAUDE_SIM_EXEC: '1', CLAUDE_SIM_SCENARIO: box.file('slow-tool.json'), CLAUDE_SIM_SPEED: '1' },
    );
    await until(() => parseLines(hanging.stdout()).some((message) => message.type === 'assistant' && JSON.stringify(message).includes('"name":"Bash"')));
    hanging.child.kill('SIGINT');
    const run = await hanging.done;
    expect(run.code).toBe(0);
    const messages = parseLines(run.stdout);
    expect(messages.find((message) => message.type === 'result')).toMatchObject({ subtype: 'error_during_execution', terminal_reason: 'aborted_tools' });
    const rejected = messages.filter((message) => message.type === 'user');
    expect(rejected.at(-2)!.message.content[0]).toMatchObject({
      type: 'tool_result',
      is_error: true,
      content: expect.stringContaining("The user doesn't want to proceed with this tool use."),
    });
    expect(rejected.at(-2)!.tool_use_result).toBe('User rejected tool use');
    expect(rejected.at(-1)!.message.content).toEqual([{ type: 'text', text: '[Request interrupted by user for tool use]' }]);
  }, 30_000);
});
