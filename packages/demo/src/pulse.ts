/**
 * Demo pulse — keeps the seeded "live" sessions behaving like real ones through the REAL ingest API:
 * working = heartbeats + tool calls, thinking = heartbeats + streaming, stalled = heartbeats only,
 * dead = nothing. `pnpm --filter @aoc/demo pulse -- --data-dir <dir> --daemon http://127.0.0.1:7420`
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const dataDir = resolve(arg('data-dir', '.aoc/demo'));
const daemon = arg('daemon', 'http://127.0.0.1:7420').replace(/\/+$/, '');
const demo = JSON.parse(readFileSync(join(dataDir, 'demo-tokens.json'), 'utf8')) as {
  live: Record<string, { sessionId: string; claudeSessionId: string; token: string }>;
};

async function post(path: string, token: string, body: unknown): Promise<void> {
  try {
    await fetch(daemon + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  } catch {
    /* daemon restarting — next tick retries */
  }
}

const TOOLS = ['Read', 'Grep', 'Edit', 'Bash', 'Read', 'Write'];
let tick = 0;
async function beat(): Promise<void> {
  tick++;
  const at = new Date().toISOString();
  for (const [kind, s] of Object.entries(demo.live)) {
    if (kind === 'dead' || kind === 'waiting' || kind === 'throttled') continue;
    await post('/ingest/heartbeat', s.token, { sessionId: s.sessionId, pid: 4242, alive: true, at, transcriptBytes: 1000 + tick, lastTranscriptWriteAt: kind === 'stalled' ? null : at });
    if (kind === 'thinking') await post('/ingest/activity', s.token, { sessionId: s.sessionId, kind: 'stream', at });
    if (kind === 'working' && Math.random() < 0.8) {
      const tool = TOOLS[tick % TOOLS.length]!;
      const base = { session_id: s.claudeSessionId, transcript_path: '/tmp/demo.jsonl', cwd: '/tmp/demo' };
      const input = tool === 'Bash' ? { command: 'pnpm test --filter api' } : { file_path: 'src/panel.ts' };
      await post('/ingest/hook', s.token, { mode: 'managed', aocSessionId: s.sessionId, hook: { ...base, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: `toolu_${tick}` }, sentAt: at, idempotencyKey: randomUUID() });
      await post('/ingest/hook', s.token, { mode: 'managed', aocSessionId: s.sessionId, hook: { ...base, hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input, tool_response: { ok: true }, tool_use_id: `toolu_${tick}` }, sentAt: at, idempotencyKey: randomUUID() });
    }
  }
}

console.log(`demo pulse → ${daemon} (${Object.keys(demo.live).join(', ')})`);
await beat();
setInterval(() => void beat(), 5000);
