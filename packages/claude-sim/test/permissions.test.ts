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
import { hookSettings, makeSandbox, parseLines, readJsonLines, readTranscript, runSim, SESSION_A, type Sandbox } from './helpers';

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
const WRITE_PROMPT = (file: string) => ({
  behavior: 'deny',
  message: `Claude requested permissions to write to ${file}, but you haven't granted it yet.`,
  source: 'prompt',
});
/** What print mode answers a Bash command nobody can approve (observed on 2.1.295). */
const NEEDS_APPROVAL = {
  behavior: 'deny',
  message: 'This command requires approval',
  source: 'prompt',
  reason: 'other',
};
const PARTS_NEED_APPROVAL = (...parts: string[]) => ({
  behavior: 'deny',
  message: `This Bash command contains multiple operations. The following ${parts.length === 1 ? 'part requires' : 'parts require'} approval: ${parts.join(', ')}`,
  source: 'prompt',
  reason: 'subcommandResults',
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
    expect(decidePermission(p, 'Write', { file_path: `${CWD}/a.ts`, content: '' })).toEqual(
      WRITE_PROMPT(`${CWD}/a.ts`),
    );
    expect(decidePermission(p, 'Bash', { command: 'ls' })).toEqual({ behavior: 'allow' });
    expect(decidePermission(p, 'Bash', { command: 'git commit -m x' })).toEqual(NEEDS_APPROVAL);
    expect(decidePermission(p, 'mcp__aoc__task_done', {})).toEqual(PROMPT('mcp__aoc__task_done'));
  });

  it('acceptEdits allows edits inside the working directory only; bypassPermissions allows everything', () => {
    expect(decidePermission(policy('acceptEdits'), 'Edit', { file_path: `${CWD}/a.ts` })).toEqual({
      behavior: 'allow',
    });
    expect(decidePermission(policy('acceptEdits'), 'Edit', { file_path: '/tmp/a.ts' })).toEqual(
      WRITE_PROMPT('/tmp/a.ts'),
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
      PARTS_NEED_APPROVAL('git push origin main'),
    );
    expect(decidePermission(p, 'Bash', { command: 'git diffx' })).toEqual(NEEDS_APPROVAL);
    expect(decidePermission(p, 'Write', { file_path: `${CWD}/src/deep/a.ts` })).toEqual({
      behavior: 'allow',
    });
    expect(decidePermission(p, 'Write', { file_path: `${CWD}/docs/a.md` })).toEqual(
      WRITE_PROMPT(`${CWD}/docs/a.md`),
    );
  });

  // A real-CLI check (acceptEdits, no rules) ran 26 commands: these were allowed ...
  const ALLOWED_UNDER_ACCEPT_EDITS = [
    'ls',
    'cat README.md',
    'pwd',
    'echo hi',
    'git status',
    'git diff',
    'git log --oneline',
    'git branch',
    'node --version',
    'python3 --version',
    'touch a.txt',
    'mkdir sub',
    'cp a.txt b.txt',
    'mv b.txt c.txt',
    'sed -i s/x/y/ a.txt',
    'rm c.txt',
    'echo hi > out.txt',
    'ls && pwd',
    'cat README.md | head -1',
  ];
  // ... and these needed approval, which nobody can give under -p.
  const DENIED_UNDER_ACCEPT_EDITS = [
    'git add a.txt',
    'git commit -m probe',
    'npm test',
    'node test.js',
    'curl --version',
    'make --version',
    'bash -c "echo hi"',
  ];

  it('Bash under acceptEdits: read-only and plain file commands run, everything else needs approval (real-CLI matrix)', () => {
    const p = policy('acceptEdits');
    for (const command of ALLOWED_UNDER_ACCEPT_EDITS)
      expect(decidePermission(p, 'Bash', { command }), command).toEqual({ behavior: 'allow' });
    for (const command of DENIED_UNDER_ACCEPT_EDITS)
      expect(decidePermission(p, 'Bash', { command }), command).toEqual(NEEDS_APPROVAL);
  });

  it('file commands need acceptEdits and stay inside the working directory; redirects follow the same rule', () => {
    expect(decidePermission(policy('default'), 'Bash', { command: 'touch a.txt' })).toEqual(NEEDS_APPROVAL);
    expect(decidePermission(policy('default'), 'Bash', { command: 'echo hi > out.txt' })).toEqual(NEEDS_APPROVAL);
    const p = policy('acceptEdits');
    expect(decidePermission(p, 'Bash', { command: 'rm /etc/hosts' })).toEqual(NEEDS_APPROVAL);
    expect(decidePermission(p, 'Bash', { command: 'cp a.txt ../outside.txt' })).toEqual(NEEDS_APPROVAL);
    expect(decidePermission(p, 'Bash', { command: 'echo hi > /tmp/x' })).toEqual(NEEDS_APPROVAL);
    expect(decidePermission(p, 'Bash', { command: 'echo hi > /dev/null' })).toEqual({ behavior: 'allow' });
  });

  it('a compound command names the parts that need approval; every part needs its own grant', () => {
    const p = policy('acceptEdits');
    expect(decidePermission(p, 'Bash', { command: 'git add hello.txt && git commit -q -m x' })).toEqual(
      PARTS_NEED_APPROVAL('git add hello.txt', 'git commit -q -m x'),
    );
    expect(decidePermission(p, 'Bash', { command: 'ls && git push origin main' })).toEqual(
      PARTS_NEED_APPROVAL('git push origin main'),
    );
    // The blanket `Bash` grant of the supervisor covers every part ...
    const granted = policy('acceptEdits', ['Bash']);
    expect(decidePermission(granted, 'Bash', { command: 'git add hello.txt && git commit -q -m x' })).toEqual({
      behavior: 'allow',
    });
    // ... and a prefix grant only its own.
    const prefix = policy('acceptEdits', ['Bash(git add:*)']);
    expect(decidePermission(prefix, 'Bash', { command: 'git add hello.txt && git commit -q -m x' })).toEqual(
      PARTS_NEED_APPROVAL('git commit -q -m x'),
    );
  });

  it("dontAsk answers a Bash command that needs approval with the don't-ask-mode refusal", () => {
    const verdict = decidePermission(policy('dontAsk'), 'Bash', { command: 'git commit -m x' });
    expect(verdict).toMatchObject({ behavior: 'deny', source: 'prompt' });
    expect((verdict as { message: string }).message).toMatch(
      /^Permission to use Bash has been denied because Claude Code is running in don't ask mode\./,
    );
    expect(decidePermission(policy('dontAsk'), 'Bash', { command: 'git status' })).toEqual({ behavior: 'allow' });
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
      `denied: Claude requested permissions to write to ${path.join(box.cwd, 'a.txt')}, but you haven't granted it yet.`,
      'ok',
      'denied: This command requires approval',
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
    ).toEqual(['ok', 'ok', 'denied: This command requires approval', 'ok']);
  });

  it('a refused Bash command fires PermissionRequest (never in dontAsk) and the stream says why it was denied', async () => {
    fs.writeFileSync(
      box.file('scenario.json'),
      JSON.stringify({
        name: 'refused',
        steps: [
          { kind: 'bash', command: 'git add a.txt && git commit -q -m x', stdout: '' },
          { kind: 'bash', command: 'npm test', stdout: '' },
          { kind: 'text', text: 'done' },
          { kind: 'endTurn' },
        ],
      }),
    );
    const settings = hookSettings({
      PermissionRequest: [{ command: 'cat >> "$HOOK_LOG"; echo >> "$HOOK_LOG"' }],
    });
    const run = (mode: string) =>
      runSim(
        box,
        ['-p', 'go', '--output-format', 'stream-json', '--verbose', '--settings', settings, '--permission-mode', mode],
        { env: { CLAUDE_SIM_SCENARIO: box.file('scenario.json'), HOOK_LOG: box.file(`hook-${mode}.jsonl`) } },
      );
    const accept = await run('acceptEdits');
    expect(accept.code).toBe(0);
    const denied = parseLines(accept.stdout).filter((l) => l.type === 'system' && l.subtype === 'permission_denied');
    expect(denied).toMatchObject([
      {
        tool_name: 'Bash',
        decision_reason_type: 'subcommandResults',
        message: 'This Bash command contains multiple operations. The following parts require approval: git add a.txt, git commit -q -m x',
      },
      {
        tool_name: 'Bash',
        decision_reason_type: 'other',
        decision_reason: 'This command requires approval',
        message: 'This command requires approval',
      },
    ]);
    expect(denied[0]).toHaveProperty('tool_use_id', expect.stringMatching(/^toolu_/));
    const asked = readJsonLines(box.file('hook-acceptEdits.jsonl'));
    expect(asked).toMatchObject([
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', permission_mode: 'acceptEdits', effort: { level: 'medium' } },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } },
    ]);
    expect(asked[0]).not.toHaveProperty('tool_use_id');
    expect(parseLines(accept.stdout).find((l) => l.type === 'result')!.permission_denials).toHaveLength(2);

    const dont = await run('dontAsk');
    expect(dont.code).toBe(0);
    expect(fs.existsSync(box.file('hook-dontAsk.jsonl'))).toBe(false);
    expect(parseLines(dont.stdout).filter((l) => l.type === 'system' && l.subtype === 'permission_denied')).toHaveLength(2);
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
