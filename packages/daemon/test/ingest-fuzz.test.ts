/**
 * Hostile input on the ingest surface (spec §2, §3, §7). An agent's own token lets it write structured events; whatever
 * it sends must end as a clean 4xx or an event the platform can always replay. A request that is accepted yet makes a
 * projector throw poisons the log: the projection goes degraded at once, and every rebuild (which aocd runs at start-up
 * for a degraded projection) throws on the same event, so the daemon no longer boots.
 *
 * Valid bodies for every ingest route are mutated field by field with values chosen to hurt (unparseable timestamps,
 * huge and fractional numbers, control characters, wrong types, oversized strings). After each seed: no 5xx, no
 * degraded projection, the chain verifies, and a rebuild reproduces the live projections exactly.
 */
import { describe, expect, it } from 'vitest';
import { forSeeds, type Rng } from '@aoc/kernel';
import { bootProd, seedSession, type Prod, type SeededSession } from './support/prod';
import { describeDiffs, diffSnapshots, snapshotProjections } from './support/snapshot';

const observedClaudeId = '44444444-4444-4444-8444-444444444444';

const BAD_STRINGS = [
  '',
  ' ',
  'x',
  'not-a-date',
  '2026-13-45T99:99:99Z',
  '0000-00-00T00:00:00Z',
  '+275760-09-13T00:00:00.000Z',
  '-271821-04-20T00:00:00.000Z',
  '9999-12-31T23:59:59.999Z',
  '1970-01-01T00:00:00.000Z',
  'Infinity',
  'NaN',
  'null',
  '"',
  '\\',
  'line\nbreak',
  'nul\u0000byte',
  'lone\ud800surrogate',
  '😀😀😀😀😀😀😀😀😀😀',
  "'; DROP TABLE events; --",
  '../../etc/passwd',
  '__proto__',
  'Aminah binti Yusof 900101-14-5566',
  'a'.repeat(300),
  'a'.repeat(20_000),
];
const BAD_NUMBERS = [0, -1, 1, 1.5, -0, 0.1, 1e21, 1e308, -1e308, 2 ** 53, Number.MAX_SAFE_INTEGER, 4_294_967_296];
const BAD_OTHER: unknown[] = [null, true, false, [], {}, [null], { a: 1 }, [[[[[[[[1]]]]]]]], [''], ['x', 'y']];

function badValue(rng: Rng): unknown {
  return rng.weighted<() => unknown>([
    [() => rng.pick(BAD_STRINGS), 5],
    [() => rng.pick(BAD_NUMBERS), 4],
    [() => rng.pick(BAD_OTHER), 2],
  ])();
}

/** Replace `n` randomly chosen fields (any depth) of a JSON-like value with hostile ones, or drop them. */
function mutate<T>(rng: Rng, base: T, n: number): T {
  const clone = JSON.parse(JSON.stringify(base)) as T;
  const paths: (string | number)[][] = [];
  const walk = (v: unknown, path: (string | number)[]) => {
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        const next = [...path, Array.isArray(v) ? Number(k) : k];
        paths.push(next);
        walk(x, next);
      }
    }
  };
  walk(clone, []);
  for (let i = 0; i < n && paths.length; i++) {
    const path = rng.pick(paths);
    let target: any = clone;
    for (const k of path.slice(0, -1)) target = target?.[k];
    if (target === null || typeof target !== 'object') continue;
    const last = path.at(-1)!;
    if (rng.chance(0.15)) delete target[last];
    else target[last] = badValue(rng);
  }
  return clone;
}

/**
 * Valid bodies for every ingest route, addressed to session A (or to an observed session), with the principal that
 * route accepts: the model's session token, the session's sidecar (telemetry, G-44) or the observer token.
 */
type Base = { path: string; body: unknown; as?: 'sidecar' | 'observer' };
function bases(a: SeededSession, now: string): Base[] {
  const batch = (n: number) => ({
    model: 'claude-opus-5-5',
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWrite5mTokens: 1,
    cacheWrite1hTokens: 2,
    messageIds: [`msg_fuzz_${n}`, `msg_fuzz_${n}b`],
    firstAt: now,
    lastAt: now,
    contextTokens: 1234,
  });
  const hook = (event: string, extra: Record<string, unknown> = {}, id = 'k') => ({
    mode: 'managed',
    aocSessionId: a.sessionId,
    hook: { session_id: a.claudeSessionId, hook_event_name: event, cwd: '/tmp/seed', transcript_path: '/tmp/t.jsonl', ...extra },
    sentAt: now,
    idempotencyKey: `fuzz-${id}-${Math.random().toString(36).slice(2, 10)}`,
  });
  const tool = { tool_name: 'Edit', tool_input: { file_path: '/tmp/seed/a.ts', old_string: 'a', new_string: 'b' }, tool_use_id: 'toolu_1' };
  return [
    { path: '/ingest/hook', body: hook('SessionStart') },
    { path: '/ingest/hook', body: hook('UserPromptSubmit', { prompt: 'please fix the thing' }) },
    { path: '/ingest/hook', body: hook('PreToolUse', tool) },
    { path: '/ingest/hook', body: hook('PostToolUse', { ...tool, tool_response: { success: true } }) },
    { path: '/ingest/hook', body: hook('PostToolUseFailure', { ...tool, error: 'boom' }) },
    { path: '/ingest/hook', body: hook('StopFailure', { error: 'rate_limit', last_assistant_message: 'limit reached' }) },
    { path: '/ingest/hook', body: hook('Stop') },
    { path: '/ingest/heartbeat', as: 'sidecar', body: { sessionId: a.sessionId, pid: 4242, alive: true, at: now, transcriptBytes: 100, lastTranscriptWriteAt: now } },
    { path: '/ingest/activity', as: 'sidecar', body: { sessionId: a.sessionId, kind: 'stream', at: now } },
    { path: '/ingest/usage', as: 'sidecar', body: { sessionId: a.sessionId, idempotencyKey: 'usage-key-0001', batches: [batch(1), batch(2)] } },
    { path: '/ingest/throttle', as: 'sidecar', body: { sessionId: a.sessionId, resetAt: now, message: 'You have hit your limit', source: 'stream' } },
    { path: '/ingest/process', as: 'sidecar', body: { sessionId: a.sessionId, event: 'exited', exitCode: 0, signal: null, at: now, pid: 4242 } },
    { path: '/ingest/spool', as: 'sidecar', body: { items: [{ path: '/ingest/usage', body: { sessionId: a.sessionId, idempotencyKey: 'usage-key-0002', batches: [batch(3)] }, queuedAt: now }] } },
    {
      path: '/ingest/hook',
      as: 'observer',
      body: { mode: 'observed', aocSessionId: null, hook: { session_id: observedClaudeId, hook_event_name: 'SessionStart', cwd: '/home/dev/project', transcript_path: '/home/dev/.claude/t.jsonl' }, sentAt: now, idempotencyKey: 'observed-key-0001' },
    },
    { path: '/ingest/usage', as: 'observer', body: { sessionId: observedClaudeId, idempotencyKey: 'observed-usage-01', batches: [batch(4)] } },
    { path: '/ingest/mcp/declare_plan', body: { sessionId: a.sessionId, input: { summary: 'plan', phases: [{ id: 'p1', name: 'One', tasks: [{ id: 't1', title: 'first', size: 's' }] }] } } },
    { path: '/ingest/mcp/amend_plan', body: { sessionId: a.sessionId, input: { reason: 'more', add: [{ id: 't2', title: 'second', size: 'm', phaseId: 'p1' }], resize: [{ task_id: 't1', size: 'l' }] } } },
    { path: '/ingest/mcp/task_done', body: { sessionId: a.sessionId, input: { task_id: 't1', evidence: { kind: 'test', ref: 'src/a.test.ts > works' } } } },
    { path: '/ingest/mcp/playbook_step', body: { sessionId: a.sessionId, input: { step: 'write the test', state: 'started' } } },
    { path: '/ingest/mcp/get_status', body: { sessionId: a.sessionId, input: {} } },
    { path: '/ingest/mcp/request_decision', body: { sessionId: a.sessionId, input: { test: 'ambiguity', question: 'Which one?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], recommendation: { option_id: 'a', rationale: 'because' } } } },
    { path: '/ingest/mcp/report_error', body: { sessionId: a.sessionId, input: { summary: 'a repeatable error', fix: 'do the other thing', code_area: 'src/a' }, idempotencyKey: 'err-key-1' } },
  ];
}

describe('hostile ingest bodies never poison the log (§2, §3)', () => {
  it('every mutated request is a clean 4xx or an event the platform can replay: no 5xx, no degraded projection, rebuild equals live', async () => {
    const problems: string[] = [];
    await forSeeds(
      'ingest fuzz',
      async (rng, seed) => {
        // A fresh log per seed: an accepted poison event stays in the log and would fail every later rebuild too.
        const p: Prod = await bootProd({ captureErrors: true });
        try {
          const owner = p.user('builder', 'Fuzzed owner');
          const a = seedSession(p, { sessionId: 'ses_fuzz_A', ownerId: owner.user.id });
          const now = p.clock.iso();
          const headersOf = {
            session: p.ids.ingestHeaders(a.sessionId),
            sidecar: p.ids.sidecarHeaders(a.sessionId),
            observer: p.ids.ingestHeaders('observer'),
          };
          const table = bases(a, now);
          const projectors = p.aoc.runtime.modules.flatMap((m) => m.projectors ?? []);
          const seedProblems: string[] = [];
          for (let i = 0; i < 60; i++) {
            p.clock.advance(rng.int(1, 4000));
            const base = rng.pick(table);
            const sent = rng.chance(0.15) ? base.body : mutate(rng, base.body, rng.int(1, 3));
            const res = await p.request('POST', base.path, { headers: headersOf[base.as ?? 'session'], body: sent });
            const text = await res.text();
            const label = `${base.path} ${JSON.stringify(sent).slice(0, 260)}`;
            if (res.status >= 500) {
              const why = p.errors.splice(0).map((l) => (JSON.parse(l) as { err?: string }).err ?? l).join(' | ');
              seedProblems.push(`HTTP ${res.status} for ${label}\n      ${why.slice(0, 200) || text.slice(0, 160)}`);
            }
            const degraded = p.store.projectionHealth();
            if (degraded.length) {
              seedProblems.push(`projection "${degraded[0]!.name}" degraded (${degraded[0]!.lastError}) by HTTP ${res.status} ${label}`);
              p.store.db.exec('DELETE FROM projection_health');
            }
          }
          await p.aoc.runtime.drain();
          const live = snapshotProjections(p.store.db, projectors);
          let rebuilt = live;
          try {
            p.store.rebuildProjections();
            rebuilt = snapshotProjections(p.store.db, projectors);
          } catch (err) {
            seedProblems.push(`rebuildProjections throws: ${String(err)}`);
          }
          const diffs = diffSnapshots(live, rebuilt);
          if (diffs.length) seedProblems.push(`rebuild differs from live:\n   ${describeDiffs(diffs)}`);
          if (!p.store.verifyChain().ok) seedProblems.push('the chain no longer verifies');
          if (seedProblems.length) problems.push(`seed ${seed}:\n - ${[...new Set(seedProblems)].join('\n - ')}`);
        } finally {
          await p.close();
        }
      },
      { count: 4 },
    );
    expect(problems.join('\n\n')).toBe('');
  }, 180_000);
});
