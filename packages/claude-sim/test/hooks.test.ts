import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matcherMatches } from '../src/hooks';
import { loadState } from '../src/state';
import {
  hookSettings,
  makeSandbox,
  readJsonLines,
  readTranscript,
  runSim,
  SESSION_A,
  transcriptFile,
  type Sandbox,
} from './helpers';

let box: Sandbox;
beforeEach(() => {
  box = makeSandbox();
});
afterEach(() => box.cleanup());

function scenario(steps: unknown[]): Record<string, string> {
  const file = box.file('scenario.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'custom', steps }));
  return { CLAUDE_SIM_SCENARIO: file };
}

/** A hook that appends its stdin (one JSON line) to $HOOK_LOG. */
const LOG = 'cat >> "$HOOK_LOG"; echo >> "$HOOK_LOG"';
const toolResults = (sessionId: string) =>
  readTranscript(box, sessionId)
    .filter((line) => line.type === 'user' && Array.isArray(line.message.content))
    .map((line) => line.message.content[0]);
const attachments = (sessionId: string) =>
  readTranscript(box, sessionId)
    .filter((line) => line.type === 'attachment')
    .map((line) => line.attachment);

describe('matcherMatches', () => {
  it('follows Claude Code matcher semantics', () => {
    expect(matcherMatches(undefined, 'Edit', true)).toBe(true);
    expect(matcherMatches('', 'Edit', true)).toBe(true);
    expect(matcherMatches('*', 'Edit', true)).toBe(true);
    expect(matcherMatches('Edit|Write', 'Write', true)).toBe(true);
    expect(matcherMatches('Edit, Write', 'Write', true)).toBe(true);
    // Plain names match exactly; anything else is an unanchored regex.
    expect(matcherMatches('Edit', 'NotebookEdit', true)).toBe(false);
    expect(matcherMatches('.*Edit', 'NotebookEdit', true)).toBe(true);
    expect(matcherMatches('mcp__aoc__.*', 'mcp__aoc__task_done', true)).toBe(true);
    expect(matcherMatches('mcp__aoc__.*', 'mcp__other__x', true)).toBe(false);
    expect(matcherMatches('Bash(', 'Bash', true)).toBe(false);
    expect(matcherMatches('startup', 'resume', false)).toBe(false);
    expect(matcherMatches('startup|resume', 'resume', false)).toBe(true);
    // Events without a match target (Stop, UserPromptSubmit) run every hook.
    expect(matcherMatches('Edit', undefined, false)).toBe(true);
  });
});

describe('hooks', () => {
  it('invokes every event with the documented stdin fields and CLAUDE_PROJECT_DIR', async () => {
    const log = box.file('hooks.jsonl');
    const dirs = box.file('dirs.txt');
    const events = [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PostToolBatch',
      'Notification',
      'PreCompact',
      'Stop',
      'SessionEnd',
    ];
    const settings = hookSettings(
      Object.fromEntries(
        events.map((event) => [
          event,
          [{ command: `${LOG}; printf '%s\\n' "$CLAUDE_PROJECT_DIR" >> "$DIRS"` }],
        ]),
      ),
    );
    const run = await runSim(
      box,
      [
        '-p',
        '--session-id',
        SESSION_A,
        '--settings',
        settings,
        '--permission-mode',
        'acceptEdits',
        'hello hooks',
      ],
      {
        env: {
          HOOK_LOG: log,
          DIRS: dirs,
          ...scenario([
            { kind: 'think', ms: 100, outputTokens: 50 },
            { kind: 'tool', name: 'Write', input: { file_path: 'notes.txt', content: 'one\n' } },
            { kind: 'tool', name: 'Read', input: { file_path: 'missing.txt' } },
            { kind: 'notification', message: 'Claude is waiting for your input' },
            { kind: 'compact' },
            { kind: 'text', text: 'All done.' },
            { kind: 'endTurn' },
          ]),
        },
      },
    );
    expect(run.code).toBe(0);
    const calls = readJsonLines(log);
    expect(
      calls.map((call) => `${call.hook_event_name}${call.tool_name ? `:${call.tool_name}` : ''}`),
    ).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse:Write',
      'PostToolUse:Write',
      'PostToolBatch',
      'PreToolUse:Read',
      'PostToolUseFailure:Read',
      'PostToolBatch',
      'Notification',
      'PreCompact',
      'SessionStart',
      'Stop',
      'SessionEnd',
    ]);
    const common = {
      session_id: SESSION_A,
      transcript_path: transcriptFile(box, SESSION_A),
      cwd: box.cwd,
      permission_mode: 'acceptEdits',
    };
    for (const call of calls) expect(call).toMatchObject(common);
    const [start, submit, pre, post, batch, , failure, , notification, compact, compactStart, stop, end] =
      calls;
    expect(start).toEqual({
      ...common,
      hook_event_name: 'SessionStart',
      source: 'startup',
      model: 'claude-sonnet-5-5',
    });
    expect(submit).toMatchObject({ prompt: 'hello hooks', source: 'sdk', prompt_id: expect.any(String) });
    for (const call of calls.slice(1)) expect(call!.prompt_id).toBe(submit!.prompt_id);
    const file = path.join(box.cwd, 'notes.txt');
    expect(pre).toEqual({
      ...common,
      prompt_id: submit!.prompt_id,
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: file, content: 'one\n' },
      tool_use_id: expect.stringMatching(/^toolu_01/),
    });
    expect(post).toMatchObject({
      tool_name: 'Write',
      tool_use_id: pre!.tool_use_id,
      tool_response: { type: 'create', filePath: file, content: 'one\n' },
      duration_ms: expect.any(Number),
    });
    expect(batch).toMatchObject({
      tool_calls: [
        {
          tool_name: 'Write',
          tool_input: pre!.tool_input,
          tool_use_id: pre!.tool_use_id,
          tool_response: post!.tool_response,
        },
      ],
    });
    expect(failure).toMatchObject({
      tool_name: 'Read',
      error: expect.stringContaining('File does not exist'),
      is_interrupt: false,
    });
    expect(failure).not.toHaveProperty('tool_response');
    expect(notification).toMatchObject({
      message: 'Claude is waiting for your input',
      notification_type: 'idle_prompt',
    });
    expect(compact).toMatchObject({ trigger: 'auto', custom_instructions: null });
    expect(compactStart).toMatchObject({ source: 'compact' });
    expect(stop).toMatchObject({
      stop_hook_active: false,
      last_assistant_message: 'All done.',
      background_tasks: [],
      session_crons: [],
    });
    expect(end).toMatchObject({ reason: 'other' });
    expect(fs.readFileSync(dirs, 'utf8').trim().split('\n')).toEqual(calls.map(() => box.cwd));
  });

  it('exit 2 from PreToolUse blocks the tool and feeds stderr back as the tool_result error', async () => {
    const command = 'cat > /dev/null; echo "declare a plan before editing" >&2; exit 2';
    const settings = hookSettings({
      PreToolUse: [{ matcher: 'Edit|Write', command }],
      PostToolUse: [{ command: LOG }],
    });
    const run = await runSim(
      box,
      [
        '-p',
        '--session-id',
        SESSION_A,
        '--output-format',
        'json',
        '--settings',
        settings,
        '--dangerously-skip-permissions',
        'x',
      ],
      {
        env: {
          HOOK_LOG: box.file('post.jsonl'),
          ...scenario([
            { kind: 'tool', name: 'Write', input: { file_path: 'blocked.txt', content: 'nope' } },
            { kind: 'branch', onLastToolError: true, goto: 'blocked' },
            { kind: 'text', text: 'not blocked' },
            { kind: 'endTurn', final: true },
            { kind: 'text', label: 'blocked', text: 'The write was blocked.' },
            { kind: 'endTurn' },
          ]),
        },
      },
    );
    expect(run.code).toBe(0);
    expect(fs.existsSync(path.join(box.cwd, 'blocked.txt'))).toBe(false);
    expect(toolResults(SESSION_A)).toEqual([
      {
        tool_use_id: expect.any(String),
        type: 'tool_result',
        content: `PreToolUse:Write hook error: [${command}]: declare a plan before editing`,
        is_error: true,
      },
    ]);
    expect(readJsonLines(box.file('post.jsonl'))).toEqual([]);
    const result = JSON.parse(run.stdout);
    expect(result.result).toBe('The write was blocked.');
    expect(result.permission_denials).toEqual([
      {
        tool_name: 'Write',
        tool_use_id: expect.any(String),
        tool_input: { file_path: path.join(box.cwd, 'blocked.txt'), content: 'nope' },
      },
    ]);
  });

  it('honours JSON permissionDecision deny, ask (denied in print mode) and allow', async () => {
    const decide = (decision: string, reason?: string) =>
      `cat > /dev/null; echo '${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision,
          ...(reason && { permissionDecisionReason: reason }),
        },
      })}'`;
    const settings = hookSettings({
      PreToolUse: [
        { matcher: 'Bash', command: decide('deny', 'Pushing to main needs a decision card') },
        { matcher: 'Write', command: decide('ask', 'Writing here needs approval') },
        { matcher: 'Edit', command: decide('allow') },
      ],
    });
    const run = await runSim(box, ['-p', '--session-id', SESSION_A, '--settings', settings, 'x'], {
      env: scenario([
        { kind: 'bash', command: 'git push origin main', stdout: 'pushed' },
        { kind: 'tool', name: 'Write', input: { file_path: 'a.txt', content: 'a' } },
        // Default mode would deny Edit in print mode; the hook's allow grants it.
        { kind: 'tool', name: 'Edit', input: { file_path: 'b.txt', old_string: '', new_string: 'b' } },
        { kind: 'text', text: 'done' },
        { kind: 'endTurn' },
      ]),
    });
    expect(run.code).toBe(0);
    const [bash, write, edit] = toolResults(SESSION_A);
    expect(bash).toMatchObject({ is_error: true, content: 'Pushing to main needs a decision card' });
    expect(write).toMatchObject({ is_error: true, content: 'Writing here needs approval' });
    expect(edit).toMatchObject({ is_error: false });
    expect(fs.readFileSync(path.join(box.cwd, 'b.txt'), 'utf8')).toBe('b');
    expect(fs.existsSync(path.join(box.cwd, 'a.txt'))).toBe(false);
  });

  it('stops the session on continue:false and records the stop reason', async () => {
    const settings = hookSettings({
      PostToolUse: [
        {
          matcher: 'Write',
          command: `cat > /dev/null; echo '{"continue":false,"stopReason":"Credits frozen by the operator"}'`,
        },
      ],
    });
    const run = await runSim(
      box,
      [
        '-p',
        '--session-id',
        SESSION_A,
        '--output-format',
        'json',
        '--settings',
        settings,
        '--dangerously-skip-permissions',
        'x',
      ],
      {
        env: scenario([
          { kind: 'tool', name: 'Write', input: { file_path: 'first.txt', content: '1' } },
          { kind: 'tool', name: 'Write', input: { file_path: 'second.txt', content: '2' } },
          { kind: 'endTurn' },
        ]),
      },
    );
    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result).toMatchObject({
      subtype: 'success',
      is_error: false,
      result: 'Credits frozen by the operator',
      terminal_reason: 'hook_stopped',
    });
    expect(fs.existsSync(path.join(box.cwd, 'first.txt'))).toBe(true);
    expect(fs.existsSync(path.join(box.cwd, 'second.txt'))).toBe(false);
    expect(attachments(SESSION_A)).toContainEqual(
      expect.objectContaining({
        type: 'hook_stopped_continuation',
        message: 'Credits frozen by the operator',
        hookName: 'PostToolUse:Write',
      }),
    );
    // The next resume continues with the step after the stop.
    expect(loadState(path.join(box.configDir, 'sim-state', `${SESSION_A}.json`))!.cursor).toBe(1);
  });

  it('a blocking Stop hook continues the turn for one more step with the reason as input', async () => {
    const stopLog = box.file('stop.jsonl');
    const command =
      'input=$(cat); printf "%s\\n" "$input" >> "$HOOK_LOG"; case "$input" in ' +
      `*'"stop_hook_active":false'*) echo '{"decision":"block","reason":"Run the tests before stopping."}';; esac`;
    const run = await runSim(
      box,
      ['-p', '--session-id', SESSION_A, '--settings', hookSettings({ Stop: [{ command }] }), 'x'],
      {
        env: {
          HOOK_LOG: stopLog,
          ...scenario([
            { kind: 'text', text: 'Implemented the change.' },
            { kind: 'endTurn' },
            { kind: 'text', text: 'Ran the tests as asked: all green.' },
            { kind: 'endTurn' },
          ]),
        },
      },
    );
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe('Ran the tests as asked: all green.');
    expect(readJsonLines(stopLog).map((input) => input.stop_hook_active)).toEqual([false, true]);
    expect(readJsonLines(stopLog)[1]).toMatchObject({
      last_assistant_message: 'Ran the tests as asked: all green.',
    });
    expect(attachments(SESSION_A)).toContainEqual(
      expect.objectContaining({
        type: 'hook_blocking_error',
        hookName: 'Stop',
        blockingError: { blockingError: 'Run the tests before stopping.', command },
      }),
    );
    const summaries = readTranscript(box, SESSION_A).filter((line) => line.subtype === 'stop_hook_summary');
    expect(summaries.map((line) => line.preventedContinuation)).toEqual([true, false]);
  });

  it('records additionalContext and plain SessionStart output as hook_additional_context attachments', async () => {
    const settings = hookSettings({
      SessionStart: [
        { matcher: 'startup', command: 'cat > /dev/null; echo "Project AOC: declare a plan first."' },
      ],
      PostToolUse: [
        {
          matcher: 'Write',
          command: `cat > /dev/null; echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"lint passed"}}'`,
        },
      ],
      UserPromptSubmit: [{ command: 'cat > /dev/null; exit 1' }],
    });
    const run = await runSim(
      box,
      ['-p', '--session-id', SESSION_A, '--settings', settings, '--dangerously-skip-permissions', 'x'],
      {
        env: scenario([
          { kind: 'tool', name: 'Write', input: { file_path: 'a.txt', content: 'a' } },
          { kind: 'endTurn' },
        ]),
      },
    );
    expect(run.code).toBe(0);
    const lines = readTranscript(box, SESSION_A);
    const toolUse = lines.find((line) => line.type === 'assistant')!.message.content[0];
    expect(attachments(SESSION_A)).toEqual([
      {
        type: 'hook_additional_context',
        content: ['Project AOC: declare a plan first.'],
        hookName: 'SessionStart:startup',
        toolUseID: 'SessionStart',
        hookEvent: 'SessionStart',
      },
      expect.objectContaining({ type: 'hook_non_blocking_error', hookName: 'UserPromptSubmit', exitCode: 1 }),
      {
        type: 'hook_additional_context',
        content: ['lint passed'],
        hookName: 'PostToolUse:Write',
        toolUseID: toolUse.id,
        hookEvent: 'PostToolUse',
      },
    ]);
    // The prompt stays the root of the parentUuid chain.
    expect(lines.find((line) => typeof line.uuid === 'string')).toMatchObject({
      type: 'user',
      parentUuid: null,
    });
  });

  it('runs global hooks from CLAUDE_SIM_USER_SETTINGS alongside --settings hooks', async () => {
    const log = box.file('both.jsonl');
    const userSettings = box.file('user-settings.json');
    fs.writeFileSync(
      userSettings,
      hookSettings({ SessionStart: [{ command: `cat > /dev/null; echo user >> "$HOOK_LOG"` }] }),
    );
    const flag = hookSettings({ SessionStart: [{ command: `cat > /dev/null; echo flag >> "$HOOK_LOG"` }] });
    await runSim(box, ['-p', '--settings', flag, 'x'], {
      env: { HOOK_LOG: log, CLAUDE_SIM_USER_SETTINGS: userSettings },
    });
    expect(fs.readFileSync(log, 'utf8').trim().split('\n').sort()).toEqual(['flag', 'user']);
    // Observed sessions: only the global hooks.
    fs.rmSync(log);
    await runSim(box, ['-p', 'x'], { env: { HOOK_LOG: log, CLAUDE_SIM_USER_SETTINGS: userSettings } });
    expect(fs.readFileSync(log, 'utf8').trim()).toBe('user');
  });

  it('cancels hooks that exceed their timeout without failing the session', async () => {
    const settings = hookSettings({ SessionStart: [{ command: 'sleep 5', timeout: 0.2 }] });
    const started = Date.now();
    const run = await runSim(box, ['-p', '--session-id', SESSION_A, '--settings', settings, 'x'], {
      env: scenario([{ kind: 'text', text: 'ok' }, { kind: 'endTurn' }]),
    });
    expect(run.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(attachments(SESSION_A)).toContainEqual(
      expect.objectContaining({ type: 'hook_cancelled', hookName: 'SessionStart:startup', timedOut: true }),
    );
  });

  it('an abort (SIGTERM) kills running hooks, skips the tool and the result, but still runs SessionEnd', async () => {
    const log = box.file('end.jsonl');
    const settings = hookSettings({
      PreToolUse: [{ command: 'sleep 30 & sleep 30' }],
      SessionEnd: [{ command: LOG }],
    });
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort('SIGTERM'), 300);
    const run = await runSim(
      box,
      [
        '-p',
        '--session-id',
        SESSION_A,
        '--output-format',
        'stream-json',
        '--verbose',
        '--settings',
        settings,
        '--dangerously-skip-permissions',
        'x',
      ],
      {
        env: {
          HOOK_LOG: log,
          ...scenario([
            { kind: 'tool', name: 'Write', input: { file_path: 'never.txt', content: 'x' } },
            { kind: 'endTurn' },
          ]),
        },
        signal: controller.signal,
      },
    );
    expect(run.code).toBe(143);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(fs.existsSync(path.join(box.cwd, 'never.txt'))).toBe(false);
    expect(run.stdout).not.toContain('"type":"result"');
    expect(readJsonLines(log).map((input) => [input.hook_event_name, input.reason])).toEqual([
      ['SessionEnd', 'other'],
    ]);
    expect(readTranscript(box, SESSION_A).some((line) => line.type === 'cost-state')).toBe(false);
  });

  it('a blocking UserPromptSubmit hook rejects the prompt', async () => {
    const settings = hookSettings({
      UserPromptSubmit: [{ command: 'cat > /dev/null; echo "prompt rejected by policy" >&2; exit 2' }],
    });
    const run = await runSim(box, [
      '-p',
      '--session-id',
      SESSION_A,
      '--output-format',
      'json',
      '--settings',
      settings,
      'x',
    ]);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['UserPromptSubmit operation blocked by hook:\nprompt rejected by policy'],
    });
    expect(readTranscript(box, SESSION_A).some((line) => line.type === 'user')).toBe(false);
  });
});
