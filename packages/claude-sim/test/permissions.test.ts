import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decidePermission,
  parseRules,
  splitShellCommand,
  type PermissionMode,
  type PermissionPolicy,
} from '../src/permissions';
import { makeSandbox, parseLines, readTranscript, runSim, SESSION_A, type Sandbox } from './helpers';

const CWD = '/work/project';

function policy(mode: PermissionMode, allow: string[] = [], deny: string[] = []): PermissionPolicy {
  return {
    mode,
    allow: parseRules(allow),
    deny: parseRules(deny),
    cwd: CWD,
    workingDirs: [CWD],
    homeDir: '/home/dev',
  };
}

const PROMPT = (tool: string) => ({
  behavior: 'deny',
  message: `Claude requested permissions to use ${tool}, but you haven't granted it yet.`,
  source: 'prompt',
});

describe('permission rules', () => {
  it('parses rule lists with commas and spaces outside parentheses', () => {
    expect(parseRules(['Bash(git log:*),Edit', 'mcp__aoc Bash(npm run test, lint)'])).toEqual([
      { tool: 'Bash', content: 'git log:*' },
      { tool: 'Edit' },
      { tool: 'mcp__aoc' },
      { tool: 'Bash', content: 'npm run test, lint' },
    ]);
    expect(splitShellCommand(`cd app && git push origin main; echo "a && b" | tee x`)).toEqual([
      'cd app',
      'git push origin main',
      'echo "a && b"',
      'tee x',
    ]);
  });

  it('denies what would need a prompt in print mode, and allows read-only work inside the working directory', () => {
    const p = policy('default');
    expect(decidePermission(p, 'Read', { file_path: `${CWD}/a.ts` })).toEqual({ behavior: 'allow' });
    expect(decidePermission(p, 'Grep', { pattern: 'x' })).toEqual({ behavior: 'allow' });
    expect(decidePermission(p, 'Read', { file_path: '/etc/passwd' })).toEqual(PROMPT('Read'));
    expect(decidePermission(p, 'Write', { file_path: `${CWD}/a.ts`, content: '' })).toEqual(PROMPT('Write'));
    expect(decidePermission(p, 'Bash', { command: 'ls' })).toEqual(PROMPT('Bash'));
    expect(decidePermission(p, 'mcp__aoc__task_done', {})).toEqual(PROMPT('mcp__aoc__task_done'));
  });

  it('acceptEdits allows edits inside the working directory only; bypassPermissions allows everything', () => {
    expect(decidePermission(policy('acceptEdits'), 'Edit', { file_path: `${CWD}/a.ts` })).toEqual({
      behavior: 'allow',
    });
    expect(decidePermission(policy('acceptEdits'), 'Edit', { file_path: '/tmp/a.ts' })).toEqual(
      PROMPT('Edit'),
    );
    expect(decidePermission(policy('acceptEdits'), 'mcp__aoc__declare_plan', {})).toEqual(
      PROMPT('mcp__aoc__declare_plan'),
    );
    expect(decidePermission(policy('bypassPermissions'), 'mcp__aoc__declare_plan', {})).toEqual({
      behavior: 'allow',
    });
    expect(decidePermission(policy('bypassPermissions'), 'Bash', { command: 'rm -rf build' })).toEqual({
      behavior: 'allow',
    });
  });

  it('matches allow rules: MCP server-level and per-tool, Bash prefixes, every sub-command of a compound command', () => {
    const p = policy('default', [
      'mcp__aoc',
      'mcp__other__ping',
      'Bash(git diff:*)',
      'Bash(npm test)',
      'Edit(src/**)',
    ]);
    expect(decidePermission(p, 'mcp__aoc__task_done', {})).toEqual({ behavior: 'allow' });
    expect(decidePermission(p, 'mcp__other__ping', {})).toEqual({ behavior: 'allow' });
    expect(decidePermission(p, 'mcp__other__pong', {})).toEqual(PROMPT('mcp__other__pong'));
    expect(decidePermission(p, 'Bash', { command: 'git diff --stat' })).toEqual({ behavior: 'allow' });
    expect(decidePermission(p, 'Bash', { command: 'git diff --stat && npm test' })).toEqual({
      behavior: 'allow',
    });
    expect(decidePermission(p, 'Bash', { command: 'git diff && git push origin main' })).toEqual(
      PROMPT('Bash'),
    );
    expect(decidePermission(p, 'Bash', { command: 'git diffx' })).toEqual(PROMPT('Bash'));
    expect(decidePermission(p, 'Write', { file_path: `${CWD}/src/deep/a.ts` })).toEqual({
      behavior: 'allow',
    });
    expect(decidePermission(p, 'Write', { file_path: `${CWD}/docs/a.md` })).toEqual(PROMPT('Write'));
  });

  it('deny rules win over modes, grants and hook approvals', () => {
    const p = policy('bypassPermissions', ['Bash'], ['Bash(git push:*)', 'WebFetch']);
    const push = {
      behavior: 'deny',
      message: 'Permission to use Bash with command cd app && git push origin main has been denied.',
      source: 'rule',
    };
    expect(decidePermission(p, 'Bash', { command: 'cd app && git push origin main' })).toEqual(push);
    expect(
      decidePermission(p, 'Bash', { command: 'cd app && git push origin main' }, { behavior: 'allow' }),
    ).toEqual(push);
    expect(decidePermission(p, 'WebFetch', { url: 'https://example.com' })).toEqual({
      behavior: 'deny',
      message: 'Permission to use WebFetch has been denied.',
      source: 'rule',
    });
    expect(decidePermission(p, 'Bash', { command: 'git status' })).toEqual({ behavior: 'allow' });
  });

  it('hook decisions: deny and ask deny, allow grants', () => {
    const p = policy('default');
    expect(decidePermission(p, 'Bash', { command: 'ls' }, { behavior: 'deny', message: 'no' })).toEqual({
      behavior: 'deny',
      message: 'no',
      source: 'hook',
    });
    expect(decidePermission(p, 'Bash', { command: 'ls' }, { behavior: 'ask', message: 'ask me' })).toEqual({
      behavior: 'deny',
      message: 'ask me',
      source: 'hook',
    });
    expect(decidePermission(p, 'Bash', { command: 'ls' }, { behavior: 'allow' })).toEqual({
      behavior: 'allow',
    });
  });
});

describe('permissions in a session', () => {
  let box: Sandbox;
  beforeEach(() => {
    box = makeSandbox();
    fs.writeFileSync(box.file('outside.txt'), 'outside\n');
    fs.writeFileSync(
      box.file('scenario.json'),
      JSON.stringify({
        name: 'permissions',
        steps: [
          { kind: 'tool', name: 'Write', input: { file_path: 'a.txt', content: 'a\n' } },
          { kind: 'bash', command: 'git diff --stat', stdout: '1 file changed' },
          { kind: 'bash', command: 'git push origin main', stdout: 'pushed' },
          { kind: 'tool', name: 'Read', input: { file_path: box.file('outside.txt') } },
          { kind: 'text', text: 'done' },
          { kind: 'endTurn' },
        ],
      }),
    );
  });
  afterEach(() => box.cleanup());

  async function outcomes(args: string[]): Promise<{ results: string[]; init: Record<string, any> }> {
    const run = await runSim(
      box,
      ['-p', 'go', '--session-id', SESSION_A, '--output-format', 'stream-json', '--verbose', ...args],
      {
        env: { CLAUDE_SIM_SCENARIO: box.file('scenario.json') },
      },
    );
    expect(run.code).toBe(0);
    const results = readTranscript(box, SESSION_A)
      .filter((line) => line.type === 'user' && Array.isArray(line.message.content))
      .map((line) => {
        const block = line.message.content[0];
        return block.is_error ? `denied: ${block.content}` : 'ok';
      });
    return { results, init: parseLines(run.stdout)[0]! };
  }

  it('default mode', async () => {
    expect((await outcomes([])).results).toEqual([
      "denied: Claude requested permissions to use Write, but you haven't granted it yet.",
      "denied: Claude requested permissions to use Bash, but you haven't granted it yet.",
      "denied: Claude requested permissions to use Bash, but you haven't granted it yet.",
      "denied: Claude requested permissions to use Read, but you haven't granted it yet.",
    ]);
    expect(fs.existsSync(path.join(box.cwd, 'a.txt'))).toBe(false);
  });

  it('acceptEdits, a Bash prefix grant and --add-dir', async () => {
    expect(
      (
        await outcomes([
          '--permission-mode',
          'acceptEdits',
          '--add-dir',
          box.root,
          '--allowedTools',
          'Bash(git diff:*)',
        ])
      ).results,
    ).toEqual([
      'ok',
      'ok',
      "denied: Claude requested permissions to use Bash, but you haven't granted it yet.",
      'ok',
    ]);
  });

  it('a deny rule under bypassPermissions, and --tools / whole-tool denials shaping the tool list', async () => {
    const denied = await outcomes([
      '--dangerously-skip-permissions',
      '--disallowedTools',
      'Bash(git push:*)',
      'Write',
    ]);
    expect(denied.results).toEqual([
      'denied: Permission to use Write has been denied.',
      'ok',
      'denied: Permission to use Bash with command git push origin main has been denied.',
      'ok',
    ]);
    expect(denied.init.tools).not.toContain('Write');
    expect(denied.init.tools).toContain('Bash');
    fs.rmSync(path.join(box.configDir, 'projects'), { recursive: true });
    const limited = await outcomes(['--dangerously-skip-permissions', '--tools', 'Read,Glob', 'MultiEdit']);
    expect(limited.init.tools).toEqual(['Read', 'Glob']);
    expect(limited.results).toEqual([
      'denied: <tool_use_error>Error: No such tool available: Write</tool_use_error>',
      'denied: <tool_use_error>Error: No such tool available: Bash</tool_use_error>',
      'denied: <tool_use_error>Error: No such tool available: Bash</tool_use_error>',
      'ok',
    ]);
  });
});
