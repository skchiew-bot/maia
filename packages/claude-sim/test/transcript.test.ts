import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectSlug } from '../src/index';
import { makeSandbox, readTranscript, runSim, SESSION_A, type Sandbox } from './helpers';

let box: Sandbox;
beforeEach(() => {
  box = makeSandbox();
});
afterEach(() => box.cleanup());

const YOLO = ['--dangerously-skip-permissions'];

function writeScenario(name: string, steps: unknown[]): string {
  const file = box.file(`${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ name, steps }));
  return file;
}

describe('transcript format', () => {
  it('names project dirs like Claude Code 2.1.295, including the hashed form past 200 characters', () => {
    expect(projectSlug('/tmp/aoc-capture/work')).toBe('-tmp-aoc-capture-work');
    const nested = '/home/dev/' + 'very-long-directory-name/'.repeat(9) + 'repo';
    expect(projectSlug(nested)).toBe('-home-dev-' + 'very-long-directory-name-'.repeat(7) + 'very-long-direc-gy7dfj');
  });

  it('writes Claude Code JSONL at <config>/projects/<cwd slug>/<session-id>.jsonl with the real envelope', async () => {
    const run = await runSim(box, ['-p', '--session-id', SESSION_A, '--model', 'opus', ...YOLO, 'build it']);
    expect(run.code).toBe(0);
    const expected = path.join(
      box.configDir,
      'projects',
      box.cwd.replace(/[^A-Za-z0-9]/g, '-'),
      `${SESSION_A}.jsonl`,
    );
    expect(fs.existsSync(expected)).toBe(true);

    const lines = readTranscript(box, SESSION_A);
    const chained = lines.filter((line) => typeof line.uuid === 'string');
    expect(chained[0]).toMatchObject({
      type: 'user',
      parentUuid: null,
      message: { role: 'user', content: 'build it' },
    });
    chained.forEach((line, i) => {
      expect(line.parentUuid).toBe(i === 0 ? null : chained[i - 1]!.uuid);
      expect(line).toMatchObject({
        isSidechain: false,
        sessionId: SESSION_A,
        cwd: box.cwd,
        userType: 'external',
        version: '2.1.295',
      });
      expect(new Date(line.timestamp).toISOString()).toBe(line.timestamp);
    });
    expect(new Set(chained.map((line) => line.uuid)).size).toBe(chained.length);

    const assistant = lines.filter((line) => line.type === 'assistant');
    expect(assistant.length).toBeGreaterThan(10);
    for (const line of assistant) {
      expect(line.message).toMatchObject({
        model: 'claude-opus-5-5',
        type: 'message',
        role: 'assistant',
        stop_sequence: null,
      });
      expect(line.message.id).toMatch(/^msg_01[A-Za-z0-9]{22}$/);
      expect(line.requestId).toMatch(/^req_01[A-Za-z0-9]{22}$/);
      expect(line.message.content).toHaveLength(1);
      expect(line.message.usage).toEqual({
        input_tokens: expect.any(Number),
        cache_creation_input_tokens: expect.any(Number),
        cache_read_input_tokens: expect.any(Number),
        output_tokens: expect.any(Number),
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: 'standard',
        cache_creation: {
          ephemeral_1h_input_tokens: line.message.usage.cache_creation_input_tokens,
          ephemeral_5m_input_tokens: 0,
        },
      });
    }
    expect(lines.at(-2)).toMatchObject({
      type: 'last-prompt',
      lastPrompt: 'build it',
      sessionId: SESSION_A,
      leafUuid: chained.at(-1)!.uuid,
    });
    expect(lines.at(-1)).toMatchObject({
      type: 'cost-state',
      sessionId: SESSION_A,
      totalCostUSD: expect.any(Number),
      totalLinesAdded: expect.any(Number),
      modelUsage: { 'claude-opus-5-5': { outputTokens: expect.any(Number), thinkingTokens: 2210 } },
      hasUnknownModelCost: false,
    });
    // Claude Code's redacted thinking: an empty thinking text unless the scenario provides one.
    const thinking = assistant
      .map((line) => line.message.content[0])
      .filter((block) => block.type === 'thinking');
    expect(thinking[0]).toMatchObject({
      thinking: expect.stringContaining('greeting feature'),
      signature: expect.any(String),
    });
    expect(thinking[1]).toMatchObject({ thinking: '' });
  });

  it('repeats message.id, requestId and usage on every block line of one API response (dedupe by message.id)', async () => {
    const run = await runSim(box, [
      '-p',
      '--session-id',
      SESSION_A,
      '--output-format',
      'json',
      ...YOLO,
      'go',
    ]);
    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout);
    const assistant = readTranscript(box, SESSION_A).filter((line) => line.type === 'assistant');

    const groups = new Map<string, Record<string, any>[]>();
    for (const line of assistant) groups.set(line.message.id, [...(groups.get(line.message.id) ?? []), line]);
    expect([...groups.values()].some((group) => group.length >= 3)).toBe(true);
    for (const group of groups.values()) {
      const first = group[0]!;
      for (const line of group) {
        expect(line.requestId).toBe(first.requestId);
        expect(line.message.usage).toEqual(first.message.usage);
        expect(line.message.stop_reason).toBe(first.message.stop_reason);
      }
      const types = group.map((line) => line.message.content[0].type);
      expect(types.indexOf('thinking')).toBeLessThanOrEqual(0);
      expect(types.filter((type) => type === 'tool_use').length).toBeLessThanOrEqual(1);
      expect(first.message.stop_reason).toBe(types.at(-1) === 'tool_use' ? 'tool_use' : 'end_turn');
    }
    // Lines of one response are contiguous.
    const order = assistant.map((line) => line.message.id);
    expect(order.filter((id, i) => i === 0 || id !== order[i - 1]).length).toBe(groups.size);

    // Summing usage once per message.id reproduces the result's totals; summing per line would overcount.
    const unique = [...groups.values()].map((group) => group[0]!.message.usage);
    const sum = (key: string) => unique.reduce((total, usage) => total + usage[key], 0);
    expect(result.usage.output_tokens).toBe(sum('output_tokens'));
    expect(result.usage.cache_read_input_tokens).toBe(sum('cache_read_input_tokens'));
    expect(result.usage.cache_creation_input_tokens).toBe(sum('cache_creation_input_tokens'));
    expect(result.usage.input_tokens).toBe(sum('input_tokens'));
    expect(result.num_turns).toBe(groups.size);
    expect(assistant.reduce((total, line) => total + line.message.usage.output_tokens, 0)).toBeGreaterThan(
      result.usage.output_tokens,
    );
    // Think steps drive output tokens exactly (happy-path thinks: 420 + 260 + 380 + 210 + 300 + 640).
    expect(
      unique
        .filter((usage) => usage.output_tokens >= 200)
        .reduce((total, usage) => total + usage.output_tokens, 0),
    ).toBe(2210);
  });

  it('writes tool results as user lines with tool_result content, toolUseResult and sourceToolAssistantUUID', async () => {
    await runSim(box, ['-p', '--session-id', SESSION_A, ...YOLO, 'go']);
    const lines = readTranscript(box, SESSION_A);
    const toolUses = new Map<string, Record<string, any>>();
    for (const line of lines) {
      if (line.type === 'assistant' && line.message.content[0].type === 'tool_use')
        toolUses.set(line.message.content[0].id, line);
    }
    const results = lines.filter((line) => line.type === 'user' && Array.isArray(line.message.content));
    expect(results).toHaveLength(toolUses.size);
    for (const line of results) {
      const block = line.message.content[0];
      expect(block).toMatchObject({ type: 'tool_result', is_error: expect.any(Boolean) });
      const source = toolUses.get(block.tool_use_id);
      expect(source).toBeDefined();
      expect(line.sourceToolAssistantUUID).toBe(source!.uuid);
      expect(line.parentUuid).toBe(source!.uuid);
      expect(line).toHaveProperty('toolUseResult');
      expect(line.promptId).toBe(
        lines.find((l) => l.type === 'user' && typeof l.message.content === 'string')!.promptId,
      );
    }
    const write = results.find((line) => line.toolUseResult?.type === 'create');
    expect(write!.toolUseResult).toMatchObject({
      filePath: path.join(box.cwd, 'src/greeting.ts'),
      originalFile: null,
    });
    const read = results.find((line) => line.toolUseResult?.type === 'text');
    expect(read!.message.content[0].content).toContain('     1\texport function greet');
    const edit = results.find((line) => typeof line.toolUseResult?.oldString === 'string');
    expect(edit!.toolUseResult.structuredPatch[0].lines).toContain(
      '+  return `Hello, ${name}! Welcome aboard.`;',
    );
    const bash = results.find((line) => line.toolUseResult?.stdout === '4f2a9c1');
    expect(bash!.toolUseResult).toEqual({
      stdout: '4f2a9c1',
      stderr: '',
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
    });
    // Relative scenario paths reach tools (and hooks) as absolute paths, like a real model sends them.
    const writeUse = [...toolUses.values()].find((line) => line.message.content[0].name === 'Write')!;
    expect(writeUse.message.content[0].input.file_path).toBe(path.join(box.cwd, 'src/greeting.ts'));
  });

  it('maps model aliases and passes full ids through', async () => {
    const cases: [string, string][] = [
      ['opus', 'claude-opus-5-5'],
      ['sonnet', 'claude-sonnet-5-5'],
      ['haiku', 'claude-haiku-5-5'],
      ['fable', 'claude-fable-5-1'],
      ['sonnet[1m]', 'claude-sonnet-5-5'],
      ['claude-custom-9-9', 'claude-custom-9-9'],
    ];
    const scenario = writeScenario('tiny', [{ kind: 'text', text: 'hi' }, { kind: 'endTurn' }]);
    for (const [i, [alias, id]] of cases.entries()) {
      const session = `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;
      await runSim(box, ['-p', '--session-id', session, '--model', alias, 'x'], {
        env: { CLAUDE_SIM_SCENARIO: scenario },
      });
      expect(readTranscript(box, session).find((line) => line.type === 'assistant')!.message.model).toBe(id);
    }
    await runSim(box, ['-p', '--session-id', SESSION_A, 'x'], { env: { CLAUDE_SIM_SCENARIO: scenario } });
    expect(readTranscript(box, SESSION_A).find((line) => line.type === 'assistant')!.message.model).toBe(
      'claude-sonnet-5-5',
    );
  });

  it('applies built-in file tools to the real cwd', async () => {
    await runSim(box, ['-p', ...YOLO, 'go']);
    expect(fs.readFileSync(path.join(box.cwd, 'src/greeting.ts'), 'utf8')).toContain('Welcome aboard.');
    const cli = fs.readFileSync(path.join(box.cwd, 'src/cli.ts'), 'utf8');
    expect(cli).toContain("import { loadConfig } from './config';");
    expect(cli).toContain('loadConfig(process.env).defaultName');
    expect(fs.existsSync(path.join(box.cwd, 'docs/greet.md'))).toBe(true);
  });

  it('refuses to modify files outside the working directory, even with permissions bypassed', async () => {
    const scenario = writeScenario('escape', [
      { kind: 'tool', name: 'Write', input: { file_path: '../outside.txt', content: 'nope' } },
      { kind: 'tool', name: 'Edit', input: { file_path: '/etc/hostname', old_string: 'a', new_string: 'b' } },
      { kind: 'text', text: 'done' },
      { kind: 'endTurn' },
    ]);
    fs.symlinkSync(box.root, path.join(box.cwd, 'link'));
    const linked = writeScenario('symlink', [
      { kind: 'tool', name: 'Write', input: { file_path: 'link/escaped.txt', content: 'nope' } },
      { kind: 'endTurn' },
    ]);
    await runSim(box, ['-p', '--session-id', SESSION_A, ...YOLO, 'x'], {
      env: { CLAUDE_SIM_SCENARIO: scenario },
    });
    await runSim(box, ['-p', ...YOLO, 'x'], { env: { CLAUDE_SIM_SCENARIO: linked } });
    expect(fs.existsSync(box.file('outside.txt'))).toBe(false);
    expect(fs.existsSync(box.file('escaped.txt'))).toBe(false);
    const errors = readTranscript(box, SESSION_A)
      .filter((line) => line.type === 'user' && Array.isArray(line.message.content))
      .map((line) => line.message.content[0]);
    expect(errors).toHaveLength(2);
    for (const block of errors) {
      expect(block.is_error).toBe(true);
      expect(block.content).toContain('refuses to modify files outside the working directory');
    }
  });

  it('is deterministic: the same session id yields the same ids and structure', async () => {
    const other = makeSandbox();
    try {
      const fixedNow = () => Date.parse('2026-10-09T08:00:00.000Z');
      await runSim(box, ['-p', '--session-id', SESSION_A, ...YOLO, 'go'], { now: fixedNow });
      await runSim(other, ['-p', '--session-id', SESSION_A, ...YOLO, 'go'], { now: fixedNow });
      const strip = (lines: Record<string, any>[]) =>
        lines.map((line) =>
          JSON.stringify(line)
            .split(box.cwd)
            .join('<cwd>')
            .split(other.cwd)
            .join('<cwd>')
            .replace(/"durationMs":\d+/g, ''),
        );
      const ours = strip(readTranscript(box, SESSION_A));
      const theirs = strip(readTranscript(other, SESSION_A));
      expect(ours).toEqual(theirs);
    } finally {
      other.cleanup();
    }
  });

  it('honours --no-session-persistence', async () => {
    const run = await runSim(box, [
      '-p',
      '--session-id',
      SESSION_A,
      '--no-session-persistence',
      ...YOLO,
      'go',
    ]);
    expect(run.code).toBe(0);
    expect(fs.existsSync(path.join(box.configDir, 'projects'))).toBe(false);
    expect(fs.existsSync(path.join(box.configDir, 'sim-state'))).toBe(false);
  });
});
