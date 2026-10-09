import { spawn as nodeSpawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
  MODEL_ID_BY_TIER,
  type JsonValue,
  type LlmJsonRequest,
  type LlmJsonResult,
  type LlmService,
  type ModelTier,
} from '@aoc/contracts';
import { LlmOutputInvalidError, LlmUnavailableError } from './errors';
import { assertMatchesSchema, parseJsonText } from './output';

/** The subset of a child process the adapter uses (node's ChildProcess satisfies it; tests inject fakes). */
export interface SpawnedProcess {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly stdin: NodeJS.WritableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['ignore' | 'pipe', 'pipe', 'pipe'] },
) => SpawnedProcess;

export interface ClaudeCliLlmOptions {
  /** Executable (default "claude"; e.g. "node" with extraArgs naming the claude-sim script). */
  claudeBin?: string;
  /** Args placed before the adapter's own flags (e.g. ["--import","tsx","…/cli.ts"] or ["--safe-mode"]). */
  extraArgs?: string[];
  timeoutMs?: number;
  /** Working directory (default: the OS temp dir, so no project CLAUDE.md / settings are picked up). */
  cwd?: string;
  /** Extra environment on top of process.env (the CLI needs HOME for the Max-plan login). */
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  modelIds?: Partial<Record<ModelTier, string>>;
}

/** Shape of `claude -p --output-format json` (Claude Code 2.1.x result message, subset). */
interface CliResult {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  errors?: unknown;
  api_error_status?: number | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

const DEFAULT_SYSTEM =
  'You are a precise structured-data extraction engine. Answer only with output that satisfies the provided JSON schema.';
/** Linux caps one argv string at 128 KiB (MAX_ARG_STRLEN); larger prompts go through stdin. */
const MAX_ARGV_PROMPT_BYTES = 100_000;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

const defaultSpawn: SpawnFn = (command, args, options) => nodeSpawn(command, [...args], options);

/**
 * Structured JSON via the Claude Code CLI in print mode (uses the machine's Claude login, e.g. a Max plan — no API key).
 * One hermetic invocation per request: no tools, no MCP servers, no session persistence, our own system prompt.
 */
export class ClaudeCliLlm implements LlmService {
  constructor(private readonly opts: ClaudeCliLlmOptions = {}) {}

  modelId(tier: ModelTier): string {
    return this.opts.modelIds?.[tier] ?? MODEL_ID_BY_TIER[tier];
  }

  /** The argv (and stdin, for oversized prompts) for one request. */
  invocation(req: LlmJsonRequest): { args: string[]; stdin: string | null } {
    const viaStdin = Buffer.byteLength(req.prompt) > MAX_ARGV_PROMPT_BYTES;
    const args = [
      ...(this.opts.extraArgs ?? []),
      '-p',
      '--model',
      this.modelId(req.model),
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(req.schema),
      '--no-session-persistence',
      '--tools',
      '',
      // `--tools ""` only removes built-in tools; MCP servers from user/project config would still load,
      // and prompts may carry untrusted text, so load none.
      '--strict-mcp-config',
      '--system-prompt',
      // The schema is restated so the result-text fallback works even when no StructuredOutput tool call happens.
      `${req.system ?? DEFAULT_SYSTEM}\n\nYour final answer must be one JSON object conforming to this JSON Schema:\n${JSON.stringify(req.schema)}`,
    ];
    // `--tools` is variadic: `--` stops it from swallowing the prompt (and a prompt starting with "-" stays a prompt).
    if (!viaStdin) args.push('--', req.prompt);
    return { args, stdin: viaStdin ? req.prompt : null };
  }

  async completeJson<T = JsonValue>(req: LlmJsonRequest): Promise<LlmJsonResult<T>> {
    const { args, stdin } = this.invocation(req);
    const run = await this.run(args, stdin);
    const result = parseCliResult(run.stdout);
    if (!result) {
      throw new LlmUnavailableError(
        `claude exited ${run.signal ?? run.code} without a JSON result${stderrTail(run.stderr)}`,
      );
    }
    if (result.is_error || result.subtype !== 'success') {
      const detail = errorDetail(result);
      if (result.subtype === 'error_max_structured_output_retries') {
        throw new LlmOutputInvalidError(
          `claude could not produce schema-valid output: ${detail}`,
          ['$: structured output retries exhausted'],
          run.stdout,
        );
      }
      throw new LlmUnavailableError(
        `claude ${result.subtype ?? 'error'}: ${detail}`,
        result.api_error_status ?? null,
      );
    }
    let data: unknown = result.structured_output;
    if (data === undefined || data === null) {
      if (typeof result.result !== 'string' || !result.result.trim()) {
        throw new LlmOutputInvalidError('claude returned no structured output', ['$: missing'], run.stdout);
      }
      data = parseJsonText(result.result, run.stdout);
    }
    assertMatchesSchema(req.schema, data, run.stdout);
    const u = result.usage;
    return {
      data: data as T,
      model: this.modelId(req.model),
      usage: u ? { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 } : null,
      raw: run.stdout,
    };
  }

  private run(
    args: string[],
    stdin: string | null,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
    const bin = this.opts.claudeBin ?? 'claude';
    const timeoutMs = this.opts.timeoutMs ?? 120_000;
    const spawn = this.opts.spawn ?? defaultSpawn;
    return new Promise((resolve, reject) => {
      let child: SpawnedProcess;
      try {
        child = spawn(bin, args, {
          cwd: this.opts.cwd ?? tmpdir(),
          // AOC_INTERNAL_LLM marks AOC's own helper calls so global hooks can skip them (not an observed session).
          env: { ...process.env, ...this.opts.env, AOC_INTERNAL_LLM: '1' },
          stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(new LlmUnavailableError(`cannot start ${bin}: ${String(err)}`, null, { cause: err }));
        return;
      }
      const out: Buffer[] = [];
      const errOut: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const terminate = () => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
      };
      const timer = setTimeout(() => {
        settle(() => reject(new LlmUnavailableError(`claude timed out after ${timeoutMs} ms`)));
        terminate();
      }, timeoutMs);
      child.stdout?.on('data', (d: Buffer) => {
        outBytes += d.length;
        if (outBytes > MAX_STDOUT_BYTES) {
          settle(() => reject(new LlmUnavailableError(`claude output exceeded ${MAX_STDOUT_BYTES} bytes`)));
          terminate();
        } else out.push(d);
      });
      child.stderr?.on('data', (d: Buffer) => {
        if (errBytes < MAX_STDERR_BYTES) errOut.push(d);
        errBytes += d.length;
      });
      child.on('error', (err) =>
        settle(() =>
          reject(new LlmUnavailableError(`cannot run ${bin}: ${err.message}`, null, { cause: err })),
        ),
      );
      child.on('close', (code, signal) =>
        settle(() =>
          resolve({
            code,
            signal,
            stdout: Buffer.concat(out).toString('utf8'),
            stderr: Buffer.concat(errOut).toString('utf8'),
          }),
        ),
      );
      if (stdin !== null && child.stdin) {
        child.stdin.on('error', () => {}); // EPIPE when the CLI exits early; the close handler reports the outcome
        child.stdin.end(stdin);
      }
    });
  }
}

function isCliResult(v: unknown): v is CliResult {
  return typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'result';
}

/** The JSON result object; tolerates noise lines (or stream-json) by taking the last result line. */
function parseCliResult(stdout: string): CliResult | null {
  const text = stdout.trim();
  if (!text) return null;
  const candidates = [text, ...text.split('\n').reverse()];
  for (const c of candidates) {
    try {
      const v: unknown = JSON.parse(c);
      if (isCliResult(v)) return v;
    } catch {
      // not JSON
    }
  }
  return null;
}

function errorDetail(r: CliResult): string {
  const parts: string[] = [];
  if (typeof r.result === 'string' && r.result.trim()) parts.push(r.result.trim());
  if (Array.isArray(r.errors)) {
    parts.push(...r.errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))));
  }
  return (parts.join('; ') || 'no detail').slice(0, 500);
}

function stderrTail(stderr: string): string {
  const s = stderr.trim();
  return s ? `: ${s.slice(-500)}` : '';
}
