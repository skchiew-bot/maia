import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FILE_CHANGING_TOOLS, HOOK_EVENTS, ProcessTypeSchema } from '@aoc/contracts';
import {
  MAX_ARG_BYTES,
  buildClaudeArgs,
  buildHookSettings,
  buildMcpConfig,
  buildSessionEnv,
  readCredentialProfile,
  redactArgv,
  shellQuote,
  toolPolicy,
} from '../src/launch-config';
import { buildSystemPrompt, decisionAnswersText, withHandoffBrief } from '../src/prompts';
import { RingBuffer } from '../src/ring-buffer';
import { readStreamLine } from '../src/stream';
import { isLegacyLimitResult, isLimitNotice, parseResetAt, strongestSignal } from '../src/throttle';

const NOW = Date.parse('2026-10-09T02:00:00.000Z'); // 10:00 in Kuala Lumpur
const KL = 'Asia/Kuala_Lumpur';

describe('plan-limit detection and reset parsing', () => {
  it('parses every reset format Claude Code has used', () => {
    expect(parseResetAt('Claude AI usage limit reached|1791517800', NOW, KL)).toBe(1791517800_000);
    expect(
      parseResetAt("You've hit your session limit · resets 12:50am (America/Los_Angeles)", NOW, KL),
    ).toBe(Date.parse('2026-10-09T07:50:00.000Z'));
    expect(parseResetAt("You've hit your limit · resets 4pm (Asia/Kuala_Lumpur)", NOW, KL)).toBe(
      Date.parse('2026-10-09T08:00:00.000Z'),
    );
    expect(parseResetAt('5-hour limit reached ∙ resets 9am', NOW, KL)).toBe(
      Date.parse('2026-10-10T01:00:00.000Z'),
    ); // 9am KL already passed today
    expect(
      parseResetAt("You've hit your weekly limit · resets Oct 14, 3pm (Europe/Stockholm)", NOW, KL),
    ).toBe(Date.parse('2026-10-14T13:00:00.000Z'));
    expect(parseResetAt('Weekly limit reached ∙ resets Nov 13', NOW, KL)).toBe(
      Date.parse('2026-11-12T16:00:00.000Z'),
    );
    expect(parseResetAt('Your limit will reset at 7pm (Asia/Tokyo).', NOW, KL)).toBe(
      Date.parse('2026-10-09T10:00:00.000Z'),
    );
    expect(parseResetAt('usage limit reached, resets at 15:00', NOW, KL)).toBe(
      Date.parse('2026-10-09T07:00:00.000Z'),
    );
    expect(parseResetAt('limit reached; resets in 2h 30m', NOW, KL)).toBe(NOW + 150 * 60_000);
    expect(parseResetAt('5-hour limit reached ∙ resets 3pm (Not/AZone)', NOW, KL)).toBe(
      Date.parse('2026-10-09T07:00:00.000Z'),
    );
    expect(parseResetAt('API Error: Rate limit reached', NOW, KL)).toBeNull();
  });

  it('treats limit notices as throttles but not warnings or model prose', () => {
    expect(isLimitNotice("You've hit your session limit · resets 12:50am (America/Los_Angeles)")).toBe(true);
    expect(isLimitNotice('Claude AI usage limit reached|1791517800')).toBe(true);
    expect(isLimitNotice('API Error: Rate limit reached')).toBe(true);
    expect(isLimitNotice("You've used 90% of your session limit · resets 3pm (Asia/Kuala_Lumpur)")).toBe(
      false,
    );
    expect(isLimitNotice('Approaching session limit · resets 3pm')).toBe(false);
    expect(isLegacyLimitResult('Claude AI usage limit reached|1791517800')).toBe(true);
    expect(isLegacyLimitResult('Fixed detection of "usage limit reached" messages in throttle.ts')).toBe(
      false,
    );
  });

  it('prefers the strongest signal and borrows a reset time from weaker ones', () => {
    const s = strongestSignal([
      { rank: 4, resetAt: 5, message: 'text', source: 'stream' },
      { rank: 1, resetAt: null, message: 'event', source: 'stream' },
    ]);
    expect(s).toMatchObject({ rank: 1, resetAt: 5, message: 'event' });
    expect(strongestSignal([])).toBeNull();
  });
});

const type = (over: Record<string, unknown>) =>
  ProcessTypeSchema.parse({
    id: 'feature-build',
    name: 'Feature',
    class: 'execution',
    model: 'opus',
    ...over,
  });

describe('claude argv', () => {
  const base = {
    model: 'claude-opus-5-5',
    mcpConfigPath: '/s/mcp.json',
    settingsPath: '/s/settings.json',
    permissionMode: 'acceptEdits' as const,
    systemPrompt: 'RULES',
    claudeSessionId: '7f0c1d2e-0000-4000-8000-000000000000',
    resume: false,
    prompt: '- starts with a dash',
  };

  it('puts a single-value flag between the variadic tool flags and the prompt, then -- and the prompt', () => {
    const args = buildClaudeArgs({
      ...base,
      ...toolPolicy(type({ tools: { allow: ['Bash(git log:*)'], deny: ['WebFetch'] } })),
    });
    expect(args).toEqual([
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
      'acceptEdits',
      '--append-system-prompt',
      'RULES',
      '--allowedTools',
      'mcp__aoc',
      'Bash(git log:*)',
      '--disallowedTools',
      'WebFetch',
      '--session-id',
      base.claudeSessionId,
      '--model',
      'claude-opus-5-5',
      '--',
      '- starts with a dash',
    ]);
  });

  it('resumes by id, names the CLI default permission mode explicitly and passes --tools for restricted types', () => {
    const triage = type({ id: 'bug-triage', class: 'triage', readOnly: true, permissionMode: 'dontAsk' });
    const args = buildClaudeArgs({
      ...base,
      resume: true,
      permissionMode: 'default',
      ...toolPolicy({ ...triage, builtinTools: ['Read', 'Glob', 'Grep'] } as typeof triage),
    });
    // 'default' and 'manual' are the same mode; the CLI calls it 'manual'. Never left to the user's settings.
    const mode = (m: 'default' | 'manual') => {
      const a = buildClaudeArgs({ ...base, permissionMode: m, ...toolPolicy(type({})) });
      return a.slice(a.indexOf('--permission-mode'), a.indexOf('--permission-mode') + 2);
    };
    expect(mode('default')).toEqual(['--permission-mode', 'manual']);
    expect(mode('manual')).toEqual(['--permission-mode', 'manual']);
    expect(args).not.toContain('--session-id');
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual([
      '--resume',
      base.claudeSessionId,
    ]);
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual([
      '--tools',
      'Read,Glob,Grep',
    ]);
  });

  it('always allows the AOC MCP server and denies file-changing tools to read-only types', () => {
    expect(toolPolicy(type({})).allowedTools).toEqual(['mcp__aoc']);
    expect(toolPolicy(type({})).disallowedTools).toEqual([]);
    const ro = toolPolicy(type({ class: 'triage', readOnly: true, tools: { deny: ['Bash'] } }));
    expect(ro.disallowedTools).toEqual(['Bash', ...FILE_CHANGING_TOOLS]);
    expect(ro.builtinTools).toBeUndefined();
  });

  it('redacts the system prompt and the prompt from the recorded argv', () => {
    const args = buildClaudeArgs({ ...base, ...toolPolicy(type({})) });
    const red = redactArgv(['claude', ...args]);
    expect(red).toContain('@system-prompt.md');
    expect(red[red.length - 1]).toBe('@prompt');
    expect(red.join(' ')).not.toContain('RULES');
    expect(red.join(' ')).not.toContain('starts with a dash');
  });
});

describe('session environment (credential isolation, §3)', () => {
  const source = { PATH: '/bin', HOME: '/home/aoc', SECRET: 'no', AOC_MASTER_KEY: 'kek', TZ: 'UTC' };

  it('copies only allowlisted variables, never AOC_* from aocd, and pins TZ', () => {
    const env = buildSessionEnv({
      source,
      allowlist: ['PATH', 'HOME', 'AOC_MASTER_KEY', 'TZ'],
      credentials: { GIT_TOKEN: 'g', AOC_SESSION_ID: 'forged' },
      readOnly: false,
      aoc: { AOC_SESSION_ID: 'ses_1' },
      timezone: 'Asia/Kuala_Lumpur',
    });
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/aoc',
      TZ: 'Asia/Kuala_Lumpur',
      GIT_TOKEN: 'g',
      AOC_SESSION_ID: 'ses_1',
    });
  });

  it('never gives credentials to read-only sessions', () => {
    const env = buildSessionEnv({
      source,
      allowlist: ['PATH'],
      credentials: { GIT_TOKEN: 'g' },
      readOnly: true,
      aoc: {},
      timezone: 'UTC',
    });
    expect(env.GIT_TOKEN).toBeUndefined();
  });

  it('reads credential profiles without ever echoing file contents in errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aoc-prof-'));
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify({ profiles: { deploy: { env: { DEPLOY_TOKEN: 'tok' } } } }));
    expect(readCredentialProfile(good, 'deploy')).toEqual({ DEPLOY_TOKEN: 'tok' });
    expect(() => readCredentialProfile(good, 'nope')).toThrow(/not defined/);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"profiles": {"deploy": {"env": {"DEPLOY_TOKEN": "super-secret-value"');
    expect(() => readCredentialProfile(bad, 'deploy')).toThrow(/not valid JSON/);
    try {
      readCredentialProfile(bad, 'deploy');
    } catch (err) {
      expect(String(err)).not.toContain('super-secret-value');
    }
    expect(() => readCredentialProfile(join(dir, 'missing.json'), 'deploy')).toThrow(/unreadable \(ENOENT\)/);
  });
});

describe('per-session MCP config and hook settings', () => {
  it('loads the aoc server eagerly with its env', () => {
    expect(buildMcpConfig(['node', '/opt/mcp.js', '--stdio'], { AOC_SESSION_ID: 'ses_1' })).toEqual({
      mcpServers: {
        aoc: {
          type: 'stdio',
          command: 'node',
          args: ['/opt/mcp.js', '--stdio'],
          env: { AOC_SESSION_ID: 'ses_1' },
          alwaysLoad: true,
        },
      },
    });
  });

  it('registers one validated command hook per verified event', () => {
    const s = buildHookSettings(['node', '/opt/AOC hooks/hook.js']);
    expect(Object.keys(s.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    for (const ev of [
      ...HOOK_EVENTS,
      'PostToolUseFailure',
      'StopFailure',
      'PostToolBatch',
      'PermissionRequest',
      'SubagentStart',
      'PostCompact',
    ]) {
      expect(s.hooks[ev], ev).toBeDefined();
    }
    expect(s.hooks.PreToolUse).toEqual([
      {
        matcher: '',
        hooks: [{ type: 'command', command: "node '/opt/AOC hooks/hook.js' PreToolUse", timeout: 30 }],
      },
    ]);
    expect(s.hooks.Stop![0]!.matcher).toBeUndefined();
    for (const entries of Object.values(s.hooks))
      expect(Number.isInteger(entries![0]!.hooks[0]!.timeout)).toBe(true);
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe('stream-json reader', () => {
  it('extracts init, output items, context size, results and rate-limit events', () => {
    const init = readStreamLine(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        model: 'claude-opus-5-5',
        mcp_servers: [{ name: 'aoc', status: 'failed' }],
      }),
    );
    expect(init.init).toEqual({ model: 'claude-opus-5-5', mcpServers: [{ name: 'aoc', status: 'failed' }] });
    const a = readStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-5-5',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
          ],
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 5,
            output_tokens: 3,
          },
        },
      }),
    );
    expect(a.items).toEqual([
      { kind: 'assistant_text', text: 'hello' },
      { kind: 'tool_use', toolName: 'Bash', text: 'ls -la' },
    ]);
    expect(a.contextTokens).toBe(1015);
    expect(a.conversation).toBe(true);
    expect(a.cliText).toBeNull();
    const synthetic = readStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          model: '<synthetic>',
          content: [{ type: 'text', text: "You've hit your limit" }],
          usage: { input_tokens: 0 },
        },
      }),
    );
    expect(synthetic.cliText).toBe("You've hit your limit");
    expect(synthetic.contextTokens).toBeNull();
    const tr = readStreamLine(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'out' }] }] },
      }),
    );
    expect(tr.items).toEqual([{ kind: 'tool_result', text: 'out' }]);
    const res = readStreamLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'boom',
        api_error_status: 429,
      }),
    );
    expect(res.result).toEqual({ isError: true, subtype: 'success', text: 'boom', apiErrorStatus: 429 });
    const rl = readStreamLine(
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 1791517800, rateLimitType: 'five_hour' },
      }),
    );
    expect(rl.rateLimit).toEqual({ status: 'rejected', resetsAtMs: 1791517800_000, window: 'five_hour' });
    expect(readStreamLine(JSON.stringify({ type: 'system', subtype: 'thinking_tokens' })).items).toEqual([]);
    expect(readStreamLine(JSON.stringify({ type: 'stream_event', event: {} })).items).toEqual([]);
    expect(readStreamLine('not json').items).toEqual([{ kind: 'system', text: 'not json' }]);
  });
});

describe('system prompt and injected text', () => {
  it('carries the AOC rules, trailers, lessons and the approved playbook', () => {
    const text = buildSystemPrompt({
      sessionId: 'ses_1',
      projectId: 'prj_1',
      threadId: 'thr_1',
      phaseId: null,
      ticketId: 'tkt_9',
      type: type({}),
      lessons: [
        {
          lessonId: 'les_1',
          scopeType: 'process_type',
          scopeValue: 'feature-build',
          rule: 'Run tests first',
          fix: 'pnpm test',
        },
      ],
      playbook: {
        playbookId: 'pbk_1',
        processType: 'feature-build',
        version: 2,
        title: 'Feature',
        status: 'approved',
        steps: [{ id: 's1', title: 'Write the test' }],
      },
    });
    for (const s of [
      'mcp__aoc__declare_plan',
      'mcp__aoc__task_done',
      'mcp__aoc__request_decision',
      'END YOUR TURN',
      'AOC-Session: ses_1',
      'AOC-Ticket: tkt_9',
      'AOC-Change',
      'untrusted',
      'Run tests first',
      '1. Write the test',
      'pbk_1',
    ]) {
      expect(text).toContain(s);
    }
    expect(text).not.toContain('READ-ONLY');
    expect(
      buildSystemPrompt({
        sessionId: 's',
        projectId: 'p',
        threadId: 't',
        phaseId: null,
        ticketId: null,
        type: type({ class: 'triage', readOnly: true }),
        lessons: [],
        playbook: null,
      }),
    ).toContain('READ-ONLY');
  });

  it('fits a large brief into the first turn and strips its own delimiter from it', () => {
    const text = withHandoffBrief('Continue the work.', `${'x'.repeat(300_000)}`, 'ses_0');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_ARG_BYTES);
    expect(text).toContain('[truncated by AOC]');
    expect(text.endsWith('Continue the work.')).toBe(true);
  });

  it('formats decision answers', () => {
    const card = {
      id: 'dec_1',
      status: 'resolved',
      options: [{ id: 'a', label: 'Approve' }],
      resolution: { optionId: 'a', comment: 'Ship it.' },
    };
    expect(
      decisionAnswersText([
        card as never,
        { id: 'dec_2', status: 'withdrawn', options: [], resolution: null } as never,
        { id: 'dec_3', status: 'expired', options: [], resolution: null } as never,
      ]),
    ).toBe(
      'Decision dec_1 answered: Approve. Ship it.\nDecision dec_2 was withdrawn; do not wait for it.\nDecision dec_3 expired unanswered; do not wait for it.',
    );
  });
});

describe('RingBuffer', () => {
  it('keeps the newest entries in order', () => {
    const b = new RingBuffer<number>(3);
    for (let i = 1; i <= 5; i++) b.push(i);
    expect(b.toArray()).toEqual([3, 4, 5]);
    expect(b.size).toBe(3);
  });
});
