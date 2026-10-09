/**
 * The hook binary's logic on the stdin Claude Code 2.1.295 really sent it during managed AOC sessions (scrubbed
 * captures in docs/research/fixtures/claude-code/aoc-*.hooks.jsonl, recorded by the real-CLI capture wrapper).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runHook } from '../src';
import { AOC_SESSION, MANAGED_TOKEN, managedEnv, startFakeDaemon, tmp, type FakeDaemon } from './helpers';

const FIXTURES = fileURLToPath(new URL('../../../docs/research/fixtures/claude-code/', import.meta.url));

interface Captured {
  event: string;
  elapsedMs: number;
  exitCode: number | null;
  input: Record<string, any>;
  stdout: string;
}
const captured = (file: string): Captured[] =>
  readFileSync(FIXTURES + file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Captured);

let daemon: FakeDaemon | null = null;
afterEach(async () => {
  await daemon?.close();
  daemon = null;
});

describe('managed hook on real Claude Code input', () => {
  it.each(['aoc-gateway.hooks.jsonl'])('relays every invocation of a real session (%s) unchanged, each with its own key', async (file) => {
    const runs = captured(file);
    daemon = await startFakeDaemon();
    const home = tmp();
    for (const run of runs) {
      const result = await runHook({ event: run.event, stdin: JSON.stringify(run.input), env: managedEnv(home, daemon.url), homeDir: home });
      expect(result, run.event).toEqual({ exitCode: 0 });
    }
    expect(daemon.requests.map((r) => r.body.hook)).toEqual(runs.map((r) => r.input));
    expect(new Set(daemon.requests.map((r) => r.body.idempotencyKey as string)).size).toBe(runs.length);
  });

  it('relays every invocation of a real turn unchanged — fields the contract does not list included — each with its own key', async () => {
    const runs = captured('aoc-happy.hooks.jsonl');
    daemon = await startFakeDaemon();
    const home = tmp();
    for (const run of runs) {
      const result = await runHook({ event: run.event, stdin: JSON.stringify(run.input), env: managedEnv(home, daemon.url), homeDir: home });
      expect(result, run.event).toEqual({ exitCode: 0 });
    }
    expect(daemon.requests.map((r) => r.body.hook)).toEqual(runs.map((r) => r.input));
    for (const r of daemon.requests) {
      expect(r.path).toBe('/ingest/hook');
      expect(r.headers.authorization).toBe(`Bearer ${MANAGED_TOKEN}`);
      expect(r.body).toMatchObject({ mode: 'managed', aocSessionId: AOC_SESSION });
    }
    // The events a session produces, in the order the real CLI fired them.
    expect(runs.map((r) => r.event)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PostToolBatch',
      'PreToolUse',
      'PostToolUse',
      'PostToolBatch',
      'PreToolUse',
      'PostToolUse',
      'PostToolBatch',
      'PreToolUse',
      'PostToolUse',
      'PostToolBatch',
      'Stop',
      'SessionEnd',
    ]);
    // Newer fields the contracts do not model reach the daemon too.
    const pre = daemon.requests.find((r) => r.body.hook.hook_event_name === 'PreToolUse' && String(r.body.hook.tool_name).startsWith('mcp__aoc__'))!;
    expect(pre.body.hook).toMatchObject({ mcp_server: { name: 'aoc' }, effort: { level: 'medium' }, permission_mode: 'acceptEdits' });
    // A Pre/PostToolUse pair shares a tool_use_id yet is two events; nothing collapses by accident.
    expect(new Set(daemon.requests.map((r) => r.body.idempotencyKey as string)).size).toBe(runs.length);
  });

  it('prints the exact deny a real PreToolUse hook gave Claude Code (JSON on exit 0, never exit 2) when the daemon decides so', async () => {
    const denied = captured('aoc-guard-push.hooks.jsonl').find((r) => r.event === 'PreToolUse' && r.stdout.includes('"permissionDecision":"deny"'))!;
    expect(denied.exitCode).toBe(0);
    const stdout = JSON.parse(denied.stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
    expect(stdout.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(denied.input.tool_input.command).toMatch(/git push origin main/);

    daemon = await startFakeDaemon(() => ({ status: 200, json: { exitCode: 0, stdout } }));
    const home = tmp();
    const result = await runHook({ event: 'PreToolUse', stdin: JSON.stringify(denied.input), env: managedEnv(home, daemon.url), homeDir: home });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout!)).toEqual(stdout);
    expect(daemon.requests[0]!.body.hook).toEqual(denied.input);
  });
});
