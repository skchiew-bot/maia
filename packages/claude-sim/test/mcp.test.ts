import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listBuiltInScenarios, mcpToolName } from '../src/index';
import { loadState } from '../src/state';
import {
  fakeAocConfig,
  hookSettings,
  inBatches,
  makeSandbox,
  parseLines,
  readJsonLines,
  readTranscript,
  runSim,
  SESSION_A,
  type Sandbox,
} from './helpers';

let box: Sandbox;
beforeEach(() => {
  box = makeSandbox();
});
afterEach(() => box.cleanup());

const GRANTS = ['--allowedTools', 'mcp__aoc', 'Bash', '--permission-mode', 'acceptEdits'];

describe('MCP', () => {
  it('connects stdio servers, lists their tools in system/init and round-trips tool calls', async () => {
    const log = box.file('aoc.jsonl');
    const config = JSON.parse(fakeAocConfig(log, { AOC_SESSION: 'from-config-env' }));
    config.mcpServers.broken = { command: path.join(box.root, 'no-such-server') };
    const hookLog = box.file('pre.jsonl');
    const settings = hookSettings({
      PreToolUse: [{ matcher: 'mcp__aoc__.*', command: 'cat >> "$HOOK_LOG"; echo >> "$HOOK_LOG"' }],
    });
    const run = await runSim(
      box,
      [
        '-p',
        'build it',
        '--session-id',
        SESSION_A,
        '--output-format',
        'stream-json',
        '--verbose',
        '--settings',
        settings,
        '--mcp-config',
        JSON.stringify(config),
        ...GRANTS,
      ],
      { env: { HOOK_LOG: hookLog } },
    );
    expect(run.code).toBe(0);
    const messages = parseLines(run.stdout);
    const init = messages[0]!;
    expect(init).toMatchObject({ type: 'system', subtype: 'init', session_id: SESSION_A });
    expect(init.mcp_servers).toEqual([
      { name: 'aoc', status: 'connected', source: 'dynamic' },
      { name: 'broken', status: 'failed', source: 'dynamic' },
    ]);
    expect(init.tools).toEqual(
      expect.arrayContaining([
        'Bash',
        'Edit',
        'Read',
        mcpToolName('aoc', 'declare_plan'),
        'mcp__aoc__task_done',
      ]),
    );

    const calls = readJsonLines(log);
    expect(calls.map((call) => call.tool)).toEqual([
      'declare_plan',
      'task_done',
      'task_done',
      'task_done',
      'task_done',
      'task_done',
    ]);
    expect(calls.every((call) => call.valid)).toBe(true);
    // The server got the config env merged over the session env.
    expect(calls[0]!.env.AOC_SESSION).toBe('from-config-env');
    // saveAs + templating: the diff summary saved from a bash step reached task_done's evidence.
    expect(calls[1]!.args).toEqual({
      task_id: 't1',
      evidence: {
        kind: 'diff',
        ref: 'src/greeting.ts',
        detail: ' src/greeting.ts | 3 +++\n 1 file changed, 3 insertions(+)'.trim(),
      },
    });
    expect(calls[2]!.args.evidence).toEqual({ kind: 'commit', ref: '4f2a9c1' });

    const results = readTranscript(box, SESSION_A).filter(
      (line) => line.type === 'user' && Array.isArray(line.message.content),
    );
    const declare = results.find((line) =>
      line.message.content[0].content?.[0]?.text?.includes('manifestVersion'),
    )!;
    expect(declare.message.content[0]).toMatchObject({
      type: 'tool_result',
      is_error: false,
      content: [{ type: 'text', text: expect.any(String) }],
    });
    expect(declare.toolUseResult).toEqual(declare.message.content[0].content);
    expect(JSON.parse(declare.message.content[0].content[0].text)).toMatchObject({ ok: true, totalTasks: 5 });

    const pre = readJsonLines(hookLog);
    expect(pre).toHaveLength(6);
    expect(pre[0]).toMatchObject({
      tool_name: 'mcp__aoc__declare_plan',
      mcp_server: { name: 'aoc', source: 'dynamic' },
    });
  });

  it('denies MCP tools without a grant in print mode, like Claude Code 2.1', async () => {
    const log = box.file('aoc.jsonl');
    const run = await runSim(box, [
      '-p',
      'x',
      '--session-id',
      SESSION_A,
      '--output-format',
      'json',
      '--mcp-config',
      fakeAocConfig(log),
      '--allowedTools',
      'mcp__aoc__declare_plan',
      '--permission-mode',
      'acceptEdits',
    ]);
    expect(run.code).toBe(0);
    const calls = readJsonLines(log);
    expect(calls.map((call) => call.tool)).toEqual(['declare_plan']);
    const errors = readTranscript(box, SESSION_A)
      .filter((line) => line.type === 'user' && Array.isArray(line.message.content))
      .map((line) => line.message.content[0])
      .filter((block) => block.is_error && String(block.content).includes('mcp__aoc__task_done'));
    expect(errors[0]!.content).toBe(
      "Claude requested permissions to use mcp__aoc__task_done, but you haven't granted it yet.",
    );
    const result = JSON.parse(run.stdout);
    expect(result.permission_denials.map((denial: { tool_name: string }) => denial.tool_name)).toEqual(
      expect.arrayContaining(['mcp__aoc__task_done', 'Bash']),
    );
  });

  it('ends the turn after request_decision and lets later steps use the saved decision id', async () => {
    const log = box.file('aoc.jsonl');
    const run = await runSim(
      box,
      [
        '-p',
        'ship it',
        '--session-id',
        SESSION_A,
        '--mcp-config',
        fakeAocConfig(log, { FAKE_AOC_DECISION_ID: 'dec_42' }),
        ...GRANTS,
      ],
      {
        env: { CLAUDE_SIM_SCENARIO: 'decision' },
      },
    );
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe("Decision dec_42 is waiting for an answer, so I'm ending my turn.");
    expect(readJsonLines(log).map((call) => call.tool)).toEqual([
      'declare_plan',
      'task_done',
      'request_decision',
    ]);
    const state = loadState(path.join(box.configDir, 'sim-state', `${SESSION_A}.json`))!;
    expect(state.saved.decision).toEqual({
      ok: true,
      decision_id: 'dec_42',
      instruction: 'End your turn now.',
    });
    expect(state.cursor).toBe(11);
  });

  it('honours boundary.continue=false from task_done by ending the turn; a resume continues the remaining tasks', async () => {
    const log = box.file('aoc.jsonl');
    const first = await runSim(
      box,
      [
        '-p',
        'rewrite the engine',
        '--session-id',
        SESSION_A,
        '--mcp-config',
        fakeAocConfig(log, { FAKE_AOC_BOUNDARY_AFTER: '2' }),
        ...GRANTS,
      ],
      {
        env: { CLAUDE_SIM_SCENARIO: 'credit-burn' },
      },
    );
    expect(first.code).toBe(0);
    expect(first.stdout.trim()).toBe(
      'Stopping at the task boundary (credit_cap). Credit cap reached: end your turn now.',
    );
    expect(fs.existsSync(path.join(box.cwd, 'src/engine/parser.ts'))).toBe(true);
    expect(fs.existsSync(path.join(box.cwd, 'src/engine/evaluate.ts'))).toBe(false);

    const second = await runSim(box, [
      '-p',
      'Credits topped up; continue.',
      '--resume',
      SESSION_A,
      '--mcp-config',
      fakeAocConfig(log),
      ...GRANTS,
    ]);
    expect(second.code).toBe(0);
    expect(second.stdout.trim()).toBe('All four engine tasks are done.');
    expect(
      readJsonLines(log)
        .filter((call) => call.tool === 'task_done')
        .map((call) => call.args.task_id),
    ).toEqual(['t1', 't2', 't3', 't4']);
  });

  it('ignores the boundary when a step opts out with obey:false', async () => {
    const log = box.file('aoc.jsonl');
    const file = box.file('defiant.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        name: 'defiant',
        steps: [
          {
            kind: 'mcp',
            server: 'aoc',
            tool: 'task_done',
            args: { task_id: 't1', evidence: { kind: 'diff', ref: 'a' } },
            obey: false,
          },
          { kind: 'text', text: 'Carrying on regardless.' },
          { kind: 'tool', name: 'Write', input: { file_path: 'after-boundary.txt', content: 'x' } },
          { kind: 'endTurn' },
        ],
      }),
    );
    const run = await runSim(
      box,
      ['-p', 'x', '--mcp-config', fakeAocConfig(log, { FAKE_AOC_BOUNDARY_AFTER: '1' }), ...GRANTS],
      {
        env: { CLAUDE_SIM_SCENARIO: file },
      },
    );
    expect(run.code).toBe(0);
    expect(fs.existsSync(path.join(box.cwd, 'after-boundary.txt'))).toBe(true);
  });

  it('every built-in scenario sends contract-valid AOC payloads (resuming through every branch)', async () => {
    const resumes: Record<string, string[]> = {
      decision: ['Decision dec_1 answered: option a', 'nudge'],
      'protected-push': ['Decision dec_1 answered: option b'],
      crash: ['restarted after the crash'],
      throttle: ['the usage limit has reset'],
    };
    const outcomes = await inBatches(
      listBuiltInScenarios().map((name, index) => async () => {
        const sandbox = makeSandbox();
        try {
          const log = sandbox.file('aoc.jsonl');
          const session = `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`;
          const mcp = fakeAocConfig(log);
          // A push blocked by policy, as a governed session would see it.
          const settings = hookSettings({
            PreToolUse: [
              {
                matcher: 'Bash',
                command: `cat | grep -q 'git push origin main' && { echo 'protected branch' >&2; exit 2; }; exit 0`,
              },
            ],
          });
          const codes: number[] = [];
          const env = { CLAUDE_SIM_SCENARIO: name, CLAUDE_SIM_SPEED: '0' };
          codes.push(
            (
              await runSim(
                sandbox,
                ['-p', 'go', '--session-id', session, '--settings', settings, '--mcp-config', mcp, ...GRANTS],
                { env },
              )
            ).code,
          );
          for (const prompt of resumes[name] ?? []) {
            codes.push(
              (
                await runSim(
                  sandbox,
                  ['-p', prompt, '--resume', session, '--settings', settings, '--mcp-config', mcp, ...GRANTS],
                  { env },
                )
              ).code,
            );
          }
          return { name, codes, calls: readJsonLines(log) };
        } finally {
          sandbox.cleanup();
        }
      }),
      4,
    );
    const byName = Object.fromEntries(outcomes.map((outcome) => [outcome.name, outcome]));
    for (const outcome of outcomes) {
      expect(outcome.calls.length, outcome.name).toBeGreaterThan(0);
      expect(
        outcome.calls.filter((call) => !call.valid),
        outcome.name,
      ).toEqual([]);
    }
    expect(byName.crash!.codes).toEqual([1, 0]);
    expect(byName.throttle!.codes).toEqual([1, 0]);
    expect(byName.decision!.calls.map((call) => call.tool)).toEqual([
      'declare_plan',
      'task_done',
      'request_decision',
      'task_done',
      'task_done',
    ]);
    expect(byName['protected-push']!.calls.map((call) => call.tool)).toEqual([
      'declare_plan',
      'task_done',
      'request_decision',
      'task_done',
    ]);
    expect(byName['protected-push']!.calls.at(-1)!.args.evidence.detail).toBe('Release PR #42 opened.');
    expect(byName.drift!.calls.map((call) => call.tool)).toContain('amend_plan');
    expect(byName.triage!.calls.find((call) => call.tool === 'report_diagnosis')!.args.confidence).toBe(0.82);
    expect(
      byName['triage-low-confidence']!.calls.find((call) => call.tool === 'report_diagnosis')!.args
        .confidence,
    ).toBe(0.35);
    expect(byName['evidence-missing']!.calls.map((call) => call.tool)).toEqual(['declare_plan', 'task_done']);
  }, 60_000);
});
