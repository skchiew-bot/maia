import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HELP_TEXT, parseArgs, PERMISSION_MODES, UsageError, type CliOptions } from './args';
import { DEFAULT_SCENARIO, listBuiltInScenarios } from './builtins';
import { BUILTIN_TOOLS, CLAUDE_CODE_VERSION } from './constants';
import { HookRunner } from './hooks';
import { IdSource, UUID_RE } from './ids';
import { McpHub, parseMcpConfigs, type McpServerConfig } from './mcp';
import { OutputSink, type StreamMessage, type Writer } from './output';
import {
  claudeConfigDir,
  gitBranchOf,
  projectDirFor,
  realpathLoose,
  simStatePathFor,
  transcriptPathFor,
  type SimEnv,
} from './paths';
import { parseRules, type PermissionMode, type PermissionPolicy } from './permissions';
import {
  loadScenario,
  resolveScenarioRef,
  scenarioMarker,
  type LoadedScenario,
  type ScenarioRef,
} from './scenario';
import { ScenarioError } from './scenario-schema';
import { SimSession, type ResumeContext, type TurnResult } from './session';
import { ConfigError, loadSettings, type EffectiveSettings } from './settings';
import { loadState, type SimState } from './state';
import { Pacer, parseSpeed, SimAbortError } from './time';
import {
  forkTranscript,
  readTranscriptSummary,
  TranscriptWriter,
  type TranscriptSummary,
} from './transcript';
import { CACHE_TTL_MS, cacheWriteUsd, freshContext, makeUsage, resolveModel } from './usage';

export interface SimIO {
  /** Working directory of the simulated session (default: process.cwd()). */
  cwd?: string;
  /** Prompt source when no prompt argument is given (a string is used verbatim). */
  stdin?: NodeJS.ReadableStream | string;
  stdout: Writer;
  stderr: Writer;
  /** Aborting stops the run like SIGTERM would (exit 143); with the reason "SIGINT" it ends the turn cleanly, like Ctrl-C. */
  signal?: AbortSignal;
  /** Clock for timestamps and rate-limit reset times (default: Date.now). */
  now?: () => number;
  homeDir?: string;
}

const KNOWN_MODES: readonly string[] = [...PERMISSION_MODES, 'default'];

async function readStdin(stdin: SimIO['stdin']): Promise<string> {
  if (stdin === undefined) return '';
  if (typeof stdin === 'string') return stdin;
  if ((stdin as { isTTY?: boolean }).isTTY) return '';
  let text = '';
  for await (const chunk of stdin)
    text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  return text;
}

/** `--input-format stream-json`: one SDK user message per line; each becomes a turn. */
function parseStreamJsonInput(text: string): string[] {
  const prompts: string[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let line: { type?: unknown; message?: { content?: unknown } };
    try {
      line = JSON.parse(raw) as typeof line;
    } catch {
      continue;
    }
    if (line.type !== 'user') continue;
    const content = line.message?.content;
    if (typeof content === 'string') prompts.push(content);
    else if (Array.isArray(content)) {
      prompts.push(
        content
          .filter(
            (block): block is { type: string; text: string } =>
              block?.type === 'text' && typeof block.text === 'string',
          )
          .map((block) => block.text)
          .join('\n'),
      );
    }
  }
  return prompts;
}

/** Prompts of this invocation: the argument, stdin, or (stream-json input) one per user message. */
async function readPrompts(options: CliOptions, stdin: SimIO['stdin']): Promise<string[]> {
  const prompts =
    options.inputFormat === 'stream-json'
      ? parseStreamJsonInput(await readStdin(stdin))
      : [options.prompt ?? (await readStdin(stdin))];
  if (prompts.length === 0 || prompts[0]!.trim() === '') {
    throw new ConfigError(
      'Error: Input must be provided either through stdin or as a prompt argument when using --print',
    );
  }
  return prompts;
}

interface Limits {
  maxBudgetUsd?: number;
  maxTurns?: number;
}

function parseLimits(options: CliOptions): Limits {
  const limits: Limits = {};
  if (options.maxBudgetUsd !== undefined) {
    limits.maxBudgetUsd = Number(options.maxBudgetUsd);
    if (!(limits.maxBudgetUsd > 0))
      throw new ConfigError('Error: --max-budget-usd must be a positive number');
  }
  if (options.maxTurns !== undefined) {
    limits.maxTurns = Number(options.maxTurns);
    if (!Number.isInteger(limits.maxTurns) || limits.maxTurns <= 0)
      throw new ConfigError('Error: --max-turns must be a positive integer');
  }
  return limits;
}

/** Session-id checks, in the order and wording of the real CLI. */
function checkSessionFlags(options: CliOptions, cwd: string, configDir: string): void {
  if (options.sessionId === undefined) return;
  if ((options.resume !== undefined || options.continue) && !options.forkSession) {
    throw new ConfigError(
      'Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.',
    );
  }
  if (!UUID_RE.test(options.sessionId))
    throw new ConfigError('Error: Invalid session ID. Must be a valid UUID.');
  const resumingSameId = options.forkSession && options.resume === options.sessionId;
  if (!resumingSameId && fs.existsSync(transcriptPathFor(cwd, options.sessionId, configDir))) {
    throw new ConfigError(`Error: Session ID ${options.sessionId} is already in use.`);
  }
}

function mostRecentSession(projectDir: string): string | undefined {
  let best: { id: string; mtime: number } | undefined;
  let entries: string[];
  try {
    entries = fs.readdirSync(projectDir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const id = entry.replace(/\.jsonl$/, '');
    if (id === entry || !UUID_RE.test(id)) continue;
    const mtime = fs.statSync(path.join(projectDir, entry)).mtimeMs;
    if (!best || mtime > best.mtime) best = { id, mtime };
  }
  return best?.id;
}

type Identity =
  | { ok: true; sessionId: string; previousId?: string; source: 'startup' | 'resume' | 'fork' }
  | { ok: false; error: string; sessionId: string };

/** New session, resume of an existing one, or a fork of it under a new id. */
function resolveIdentity(options: CliOptions, cwd: string, configDir: string): Identity {
  if (options.resume === undefined && !options.continue) {
    return { ok: true, sessionId: options.sessionId ?? randomUUID(), source: 'startup' };
  }
  if (options.resume === true)
    return {
      ok: false,
      error: 'Error: --resume requires a session ID when used with --print',
      sessionId: randomUUID(),
    };
  const previousId = options.resume ?? mostRecentSession(projectDirFor(cwd, configDir));
  if (previousId === undefined)
    return { ok: false, error: 'No conversation found to continue', sessionId: randomUUID() };
  if (!fs.existsSync(transcriptPathFor(cwd, previousId, configDir))) {
    return {
      ok: false,
      error: `No conversation found with session ID: ${previousId}`,
      sessionId: previousId,
    };
  }
  if (!options.forkSession) return { ok: true, sessionId: previousId, previousId, source: 'resume' };
  return { ok: true, sessionId: options.sessionId ?? randomUUID(), previousId, source: 'fork' };
}

function sameRef(a: ScenarioRef, b: ScenarioRef): boolean {
  return a.kind === 'builtin' && b.kind === 'builtin'
    ? a.name === b.name
    : a.kind === 'file' && b.kind === 'file' && a.path === b.path;
}

/**
 * A `[[scenario:<name>]]` marker in the prompt beats CLAUDE_SIM_SCENARIO; a resumed session keeps its scenario
 * and cursor unless a marker names a different scenario (which restarts it).
 */
function chooseScenario(
  prompt: string,
  env: SimEnv,
  cwd: string,
  state: SimState | null,
): { loaded: LoadedScenario; state: SimState | null } {
  const requested =
    scenarioMarker(prompt) ?? (state ? undefined : env.CLAUDE_SIM_SCENARIO || DEFAULT_SCENARIO);
  const ref = requested !== undefined ? resolveScenarioRef(requested, cwd) : state!.scenario;
  return { loaded: loadScenario(ref), state: state && sameRef(ref, state.scenario) ? state : null };
}

/** SessionStart's resume/fork fields, from the resumed transcript's last model response. */
function resumeContextFrom(
  history: TranscriptSummary | undefined,
  model: string,
  now: number,
): ResumeContext | undefined {
  const last = history?.lastResponse;
  if (!last) return undefined;
  const usage = last.usage;
  const contextTokens =
    usage.input_tokens +
    usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens +
    usage.output_tokens;
  const seconds = Math.max(0, Math.round((now - Date.parse(last.timestamp)) / 1000));
  return {
    seconds_since_last_response: seconds,
    context_tokens: contextTokens,
    prompt_cache_likely_expired: seconds * 1000 > CACHE_TTL_MS,
    estimated_cache_write_usd: cacheWriteUsd(model, contextTokens),
  };
}

function permissionPolicy(
  options: CliOptions,
  settings: EffectiveSettings,
  cwd: string,
  homeDir: string,
): PermissionPolicy {
  const configuredMode =
    settings.defaultMode && KNOWN_MODES.includes(settings.defaultMode) ? settings.defaultMode : 'default';
  const mode = (
    options.dangerouslySkipPermissions ? 'bypassPermissions' : (options.permissionMode ?? configuredMode)
  ) as PermissionMode;
  const extraDirs = [...options.addDir, ...settings.additionalDirectories].map((dir) =>
    path.resolve(cwd, dir),
  );
  return {
    mode,
    allow: parseRules([...settings.allow, ...options.allowedTools]),
    deny: parseRules([...settings.deny, ...options.disallowedTools]),
    cwd,
    workingDirs: [cwd, ...extraDirs].map(realpathLoose),
    homeDir,
  };
}

function enabledBuiltins(tools: string[] | undefined): Set<string> {
  if (tools === undefined) return new Set(BUILTIN_TOOLS);
  const names = tools
    .flatMap((value) => value.split(/[,\s]+/))
    .filter(Boolean)
    .map((name) => (name === 'Task' ? 'Agent' : name));
  if (names.includes('default')) return new Set(BUILTIN_TOOLS);
  // Unknown names (LS, MultiEdit, TodoWrite, typos) are dropped silently, as in Claude Code.
  return new Set(names.filter((name) => (BUILTIN_TOOLS as readonly string[]).includes(name)));
}

/** Environment for hooks, MCP servers and executed bash: inherited env + settings env + Claude Code markers. */
function childEnvironment(env: SimEnv, settings: EffectiveSettings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  Object.assign(out, settings.env);
  out.CLAUDECODE = '1';
  out.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli';
  return out;
}

function errorResult(message: string, sessionId: string): StreamMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: true,
    num_turns: 0,
    stop_reason: null,
    session_id: sessionId,
    total_cost_usd: 0,
    usage: makeUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    errors: [message],
  };
}

/**
 * Run one `claude` invocation in-process. `argv` excludes the executable (process.argv.slice(2)); `env` is
 * used instead of process.env everywhere (child processes included). Resolves to the exit code.
 */
export async function runClaudeSim(argv: readonly string[], env: SimEnv, io: SimIO): Promise<number> {
  const writeErr = (message: string): void => {
    io.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
  };
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      writeErr(error.message);
      return 1;
    }
    throw error;
  }
  if (options.help) {
    io.stdout.write(`${HELP_TEXT}\nBuilt-in scenarios: ${listBuiltInScenarios().join(', ')}\n`);
    return 0;
  }
  if (options.version) {
    io.stdout.write(`${CLAUDE_CODE_VERSION} (Claude Code)\n`);
    return 0;
  }

  const now = io.now ?? Date.now;
  let cwd: string;
  try {
    cwd = fs.realpathSync(io.cwd ?? process.cwd());
  } catch {
    writeErr(`Error: working directory does not exist: ${io.cwd ?? process.cwd()}`);
    return 1;
  }
  const homeDir = io.homeDir ?? os.homedir();
  const configDir = claudeConfigDir(env, homeDir);
  const debug =
    options.debug || env.CLAUDE_SIM_DEBUG === '1'
      ? (message: string) => writeErr(`[claude-sim] ${message}`)
      : undefined;

  let settings: EffectiveSettings;
  let mcpConfigs: Record<string, McpServerConfig>;
  let prompts: string[];
  let limits: Limits;
  try {
    settings = loadSettings(options.settings, env, cwd);
    checkSessionFlags(options, cwd, configDir);
    mcpConfigs = parseMcpConfigs(options.mcpConfig, cwd, env);
    prompts = await readPrompts(options, io.stdin);
    if (options.outputFormat === 'stream-json' && !options.verbose) {
      throw new ConfigError('Error: When using --print, --output-format=stream-json requires --verbose');
    }
    limits = parseLimits(options);
  } catch (error) {
    if (error instanceof ConfigError) {
      writeErr(error.message);
      return 1;
    }
    throw error;
  }

  const out = new OutputSink(
    options.outputFormat,
    options.verbose,
    options.includePartialMessages,
    io.stdout,
  );
  const identity = resolveIdentity(options, cwd, configDir);
  if (!identity.ok) {
    writeErr(identity.error);
    if (options.outputFormat !== 'text')
      out.result(errorResult(identity.error, identity.sessionId), io.stderr);
    return 1;
  }
  const { sessionId, previousId, source } = identity;
  const persist = !options.noSessionPersistence;
  const transcriptPath = transcriptPathFor(cwd, sessionId, configDir);
  const previousTranscript =
    previousId !== undefined ? transcriptPathFor(cwd, previousId, configDir) : undefined;
  // The resumed history (for a fork, the source session's) seeds the chain, the cost ledger and SessionStart.
  const history = previousTranscript !== undefined ? readTranscriptSummary(previousTranscript) : undefined;

  let loaded: LoadedScenario;
  let state: SimState | null;
  try {
    const previousState = previousId !== undefined ? loadState(simStatePathFor(previousId, configDir)) : null;
    ({ loaded, state } = chooseScenario(prompts[0]!, env, cwd, previousState));
  } catch (error) {
    if (error instanceof ScenarioError) {
      writeErr(`claude-sim: ${error.message}`);
      return 1;
    }
    throw error;
  }
  if (source === 'fork' && persist) forkTranscript(previousTranscript!, transcriptPath, sessionId);

  const model = resolveModel(options.model ?? settings.model ?? env.ANTHROPIC_MODEL);
  const resumeContext = resumeContextFrom(history, model, now());
  const policy = permissionPolicy(options, settings, cwd, homeDir);
  const childEnv = childEnvironment(env, settings);
  const mcp = new McpHub({
    env: childEnv,
    cwd,
    connectTimeoutMs: Number(env.MCP_TIMEOUT) || 30_000,
    toolTimeoutMs: Number(env.MCP_TOOL_TIMEOUT) || 600_000,
    ...(debug && {
      onStderr: (server: string, chunk: string) => debug(`mcp ${server} stderr: ${chunk.trimEnd()}`),
      debug,
    }),
  });

  let session: SimSession | undefined;
  try {
    await mcp.connectAll(mcpConfigs);
    const mcpPrefixTokens = Math.ceil(mcp.definitionChars() / 4);
    const createdAt = new Date(now()).toISOString();
    const simState: SimState = state
      ? { ...state, sessionId }
      : {
          version: 1,
          sessionId,
          scenario: loaded.ref,
          cursor: 0,
          saved: {},
          context: freshContext(mcpPrefixTokens),
          idCounter: 0,
          turns: 0,
          createdAt,
          updatedAt: createdAt,
        };
    // A resume without sim state must not regenerate the ids already in the transcript.
    const seed = source !== 'startup' && state === null ? `${sessionId}:${randomUUID()}` : sessionId;

    session = new SimSession({
      sessionId,
      cwd,
      transcriptPath,
      statePath: simStatePathFor(sessionId, configDir),
      persist,
      source,
      ...(resumeContext && { resumeContext }),
      model,
      scenario: loaded,
      state: simState,
      restoredCost: history?.costState ?? null,
      permissionMode: policy.mode,
      policy,
      enabledBuiltins: enabledBuiltins(options.tools),
      ...limits,
      mcpPrefixTokens,
      childEnv,
      execAllowed: env.CLAUDE_SIM_EXEC === '1',
      ...(env.TZ && { timeZone: env.TZ }),
      hooks: new HookRunner(settings.hooks, {
        env: childEnv,
        cwd,
        projectDir: cwd,
        disabled: settings.disableAllHooks,
        ...(debug && { debug }),
      }),
      mcp,
      out,
      transcript: new TranscriptWriter(
        transcriptPath,
        { sessionId, cwd, version: CLAUDE_CODE_VERSION, gitBranch: gitBranchOf(cwd) },
        persist,
        history?.leafUuid ?? null,
      ),
      ids: new IdSource(seed, simState.idCounter),
      streamIds: new IdSource(`${seed}:stream:${simState.turns}`),
      pacer: new Pacer(parseSpeed(env.CLAUDE_SIM_SPEED), io.signal),
      ...(io.signal && { signal: io.signal }),
      now,
      stderr: io.stderr,
    });

    let result: TurnResult | null = await session.start();
    if (result === null) {
      for (const prompt of prompts) {
        result = await session.runTurn(prompt);
        if (result.kind === 'crash') break;
        session.emitResult(result);
        if (result.exitCode !== 0) break;
      }
    } else {
      session.emitResult(result);
    }
    await session.end(result!);
    return result!.exitCode;
  } catch (error) {
    if (error instanceof SimAbortError) {
      // SIGINT ends the turn cleanly (result, cost state, exit 0); SIGTERM kills it: no result and no cost-state
      // line, SessionEnd still fires, exit 143 (both observed on 2.1.295).
      if (error.reason === 'SIGINT' && session) return session.interrupted();
      await session?.sessionEnd();
      return 143;
    }
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    writeErr(`claude-sim: internal error: ${message}`);
    if (options.outputFormat !== 'text') out.result(errorResult(String(error), sessionId), io.stderr);
    return 1;
  } finally {
    await mcp.closeAll();
  }
}
