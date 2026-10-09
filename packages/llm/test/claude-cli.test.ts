import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { LlmJsonRequest } from '@aoc/contracts';
import { CHILD_ENV_ALLOWLIST } from '@aoc/kernel';
import {
  CLAUDE_CLI_ENV,
  ClaudeCliLlm,
  LlmOutputInvalidError,
  LlmUnavailableError,
  type SpawnFn,
} from '../src';

/** A scripted child process: no real `claude` is ever started in tests. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: PassThrough | null;
  readonly signals: string[] = [];
  stdinText = '';
  private closed = false;

  constructor(withStdin: boolean) {
    super();
    this.stdin = withStdin ? new PassThrough() : null;
    this.stdin?.on('data', (d: Buffer) => (this.stdinText += d.toString()));
  }

  finish(stdout: string, code = 0, stderr = ''): void {
    let pending = 2;
    const done = () => {
      if (--pending === 0) this.close(code, null);
    };
    this.stdout.on('end', done);
    this.stderr.on('end', done);
    this.stdout.end(stdout);
    this.stderr.end(stderr);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    setImmediate(() => this.close(null, signal));
    return true;
  }

  private close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code, signal);
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  options: Parameters<SpawnFn>[2];
  child: FakeChild;
}

function fakeSpawn(script: (child: FakeChild) => void): { spawn: SpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    const child = new FakeChild(options.stdio[0] === 'pipe');
    calls.push({ command, args: [...args], options, child });
    setImmediate(() => script(child));
    return child;
  };
  return { spawn, calls };
}

const schema = {
  type: 'object',
  properties: { usdMyr: { type: 'number' }, publishedDate: { type: 'string' } },
  required: ['usdMyr', 'publishedDate'],
  additionalProperties: false,
};
const req: LlmJsonRequest = {
  model: 'haiku',
  purpose: 'fx.extract',
  system: 'Extract the rate.',
  prompt: 'Page: USD 4.2130',
  schema,
};

const result = (fields: Record<string, unknown>) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1800,
    num_turns: 2,
    result: '',
    session_id: '0d6f0f43-2a0e-4a55-9a8e-2d3c1c8c3f11',
    total_cost_usd: 0.0012,
    usage: { input_tokens: 812, output_tokens: 64 },
    ...fields,
  });

describe('ClaudeCliLlm', () => {
  it('runs one hermetic print-mode call and returns the validated structured output', async () => {
    const { spawn, calls } = fakeSpawn((c) =>
      c.finish(result({ structured_output: { usdMyr: 4.213, publishedDate: '2026-10-09' } })),
    );
    const llm = new ClaudeCliLlm({ spawn, timeoutMs: 5_000 });
    const out = await llm.completeJson(req);

    expect(out).toMatchObject({
      data: { usdMyr: 4.213, publishedDate: '2026-10-09' },
      model: 'claude-haiku-5-5',
      usage: { inputTokens: 812, outputTokens: 64 },
    });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe('claude');
    expect(call.args).toEqual([
      '-p',
      '--model',
      'claude-haiku-5-5',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(schema),
      '--no-session-persistence',
      '--tools',
      '',
      '--strict-mcp-config',
      '--system-prompt',
      `Extract the rate.\n\nYour final answer must be one JSON object conforming to this JSON Schema:\n${JSON.stringify(schema)}`,
      '--',
      'Page: USD 4.2130',
    ]);
    expect(call.options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(call.options.cwd).toBe(tmpdir());
    expect(call.options.env.AOC_INTERNAL_LLM).toBe('1');
  });

  it('starts the CLI with an allowlisted environment: its Claude login, never AOC_* or unrelated secrets (G-46)', async () => {
    const login = {
      CLAUDE_CONFIG_DIR: '/home/aoc/.claude',
      ANTHROPIC_API_KEY: 'sk-ant-needed-by-the-cli',
      ANTHROPIC_AUTH_TOKEN: 'auth-needed-by-the-cli',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-needed-by-the-cli',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corp-ca.pem',
    };
    const unrelated = {
      AOC_MASTER_KEY: 'kek-SECRET-1',
      AOC_BOOTSTRAP_TOKEN: 'bootstrap-SECRET-2',
      AOC_INGEST_TOKEN: 'ingest-SECRET-3',
      GITHUB_TOKEN: 'ghp_SECRET-4',
      GH_TOKEN: 'gh-SECRET-5',
      AWS_SECRET_ACCESS_KEY: 'aws-SECRET-6',
      NPM_TOKEN: 'npm-SECRET-7',
      DEPLOY_KEY: 'deploy-SECRET-8',
      GIT_SSH_COMMAND: 'ssh -i /etc/aoc/keys/promotion-SECRET-9',
    };
    const planted = { ...login, ...unrelated };
    const saved = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
    Object.assign(process.env, planted);
    let env: Record<string, string | undefined>;
    try {
      const { spawn, calls } = fakeSpawn((c) =>
        c.finish(result({ structured_output: { usdMyr: 4.213, publishedDate: '2026-10-09' } })),
      );
      await new ClaudeCliLlm({
        spawn,
        env: { EXPLICIT_FROM_CALLER: 'yes', ANTHROPIC_API_KEY: 'override' },
      }).completeJson(req);
      env = calls[0]!.options.env;
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    // Whatever else aocd's environment holds (this host's too), the child's is a subset of the allowlists.
    const allowed = new Set<string>([
      ...CHILD_ENV_ALLOWLIST,
      ...CLAUDE_CLI_ENV,
      'EXPLICIT_FROM_CALLER',
      'AOC_INTERNAL_LLM',
    ]);
    expect(Object.keys(env).filter((k) => !allowed.has(k))).toEqual([]);
    expect(Object.keys(env).filter((k) => k.startsWith('AOC_'))).toEqual(['AOC_INTERNAL_LLM']);
    expect(JSON.stringify(env)).not.toContain('SECRET');
    for (const k of Object.keys(unrelated)) expect(env, k).not.toHaveProperty(k);
    expect(env).toMatchObject({
      ...login,
      ANTHROPIC_API_KEY: 'override', // an explicit value from the caller wins
      EXPLICIT_FROM_CALLER: 'yes',
      AOC_INTERNAL_LLM: '1',
      PATH: process.env.PATH,
    });
  });

  it('maps tiers to model ids and puts extraArgs first (claude-sim under node)', () => {
    const llm = new ClaudeCliLlm({ claudeBin: 'node', extraArgs: ['--import', 'tsx', '/sim/cli.ts'] });
    const { args, stdin } = llm.invocation({ ...req, model: 'sonnet', system: undefined });
    expect(args.slice(0, 6)).toEqual([
      '--import',
      'tsx',
      '/sim/cli.ts',
      '-p',
      '--model',
      'claude-sonnet-5-5',
    ]);
    expect(args[args.indexOf('--system-prompt') + 1]).toMatch(/extraction engine/);
    expect(stdin).toBeNull();
    expect(new ClaudeCliLlm().modelId('opus')).toBe('claude-opus-5-5');
  });

  it('falls back to JSON in the result text when structured_output is absent', async () => {
    const { spawn } = fakeSpawn((c) =>
      c.finish(result({ result: '```json\n{"usdMyr": 4.2, "publishedDate": "2026-10-08"}\n```' })),
    );
    const out = await new ClaudeCliLlm({ spawn }).completeJson(req);
    expect(out.data).toEqual({ usdMyr: 4.2, publishedDate: '2026-10-08' });
  });

  it('rejects output that does not match the schema', async () => {
    const { spawn } = fakeSpawn((c) =>
      c.finish(result({ structured_output: { usdMyr: '4.2', publishedDate: '2026-10-08' } })),
    );
    const err = await new ClaudeCliLlm({ spawn }).completeJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmOutputInvalidError);
    expect((err as LlmOutputInvalidError).problems).toEqual(['$.usdMyr: expected number, got string']);
  });

  it('treats exhausted structured-output retries as invalid output', async () => {
    const { spawn } = fakeSpawn((c) =>
      c.finish(
        result({
          subtype: 'error_max_structured_output_retries',
          is_error: true,
          errors: ['schema validation failed'],
        }),
        1,
      ),
    );
    await expect(new ClaudeCliLlm({ spawn }).completeJson(req)).rejects.toBeInstanceOf(LlmOutputInvalidError);
  });

  it('treats CLI error results, garbage output, spawn failures and timeouts as unavailable', async () => {
    const authFail = fakeSpawn((c) =>
      c.finish(
        result({ is_error: true, result: 'Invalid API key · Please run /login', api_error_status: 401 }),
        1,
      ),
    );
    const e1 = await new ClaudeCliLlm({ spawn: authFail.spawn }).completeJson(req).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(LlmUnavailableError);
    expect((e1 as LlmUnavailableError).status).toBe(401);
    expect((e1 as Error).message).toMatch(/run \/login/);

    const garbage = fakeSpawn((c) =>
      c.finish('Error: unknown option --json-schema\n', 1, 'usage: claude [options]'),
    );
    await expect(new ClaudeCliLlm({ spawn: garbage.spawn }).completeJson(req)).rejects.toThrow(
      /without a JSON result: usage: claude/,
    );

    const missing = fakeSpawn((c) =>
      c.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })),
    );
    await expect(new ClaudeCliLlm({ spawn: missing.spawn }).completeJson(req)).rejects.toThrow(
      LlmUnavailableError,
    );

    const hang = fakeSpawn(() => {});
    const err = await new ClaudeCliLlm({ spawn: hang.spawn, timeoutMs: 30 })
      .completeJson(req)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect((err as Error).message).toMatch(/timed out after 30 ms/);
    expect(hang.calls[0]!.child.signals).toContain('SIGTERM');
  });

  it('sends oversized prompts on stdin instead of argv', async () => {
    const big = `Page: ${'x'.repeat(150_000)} USD 4.2130`;
    const { spawn, calls } = fakeSpawn((c) =>
      c.finish(result({ structured_output: { usdMyr: 4.213, publishedDate: '2026-10-09' } })),
    );
    await new ClaudeCliLlm({ spawn }).completeJson({ ...req, prompt: big });
    const call = calls[0]!;
    expect(call.options.stdio[0]).toBe('pipe');
    expect(call.args).not.toContain('--');
    expect(call.args.some((a) => a.length > 100_000)).toBe(false);
    expect(call.child.stdinText).toBe(big);
  });
});
