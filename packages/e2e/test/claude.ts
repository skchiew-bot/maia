/**
 * "Simulated Claude session" driver: everything Claude Code would do around a managed or observed session,
 * done with the REAL AOC binaries — the hook entry (stdin JSON in the 2.1.x shapes, AOC_* env), the MCP server
 * over stdio (MCP SDK client), the sidecar against a transcript written in the real JSONL format.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mcpToolName, transcriptPathFor, type AocMcpToolName, type HookOutput } from '@aoc/contracts';
import type { Harness, LaunchedSession } from './harness';
import { HOOK_MAIN, MCP_MAIN, SIDECAR_MAIN, tsNode } from './paths';

// ── hook binary ───────────────────────────────────────────────────────────────

export interface HookRun {
  event: string;
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout parsed as the hook's JSON output (null when empty). */
  json: HookOutput | null;
}

export type ToolDecision = 'allow' | 'deny' | 'ask' | 'defer' | 'block';

/** What Claude Code makes of a PreToolUse result: exit 2 blocks; otherwise the JSON permissionDecision, else allow. */
export function decisionOf(run: HookRun): ToolDecision {
  if (run.code === 2) return 'block';
  const out = run.json?.hookSpecificOutput;
  return out && 'permissionDecision' in out ? out.permissionDecision : 'allow';
}

export function denyReason(run: HookRun): string {
  const out = run.json?.hookSpecificOutput;
  return out && 'permissionDecisionReason' in out ? (out.permissionDecisionReason ?? '') : run.stderr;
}

/** Spawn `node --import tsx packages/hooks/src/main.ts <event>` exactly like a registered hook command. */
export function runHookBinary(event: string, stdin: unknown, env: Record<string, string>, cwd: string, track?: (c: ChildProcess) => void): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, tsNode(HOOK_MAIN, event), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    track?.(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      let json: HookOutput | null = null;
      if (stdout.trim()) {
        try {
          json = JSON.parse(stdout) as HookOutput;
        } catch {
          json = null;
        }
      }
      resolve({ event, code, stdout, stderr, json });
    });
    child.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
  });
}

// ── transcript (Claude Code JSONL) ────────────────────────────────────────────

export interface UsageSpec {
  input?: number;
  output?: number;
  cacheRead?: number;
  cache5m?: number;
  cache1h?: number;
}
type Block = Record<string, unknown>;

/**
 * Writes `<configDir>/projects/<slug>/<session>.jsonl` the way Claude Code 2.1.x does: one line per content block,
 * every line of an API response repeating the same message.id, requestId and usage. Subagents write their own file
 * under `<session>/subagents/agent-<id>.jsonl` with isSidechain: true.
 */
export class Transcript {
  private parent: string | null = null;

  constructor(
    readonly path: string,
    readonly claudeSessionId: string,
    readonly cwd: string,
    readonly agentId: string | null = null,
  ) {
    mkdirSync(dirname(path), { recursive: true });
  }

  private write(o: Record<string, unknown>): void {
    const uuid = randomUUID();
    const line = {
      parentUuid: this.parent,
      isSidechain: this.agentId !== null,
      ...(this.agentId ? { agentId: this.agentId } : {}),
      ...o,
      uuid,
      timestamp: new Date().toISOString(),
      userType: 'external',
      entrypoint: 'sdk-cli',
      cwd: this.cwd,
      sessionId: this.claudeSessionId,
      version: '2.1.295',
      gitBranch: 'main',
    };
    this.parent = uuid;
    appendFileSync(this.path, JSON.stringify(line) + '\n');
  }

  user(content: string | Block[]): void {
    this.write({ type: 'user', message: { role: 'user', content } });
  }

  /** One API response; returns its message id. */
  assistant(usage: UsageSpec, blocks: Block[] = [{ type: 'text', text: 'Working on it.' }], model = 'claude-opus-5-5'): string {
    const id = `msg_${randomBytes(12).toString('hex')}`;
    const requestId = `req_${randomBytes(12).toString('hex')}`;
    const u = {
      input_tokens: usage.input ?? 0,
      cache_creation_input_tokens: (usage.cache5m ?? 0) + (usage.cache1h ?? 0),
      cache_read_input_tokens: usage.cacheRead ?? 0,
      output_tokens: usage.output ?? 0,
      service_tier: 'standard',
      cache_creation: { ephemeral_1h_input_tokens: usage.cache1h ?? 0, ephemeral_5m_input_tokens: usage.cache5m ?? 0 },
    };
    blocks.forEach((block, apiBlockIndex) =>
      this.write({
        type: 'assistant',
        message: { model, id, type: 'message', role: 'assistant', content: [block], stop_reason: 'tool_use', stop_sequence: null, usage: u },
        apiBlockIndex,
        requestId,
        requestedModel: model,
      }),
    );
    return id;
  }

  /** The synthetic assistant message Claude Code writes when an API call fails (e.g. a plan usage limit). */
  apiError(text: string, error = 'rate_limit'): void {
    this.write({
      type: 'assistant',
      isApiErrorMessage: true,
      error,
      message: {
        id: randomUUID(),
        model: '<synthetic>',
        role: 'assistant',
        type: 'message',
        stop_reason: 'stop_sequence',
        stop_sequence: '',
        content: [{ type: 'text', text }],
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
  }

  subagent(agentId: string): Transcript {
    return new Transcript(this.path.replace(/\.jsonl$/, '') + `/subagents/agent-${agentId}.jsonl`, this.claudeSessionId, this.cwd, agentId);
  }
}

// ── sidecar ───────────────────────────────────────────────────────────────────

export class SidecarProcess {
  stderr = '';
  readonly exited: Promise<number | null>;

  constructor(readonly child: ChildProcess) {
    child.stderr?.on('data', (c: Buffer) => (this.stderr += c.toString('utf8')));
    this.exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  }

  /** SIGTERM: the sidecar flushes pending usage and exits. */
  async stop(): Promise<number | null> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM');
    return this.exited;
  }
}

// ── managed session ───────────────────────────────────────────────────────────

export interface ToolCall {
  toolUseId: string;
  pre: HookRun;
  post: HookRun | null;
  decision: ToolDecision;
}

export interface McpCall {
  isError: boolean;
  text: string;
  data: any;
  tool: ToolCall;
}

/** A managed session as Claude Code would run it under the supervisor's env. */
export class ClaudeSession {
  readonly transcript: Transcript;
  readonly spoolDir: string;
  promptId = randomUUID();
  private client: Client | null = null;
  private mcpStderr = '';
  sidecarProc: SidecarProcess | null = null;

  constructor(
    readonly h: Harness,
    readonly s: LaunchedSession,
    opts: { spoolDir?: string } = {},
  ) {
    this.transcript = new Transcript(s.transcriptPath, s.claudeSessionId, s.cwd);
    this.spoolDir = opts.spoolDir ?? join(h.root, 'spool', s.sessionId);
  }

  get sessionId(): string {
    return this.s.sessionId;
  }

  /** What the supervisor sets on the claude process; hooks inherit it. */
  get env(): Record<string, string> {
    return {
      PATH: process.env.PATH ?? '',
      HOME: this.h.homeDir,
      TZ: 'Asia/Kuala_Lumpur',
      CLAUDE_CONFIG_DIR: this.h.claudeConfigDir,
      CLAUDE_PROJECT_DIR: this.s.cwd,
      CLAUDE_CODE_SESSION_ID: this.s.claudeSessionId,
      AOC_MODE: 'managed',
      AOC_SESSION_ID: this.s.sessionId,
      AOC_PROJECT_ID: this.s.projectId,
      AOC_THREAD_ID: this.s.threadId,
      AOC_PROCESS_TYPE: this.s.processType,
      AOC_DAEMON_URL: this.h.url,
      AOC_INGEST_TOKEN: this.s.token,
      AOC_SPOOL_DIR: this.spoolDir,
      ...(this.s.readOnly ? { AOC_READ_ONLY: '1' } : {}),
    };
  }

  private base(event: string): Record<string, unknown> {
    const b: Record<string, unknown> = {
      session_id: this.s.claudeSessionId,
      transcript_path: this.s.transcriptPath,
      cwd: this.s.cwd,
      hook_event_name: event,
    };
    if (event !== 'SessionStart') Object.assign(b, { prompt_id: this.promptId, permission_mode: 'acceptEdits' });
    return b;
  }

  hook(event: string, fields: Record<string, unknown> = {}, opts: { env?: Record<string, string> } = {}): Promise<HookRun> {
    return runHookBinary(event, { ...this.base(event), ...fields }, { ...this.env, ...opts.env }, this.s.cwd, (c) => this.h.track(c));
  }

  /** SessionStart → UserPromptSubmit with the launch prompt (what fires first in a -p run). */
  async start(): Promise<void> {
    expectExit0(await this.hook('SessionStart', { source: 'startup' }));
    this.transcript.user(this.s.prompt);
    expectExit0(await this.hook('UserPromptSubmit', { prompt: this.s.prompt }));
  }

  /** PreToolUse → (the tool runs only when allowed) → PostToolUse / PostToolUseFailure. */
  async tool(
    name: string,
    input: Record<string, unknown>,
    opts: { response?: unknown; run?: () => unknown; failWith?: string; extra?: Record<string, unknown> } = {},
  ): Promise<ToolCall> {
    const toolUseId = `toolu_${randomBytes(12).toString('hex')}`;
    const common = { tool_name: name, tool_input: input, tool_use_id: toolUseId, effort: { level: 'medium' }, ...opts.extra };
    const pre = await this.hook('PreToolUse', common);
    const decision = decisionOf(pre);
    if (decision !== 'allow') return { toolUseId, pre, post: null, decision };
    const ran = opts.run?.();
    const response = opts.response ?? ran ?? { ok: true };
    const post = opts.failWith
      ? await this.hook('PostToolUseFailure', { ...common, error: opts.failWith, is_interrupt: false, duration_ms: 9 })
      : await this.hook('PostToolUse', { ...common, tool_response: response, duration_ms: 12 });
    expectExit0(post);
    return { toolUseId, pre, post, decision };
  }

  read(file: string): Promise<ToolCall> {
    const path = join(this.s.cwd, file);
    return this.tool('Read', { file_path: path }, { run: () => ({ type: 'text', file: { filePath: path, content: readFileSync(path, 'utf8') } }) });
  }

  write(file: string, content: string): Promise<ToolCall> {
    const path = join(this.s.cwd, file);
    return this.tool('Write', { file_path: path, content }, {
      run: () => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
        return { type: 'create', filePath: path, content, structuredPatch: [], originalFile: null, userModified: false };
      },
    });
  }

  edit(file: string, oldString: string, newString: string): Promise<ToolCall> {
    const path = join(this.s.cwd, file);
    return this.tool('Edit', { file_path: path, old_string: oldString, new_string: newString, replace_all: false }, {
      run: () => {
        const before = readFileSync(path, 'utf8');
        if (!before.includes(oldString)) throw new Error(`Edit: ${oldString} not found in ${file}`);
        writeFileSync(path, before.replace(oldString, newString));
        return { filePath: path, oldString, newString, originalFile: before, structuredPatch: [], userModified: false, replaceAll: false };
      },
    });
  }

  /** Bash: runs the command for real in the session cwd when the hook allows it. */
  bash(command: string): Promise<ToolCall> {
    return this.tool('Bash', { command, description: command.slice(0, 60) }, {
      run: () => {
        const r = spawnSync('bash', ['-c', command], { cwd: this.s.cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        return { stdout: r.stdout, stderr: r.stderr, interrupted: false, isImage: false, noOutputExpected: false };
      },
    });
  }

  // ── MCP ──────────────────────────────────────────────────────────────────
  /** The AOC MCP server over stdio, with the env the supervisor passes in the --mcp-config entry. */
  async mcp(): Promise<Client> {
    if (this.client) return this.client;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: tsNode(MCP_MAIN),
      cwd: this.s.cwd,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: this.h.homeDir,
        CLAUDE_CODE_SESSION_ID: this.s.claudeSessionId,
        AOC_SESSION_ID: this.s.sessionId,
        AOC_DAEMON_URL: this.h.url,
        AOC_INGEST_TOKEN: this.s.token,
      },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (c: Buffer) => (this.mcpStderr += c.toString('utf8')));
    const client = new Client({ name: 'claude-code', version: '2.1.295' });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  get mcpLog(): string {
    return this.mcpStderr;
  }

  /**
   * An AOC MCP tool call as Claude Code makes it: PreToolUse(mcp__aoc__<tool>) → tools/call → PostToolUse with the
   * content blocks. Returns the tool's text and structuredContent.
   */
  async aoc(tool: AocMcpToolName, args: Record<string, unknown>): Promise<McpCall> {
    const client = await this.mcp();
    const toolUseId = `toolu_${randomBytes(12).toString('hex')}`;
    const common = {
      tool_name: mcpToolName(tool),
      tool_input: args,
      tool_use_id: toolUseId,
      effort: { level: 'medium' },
      mcp_server: { name: 'aoc', source: 'dynamic' },
    };
    const pre = await this.hook('PreToolUse', common);
    const decision = decisionOf(pre);
    if (decision !== 'allow') throw new Error(`PreToolUse denied ${tool}: ${denyReason(pre)}`);
    const result = (await client.callTool({ name: tool, arguments: args })) as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
      structuredContent?: unknown;
    };
    const content = Array.isArray(result.content) ? result.content : [];
    // Claude Code reports an MCP tool's result to PostToolUse as its content-block array.
    const post = expectExit0(await this.hook('PostToolUse', { ...common, tool_response: content, duration_ms: 20 }));
    return {
      isError: result.isError === true,
      text: content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n'),
      data: result.structuredContent ?? null,
      tool: { toolUseId, pre, post, decision },
    };
  }

  // ── sidecar ──────────────────────────────────────────────────────────────
  startSidecar(opts: { intervalMs?: number } = {}): SidecarProcess {
    const stateDir = join(this.h.root, 'sidecar', this.s.sessionId);
    const child = spawn(
      process.execPath,
      tsNode(
        SIDECAR_MAIN,
        '--session', this.s.sessionId,
        '--pid', String(this.s.pid),
        '--transcript', this.s.transcriptPath,
        '--daemon', this.h.url,
        '--token', this.s.token,
        '--interval', String(opts.intervalMs ?? 200),
        '--state-dir', stateDir,
        '--spool-dir', join(stateDir, 'spool'),
      ),
      { cwd: this.s.cwd, env: { PATH: process.env.PATH ?? '', HOME: this.h.homeDir, TZ: 'Asia/Kuala_Lumpur' }, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    this.h.track(child);
    this.sidecarProc = new SidecarProcess(child);
    return this.sidecarProc;
  }

  /** The claude process exits (end of turn / crash): what the sidecar watches for. */
  killClaude(signal: NodeJS.Signals = 'SIGKILL'): void {
    this.s.claude.kill(signal);
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = null;
    await this.sidecarProc?.stop();
  }
}

// ── observed session ──────────────────────────────────────────────────────────

/** A developer's own `claude` in a terminal: global (observed) hooks configured by ~/.aoc/client.json. */
export class ObservedClaude {
  readonly claudeSessionId = randomUUID();
  readonly transcriptPath: string;
  readonly transcript: Transcript;
  readonly homeDir: string;
  promptId = randomUUID();

  constructor(
    readonly h: Harness,
    readonly cwd: string,
    observerToken: string,
  ) {
    this.homeDir = join(h.root, `observed-home-${this.claudeSessionId.slice(0, 8)}`);
    mkdirSync(join(this.homeDir, '.aoc'), { recursive: true });
    writeFileSync(join(this.homeDir, '.aoc', 'client.json'), JSON.stringify({ daemonUrl: h.url, observerToken }));
    this.transcriptPath = transcriptPathFor(cwd, this.claudeSessionId, join(this.homeDir, '.claude'));
    this.transcript = new Transcript(this.transcriptPath, this.claudeSessionId, cwd);
  }

  get spoolDir(): string {
    return join(this.homeDir, '.aoc', 'spool', 'observed');
  }

  hook(event: string, fields: Record<string, unknown> = {}): Promise<HookRun> {
    const base: Record<string, unknown> = { session_id: this.claudeSessionId, transcript_path: this.transcriptPath, cwd: this.cwd, hook_event_name: event };
    if (event !== 'SessionStart') Object.assign(base, { prompt_id: this.promptId, permission_mode: 'default' });
    // The globally installed entries carry AOC_HOOK_SCOPE=observed (hooks/settings.ts).
    const env = { PATH: process.env.PATH ?? '', HOME: this.homeDir, AOC_HOOK_SCOPE: 'observed' };
    return runHookBinary(event, { ...base, ...fields }, env, this.cwd, (c) => this.h.track(c));
  }

  async tool(name: string, input: Record<string, unknown>, response: unknown = { ok: true }): Promise<{ pre: HookRun; post: HookRun; toolUseId: string }> {
    const toolUseId = `toolu_${randomBytes(12).toString('hex')}`;
    const common = { tool_name: name, tool_input: input, tool_use_id: toolUseId, effort: { level: 'medium' } };
    const pre = await this.hook('PreToolUse', common);
    const post = await this.hook('PostToolUse', { ...common, tool_response: response, duration_ms: 7 });
    return { pre, post, toolUseId };
  }
}

export function expectExit0(run: HookRun): HookRun {
  if (run.code !== 0) throw new Error(`hook ${run.event} exited ${run.code}: ${run.stderr || run.stdout}`);
  return run;
}
