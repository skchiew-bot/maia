#!/usr/bin/env node
// Tiny fake `claude -p` for supervisor tests. Parses the flags the supervisor passes (variadic tool flags swallow
// positionals exactly like the real CLI, so argv ordering bugs surface), keeps a transcript so --session-id /
// --resume behave like Claude Code, and prints stream-json.
//
// Scenario: `[[fake:<mode>,<mode>…|key=value|…]]` in the first prompt (or FAKE_CLAUDE_MODE), one mode per turn
// (the last repeats). Modes: normal | gated (waits for gate=<file>; end=crash exits 1 without a result) | crash |
// usage_limit | rate_limited | error | hang (until SIGINT) | hang_hard (ignores SIGINT) | chatty (count=<n>) |
// tampered (one short answer, resumed from a deleted cost state: its cumulative modelUsage goes down).
// Params: context=<tokens>, reset=<epoch s>, gate=<path>, mcp=<status reported for the aoc server>,
// overhead=<input tokens the result's modelUsage counts but no assistant message carries>, compact=1 (a
// compact_boundary line). Like Claude Code, result.modelUsage is cumulative across --resume (saved per invocation).
// FAKE_CLAUDE_LOG=<file> receives one JSON line per invocation (argv, env, cwd, pid, turn, mode, prompt).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const fail = (msg) => {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
};

const BOOL = new Set(['-p', '--print', '--verbose', '--include-partial-messages', '--strict-mcp-config']);
const VALUE = new Set(['--output-format', '--model', '--settings', '--permission-mode', '--append-system-prompt', '--session-id', '--resume']);
const VARIADIC = new Set(['--tools', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--mcp-config']);
const opts = {};
const positionals = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') {
    positionals.push(...argv.slice(i + 1));
    break;
  }
  if (BOOL.has(a)) opts[a] = true;
  else if (VALUE.has(a)) {
    if (i + 1 >= argv.length) fail(`option '${a}' argument missing`);
    opts[a] = argv[++i];
  } else if (VARIADIC.has(a)) {
    const values = [];
    while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) values.push(argv[++i]);
    opts[a] = values;
  } else if (a.startsWith('-')) fail(`unknown option '${a}'`);
  else positionals.push(a);
}

if (!opts['-p'] && !opts['--print']) fail('the fake only supports --print');
if (opts['--output-format'] !== 'stream-json') fail('expected --output-format stream-json');
if (!opts['--verbose']) fail('When using --print, --output-format=stream-json requires --verbose');
if (opts['--session-id'] && opts['--resume']) fail('--session-id cannot be used with --resume');
const uuid = opts['--session-id'] ?? opts['--resume'];
if (!uuid) fail('the fake needs --session-id or --resume');
const prompt = positionals.join(' ');
if (!prompt) fail('Input must be provided either through stdin or as a prompt argument when using --print');
const configDir = process.env.CLAUDE_CONFIG_DIR;
if (!configDir) fail('the fake requires CLAUDE_CONFIG_DIR (it never touches a real ~/.claude)');

const transcript = join(configDir, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'), `${uuid}.jsonl`);
let scenario;
let turn;
let savedCost = {};
if (opts['--resume']) {
  if (!existsSync(transcript)) fail(`No conversation found with session ID: ${uuid}`);
  const lines = readFileSync(transcript, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  scenario = lines.find((l) => l.type === 'fake_meta').scenario;
  turn = lines.filter((l) => l.type === 'fake_turn').length + 1;
  savedCost = lines.filter((l) => l.type === 'fake_cost').at(-1)?.modelUsage ?? {};
} else {
  if (existsSync(transcript)) fail(`Session ID ${uuid} is already in use.`);
  const m = /\[\[fake:([^\]]+)\]\]/.exec(prompt);
  scenario = m ? m[1] : (process.env.FAKE_CLAUDE_MODE ?? 'normal');
  turn = 1;
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, JSON.stringify({ type: 'fake_meta', scenario }) + '\n');
}
appendFileSync(transcript, JSON.stringify({ type: 'fake_turn', turn, prompt }) + '\n');

const [modeList, ...paramList] = scenario.split('|');
const modes = modeList.split(',').map((m) => m.trim());
const params = Object.fromEntries(paramList.map((p) => p.split('=')).map(([k, ...v]) => [k.trim(), v.join('=').trim()]));
const mode = modes[Math.min(turn - 1, modes.length - 1)];
// Before the invocation is logged (tests wait for the log), so an early SIGINT never hits the default action.
if (mode === 'hang' || mode === 'hang_hard') {
  process.on('SIGINT', () => {
    if (mode === 'hang') {
      process.stderr.write('interrupted\n');
      finish(130);
    }
  });
}

if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    JSON.stringify({ pid: process.pid, argv, env: process.env, cwd: process.cwd(), uuid, turn, mode, prompt }) + '\n',
  );
}

const model = opts['--model'] ?? 'claude-sonnet-5-5';
let msgN = 0;
const emit = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: uuid }) + '\n');
const usage = { input_tokens: 12, cache_read_input_tokens: Number(params.context ?? 2000), cache_creation_input_tokens: 0, output_tokens: 40 };
const spent = { inputTokens: Number(params.overhead ?? 0), outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
const assistant = (content, extra = {}) => {
  spent.inputTokens += usage.input_tokens;
  spent.outputTokens += usage.output_tokens;
  spent.cacheReadInputTokens += usage.cache_read_input_tokens;
  spent.cacheCreationInputTokens += usage.cache_creation_input_tokens;
  emit({ type: 'assistant', message: { id: `msg_${turn}_${++msgN}`, type: 'message', role: 'assistant', model, content, stop_reason: null, usage }, parent_tool_use_id: null, ...extra });
};
const text = (t) => assistant([{ type: 'text', text: t }]);
const partial = (t) => emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }, parent_tool_use_id: null });
// Cumulative for the conversation: what the previous invocation saved plus this one (a tampered run lost the save).
const modelUsage = () => {
  const before = mode === 'tampered' ? {} : savedCost;
  const prev = before[model] ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  const now = Object.fromEntries(Object.entries(spent).map(([k, v]) => [k, (prev[k] ?? 0) + v]));
  return { ...before, [model]: { ...now, costUSD: 0.001, contextWindow: 1000000, maxOutputTokens: 128000, costBasis: 'list' } };
};
const result = (t, isError = false, subtype = 'success', extra = {}) => {
  const cumulative = modelUsage();
  appendFileSync(transcript, JSON.stringify({ type: 'fake_cost', modelUsage: cumulative }) + '\n');
  emit({ type: 'result', subtype, is_error: isError, duration_ms: 5, num_turns: 1, result: t, api_error_status: null, total_cost_usd: 0.001, usage, modelUsage: cumulative, ...extra });
};
const finish = (code) => process.stdout.write('', () => process.exit(code));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// MCP servers come from the --mcp-config file the supervisor wrote.
const mcpServers = [];
for (const file of opts['--mcp-config'] ?? []) {
  try {
    for (const name of Object.keys(JSON.parse(readFileSync(file, 'utf8')).mcpServers ?? {})) {
      mcpServers.push({ name, status: name === 'aoc' && params.mcp ? params.mcp : 'connected', source: 'dynamic' });
    }
  } catch {
    fail(`invalid MCP config ${file}`);
  }
}
emit({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' });
emit({ type: 'system', subtype: 'init', cwd: process.cwd(), model, permissionMode: opts['--permission-mode'] ?? 'default', tools: ['Read', 'Edit', 'Bash'], mcp_servers: mcpServers });
emit({ type: 'system', subtype: 'status', status: 'requesting' });

async function main() {
  switch (mode) {
    case 'normal':
    case 'gated': {
      partial('Work');
      partial('ing');
      text(`Turn ${turn}: working on it`);
      emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1791517800, rateLimitType: 'five_hour' } });
      assistant([{ type: 'tool_use', id: `toolu_${turn}`, name: 'Read', input: { file_path: 'README.md' } }]);
      emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${turn}`, content: '# readme' }] } });
      if (mode === 'gated') {
        for (let i = 0; i < 1500 && !existsSync(params.gate); i++) await sleep(10);
        if (params.end === 'crash') return finish(1);
      }
      if (params.compact) emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 3000, post_tokens: 900 } });
      text('Done for now.');
      result('Done for now.');
      return finish(0);
    }
    case 'tampered':
      text(`Turn ${turn}: short`);
      result('short');
      return finish(0);
    case 'crash':
      partial('About to');
      text('About to crash');
      process.stderr.write('fatal: simulated crash\n');
      return finish(1);
    case 'usage_limit': {
      const reset = params.reset ?? String(Math.floor(Date.now() / 1000) + 3600);
      const notice = `Claude AI usage limit reached|${reset}`;
      assistant([{ type: 'text', text: notice }], { error: 'rate_limit' });
      emit({ type: 'assistant', message: { id: `msg_${turn}_x`, model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: notice }] } });
      result(notice, true);
      return finish(1);
    }
    case 'rate_limited': {
      partial('Hi');
      emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Number(params.reset), rateLimitType: 'five_hour' } });
      const notice = "You've hit your session limit · resets 3pm (Asia/Kuala_Lumpur)";
      emit({ type: 'assistant', message: { id: `msg_${turn}_x`, model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: notice }] } });
      result(notice, true, 'success', { api_error_status: 429 });
      return finish(1);
    }
    case 'error':
      result('API Error: 500 simulated', true, 'error_during_execution');
      return finish(1);
    case 'hang':
    case 'hang_hard':
      partial('Thinking…');
      setInterval(() => {}, 1000);
      return;
    case 'chatty':
      for (let i = 0; i < Number(params.count ?? 600); i++) text(`line ${i}`);
      result('chatty done');
      return finish(0);
    default:
      fail(`unknown fake mode ${mode}`);
  }
}
void main();
