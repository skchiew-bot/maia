import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

export function tmp(prefix = 'aoc-hooks-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ------------------------------------------------------------------------------------------------- fake daemon

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
}
export type Reply = { status: number; json?: unknown } | 'hang';

export interface FakeDaemon {
  url: string;
  requests: Recorded[];
  close(): Promise<void>;
}

export async function startFakeDaemon(
  reply: (r: Recorded) => Reply = () => ({ status: 200, json: { exitCode: 0 } }),
): Promise<FakeDaemon> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const rec: Recorded = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      };
      requests.push(rec);
      const r = reply(rec);
      if (r === 'hang') return; // never answer: the hook's own deadline has to fire
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(r.json === undefined ? '' : JSON.stringify(r.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A URL on a port that was just released, so connections are refused. */
export async function deadUrl(): Promise<string> {
  const d = await startFakeDaemon();
  await d.close();
  return d.url;
}

// ----------------------------------------------------------------------------------------------- hook binary

export interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Spawns the real entry (`node --import tsx src/main.ts <event>`) with only the env given (plus PATH). */
export function runHookBinary(event: string, stdin: unknown, env: Record<string, string>): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', event], {
      cwd: PKG_DIR,
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: performance.now() - started }));
    child.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
  });
}

// ------------------------------------------------------------------------------------------------- env & fs

export const AOC_SESSION = 'ses_01JTEST0000000000000000000';
export const MANAGED_TOKEN = 'ingest-token';
export const OBSERVER_TOKEN = 'observer-token';

export function managedEnv(
  home: string,
  daemonUrl: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    HOME: home,
    AOC_MODE: 'managed',
    AOC_SESSION_ID: AOC_SESSION,
    AOC_DAEMON_URL: daemonUrl,
    AOC_INGEST_TOKEN: MANAGED_TOKEN,
    ...extra,
  };
}

/** Writes ~/.aoc/client.json for observed mode; returns the home dir. */
export function writeClientConfig(home: string, daemonUrl: string): string {
  mkdirSync(join(home, '.aoc'), { recursive: true });
  writeFileSync(
    join(home, '.aoc', 'client.json'),
    JSON.stringify({ daemonUrl, observerToken: OBSERVER_TOKEN }),
  );
  return home;
}

export interface SpooledItem {
  path: string;
  body: any;
  queuedAt: string;
}
export function readSpool(dir: string): SpooledItem[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean))
    .map((l) => JSON.parse(l) as SpooledItem);
}

// --------------------------------------------------------------------------------------------- hook payloads

export const CLAUDE_SESSION = '59c4a8a4-23c6-45c0-9e98-92ae3305068d';

const base = (event: string, transcriptPath = '/tmp/none.jsonl') => ({
  session_id: CLAUDE_SESSION,
  transcript_path: transcriptPath,
  cwd: '/work/repo',
  hook_event_name: event,
  permission_mode: 'default',
  prompt_id: '0a288d76-4f91-4737-b1bb-7c107ecd5037',
});

export const preToolUse = (toolUseId = 'toolu_01K2X3hZ9kat9pi8zg8YnP34') => ({
  ...base('PreToolUse'),
  tool_name: 'Bash',
  tool_input: { command: 'git push origin main' },
  tool_use_id: toolUseId,
});
export const postToolUse = (toolUseId = 'toolu_01K2X3hZ9kat9pi8zg8YnP34') => ({
  ...base('PostToolUse'),
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
  tool_response: { stdout: 'README.md\n', stderr: '', interrupted: false },
  tool_use_id: toolUseId,
  duration_ms: 12,
});
export const sessionStart = (cwd: string) => ({ ...base('SessionStart'), cwd, source: 'startup' });
export const userPromptSubmit = () => ({ ...base('UserPromptSubmit'), prompt: 'Fix the flaky test.' });
export const stop = (transcriptPath: string) => ({
  ...base('Stop', transcriptPath),
  stop_hook_active: false,
  last_assistant_message: 'DONE',
});
export const subagentStop = (transcriptPath: string, agentTranscriptPath: string) => ({
  ...base('SubagentStop', transcriptPath),
  stop_hook_active: false,
  agent_id: 'a3e0385ed503597cc',
  agent_type: 'general-purpose',
  agent_transcript_path: agentTranscriptPath,
  last_assistant_message: 'PONG',
});

// ---------------------------------------------------------------------------------------- transcript lines

export interface UsageSpec {
  input?: number;
  output?: number;
  cacheRead?: number;
  /** Total cache_creation_input_tokens. */
  cacheWrite?: number;
  /** Optional TTL split (cache_creation object). */
  split?: { m5: number; h1: number };
}

/** One assistant API response as Claude Code writes it: one line per content block, each repeating id + usage. */
export function assistantMessage(
  id: string,
  model: string,
  u: UsageSpec,
  timestamp: string,
  blocks = 1,
): string[] {
  const usage: Record<string, unknown> = {
    input_tokens: u.input ?? 0,
    output_tokens: u.output ?? 0,
    cache_read_input_tokens: u.cacheRead ?? 0,
    cache_creation_input_tokens: u.cacheWrite ?? 0,
    service_tier: 'standard',
  };
  if (u.split)
    usage.cache_creation = { ephemeral_5m_input_tokens: u.split.m5, ephemeral_1h_input_tokens: u.split.h1 };
  return Array.from({ length: blocks }, (_, i) =>
    JSON.stringify({
      type: 'assistant',
      uuid: `${id}-line-${i}`,
      sessionId: CLAUDE_SESSION,
      timestamp,
      requestId: `req_${id}`,
      isSidechain: false,
      message: {
        id,
        role: 'assistant',
        model,
        usage,
        content: [{ type: 'text', text: `block ${i} — ✓ ünïcödé` }],
      },
    }),
  );
}

export function userLine(text: string, timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    uuid: `u-${timestamp}`,
    timestamp,
    message: { role: 'user', content: text },
  });
}
