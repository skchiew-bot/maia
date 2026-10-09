import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadState } from '../src/state';
import {
  fakeAocConfig,
  hookSettings,
  makeSandbox,
  parseLines,
  readJsonLines,
  readTranscript,
  runSim,
  SESSION_A,
  SESSION_B,
  type Sandbox,
} from './helpers';

let box: Sandbox;
beforeEach(() => {
  box = makeSandbox();
});
afterEach(() => box.cleanup());

const GRANTS = ['--allowedTools', 'mcp__aoc', 'Bash', '--permission-mode', 'acceptEdits'];
const statePath = (sessionId: string) => path.join(box.configDir, 'sim-state', `${sessionId}.json`);

describe('resume', () => {
  it('continues the scenario after the last endTurn, appending to the same transcript', async () => {
    const log = box.file('aoc.jsonl');
    const hookLog = box.file('session-start.jsonl');
    const settings = hookSettings({ SessionStart: [{ command: 'cat >> "$HOOK_LOG"; echo >> "$HOOK_LOG"' }] });
    const env = { CLAUDE_SIM_SCENARIO: 'decision', HOOK_LOG: hookLog };
    const mcp = fakeAocConfig(log, { FAKE_AOC_DECISION_ID: 'dec_7' });

    const first = await runSim(
      box,
      [
        '-p',
        'ship it',
        '--session-id',
        SESSION_A,
        '--output-format',
        'json',
        '--settings',
        settings,
        '--mcp-config',
        mcp,
        ...GRANTS,
      ],
      { env },
    );
    expect(first.code).toBe(0);
    const firstResult = JSON.parse(first.stdout);
    const afterFirst = readTranscript(box, SESSION_A);
    const leaf = afterFirst.filter((line) => typeof line.uuid === 'string').at(-1)!.uuid;

    const second = await runSim(
      box,
      [
        '-p',
        'Decision dec_7 answered: option b (hold the merge)',
        '--resume',
        SESSION_A,
        '--output-format',
        'json',
        '--settings',
        settings,
        '--mcp-config',
        mcp,
        ...GRANTS,
      ],
      { env: { HOOK_LOG: hookLog } },
    );
    expect(second.code).toBe(0);
    const secondResult = JSON.parse(second.stdout);
    expect(secondResult.result).toBe(
      'The merge is on hold as decided; the plan is amended and the release note records it.',
    );
    expect(secondResult.session_id).toBe(SESSION_A);
    expect(readJsonLines(log).map((call) => call.tool)).toEqual([
      'declare_plan',
      'task_done',
      'request_decision',
      'amend_plan',
      'task_done',
    ]);
    expect(fs.readFileSync(path.join(box.cwd, 'RELEASE_NOTES.md'), 'utf8')).toContain('on hold');

    // Same file, history kept, the new prompt chained onto the previous leaf.
    const all = readTranscript(box, SESSION_A);
    expect(all.slice(0, afterFirst.length)).toEqual(afterFirst);
    const resumedPrompt = all.slice(afterFirst.length).find((line) => line.type === 'user')!;
    expect(resumedPrompt).toMatchObject({
      parentUuid: leaf,
      message: { content: 'Decision dec_7 answered: option b (hold the merge)' },
    });
    expect(new Set(all.filter((line) => line.uuid).map((line) => line.uuid)).size).toBe(
      all.filter((line) => line.uuid).length,
    );

    // SessionStart: startup, then resume with the resumed context size.
    const starts = readJsonLines(hookLog);
    expect(starts.map((input) => input.source)).toEqual(['startup', 'resume']);
    const lastUsage = afterFirst.filter((line) => line.type === 'assistant').at(-1)!.message.usage;
    expect(starts[1]).toMatchObject({
      context_tokens:
        lastUsage.input_tokens +
        lastUsage.cache_read_input_tokens +
        lastUsage.cache_creation_input_tokens +
        lastUsage.output_tokens,
      seconds_since_last_response: expect.any(Number),
      prompt_cache_likely_expired: false,
      estimated_cache_write_usd: expect.any(Number),
    });

    // usage is per invocation; total_cost_usd and the cost-state line are cumulative.
    const costStates = all.filter((line) => line.type === 'cost-state');
    expect(costStates).toHaveLength(2);
    expect(costStates[0]!.totalCostUSD).toBe(firstResult.total_cost_usd);
    expect(costStates[1]!.totalCostUSD).toBe(secondResult.total_cost_usd);
    const sonnetCost = (usage: Record<string, number>) =>
      (usage.input_tokens! * 3 +
        usage.output_tokens! * 15 +
        usage.cache_creation_input_tokens! * 6 +
        usage.cache_read_input_tokens! * 0.3) /
      1e6;
    expect(firstResult.total_cost_usd).toBeCloseTo(sonnetCost(firstResult.usage), 5);
    expect(secondResult.total_cost_usd).toBeCloseTo(
      firstResult.total_cost_usd + sonnetCost(secondResult.usage),
      5,
    );
    const cumulative = costStates[1]!.modelUsage['claude-sonnet-5-5'];
    expect(cumulative.outputTokens).toBe(firstResult.usage.output_tokens + secondResult.usage.output_tokens);
    expect(secondResult.modelUsage['claude-sonnet-5-5'].outputTokens).toBe(cumulative.outputTokens);
    // The hold path ends with a final endTurn: the scenario is complete.
    expect(loadState(statePath(SESSION_A))!.cursor).toBe(26);
  });

  it('takes the hold branch on the supervisor’s answer line, which names the option by its label', async () => {
    // The supervisor resumes with `Decision <id> answered: <label>.` (prompts.ts decisionAnswersText), passed as
    // `--resume <id> … --model <id> -- <prompt>`.
    const env = { CLAUDE_SIM_SCENARIO: 'decision' };
    await runSim(box, ['-p', 'ship it', '--session-id', SESSION_A, '--permission-mode', 'acceptEdits'], { env });
    const resumed = await runSim(box, [
      '-p',
      '--resume',
      SESSION_A,
      '--permission-mode',
      'acceptEdits',
      '--model',
      'claude-opus-5-5',
      '--',
      'Decision dec_7 answered: Hold the merge.\n\nContinue with your declared plan in line with these answers.',
    ]);
    expect(resumed.stdout.trim()).toBe(
      'The merge is on hold as decided; the plan is amended and the release note records it.',
    );
  });

  it('takes the default branch when the resume prompt does not pick option b', async () => {
    const env = { CLAUDE_SIM_SCENARIO: 'decision' };
    await runSim(box, ['-p', 'ship it', '--session-id', SESSION_A, '--permission-mode', 'acceptEdits'], {
      env,
    });
    const resumed = await runSim(box, [
      '-p',
      'Decision answered: option a',
      '--resume',
      SESSION_A,
      '--permission-mode',
      'acceptEdits',
    ]);
    expect(resumed.stdout.trim()).toBe('Merged and documented; all three tasks are done.');
    // The scenario is complete: a further resume does no work.
    const again = await runSim(box, ['-p', 'anything else?', '--resume', SESSION_A]);
    expect(again.stdout.trim()).toBe('All scenario steps are complete; there is nothing further to do.');
  });

  it('fails like the real CLI when the session does not exist', async () => {
    const missing = '3f1c2a9e-1111-4222-8333-444455556666';
    const text = await runSim(box, ['-p', '--resume', missing, 'hi']);
    expect(text).toMatchObject({
      code: 1,
      stdout: '',
      stderr: `No conversation found with session ID: ${missing}\n`,
    });
    const stream = await runSim(box, [
      '-p',
      '--resume',
      missing,
      '--output-format',
      'stream-json',
      '--verbose',
      'hi',
    ]);
    expect(stream.code).toBe(1);
    expect(parseLines(stream.stdout)).toEqual([
      expect.objectContaining({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        session_id: missing,
        errors: [`No conversation found with session ID: ${missing}`],
      }),
    ]);
    const cont = await runSim(box, ['-p', '--continue', 'hi']);
    expect(cont).toMatchObject({ code: 1, stderr: 'No conversation found to continue\n' });
  });

  it('validates --session-id like the real CLI', async () => {
    expect(await runSim(box, ['-p', '--session-id', 'not-a-uuid', 'hi'])).toMatchObject({
      code: 1,
      stderr: 'Error: Invalid session ID. Must be a valid UUID.\n',
    });
    await runSim(box, ['-p', '--session-id', SESSION_A, 'hi']);
    expect(await runSim(box, ['-p', '--session-id', SESSION_A, 'hi'])).toMatchObject({
      code: 1,
      stderr: `Error: Session ID ${SESSION_A} is already in use.\n`,
    });
    expect(await runSim(box, ['-p', '--session-id', SESSION_B, '--resume', SESSION_A, 'hi'])).toMatchObject({
      code: 1,
      stderr:
        'Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.\n',
    });
  });

  it('--fork-session continues the history under a new session id', async () => {
    const hookLog = box.file('start.jsonl');
    const settings = hookSettings({ SessionStart: [{ command: 'cat >> "$HOOK_LOG"; echo >> "$HOOK_LOG"' }] });
    await runSim(box, ['-p', 'ship it', '--session-id', SESSION_A, '--permission-mode', 'acceptEdits'], {
      env: { CLAUDE_SIM_SCENARIO: 'decision' },
    });
    const original = readTranscript(box, SESSION_A);
    const fork = await runSim(
      box,
      [
        '-p',
        'option b',
        '--resume',
        SESSION_A,
        '--fork-session',
        '--session-id',
        SESSION_B,
        '--settings',
        settings,
        '--permission-mode',
        'acceptEdits',
      ],
      { env: { HOOK_LOG: hookLog } },
    );
    expect(fork.code).toBe(0);
    expect(fork.stdout.trim()).toBe(
      'The merge is on hold as decided; the plan is amended and the release note records it.',
    );
    expect(readTranscript(box, SESSION_A)).toEqual(original);
    const forked = readTranscript(box, SESSION_B);
    expect(forked.slice(0, original.length).map((line) => line.uuid)).toEqual(
      original.map((line) => line.uuid),
    );
    expect(forked.every((line) => line.sessionId === SESSION_B)).toBe(true);
    expect(readJsonLines(hookLog)[0]).toMatchObject({
      source: 'fork',
      session_id: SESSION_B,
      context_tokens: expect.any(Number),
    });
  });

  it('--continue resumes the most recent session in the directory', async () => {
    await runSim(box, ['-p', 'ship it', '--session-id', SESSION_A, '--permission-mode', 'acceptEdits'], {
      env: { CLAUDE_SIM_SCENARIO: 'decision' },
    });
    const run = await runSim(box, [
      '-p',
      '--continue',
      '--output-format',
      'json',
      'option b',
      '--permission-mode',
      'acceptEdits',
    ]);
    expect(JSON.parse(run.stdout)).toMatchObject({
      session_id: SESSION_A,
      result: expect.stringContaining('on hold'),
    });
  });

  it('a crash keeps the cursor after the crash step so a restart finishes the work', async () => {
    const env = { CLAUDE_SIM_SCENARIO: 'crash' };
    const crashed = await runSim(
      box,
      [
        '-p',
        'build the csv module',
        '--session-id',
        SESSION_A,
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'acceptEdits',
      ],
      { env },
    );
    expect(crashed.code).toBe(1);
    expect(crashed.stderr).toContain('simulated crash');
    expect(parseLines(crashed.stdout).some((message) => message.type === 'result')).toBe(false);
    const lines = readTranscript(box, SESSION_A);
    // The response being streamed when the process died was never written; no last-prompt, no cost-state.
    expect(lines.filter((line) => line.type === 'assistant').at(-1)!.message.content[0].type).toBe(
      'tool_use',
    );
    expect(lines.some((line) => line.type === 'cost-state' || line.type === 'last-prompt')).toBe(false);

    const restarted = await runSim(box, [
      '-p',
      'You were restarted; continue.',
      '--resume',
      SESSION_A,
      '--permission-mode',
      'acceptEdits',
    ]);
    expect(restarted).toMatchObject({ code: 0, stdout: 'Both CSV tasks are done.\n' });
    expect(fs.existsSync(path.join(box.cwd, 'src/csv/write.ts'))).toBe(true);
  });

  it('a scenario marker in a resume prompt switches scenario and restarts it', async () => {
    await runSim(box, ['-p', 'x', '--session-id', SESSION_A, '--permission-mode', 'acceptEdits'], {
      env: { CLAUDE_SIM_SCENARIO: 'decision' },
    });
    const run = await runSim(box, [
      '-p',
      '[[scenario:triage]] look into the login bug',
      '--resume',
      SESSION_A,
    ]);
    expect(run.stdout.trim()).toBe(
      'Diagnosis reported with confidence 0.82. No code was changed; ending my turn.',
    );
    expect(loadState(statePath(SESSION_A))!.scenario).toEqual({ kind: 'builtin', name: 'triage' });
  });
});

describe('transcript path', () => {
  it('uses $HOME/.claude when CLAUDE_CONFIG_DIR is unset', async () => {
    const run = await runSim(box, ['-p', '--session-id', SESSION_A, 'hi'], {
      env: { CLAUDE_CONFIG_DIR: '' },
    });
    expect(run.code).toBe(0);
    const expected = path.join(
      box.home,
      '.claude',
      'projects',
      box.cwd.replace(/[^A-Za-z0-9]/g, '-'),
      `${SESSION_A}.jsonl`,
    );
    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.existsSync(path.join(box.home, '.claude', 'sim-state', `${SESSION_A}.json`))).toBe(true);
  });
});
