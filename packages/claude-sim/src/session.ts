import { CLAUDE_CODE_VERSION, type HookEventName } from './constants';
import type { HookOutcome, HookRunner } from './hooks';
import type { IdSource } from './ids';
import { mcpToolName, type McpCallResult, type McpHub } from './mcp';
import type { OutputSink, StreamMessage, Writer } from './output';
import { decidePermission, isWholeToolDenied, type HookVerdict, type PermissionPolicy } from './permissions';
import { rateLimitNotice } from './ratelimit';
import { gotoIndex, type LoadedScenario } from './scenario';
import { ScenarioError, type ScenarioStep, type StepOf } from './scenario-schema';
import { saveState, type SimState } from './state';
import { renderDeep, renderText, type TemplateContext } from './template';
import { SimAbortError, type Pacer } from './time';
import {
  absolutizePaths,
  runBash,
  runBuiltinTool,
  scriptedResult,
  toolError,
  type ToolContext,
  type ToolOutcome,
} from './tools';
import type { TranscriptWriter } from './transcript';
import {
  CostLedger,
  estimateTokens,
  makeUsage,
  nextRequest,
  SESSION_PREFIX_TOKENS,
  SHARED_PREFIX_TOKENS,
  type CostState,
  type RequestShape,
  type Usage,
} from './usage';

export type ResultSubtype = 'success' | 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd';

/** How a turn ended. A `crash` produces no result line, no cost-state line and skips Stop/SessionEnd hooks. */
export interface TurnResult {
  kind: 'result' | 'crash';
  subtype: ResultSubtype;
  isError: boolean;
  resultText?: string;
  errors?: string[];
  stopReason: string | null;
  terminalReason?: string;
  apiErrorStatus?: number;
  exitCode: number;
}

/** SessionStart fields Claude Code adds when it resumes or forks a transcript. */
export interface ResumeContext {
  seconds_since_last_response: number;
  context_tokens: number;
  prompt_cache_likely_expired: boolean;
  estimated_cache_write_usd: number;
}

export interface SessionDeps {
  sessionId: string;
  cwd: string;
  transcriptPath: string;
  statePath: string;
  persist: boolean;
  source: 'startup' | 'resume' | 'fork';
  resumeContext?: ResumeContext;
  model: string;
  scenario: LoadedScenario;
  state: SimState;
  /** Cumulative spend restored from the transcript's last cost-state line. */
  restoredCost: CostState | null;
  /** Mode name reported to hooks and in the init message. */
  permissionMode: string;
  policy: PermissionPolicy;
  enabledBuiltins: ReadonlySet<string>;
  maxBudgetUsd?: number;
  maxTurns?: number;
  /** Extra system-prompt tokens contributed by MCP tool definitions. */
  mcpPrefixTokens: number;
  childEnv: Readonly<Record<string, string>>;
  execAllowed: boolean;
  timeZone?: string;
  hooks: HookRunner;
  mcp: McpHub;
  out: OutputSink;
  transcript: TranscriptWriter;
  /** Ids that land in the transcript (deterministic per session). */
  ids: IdSource;
  /** Ids that only appear on stdout, so output flags never shift transcript ids. */
  streamIds: IdSource;
  pacer: Pacer;
  /** Aborts the session (SIGTERM / SIGINT in the CLI). */
  signal?: AbortSignal;
  now: () => number;
  stderr: Writer;
}

type StepOutcome = 'next' | 'ended' | 'continue';

interface PendingBlock {
  content: Record<string, unknown>;
  uuid: string;
  timestamp: string;
}

interface OpenResponse {
  messageId: string;
  requestId: string;
  base: { input: number; cacheRead: number; cacheWrite: number };
  /** Sum of think-step output tokens; when null, output is estimated from the blocks. */
  thinkOutput: number | null;
  estimatedOutput: number;
  blocks: PendingBlock[];
  openedAt: number;
  nextIndex: number;
}

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  run: () => Promise<ToolOutcome>;
  saveAs?: string;
  mcp?: { tool: string; obey: boolean };
}

/** Thrown inside a turn to end it immediately with a prepared result. */
class TurnStop extends Error {
  constructor(readonly result: TurnResult) {
    super('turn stopped');
  }
}

const MAX_STEPS_PER_TURN = 10_000;
/** The tool_result of a call that was pending when the user interrupted (observed on 2.1.295). */
const REJECTED_TOOL_USE_TEXT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
/** Consecutive Stop-hook blocks honoured before the turn ends regardless (Claude Code relies on stop_hook_active). */
const MAX_STOP_HOOK_CONTINUATIONS = 3;
/** Observed on 2.1.295 (research §4.2): lifecycle events (SessionStart/End, compaction, subagent start) carry neither field. */
const PERMISSION_MODE_EVENTS: ReadonlySet<HookEventName> = new Set([
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'PermissionRequest',
  'Stop',
  'StopFailure',
]);
const EFFORT_EVENTS: ReadonlySet<HookEventName> = new Set([...PERMISSION_MODE_EVENTS].filter((e) => e !== 'UserPromptSubmit'));
const SCENARIO_COMPLETE_TEXT = 'All scenario steps are complete; there is nothing further to do.';
const STOP_FEEDBACK_TEXT = 'Noted the Stop hook feedback; there is nothing further to do.';
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** `text` cut into exactly `count` consecutive pieces (some may be empty). */
function pieces(text: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    text.slice(Math.floor((i * text.length) / count), Math.floor(((i + 1) * text.length) / count)),
  );
}

/** `total` split into `count` integers that add up to it exactly. */
function shares(total: number, count: number): number[] {
  const base = Math.floor(total / count);
  return Array.from({ length: count }, (_, i) => base + (i < total % count ? 1 : 0));
}

function contentText(content: ToolOutcome['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => (typeof block.text === 'string' ? block.text : JSON.stringify(block)))
    .join('\n');
}

/** What a step that reads an MCP result sees: structuredContent, else JSON-parsed text, else the text. */
function mcpPayload(result: McpCallResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** One simulated Claude Code session: replays scenario steps as model turns, tools, hooks and transcript lines. */
export class SimSession {
  private open: OpenResponse | null = null;
  private readonly ledger: CostLedger;
  private readonly startedAt: number;
  private numTurns = 0;
  private allowedEventSent = false;
  private readonly denials: {
    tool_name: string;
    tool_use_id: string;
    tool_input: Record<string, unknown>;
  }[] = [];
  private readonly toolContext: ToolContext;
  private pendingStartContext: HookOutcome | null = null;
  // Per-turn state.
  private prompt = '';
  private promptId = '';
  private latestInput = '';
  private lastResponseText = '';
  private lastToolError = false;
  private stepsThisTurn = 0;
  private stopHookActive = false;
  private stopContinuations = 0;
  /** The tool call whose result has not been written yet (what SIGINT rejects). */
  private pendingTool: { toolUseId: string; sourceUuid: string } | null = null;

  constructor(private readonly deps: SessionDeps) {
    this.startedAt = deps.now();
    this.ledger = new CostLedger(deps.restoredCost);
    this.toolContext = { cwd: deps.cwd, env: deps.childEnv, execAllowed: deps.execAllowed, signal: deps.signal };
  }

  /** SessionStart hooks, then the stream-json init message. Returns a result if a hook stopped the session. */
  async start(): Promise<TurnResult | null> {
    const outcome = await this.runHooks(
      'SessionStart',
      { source: this.deps.source, ...this.deps.resumeContext },
      this.deps.source,
    );
    this.pendingStartContext = outcome;
    this.deps.out.emit(this.initMessage());
    return outcome.preventContinuation ? this.stopped(outcome.stopReason) : null;
  }

  async runTurn(prompt: string): Promise<TurnResult> {
    this.prompt = prompt;
    this.latestInput = prompt;
    this.lastResponseText = '';
    this.lastToolError = false;
    this.stepsThisTurn = 0;
    this.stopHookActive = false;
    this.stopContinuations = 0;
    this.promptId = this.deps.ids.uuid();

    const submit = await this.runHooks('UserPromptSubmit', { prompt });
    if (submit.blocking.length > 0) {
      this.flushStartContext();
      return {
        kind: 'result',
        subtype: 'error_during_execution',
        isError: true,
        errors: [
          `UserPromptSubmit operation blocked by hook:\n${submit.blocking.map((block) => block.reason).join('\n')}`,
        ],
        stopReason: null,
        terminalReason: 'hook_stopped',
        exitCode: 1,
      };
    }

    const ts = this.timestamp();
    const { transcript, sessionId } = this.deps;
    transcript.unchained({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: ts,
      sessionId,
      content: prompt,
    });
    transcript.unchained({ type: 'queue-operation', operation: 'dequeue', timestamp: ts, sessionId });
    transcript.chained(
      this.deps.ids.uuid(),
      ts,
      { promptId: this.promptId, type: 'user', message: { role: 'user', content: prompt } },
      { permissionMode: this.deps.permissionMode },
    );
    this.flushStartContext();
    this.recordHookSideEffects(submit, 'UserPromptSubmit');
    this.deps.state.context.uncached += estimateTokens(prompt);
    this.deps.state.turns += 1;
    this.persistState();

    let result: TurnResult;
    if (submit.preventContinuation) {
      this.stoppedContinuation(submit, 'UserPromptSubmit');
      result = this.stopped(submit.stopReason);
    } else {
      try {
        result = await this.loop();
      } catch (error) {
        if (error instanceof TurnStop) result = error.result;
        else if (error instanceof ScenarioError) result = this.failure(error.message);
        else throw error;
      }
    }
    if (result.kind === 'crash') return result;
    this.closeResponse('end_turn');
    transcript.unchained({
      type: 'last-prompt',
      lastPrompt: prompt.length > 200 ? `${prompt.slice(0, 200)}…` : prompt,
      leafUuid: transcript.leafUuid,
      sessionId,
    });
    this.persistState();
    return result;
  }

  /** The final `result` message: `usage` covers this invocation, cost and modelUsage the whole session. */
  emitResult(result: TurnResult): void {
    const message: StreamMessage = {
      type: 'result',
      subtype: result.subtype,
      is_error: result.isError,
      api_error_status: result.apiErrorStatus ?? null,
      duration_ms: Math.max(0, this.deps.now() - this.startedAt),
      duration_api_ms: this.ledger.invocationApiMs,
      num_turns: this.numTurns,
      ...(result.resultText !== undefined && { result: result.resultText }),
      stop_reason: result.stopReason,
      ...(result.terminalReason !== undefined && { terminal_reason: result.terminalReason }),
      session_id: this.deps.sessionId,
      total_cost_usd: this.ledger.cumulativeCostUsd(),
      usage: this.ledger.invocationUsage(),
      modelUsage: this.ledger.resultModelUsage(),
      permission_denials: this.denials,
      ...(result.errors !== undefined && { errors: result.errors }),
      uuid: this.deps.streamIds.uuid(),
    };
    this.deps.out.result(message, this.deps.stderr);
  }

  /** End of a graceful invocation: the cumulative cost-state line, then SessionEnd hooks. Nothing after a crash. */
  async end(result: TurnResult): Promise<void> {
    if (result.kind === 'crash') return;
    const now = this.deps.now();
    this.deps.transcript.unchained({
      type: 'cost-state',
      sessionId: this.deps.sessionId,
      ...this.ledger.costState(Math.max(0, now - this.startedAt), this.startedAt),
    });
    await this.sessionEnd();
  }

  /**
   * SIGINT (observed on 2.1.295): the turn ends cleanly, unlike SIGTERM. A pending tool call is rejected, the
   * interruption is written as a user message, a `result` of subtype error_during_execution is printed (terminal
   * reason aborted_tools, or aborted_streaming when no tool was pending), the cost state is saved, SessionEnd fires
   * and the process exits 0. No Stop hook runs. The response being generated is dropped.
   */
  async interrupted(): Promise<number> {
    const pending = this.pendingTool;
    this.open = null;
    if (pending) {
      this.writeToolResult(pending.toolUseId, pending.sourceUuid, {
        content: REJECTED_TOOL_USE_TEXT,
        isError: true,
        toolUseResult: 'User rejected tool use',
        resultMeta: { non_execution_kind: 'user-rejected' },
      });
    }
    const message = {
      role: 'user',
      content: [{ type: 'text', text: pending ? '[Request interrupted by user for tool use]' : '[Request interrupted by user]' }],
    };
    const uuid = this.deps.ids.uuid();
    const timestamp = this.timestamp();
    this.deps.transcript.chained(uuid, timestamp, { promptId: this.promptId, type: 'user', message }, {});
    this.deps.out.emit({
      type: 'user',
      message,
      parent_tool_use_id: null,
      session_id: this.deps.sessionId,
      uuid,
      timestamp,
    });
    const result: TurnResult = {
      kind: 'result',
      subtype: 'error_during_execution',
      isError: true,
      errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'],
      stopReason: 'tool_use',
      terminalReason: pending ? 'aborted_tools' : 'aborted_streaming',
      exitCode: 0,
    };
    this.emitResult(result);
    await this.end(result);
    return result.exitCode;
  }

  /** SIGTERM: SessionEnd still fires, but there is no result and no cost-state line. */
  async sessionEnd(): Promise<void> {
    await this.runHooks('SessionEnd', { reason: 'other' }, 'other');
  }

  // ---------------------------------------------------------------------------------------------------------
  // Step loop

  private async loop(): Promise<TurnResult> {
    const steps = this.deps.scenario.scenario.steps;
    let endAfterStep = false;
    for (let guard = 0; guard < MAX_STEPS_PER_TURN; guard++) {
      this.deps.pacer.throwIfAborted();
      this.checkBudget();
      if (this.deps.state.cursor >= steps.length) {
        if (endAfterStep) this.say(STOP_FEEDBACK_TEXT);
        else if (this.stepsThisTurn === 0) this.say(SCENARIO_COMPLETE_TEXT);
        if ((await this.finishTurn()) === 'ended') return this.success();
        endAfterStep = true;
        continue;
      }
      const index = this.deps.state.cursor;
      const step = steps[index]!;
      // The cursor moves before the step runs, so a crash/kill mid-step resumes after it.
      this.deps.state.cursor = index + 1;
      this.persistState();
      this.stepsThisTurn += 1;
      const outcome = await this.execute(step);
      if (outcome === 'ended') return this.success();
      if (outcome === 'continue') {
        endAfterStep = true;
        continue;
      }
      if (endAfterStep) {
        endAfterStep = false;
        if ((await this.finishTurn()) === 'ended') return this.success();
        endAfterStep = true;
      }
    }
    throw new ScenarioError(`scenario exceeded ${MAX_STEPS_PER_TURN} steps in one turn (a goto loop?)`);
  }

  private async execute(step: ScenarioStep): Promise<StepOutcome> {
    switch (step.kind) {
      case 'think':
        await this.think(step);
        return 'next';
      case 'text':
        this.say(renderText(step.text, this.templateContext()));
        return 'next';
      case 'tool':
        return this.toolStep(step);
      case 'mcp':
        return this.mcpStep(step);
      case 'bash':
        return this.bashStep(step);
      case 'endTurn':
        if (step.final) this.deps.state.cursor = this.deps.scenario.scenario.steps.length;
        this.persistState();
        return this.finishTurn();
      case 'rateLimit':
        return this.rateLimit(step);
      case 'crash':
        return this.crash(step);
      case 'hang':
        await this.deps.pacer.sleepRaw(this.deps.pacer.scaled(step.ms));
        return 'next';
      case 'contextGrowth':
        this.deps.state.context.cachedPrefix += step.tokens;
        this.persistState();
        return 'next';
      case 'branch':
        this.branch(step);
        return 'next';
      case 'notification':
        await this.notification(step);
        return 'next';
      case 'compact':
        await this.compact(step);
        return 'next';
    }
  }

  private success(): TurnResult {
    return {
      kind: 'result',
      subtype: 'success',
      isError: false,
      resultText: this.lastResponseText,
      stopReason: 'end_turn',
      terminalReason: 'completed',
      exitCode: 0,
    };
  }

  private stopped(stopReason: string | undefined): TurnResult {
    return {
      kind: 'result',
      subtype: 'success',
      isError: false,
      resultText: stopReason ?? this.lastResponseText,
      stopReason: null,
      terminalReason: 'hook_stopped',
      exitCode: 0,
    };
  }

  private failure(message: string): TurnResult {
    return {
      kind: 'result',
      subtype: 'error_during_execution',
      isError: true,
      errors: [message],
      stopReason: null,
      exitCode: 1,
    };
  }

  private checkBudget(): void {
    const budget = this.deps.maxBudgetUsd;
    if (budget !== undefined && this.ledger.invocationCostUsd >= budget) {
      throw new TurnStop({
        kind: 'result',
        subtype: 'error_max_budget_usd',
        isError: true,
        errors: [`Reached maximum budget ($${budget})`],
        stopReason: null,
        terminalReason: 'budget_exhausted',
        exitCode: 1,
      });
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Model responses: one API response = N content blocks = N transcript lines sharing id/requestId/usage.

  private openResponse(shape: RequestShape = {}): OpenResponse {
    if (this.open) return this.open;
    if (this.deps.maxTurns !== undefined && this.numTurns >= this.deps.maxTurns) {
      throw new TurnStop({
        kind: 'result',
        subtype: 'error_max_turns',
        isError: true,
        errors: [`Reached maximum number of turns (${this.deps.maxTurns})`],
        stopReason: null,
        terminalReason: 'max_turns',
        exitCode: 1,
      });
    }
    this.emitSystem('status', { status: 'requesting' });
    const base = nextRequest(this.deps.state.context, shape, this.deps.now());
    this.numTurns += 1;
    const open: OpenResponse = {
      messageId: this.deps.ids.messageId(),
      requestId: this.deps.ids.requestId(),
      base,
      thinkOutput: null,
      estimatedOutput: 0,
      blocks: [],
      openedAt: this.deps.now(),
      nextIndex: 0,
    };
    this.open = open;
    this.partial({
      type: 'message_start',
      message: this.message(open, [], null, makeUsage({ ...base, output: 1 })),
    });
    return open;
  }

  private outputTokens(open: OpenResponse): number {
    return open.thinkOutput ?? Math.max(1, open.estimatedOutput);
  }

  private message(
    open: OpenResponse,
    content: unknown[],
    stopReason: string | null,
    usage: Usage,
  ): Record<string, unknown> {
    return {
      model: this.deps.model,
      id: open.messageId,
      type: 'message',
      role: 'assistant',
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage,
    };
  }

  /** A completed content block: streamed now (stop_reason null, usage not final), written when the response closes. */
  private addBlock(open: OpenResponse, content: Record<string, unknown>): PendingBlock {
    const block: PendingBlock = { content, uuid: this.deps.ids.uuid(), timestamp: this.timestamp() };
    open.blocks.push(block);
    this.deps.out.emit({
      type: 'assistant',
      message: this.message(
        open,
        [content],
        null,
        makeUsage({ ...open.base, output: this.outputTokens(open) }),
      ),
      parent_tool_use_id: null,
      session_id: this.deps.sessionId,
      uuid: block.uuid,
    });
    return block;
  }

  private closeResponse(stopReason: 'end_turn' | 'tool_use'): void {
    const open = this.open;
    if (!open) return;
    this.open = null;
    const usage = makeUsage({ ...open.base, output: this.outputTokens(open) });
    for (const block of open.blocks) {
      this.deps.transcript.chained(block.uuid, block.timestamp, {
        message: this.message(open, [block.content], stopReason, usage),
        requestId: open.requestId,
        type: 'assistant',
      });
    }
    this.partial({
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    });
    this.partial({ type: 'message_stop' });
    this.ledger.addResponse(
      this.deps.model,
      usage,
      open.thinkOutput ?? 0,
      Math.max(0, this.deps.now() - open.openedAt),
    );
    this.deps.state.context.uncached += usage.output_tokens;
    const text = open.blocks
      .filter((block) => block.content.type === 'text')
      .map((block) => String(block.content.text))
      .join('\n');
    if (text) this.lastResponseText = text;
    this.persistState();
    if (!this.allowedEventSent) {
      // Claude Code reports the (still allowed) plan window after the first response of a run.
      this.allowedEventSent = true;
      const resetsAt = Math.ceil((this.deps.now() + FIVE_HOURS_MS) / 3_600_000) * 3600;
      this.deps.out.emit({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          resetsAt,
          rateLimitType: 'five_hour',
          // The plan windows as the unified rate-limit headers report them (observed on 2.1.295 for a subscription login).
          utilization: 0.16,
          overageStatus: 'rejected',
          overageDisabledReason: 'org_level_disabled',
          isUsingOverage: false,
          unifiedWindows: {
            five_hour: { utilization: 0.16, resetsAt },
            seven_day: { utilization: 0.35, resetsAt: resetsAt + 4 * 24 * 3600 },
          },
        },
        uuid: this.deps.streamIds.uuid(),
        session_id: this.deps.sessionId,
      });
    }
  }

  private partial(event: Record<string, unknown>): void {
    if (!this.deps.out.partialsEnabled) return;
    this.deps.out.emit({
      type: 'stream_event',
      event,
      session_id: this.deps.sessionId,
      parent_tool_use_id: null,
      uuid: this.deps.streamIds.uuid(),
    });
  }

  private emitSystem(subtype: string, fields: Record<string, unknown>): void {
    this.deps.out.emit({
      type: 'system',
      subtype,
      ...fields,
      uuid: this.deps.streamIds.uuid(),
      session_id: this.deps.sessionId,
    });
  }

  /**
   * Thinking: a few progress frames spread over the (scaled) duration — system/thinking_tokens on stream-json,
   * plus thinking_delta stream events with --include-partial-messages — so a watcher sees activity while the
   * transcript stays silent until the block completes. Like Claude Code's redacted thinking, the block's text
   * is empty unless the scenario supplies one.
   */
  private async think(step: StepOf<'think'>): Promise<void> {
    const open = this.openResponse({
      ...(step.inputTokens !== undefined && { inputTokens: step.inputTokens }),
      ...(step.cacheRead !== undefined && { cacheRead: step.cacheRead }),
      ...(step.cacheWrite !== undefined && { cacheWrite: step.cacheWrite }),
    });
    const text = step.thinking ?? '';
    const blockIndex = open.nextIndex++;
    const total = this.deps.pacer.scaled(step.ms);
    const frames = Math.min(60, Math.max(3, Math.ceil(total / 1000)));
    const textPieces = pieces(text, frames);
    const tokenShares = shares(step.outputTokens, frames);
    const gap = Math.floor(total / (frames + 1));
    this.partial({
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    });
    let running = 0;
    for (let i = 0; i < frames; i++) {
      await this.deps.pacer.sleepRaw(gap);
      running += tokenShares[i]!;
      this.partial({
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'thinking_delta', thinking: textPieces[i], estimated_tokens: tokenShares[i] },
      });
      this.emitSystem('thinking_tokens', {
        estimated_tokens: running,
        estimated_tokens_delta: tokenShares[i],
      });
    }
    await this.deps.pacer.sleepRaw(total - gap * frames);
    const signature = this.deps.ids.signature();
    this.partial({
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'signature_delta', signature },
    });
    this.partial({ type: 'content_block_stop', index: blockIndex });
    open.thinkOutput = (open.thinkOutput ?? 0) + step.outputTokens;
    this.addBlock(open, { type: 'thinking', thinking: text, signature });
  }

  /** Emit an assistant text block (opening a response if none is open). */
  private say(text: string): void {
    const open = this.openResponse();
    const blockIndex = open.nextIndex++;
    this.partial({
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'text', text: '' },
    });
    for (const piece of pieces(text, Math.min(4, text.length))) {
      this.partial({
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'text_delta', text: piece },
      });
    }
    this.partial({ type: 'content_block_stop', index: blockIndex });
    if (open.thinkOutput === null) open.estimatedOutput += estimateTokens(text);
    this.addBlock(open, { type: 'text', text });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Tools

  private toolStep(step: StepOf<'tool'>): Promise<StepOutcome> {
    const rendered = renderDeep(step.input, this.templateContext());
    const saveAs = step.saveAs !== undefined ? { saveAs: step.saveAs } : {};
    if (step.name.startsWith('mcp__')) {
      return this.toolCall({
        name: step.name,
        input: rendered,
        run: async () =>
          step.result !== undefined
            ? scriptedResult(step.result, step.isError === true)
            : this.mcpOutcome(step.name, rendered),
        ...saveAs,
        mcp: { tool: step.name.split('__').slice(2).join('__'), obey: true },
      });
    }
    const input = absolutizePaths(step.name, rendered, this.deps.cwd);
    const result = step.result;
    let run: () => Promise<ToolOutcome>;
    if (step.name === 'Bash')
      run = () => runBash(input, { stdout: result ?? '', exitCode: step.isError ? 1 : 0 }, this.toolContext);
    else if (result !== undefined) run = async () => scriptedResult(result, step.isError === true);
    else run = async () => runBuiltinTool(step.name, input, this.toolContext);
    return this.toolCall({ name: step.name, input, run, ...saveAs });
  }

  private bashStep(step: StepOf<'bash'>): Promise<StepOutcome> {
    const context = this.templateContext();
    const input: Record<string, unknown> = { command: renderText(step.command, context) };
    if (step.description !== undefined) input.description = renderText(step.description, context);
    const script = {
      stdout: renderText(step.stdout, context),
      ...(step.stderr !== undefined && { stderr: renderText(step.stderr, context) }),
      ...(step.exitCode !== undefined && { exitCode: step.exitCode }),
      ...(step.exec !== undefined && { exec: step.exec }),
    };
    return this.toolCall({
      name: 'Bash',
      input,
      run: () => runBash(input, script, this.toolContext),
      ...(step.saveAs !== undefined && { saveAs: step.saveAs }),
    });
  }

  private mcpStep(step: StepOf<'mcp'>): Promise<StepOutcome> {
    const name = mcpToolName(step.server, step.tool);
    const input = renderDeep(step.args, this.templateContext());
    return this.toolCall({
      name,
      input,
      run: () => this.mcpOutcome(name, input),
      ...(step.saveAs !== undefined && { saveAs: step.saveAs }),
      mcp: { tool: step.tool, obey: step.obey !== false },
    });
  }

  private async mcpOutcome(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
    try {
      const result = await this.deps.mcp.call(name, input, this.deps.signal);
      // Claude Code 2.1.295 (observed with the AOC server, which answers with structuredContent): the model gets
      // JSON.stringify(structuredContent) and the text blocks are dropped; hooks see that same string.
      if (!result.isError && result.structuredContent !== undefined) {
        const text = JSON.stringify(result.structuredContent);
        return {
          content: text,
          isError: false,
          toolUseResult: { content: text, structuredContent: result.structuredContent },
          hookResponse: text,
          saveValue: mcpPayload(result),
        };
      }
      return {
        content: result.content.length > 0 ? result.content : [{ type: 'text', text: '' }],
        isError: result.isError,
        toolUseResult: result.content,
        saveValue: mcpPayload(result),
      };
    } catch (error) {
      this.deps.pacer.throwIfAborted();
      return toolError(`Error calling MCP tool ${name}: ${(error as Error).message}`);
    }
  }

  private isAvailable(name: string): boolean {
    return name.startsWith('mcp__') ? this.deps.mcp.has(name) : this.deps.enabledBuiltins.has(name);
  }

  /**
   * Claude Code's tool pipeline: tool_use block (closing the response) → PreToolUse hooks → permission
   * decision → execution → tool_result line → PostToolUse / PostToolUseFailure → PostToolBatch.
   */
  private async toolCall(call: ToolCall): Promise<StepOutcome> {
    const open = this.openResponse();
    const toolUseId = this.deps.ids.toolUseId();
    const blockIndex = open.nextIndex++;
    const inputJson = JSON.stringify(call.input);
    this.partial({
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'tool_use', id: toolUseId, name: call.name, input: {} },
    });
    this.partial({
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'input_json_delta', partial_json: inputJson },
    });
    this.partial({ type: 'content_block_stop', index: blockIndex });
    if (open.thinkOutput === null) open.estimatedOutput += estimateTokens(inputJson) + 12;
    const toolUseBlock = this.addBlock(open, {
      type: 'tool_use',
      id: toolUseId,
      name: call.name,
      input: call.input,
    });
    this.closeResponse('tool_use');
    this.pendingTool = { toolUseId, sourceUuid: toolUseBlock.uuid };

    const batchEntry: Record<string, unknown> = {
      tool_name: call.name,
      tool_input: call.input,
      tool_use_id: toolUseId,
    };
    if (!this.isAvailable(call.name)) {
      this.writeToolResult(toolUseId, toolUseBlock.uuid, {
        content: `<tool_use_error>Error: No such tool available: ${call.name}</tool_use_error>`,
        isError: true,
        toolUseResult: `Error: No such tool available: ${call.name}`,
      });
      this.lastToolError = true;
      await this.postToolBatch(batchEntry);
      return 'next';
    }

    const mcpServer = this.deps.mcp.serverOf(call.name);
    const serverField = mcpServer ? { mcp_server: mcpServer } : {};
    const pre = await this.runHooks('PreToolUse', { ...batchEntry, ...serverField }, call.name);
    this.recordHookSideEffects(pre, toolUseId);
    if (pre.preventContinuation) {
      this.writeToolResult(
        toolUseId,
        toolUseBlock.uuid,
        toolError(pre.stopReason ?? `Execution stopped by ${pre.hookName} hook`),
      );
      this.stoppedContinuation(pre, toolUseId);
      throw new TurnStop(this.stopped(pre.stopReason));
    }
    const verdict = decidePermission(
      this.deps.policy,
      call.name,
      call.input,
      this.preToolVerdict(pre, call.name),
    );
    if (verdict.behavior === 'deny') {
      this.denials.push({ tool_name: call.name, tool_use_id: toolUseId, tool_input: call.input });
      // The permission layer (not a rule or a hook) refused: nobody can approve in print mode, but a
      // PermissionRequest hook still sees the request (never in dontAsk) and the stream says why it was denied.
      if (verdict.source === 'prompt') {
        if (this.deps.policy.mode !== 'dontAsk')
          await this.runHooks('PermissionRequest', { tool_name: call.name, tool_input: call.input, permission_suggestions: [], ...serverField }, call.name);
        this.emitSystem('permission_denied', {
          tool_name: call.name,
          tool_use_id: toolUseId,
          ...(verdict.reason && { decision_reason_type: verdict.reason }),
          ...(verdict.reason === 'other' && { decision_reason: verdict.message }),
          message: verdict.message,
        });
      }
      this.writeToolResult(toolUseId, toolUseBlock.uuid, {
        content: verdict.message,
        isError: true,
        toolUseResult: `Error: ${verdict.message}`,
      });
      this.lastToolError = true;
      await this.postToolBatch(batchEntry);
      return 'next';
    }

    const started = this.deps.now();
    let outcome: ToolOutcome;
    try {
      outcome = await call.run();
    } catch (error) {
      outcome = toolError((error as Error).message);
    }
    // SIGINT during the call rejects it instead of reporting how it ended (SIGTERM reports the killed command's status).
    if (this.deps.signal?.aborted && this.deps.signal.reason === 'SIGINT') throw new SimAbortError('SIGINT');
    const durationMs = Math.max(0, this.deps.now() - started);
    this.ledger.addTool(durationMs, outcome.linesAdded, outcome.linesRemoved);
    this.writeToolResult(toolUseId, toolUseBlock.uuid, outcome);
    this.lastToolError = outcome.isError;
    if (call.saveAs !== undefined && outcome.saveValue !== undefined) {
      this.deps.state.saved[call.saveAs] = outcome.saveValue;
      this.persistState();
    }

    const event: HookEventName = outcome.isError ? 'PostToolUseFailure' : 'PostToolUse';
    const post = outcome.isError
      ? await this.runHooks(
          event,
          {
            ...batchEntry,
            error: contentText(outcome.content),
            is_interrupt: false,
            duration_ms: durationMs,
            ...serverField,
          },
          call.name,
        )
      : await this.runHooks(
          event,
          {
            tool_name: call.name,
            tool_input: call.input,
            tool_response: outcome.hookResponse ?? outcome.toolUseResult,
            tool_use_id: toolUseId,
            duration_ms: durationMs,
            ...serverField,
          },
          call.name,
        );
    this.recordFeedback(post, toolUseId, event);
    // PostToolBatch carries the rendered result: the text the model was given.
    if (!outcome.isError) batchEntry.tool_response = contentText(outcome.content);
    await this.postToolBatch(batchEntry);

    if (call.mcp?.obey && !outcome.isError) return this.obey(call.mcp.tool, outcome.saveValue);
    return 'next';
  }

  /** PostToolBatch fires once every call of the batch (one call per response here) has resolved. */
  private async postToolBatch(entry: Record<string, unknown>): Promise<void> {
    const outcome = await this.runHooks('PostToolBatch', { tool_calls: [entry] });
    this.recordFeedback(outcome, String(entry.tool_use_id), 'PostToolBatch');
  }

  /** Post-tool hook results: context and failures, blocking feedback for the model, or a stop. */
  private recordFeedback(outcome: HookOutcome, toolUseId: string, hookEvent: HookEventName): void {
    this.recordHookSideEffects(outcome, toolUseId);
    for (const block of outcome.blocking) {
      this.attachment({
        type: 'hook_blocking_error',
        hookName: outcome.hookName,
        toolUseID: toolUseId,
        hookEvent,
        blockingError: { blockingError: block.text, command: block.command },
      });
    }
    if (outcome.preventContinuation) {
      this.stoppedContinuation(outcome, toolUseId);
      throw new TurnStop(this.stopped(outcome.stopReason));
    }
  }

  /**
   * A compliant agent ends its turn when task_done returns `boundary.continue === false` and after raising a
   * decision. If the scenario is about to end the turn anyway (only talk until the next endTurn) it does so.
   */
  private async obey(tool: string, payload: unknown): Promise<StepOutcome> {
    const record = asRecord(payload);
    const boundary = asRecord(record?.boundary);
    let closing: string | undefined;
    if (boundary?.continue === false) {
      const reason = typeof boundary.reason === 'string' ? boundary.reason : 'boundary';
      const instruction = typeof boundary.instruction === 'string' ? ` ${boundary.instruction}` : '';
      closing = `Stopping at the task boundary (${reason}).${instruction}`;
    } else if (tool === 'request_decision' && record?.ok !== false) {
      const id = typeof record?.decision_id === 'string' ? ` ${record.decision_id}` : '';
      closing = `Decision${id} is raised; ending my turn until it is answered.`;
    }
    if (closing === undefined || this.onlyTalkBeforeEndTurn()) return 'next';
    this.say(closing);
    return this.finishTurn();
  }

  private onlyTalkBeforeEndTurn(): boolean {
    const steps = this.deps.scenario.scenario.steps;
    for (let i = this.deps.state.cursor; i < steps.length; i++) {
      const kind = steps[i]!.kind;
      if (kind === 'endTurn') return true;
      if (kind !== 'text' && kind !== 'think' && kind !== 'contextGrowth') return false;
    }
    return false;
  }

  private preToolVerdict(outcome: HookOutcome, toolName: string): HookVerdict | undefined {
    const deny = outcome.permissionDecisions.find((decision) => decision.behavior === 'deny');
    // Observed on 2.1.295: the model reads a hook's JSON deny as "PreToolUse:<tool> hook error: <reason>".
    if (deny)
      return {
        behavior: 'deny',
        message: `PreToolUse:${toolName} hook error: ${deny.reason || `Hook PreToolUse:${toolName} denied this tool`}`,
      };
    const blocking = outcome.blocking[0];
    if (blocking) return { behavior: 'deny', message: `PreToolUse:${toolName} hook error: ${blocking.text}` };
    const ask = outcome.permissionDecisions.find((decision) => decision.behavior === 'ask');
    if (ask) {
      // Print mode has nobody to ask: the call is denied with the hook's reason.
      return {
        behavior: 'ask',
        message: ask.reason || `Hook PreToolUse:${toolName} asked for confirmation for this tool`,
      };
    }
    if (outcome.permissionDecisions.some((decision) => decision.behavior === 'allow'))
      return { behavior: 'allow' };
    return undefined;
  }

  private writeToolResult(toolUseId: string, sourceUuid: string, outcome: ToolOutcome): void {
    if (this.pendingTool?.toolUseId === toolUseId) this.pendingTool = null;
    const uuid = this.deps.ids.uuid();
    const timestamp = this.timestamp();
    const message = {
      role: 'user',
      content: [
        { tool_use_id: toolUseId, type: 'tool_result', content: outcome.content, is_error: outcome.isError },
      ],
    };
    this.deps.transcript.chained(
      uuid,
      timestamp,
      { promptId: this.promptId, type: 'user', message },
      { toolUseResult: outcome.toolUseResult, sourceToolAssistantUUID: sourceUuid },
    );
    this.deps.out.emit({
      type: 'user',
      message,
      parent_tool_use_id: null,
      session_id: this.deps.sessionId,
      uuid,
      timestamp,
      tool_use_result: outcome.toolUseResult,
      ...(outcome.resultMeta && { tool_result_meta: [{ id: toolUseId, ...outcome.resultMeta }] }),
    });
    this.deps.state.context.uncached += estimateTokens(contentText(outcome.content));
  }

  // ---------------------------------------------------------------------------------------------------------
  // Turn end, Stop hooks and the other step kinds

  /** End the turn: close the response, run Stop hooks; 'continue' when a Stop hook blocked the stop. */
  private async finishTurn(): Promise<'ended' | 'continue'> {
    this.closeResponse('end_turn');
    if (this.deps.hooks.matching('Stop').length === 0) return 'ended';
    const outcome = await this.runHooks('Stop', {
      stop_hook_active: this.stopHookActive,
      ...(this.lastResponseText && { last_assistant_message: this.lastResponseText }),
      background_tasks: [],
      session_crons: [],
    });
    this.recordHookSideEffects(outcome, 'Stop');
    const blocking = outcome.blocking[0];
    this.deps.transcript.chained(this.deps.ids.uuid(), this.timestamp(), {
      type: 'system',
      subtype: 'stop_hook_summary',
      hookCount: outcome.executions.length,
      hookInfos: outcome.executions.map((execution) => ({
        command: execution.command,
        durationMs: execution.durationMs,
      })),
      hookErrors: outcome.blocking.map((block) => block.text),
      preventedContinuation: blocking !== undefined,
      stopReason: outcome.stopReason ?? '',
      hasOutput: outcome.executions.some((execution) => execution.stdout !== '' || execution.stderr !== ''),
      level: 'suggestion',
    });
    if (!blocking || outcome.preventContinuation || this.stopContinuations >= MAX_STOP_HOOK_CONTINUATIONS)
      return 'ended';
    this.attachment({
      type: 'hook_blocking_error',
      hookName: 'Stop',
      toolUseID: this.deps.ids.uuid(),
      hookEvent: 'Stop',
      blockingError: { blockingError: blocking.text, command: blocking.command },
    });
    this.latestInput = blocking.reason;
    this.stopHookActive = true;
    this.stopContinuations += 1;
    return 'continue';
  }

  /** Usage limit: the request is rejected, the turn ends on a synthetic error message and StopFailure fires. */
  private async rateLimit(step: StepOf<'rateLimit'>): Promise<never> {
    this.closeResponse('end_turn');
    this.emitSystem('status', { status: 'requesting' });
    const now = this.deps.now();
    const notice = rateLimitNotice(step, now, this.deps.timeZone);
    this.deps.out.emit({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: notice.resetsAt, rateLimitType: notice.rateLimitType },
      uuid: this.deps.streamIds.uuid(),
      session_id: this.deps.sessionId,
    });
    const uuid = this.deps.ids.uuid();
    const message = {
      id: this.deps.ids.uuid(),
      container: null,
      model: '<synthetic>',
      role: 'assistant',
      stop_reason: 'stop_sequence',
      stop_sequence: '',
      type: 'message',
      usage: makeUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      content: [{ type: 'text', text: notice.text }],
      context_management: null,
    };
    this.deps.transcript.chained(
      uuid,
      new Date(now).toISOString(),
      { type: 'assistant' },
      { message, apiError: 'usage_limit_reached', error: 'rate_limit', isApiErrorMessage: true },
    );
    this.deps.out.emit({
      type: 'assistant',
      message,
      parent_tool_use_id: null,
      session_id: this.deps.sessionId,
      uuid,
      error: 'rate_limit',
    });
    this.persistState();
    const failure = await this.runHooks(
      'StopFailure',
      { error: 'rate_limit', last_assistant_message: notice.text },
      'rate_limit',
    );
    this.recordHookSideEffects(failure, 'StopFailure');
    throw new TurnStop({
      kind: 'result',
      subtype: 'success',
      isError: true,
      resultText: notice.text,
      stopReason: 'stop_sequence',
      terminalReason: 'api_error',
      apiErrorStatus: 429,
      exitCode: 1,
    });
  }

  private crash(step: StepOf<'crash'>): never {
    // Blocks of an unfinished response die with the process.
    this.open = null;
    const stderr = step.stderr ?? 'Error: simulated crash';
    if (stderr) this.deps.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`);
    throw new TurnStop({
      kind: 'crash',
      subtype: 'error_during_execution',
      isError: true,
      stopReason: null,
      exitCode: step.exitCode ?? 1,
    });
  }

  private branch(step: StepOf<'branch'>): void {
    let taken: boolean;
    if (step.onResumeTextIncludes !== undefined) {
      const needles = Array.isArray(step.onResumeTextIncludes)
        ? step.onResumeTextIncludes
        : [step.onResumeTextIncludes];
      const haystack = this.latestInput.toLowerCase();
      taken = needles.some((needle) => haystack.includes(needle.toLowerCase()));
    } else if (step.onLastToolError !== undefined) {
      taken = this.lastToolError === step.onLastToolError;
    } else {
      taken = true;
    }
    if (taken) {
      this.deps.state.cursor = gotoIndex(this.deps.scenario, step);
      this.persistState();
    }
  }

  private async notification(step: StepOf<'notification'>): Promise<void> {
    const type = step.notificationType ?? 'idle_prompt';
    const outcome = await this.runHooks(
      'Notification',
      { message: renderText(step.message, this.templateContext()), notification_type: type },
      type,
    );
    this.recordHookSideEffects(outcome, 'Notification');
  }

  private async compact(step: StepOf<'compact'>): Promise<void> {
    this.closeResponse('end_turn');
    const trigger = step.trigger ?? 'auto';
    const instructions = trigger === 'manual' ? (step.instructions ?? '') : null;
    const pre = await this.runHooks('PreCompact', { trigger, custom_instructions: instructions }, trigger);
    this.recordHookSideEffects(pre, 'PreCompact');
    if (pre.blocking.length > 0) {
      // Exit 2 from PreCompact blocks compaction.
      for (const block of pre.blocking) {
        this.attachment({
          type: 'hook_blocking_error',
          hookName: pre.hookName,
          toolUseID: 'PreCompact',
          hookEvent: 'PreCompact',
          blockingError: { blockingError: block.text, command: block.command },
        });
      }
      return;
    }
    const context = this.deps.state.context;
    const preTokens = context.cachedPrefix + context.uncached;
    const leaf = this.deps.transcript.leafUuid;
    const boundary = this.deps.ids.uuid();
    this.deps.transcript.chained(
      boundary,
      this.timestamp(),
      { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', isMeta: false },
      { level: 'info', logicalParentUuid: leaf, compactMetadata: { trigger, preTokens } },
      null,
    );
    const summary =
      'This session is being continued from a previous conversation that ran out of context. ' +
      `Summary: the session follows the "${this.deps.scenario.scenario.name}" scenario; ${this.deps.state.cursor} steps have run.`;
    this.deps.transcript.chained(
      this.deps.ids.uuid(),
      this.timestamp(),
      { type: 'user', message: { role: 'user', content: summary } },
      { isCompactSummary: true, isVisibleInTranscriptOnly: true },
    );
    this.emitSystem('compact_boundary', { compact_metadata: { trigger, pre_tokens: preTokens } });
    context.cachedPrefix = SHARED_PREFIX_TOKENS;
    context.uncached = SESSION_PREFIX_TOKENS + this.deps.mcpPrefixTokens + estimateTokens(summary);
    this.persistState();
    const restart = await this.runHooks(
      'SessionStart',
      { source: 'compact', model: this.deps.model },
      'compact',
    );
    this.recordHookSideEffects(restart, 'SessionStart');
  }

  // ---------------------------------------------------------------------------------------------------------
  // Hooks plumbing

  /**
   * Run `event` hooks with the common stdin fields. Every event except SessionEnd (which must still run after
   * a SIGTERM) is abortable: an abort kills the hook processes and stops the session right after them.
   */
  private async runHooks(
    event: HookEventName,
    fields: Record<string, unknown>,
    matchValue?: string,
  ): Promise<HookOutcome> {
    const abortable = event !== 'SessionEnd';
    const outcome = await this.deps.hooks.run(
      event,
      {
        session_id: this.deps.sessionId,
        transcript_path: this.deps.transcriptPath,
        cwd: this.deps.cwd,
        ...(this.promptId && { prompt_id: this.promptId }),
        ...(PERMISSION_MODE_EVENTS.has(event) && { permission_mode: this.deps.permissionMode }),
        ...(EFFORT_EVENTS.has(event) && { effort: { level: 'medium' } }),
        hook_event_name: event,
        ...fields,
      },
      matchValue,
      abortable ? this.deps.signal : undefined,
    );
    if (abortable) this.deps.pacer.throwIfAborted();
    return outcome;
  }

  /** Context and failures a hook produced become attachment lines, as in Claude Code transcripts. */
  private recordHookSideEffects(outcome: HookOutcome, toolUseID: string): void {
    const hookEvent = outcome.hookName.split(':')[0];
    if (outcome.additionalContexts.length > 0) {
      this.attachment({
        type: 'hook_additional_context',
        content: outcome.additionalContexts,
        hookName: outcome.hookName,
        toolUseID,
        hookEvent,
      });
    }
    for (const failure of outcome.failures) {
      this.attachment(
        failure.timedOut
          ? {
              type: 'hook_cancelled',
              hookName: outcome.hookName,
              toolUseID,
              hookEvent,
              command: failure.command,
              timedOut: true,
            }
          : {
              type: 'hook_non_blocking_error',
              hookName: outcome.hookName,
              toolUseID,
              hookEvent,
              stderr: failure.stderr,
              stdout: failure.stdout,
              exitCode: failure.exitCode,
              command: failure.command,
              durationMs: failure.durationMs,
            },
      );
    }
  }

  private stoppedContinuation(outcome: HookOutcome, toolUseID: string): void {
    this.attachment({
      type: 'hook_stopped_continuation',
      message: outcome.stopReason ?? 'Execution stopped by hook',
      hookName: outcome.hookName,
      toolUseID,
      hookEvent: outcome.hookName.split(':')[0],
    });
  }

  /** SessionStart output is recorded once the turn's prompt line exists (the prompt stays the chain root). */
  private flushStartContext(): void {
    if (!this.pendingStartContext) return;
    this.recordHookSideEffects(this.pendingStartContext, 'SessionStart');
    this.pendingStartContext = null;
  }

  private attachment(attachment: Record<string, unknown>): void {
    this.deps.transcript.chained(this.deps.ids.uuid(), this.timestamp(), { attachment, type: 'attachment' });
  }

  // ---------------------------------------------------------------------------------------------------------

  private initMessage(): StreamMessage {
    const builtins = [...this.deps.enabledBuiltins].filter(
      (name) => !isWholeToolDenied(this.deps.policy, name),
    );
    const mcpTools = this.deps.mcp.toolNames().filter((name) => !isWholeToolDenied(this.deps.policy, name));
    return {
      type: 'system',
      subtype: 'init',
      cwd: this.deps.cwd,
      session_id: this.deps.sessionId,
      tools: [...builtins, ...mcpTools],
      mcp_servers: this.deps.mcp.statuses(),
      model: this.deps.model,
      permissionMode: this.deps.permissionMode,
      slash_commands: [],
      apiKeySource: 'none',
      claude_code_version: CLAUDE_CODE_VERSION,
      output_style: 'default',
      agents: [],
      skills: [],
      plugins: [],
      uuid: this.deps.streamIds.uuid(),
    };
  }

  private templateContext(): TemplateContext {
    return {
      ...this.deps.state.saved,
      sim: {
        cwd: this.deps.cwd,
        sessionId: this.deps.sessionId,
        prompt: this.prompt,
        lastInput: this.latestInput,
        model: this.deps.model,
      },
    };
  }

  private timestamp(): string {
    return new Date(this.deps.now()).toISOString();
  }

  private persistState(): void {
    if (!this.deps.persist) return;
    this.deps.state.idCounter = this.deps.ids.position;
    this.deps.state.updatedAt = this.timestamp();
    saveState(this.deps.statePath, this.deps.state);
  }
}
