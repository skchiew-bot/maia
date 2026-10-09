import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { MetaOf } from '@aoc/contracts';
import {
  previousCheckOf,
  reconcileTurnUsage,
  sidecarTotals,
  type ModelTokens,
  type ReconcileInput,
  type TokenCounts,
} from '../src/reconcile';
import { readStreamLine } from '../src/stream';
import { createHarness, type Harness } from './harness';

const FIXTURES = fileURLToPath(new URL('../../../docs/research/fixtures/claude-code/', import.meta.url));
const jsonl = (file: string) =>
  readFileSync(FIXTURES + file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

const tokens = (input: number, output: number, cacheRead: number, cacheWrite = 0): TokenCounts => ({ input, output, cacheRead, cacheWrite });
const OPUS = 'claude-opus-5-5';

/** The check a recorded turn leaves for the next one. */
function checkOf(turn: number, input: ReconcileInput): { meta: MetaOf<'usage.reconciled'>; status: string } {
  const r = reconcileTurnUsage({ ...input, turn });
  const meta = { sessionId: 'ses_X', turn, status: r.status, reported: input.cumulative !== null, compacted: input.compacted, batches: 1, models: r.models };
  return { meta, status: r.status };
}

describe('usage reconciliation rules (G-44, O-5)', () => {
  it('reconciles real Claude Code captures: cumulative modelUsage differences equal the transcript per message; compaction is overhead', () => {
    // Three invocations of one session (startup, --resume, /compact) as Claude Code 2.1.295 printed and saved them.
    const modelUsage = ['stream-json.sample.jsonl', 'stream-json.resume-hook-events.sample.jsonl', 'stream-json.compact.sample.jsonl'].map(
      (f) => readStreamLine(JSON.stringify(jsonl(f).find((l) => l.type === 'result'))).result!.modelUsage!,
    );
    // What the sidecar records: assistant lines deduplicated by message.id, per invocation (cost-state ends one).
    const perInvocation: ModelTokens[] = [{}];
    const seen = new Set<string>();
    for (const l of jsonl('transcript.sample.jsonl')) {
      if (l.type === 'cost-state') perInvocation.push({});
      const m = l.message as { id: string; model: string; usage: Record<string, number> } | undefined;
      if (l.type !== 'assistant' || !m?.usage || seen.has(m.id)) continue;
      seen.add(m.id);
      const t = (perInvocation.at(-1)![m.model] ??= tokens(0, 0, 0));
      t.input += m.usage.input_tokens!;
      t.output += m.usage.output_tokens!;
      t.cacheRead += m.usage.cache_read_input_tokens!;
      t.cacheWrite += m.usage.cache_creation_input_tokens!;
    }
    const sidecar = (i: number) =>
      sidecarTotals(
        Object.entries(perInvocation[i]!).map(([model, t]) => ({
          sessionId: 'ses_X', model, inputTokens: t.input, outputTokens: t.output, cacheReadTokens: t.cacheRead,
          cacheWrite5mTokens: 0, cacheWrite1hTokens: t.cacheWrite, messages: 1, contextTokens: 0, firstAt: '', lastAt: '',
        })),
      );

    const t1 = checkOf(1, { turn: 1, cumulative: modelUsage[0]!, fresh: true, previous: null, sidecar: sidecar(0), compacted: false });
    expect(t1.status).toBe('match');
    expect(t1.meta.models).toEqual([
      { model: 'claude-haiku-5-5', process: tokens(12, 618, 102451, 4884), sidecar: tokens(12, 618, 102451, 4884), cumulative: tokens(12, 618, 102451, 4884) },
    ]);
    // Summing the cumulative figures would count the first invocation twice: the turn is the difference.
    const t2 = checkOf(2, { turn: 2, cumulative: modelUsage[1]!, fresh: false, previous: previousCheckOf(t1.meta), sidecar: sidecar(1), compacted: false });
    expect(t2.status).toBe('match');
    expect(t2.meta.models[0]).toMatchObject({ process: tokens(2, 5, 18337, 60), cumulative: tokens(14, 623, 120788, 4944) });
    // /compact writes no assistant line: only the process's figures see it.
    const compact = { turn: 3, cumulative: modelUsage[2]!, fresh: false, previous: previousCheckOf(t2.meta), sidecar: sidecar(2) };
    expect(sidecar(2)).toEqual({});
    expect(reconcileTurnUsage({ ...compact, compacted: true }).status).toBe('overhead');
    expect(reconcileTurnUsage({ ...compact, compacted: false }).status).toBe('under_reported');
  });

  const base = (over: Partial<ReconcileInput>): ReconcileInput => ({
    turn: 2,
    cumulative: { [OPUS]: tokens(200, 400, 6000) },
    fresh: false,
    previous: { turn: 1, reported: true, cumulative: { [OPUS]: tokens(100, 200, 3000) } },
    sidecar: { [OPUS]: tokens(100, 200, 3000) },
    compacted: false,
    ...over,
  });

  it('flags usage the process never reported, and usage it reported that the sidecar did not record', () => {
    expect(reconcileTurnUsage(base({})).status).toBe('match');
    // within 16 tokens or 0.5 %: the same
    expect(reconcileTurnUsage(base({ sidecar: { [OPUS]: tokens(100, 216, 3015) } })).status).toBe('match');
    expect(reconcileTurnUsage(base({ sidecar: { [OPUS]: tokens(100, 240, 3000) } })).status).toBe('over_reported');
    expect(reconcileTurnUsage(base({ sidecar: { [OPUS]: tokens(100, 200, 3000), 'claude-haiku-5-5': tokens(50, 50, 0) } })).status).toBe('over_reported');
    expect(reconcileTurnUsage(base({ sidecar: { [OPUS]: tokens(100, 20, 3000) } })).status).toBe('under_reported');
    expect(reconcileTurnUsage(base({ sidecar: {} })).status).toBe('under_reported');
    // the same model under its context-window spelling
    expect(reconcileTurnUsage(base({ cumulative: { [`${OPUS}[1m]`]: tokens(200, 400, 6000) } })).status).toBe('match');
  });

  it('flags a cumulative that went down once, then measures from the figures the process reports', () => {
    const regressed = checkOf(2, base({ cumulative: { [OPUS]: tokens(50, 100, 1500) } }));
    expect(regressed.status).toBe('regressed');
    expect(regressed.meta.models[0]).toMatchObject({ process: null, cumulative: tokens(50, 100, 1500) });
    const next = reconcileTurnUsage(
      base({ turn: 3, previous: previousCheckOf(regressed.meta), cumulative: { [OPUS]: tokens(150, 300, 4500) } }),
    );
    expect(next.status).toBe('match');
  });

  it('never calls a turn verified without exact figures: no result, unknown baseline, or turns never checked in between', () => {
    const crashed = checkOf(2, base({ cumulative: null }));
    expect(crashed.status).toBe('unverified');
    expect(crashed.meta.models[0]).toMatchObject({ process: null, sidecar: tokens(100, 200, 3000), cumulative: tokens(100, 200, 3000) });
    // The crashed invocation may have saved a cost state the next one resumed from: a shortfall proves nothing then,
    // but more than the process could have used still does.
    const after = (sidecar: ModelTokens) =>
      reconcileTurnUsage(base({ turn: 3, previous: previousCheckOf(crashed.meta), cumulative: { [OPUS]: tokens(200, 400, 6000) }, sidecar })).status;
    expect(after({ [OPUS]: tokens(100, 200, 3000) })).toBe('match');
    expect(after({ [OPUS]: tokens(10, 20, 300) })).toBe('unverified');
    expect(after({ [OPUS]: tokens(300, 600, 9000) })).toBe('over_reported');
    expect(reconcileTurnUsage(base({ previous: null })).status).toBe('unverified');
    expect(reconcileTurnUsage(base({ turn: 4 })).status).toBe('unverified');
    // a conversation started afresh resumes from nothing
    expect(reconcileTurnUsage(base({ fresh: true, sidecar: { [OPUS]: tokens(200, 400, 6000) } })).status).toBe('match');
  });

  it('folds a flood of made-up sidecar models into one row, never the process’s own', () => {
    const flood: ModelTokens = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`fake-${i}`, tokens(1, i, 0)]));
    const r = reconcileTurnUsage(base({ sidecar: { ...flood, [OPUS]: tokens(100, 200, 3000) } }));
    expect(r.status).toBe('over_reported');
    expect(r.models).toHaveLength(32);
    expect(r.models.find((m) => m.model === OPUS)).toMatchObject({ cumulative: tokens(200, 400, 6000) });
    const folded = r.models.find((m) => m.model === 'other')!;
    expect(folded.cumulative).toBeNull();
    expect(r.models.reduce((n, m) => n + m.sidecar.input, 0)).toBe(40 + 100);
  });
});

describe('usage reconciliation at turn end (G-44, O-5)', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    await h?.close();
    h = null;
  });

  /** fake claude, per turn: three answers of 12 input, 40 output and 2000 cache-read tokens each. */
  const TURN = tokens(36, 120, 6000);
  const checks = (id: string) => h!.events('usage.reconciled', id).map((e) => e.meta as MetaOf<'usage.reconciled'>);
  /** What the session's sidecar would have posted (it is a fake here). */
  const sidecarReports = (id: string, t: TokenCounts, messageIds = ['msg_1', 'msg_2', 'msg_3']) =>
    h!.t.rt.store.append({
      type: 'usage.recorded',
      actor: { kind: 'agent', id },
      scope: { sessionId: id },
      meta: {
        sessionId: id, model: OPUS, inputTokens: t.input, outputTokens: t.output, cacheReadTokens: t.cacheRead,
        cacheWrite5mTokens: 0, cacheWrite1hTokens: t.cacheWrite, messages: messageIds.length, contextTokens: 2012,
        firstAt: h!.t.clock.iso(), lastAt: h!.t.clock.iso(),
      },
      payload: { messageIds },
      source: 'sidecar',
    });

  it('agrees when the sidecar recorded what the process reported, differencing the cumulative figures across resumes', async () => {
    h = await createHarness();
    const gate = h.gate();
    const id = await h.launch(`[[fake:gated,normal|gate=${gate.path}]] Build`);
    await h.waitFor(() => h!.callsFor(id).length === 1, 'turn 1 running');
    sidecarReports(id, TURN);
    gate.open();
    await h.waitFor(() => checks(id).length === 1, 'turn 1 reconciled');
    expect(checks(id)[0]).toEqual({
      sessionId: id,
      turn: 1,
      status: 'match',
      reported: true,
      compacted: false,
      batches: 1,
      models: [{ model: OPUS, process: TURN, sidecar: TURN, cumulative: TURN }],
    });
    await h.waitLifecycle(id, 'idle');
    // The process now reports 72 / 240 / 12000 for the session: this turn is the difference.
    sidecarReports(id, TURN, ['msg_4', 'msg_5', 'msg_6']);
    await h.sup.resume(id, 'Next step', 'operator_prompt', h.ownerActor);
    await h.waitFor(() => checks(id).length === 2, 'turn 2 reconciled');
    expect(checks(id)[1]).toMatchObject({ turn: 2, status: 'match', models: [{ process: TURN, sidecar: TURN, cumulative: tokens(72, 240, 12000) }] });
  });

  it('flags a turn whose sidecar totals disagree with modelUsage — missing usage, then forged usage', async () => {
    h = await createHarness();
    const gate = h.gate();
    const id = await h.launch(`[[fake:gated,normal|gate=${gate.path}]] Build`);
    await h.waitFor(() => h!.callsFor(id).length === 1, 'turn 1 running');
    // one answer edited out of the transcript before the sidecar read it
    sidecarReports(id, tokens(24, 80, 4000), ['msg_1', 'msg_2']);
    gate.open();
    await h.waitFor(() => checks(id).length === 1, 'turn 1 reconciled');
    expect(checks(id)[0]).toMatchObject({ status: 'under_reported', models: [{ process: TURN, sidecar: tokens(24, 80, 4000) }] });
    await h.waitLifecycle(id, 'idle');
    // the real report plus a batch the process never produced
    sidecarReports(id, TURN, ['msg_4', 'msg_5', 'msg_6']);
    sidecarReports(id, tokens(0, 5000, 0), ['msg_forged']);
    await h.sup.resume(id, 'Next step', 'operator_prompt', h.ownerActor);
    await h.waitFor(() => checks(id).length === 2, 'turn 2 reconciled');
    expect(checks(id)[1]).toMatchObject({ status: 'over_reported', batches: 2, models: [{ process: TURN, sidecar: tokens(36, 5120, 6000) }] });
  });

  it('waits for the sidecar’s last report before reconciling the turn', async () => {
    h = await createHarness({ sidecarHold: true });
    const id = await h.launch('Build');
    await h.waitLifecycle(id, 'idle');
    await h.waitFor(() => h!.sidecarSignals().length === 1, 'sidecar stopped');
    expect(checks(id)).toEqual([]);
    sidecarReports(id, TURN); // its final flush, after the process exited
    h.releaseSidecars();
    await h.waitFor(() => checks(id).length === 1, 'turn reconciled');
    expect(checks(id)[0]!.status).toBe('match');
  });

  it('calls a turn without a result unverified, and does not hold the next turn’s shortfall against the sidecar', async () => {
    h = await createHarness();
    const id = await h.launch('[[fake:crash,normal]] Build');
    await h.waitLifecycle(id, 'failed');
    await h.waitFor(() => checks(id).length === 1, 'crashed turn reconciled');
    expect(checks(id)[0]).toMatchObject({ turn: 1, status: 'unverified', reported: false, models: [] });
    await h.sup.restart(id, h.ownerActor);
    await h.waitFor(() => checks(id).length === 2, 'restart reconciled');
    expect(checks(id)[1]).toMatchObject({ turn: 2, status: 'unverified', reported: true, models: [{ process: TURN, sidecar: tokens(0, 0, 0), cumulative: TURN }] });
  });
});
