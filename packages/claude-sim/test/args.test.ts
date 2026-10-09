import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs, UsageError } from '../src/args';
import { makeSandbox, runSim, type Sandbox } from './helpers';

describe('parseArgs', () => {
  it('parses the flags the supervisor uses', () => {
    const options = parseArgs([
      '-p',
      'do the thing',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--session-id',
      '11111111-2222-4333-8444-555555555555',
      '--model',
      'opus',
      '--mcp-config',
      'a.json',
      '{"mcpServers":{}}',
      '--strict-mcp-config',
      '--settings',
      '{"hooks":{}}',
      '--append-system-prompt',
      'be brief',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Bash(git log:*),Edit',
      'mcp__aoc',
      '--disallowed-tools',
      'WebFetch',
      '--max-budget-usd',
      '2.5',
      '--add-dir',
      '../shared',
    ]);
    expect(options).toMatchObject({
      print: true,
      prompt: 'do the thing',
      outputFormat: 'stream-json',
      verbose: true,
      includePartialMessages: true,
      sessionId: '11111111-2222-4333-8444-555555555555',
      model: 'opus',
      mcpConfig: ['a.json', '{"mcpServers":{}}'],
      strictMcpConfig: true,
      settings: '{"hooks":{}}',
      appendSystemPrompt: 'be brief',
      permissionMode: 'acceptEdits',
      allowedTools: ['Bash(git log:*),Edit', 'mcp__aoc'],
      disallowedTools: ['WebFetch'],
      maxBudgetUsd: '2.5',
      addDir: ['../shared'],
    });
  });

  it('parses the argv exactly as the supervisor lays it out (variadics, --tools, then --model <id> -- <prompt>)', () => {
    // packages/supervisor buildClaudeArgs: a single-value flag after the variadic ones, `--` before the prompt.
    const options = parseArgs([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--mcp-config',
      '/s/mcp.json',
      '--strict-mcp-config',
      '--settings',
      '/s/settings.json',
      '--permission-mode',
      'dontAsk',
      '--append-system-prompt',
      '# AOC operating rules\n1. Declare your plan first.',
      '--tools',
      'Read,Glob,Grep',
      '--allowedTools',
      'mcp__aoc',
      '--disallowedTools',
      'Edit',
      'Write',
      'Bash',
      '--resume',
      '11111111-2222-4333-8444-555555555555',
      '--model',
      'claude-opus-5-5',
      '--',
      '- a prompt that starts with a dash',
    ]);
    expect(options).toMatchObject({
      print: true,
      mcpConfig: ['/s/mcp.json'],
      settings: '/s/settings.json',
      permissionMode: 'dontAsk',
      tools: ['Read,Glob,Grep'],
      allowedTools: ['mcp__aoc'],
      disallowedTools: ['Edit', 'Write', 'Bash'],
      resume: '11111111-2222-4333-8444-555555555555',
      model: 'claude-opus-5-5',
      prompt: '- a prompt that starts with a dash',
    });
  });

  it('lets variadic options swallow following positionals, like commander', () => {
    expect(parseArgs(['-p', '--allowedTools', 'Edit', 'my prompt'])).toMatchObject({
      allowedTools: ['Edit', 'my prompt'],
      prompt: undefined,
    });
    expect(parseArgs(['-p', '--allowedTools', 'Edit', '--', 'my prompt'])).toMatchObject({
      allowedTools: ['Edit'],
      prompt: 'my prompt',
    });
    expect(parseArgs(['-p', '--tools=Read', 'my prompt'])).toMatchObject({ tools: ['Read', 'my prompt'] });
  });

  it('handles optional values, short flags and the first positional as the prompt', () => {
    expect(parseArgs(['-r', 'abc', '-p', 'hi', 'extra'])).toMatchObject({
      resume: 'abc',
      print: true,
      prompt: 'hi',
    });
    expect(parseArgs(['-p', '-r'])).toMatchObject({ resume: true });
    expect(parseArgs(['-pc', 'hi'])).toMatchObject({ print: true, continue: true, prompt: 'hi' });
    expect(parseArgs(['--resume=abc', '-p'])).toMatchObject({ resume: 'abc' });
    expect(parseArgs(['--fork-session', '-c'])).toMatchObject({ forkSession: true, continue: true });
    expect(parseArgs(['--permission-mode', 'default'])).toMatchObject({ permissionMode: 'default' });
  });

  it('rejects unknown options, missing values and invalid choices with commander wording', () => {
    expect(() => parseArgs(['--frobnicate'])).toThrow(new UsageError("error: unknown option '--frobnicate'"));
    expect(() => parseArgs(['--model'])).toThrow(
      new UsageError("error: option '--model <model>' argument missing"),
    );
    expect(() => parseArgs(['--output-format', 'xml'])).toThrow(
      new UsageError(
        "error: option '--output-format <format>' argument 'xml' is invalid. Allowed choices are text, json, stream-json.",
      ),
    );
    expect(() => parseArgs(['--permission-mode', 'foo'])).toThrow(
      new UsageError(
        "error: option '--permission-mode <mode>' argument 'foo' is invalid. Allowed choices are acceptEdits, auto, bypassPermissions, manual, dontAsk, plan.",
      ),
    );
    expect(() => parseArgs(['--mcp-config'])).toThrow(
      new UsageError("error: option '--mcp-config <configs...>' argument missing"),
    );
  });
});

describe('CLI errors', () => {
  let box: Sandbox;
  beforeEach(() => {
    box = makeSandbox();
  });
  afterEach(() => box.cleanup());

  it('exits 1 when a variadic flag consumed the prompt and stdin is empty', async () => {
    expect(await runSim(box, ['-p', '--allowedTools', 'Edit', 'my prompt'])).toEqual({
      code: 1,
      stdout: '',
      stderr:
        'Error: Input must be provided either through stdin or as a prompt argument when using --print\n',
    });
  });

  it('reads the prompt from stdin when there is no prompt argument', async () => {
    const run = await runSim(box, ['-p', '--output-format', 'json'], {
      stdin: '[[scenario:triage]] the login page is slow\n',
    });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).result).toBe(
      'Diagnosis reported with confidence 0.82. No code was changed; ending my turn.',
    );
  });

  it('runs one turn per user message with --input-format stream-json', async () => {
    const stdin = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '[[scenario:decision]] ship it' } }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'option b' }] },
      }),
    ].join('\n');
    const run = await runSim(
      box,
      [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'acceptEdits',
      ],
      { stdin },
    );
    expect(run.code).toBe(0);
    const results = run.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, any>)
      .filter((message) => message.type === 'result');
    expect(results.map((result) => result.result)).toEqual([
      "Decision {{decision.decision_id}} is waiting for an answer, so I'm ending my turn.",
      'The merge is on hold as decided; the plan is amended and the release note records it.',
    ]);
  });

  it('reports configuration errors like the real CLI', async () => {
    expect(await runSim(box, ['-p', '--frobnicate', 'hi'])).toMatchObject({
      code: 1,
      stderr: "error: unknown option '--frobnicate'\n",
    });
    expect(await runSim(box, ['-p', '--settings', '/nonexistent/x.json', 'hi'])).toMatchObject({
      code: 1,
      stderr: 'Error: Settings file not found: /nonexistent/x.json\n',
    });
    expect(await runSim(box, ['-p', '--mcp-config', '/nonexistent/m.json', '--', 'hi'])).toMatchObject({
      code: 1,
      stderr: 'Error: Invalid MCP configuration:\nMCP config file not found: /nonexistent/m.json\n',
    });
    expect(
      await runSim(box, ['-p', 'hi'], { env: { CLAUDE_SIM_SCENARIO: 'no-such-scenario' } }),
    ).toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        'unknown scenario "no-such-scenario" (built-ins: happy-path, decision,',
      ),
    });
  });

  it('prints the version and help', async () => {
    expect(await runSim(box, ['--version'])).toEqual({
      code: 0,
      stdout: '2.1.295 (Claude Code)\n',
      stderr: '',
    });
    const help = await runSim(box, ['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('CLAUDE_SIM_SCENARIO');
  });
});
