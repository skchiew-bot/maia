/**
 * Reads one stdout line of `claude -p --output-format stream-json` (research §3): operator output items plus the
 * facts the supervisor acts on (init/MCP state, result, rate-limit event, context size).
 */
import type { SessionOutputItem } from '@aoc/contracts';

export type OutputDraft = Omit<SessionOutputItem, 'at'>;

export interface StreamFacts {
  items: OutputDraft[];
  init: { model: string | null; mcpServers: { name: string; status: string }[] } | null;
  result: { isError: boolean; subtype: string; text: string; apiErrorStatus: number | null } | null;
  rateLimit: { status: string; resetsAtMs: number | null; window: string | null } | null;
  /** Context size implied by the latest assistant message (input + cache read + cache write tokens). */
  contextTokens: number | null;
  /** Text Claude Code generated itself (synthetic / API-error messages), safe for the limit-notice check. */
  cliText: string | null;
  /** The model produced output, so the conversation exists on disk and later turns must `--resume` it. */
  conversation: boolean;
}

const MAX_TEXT = 4000;
/** Activity markers that would drown the operator view (still count as liveness). */
const QUIET_SYSTEM = new Set(['status', 'thinking_tokens', 'hook_started', 'hook_response', 'notification']);

type Obj = Record<string, unknown>;
const rec = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function clip(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function readStreamLine(line: string): StreamFacts {
  const f: StreamFacts = {
    items: [],
    init: null,
    result: null,
    rateLimit: null,
    contextTokens: null,
    cliText: null,
    conversation: false,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    f.items.push({ kind: 'system', text: clip(line) });
    return f;
  }
  const o = rec(parsed);
  if (!o) return f;
  switch (o.type) {
    case 'system':
      system(o, f);
      break;
    case 'assistant':
      assistant(o, f);
      break;
    case 'user':
      user(o, f);
      break;
    case 'result':
      result(o, f);
      break;
    case 'rate_limit_event':
      rateLimit(o, f);
      break;
  }
  return f;
}

function system(o: Obj, f: StreamFacts): void {
  const sub = str(o.subtype) ?? 'system';
  if (sub === 'init') {
    const servers = arr(o.mcp_servers)
      .map(rec)
      .filter((s): s is Obj => s !== null)
      .map((s) => ({ name: str(s.name) ?? '', status: str(s.status) ?? 'unknown' }));
    f.init = { model: str(o.model), mcpServers: servers };
    const mcp = servers.map((s) => `${s.name}:${s.status}`).join(', ') || 'none';
    f.items.push({
      kind: 'system',
      text: `Session started · model ${f.init.model ?? 'unknown'} · MCP ${mcp}`,
    });
    return;
  }
  if (sub === 'compact_boundary') {
    const m = rec(o.compact_metadata);
    const post = num(m?.post_tokens);
    if (post !== null) f.contextTokens = post;
    f.items.push({
      kind: 'system',
      text: `Context compacted (${num(m?.pre_tokens) ?? '?'} → ${post ?? '?'} tokens)`,
    });
    return;
  }
  if (QUIET_SYSTEM.has(sub)) return;
  const detail = str(o.text) ?? str(o.message);
  f.items.push({ kind: 'system', text: clip(detail ? `${sub}: ${detail}` : sub) });
}

function assistant(o: Obj, f: StreamFacts): void {
  const msg = rec(o.message);
  if (!msg) return;
  f.conversation = true;
  const synthetic = msg.model === '<synthetic>' || o.isApiErrorMessage === true || o.error !== undefined;
  const usage = rec(msg.usage);
  if (usage && !synthetic) {
    const ctx =
      (num(usage.input_tokens) ?? 0) +
      (num(usage.cache_read_input_tokens) ?? 0) +
      (num(usage.cache_creation_input_tokens) ?? 0);
    if (ctx > 0) f.contextTokens = ctx;
  }
  for (const b of arr(msg.content).map(rec)) {
    if (!b) continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      f.items.push({ kind: 'assistant_text', text: clip(b.text) });
      if (synthetic) f.cliText = f.cliText ? `${f.cliText}\n${b.text}` : b.text;
    } else if (b.type === 'tool_use') {
      f.items.push({
        kind: 'tool_use',
        toolName: str(b.name) ?? 'tool',
        text: toolInputSummary(rec(b.input)),
      });
    }
  }
}

function user(o: Obj, f: StreamFacts): void {
  const content = rec(o.message)?.content;
  if (typeof content === 'string') {
    f.items.push({ kind: 'user_prompt', text: clip(content) });
    return;
  }
  for (const b of arr(content).map(rec)) {
    if (!b) continue;
    if (b.type === 'tool_result')
      f.items.push({ kind: 'tool_result', text: clip(toolResultText(b.content)) });
    else if (b.type === 'text' && typeof b.text === 'string')
      f.items.push({ kind: 'user_prompt', text: clip(b.text) });
  }
}

function result(o: Obj, f: StreamFacts): void {
  f.conversation = true;
  const errors = arr(o.errors)
    .map(str)
    .filter((s): s is string => !!s);
  const text = str(o.result) ?? errors.join('\n');
  const subtype = str(o.subtype) ?? 'unknown';
  f.result = { isError: o.is_error === true, subtype, text, apiErrorStatus: num(o.api_error_status) };
  f.items.push({ kind: 'result', text: clip(text || subtype) });
}

function rateLimit(o: Obj, f: StreamFacts): void {
  const info = rec(o.rate_limit_info);
  if (!info) return;
  const status = str(info.status) ?? 'unknown';
  const resets = num(info.resetsAt);
  const window = str(info.rateLimitType);
  f.rateLimit = {
    status,
    resetsAtMs: resets === null ? null : resets > 1e12 ? resets : resets * 1000,
    window,
  };
  if (status !== 'allowed')
    f.items.push({ kind: 'system', text: `Rate limit ${status}${window ? ` (${window})` : ''}` });
}

function toolInputSummary(input: Obj | null): string {
  if (!input) return '';
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']) {
    const v = input[k];
    if (typeof v === 'string') return clip(v, 500);
  }
  return clip(JSON.stringify(input), 500);
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  const parts = arr(content)
    .map(rec)
    .map((b) =>
      b?.type === 'text' && typeof b.text === 'string' ? b.text : b?.type === 'image' ? '[image]' : '',
    )
    .filter(Boolean);
  return parts.length ? parts.join('\n') : content === undefined ? '' : JSON.stringify(content);
}
