/**
 * Usage from the sidecar to every ledger that counts it (spec §10): sess_usage_daily, metering's priced rows and a
 * session's cost, and the credit balance of its owner.
 *
 * Messages are cut into batches the way the sidecar cuts them (each message in exactly one batch), and the batches are
 * then delivered the way a flaky network and a restarting sidecar deliver them: out of order, interleaved across
 * sessions, the same request twice, the same messages again under a new idempotency key, through the spool as well as
 * directly, and hours late. Whatever the delivery, every ledger must hold exactly the deduplicated sum by message id,
 * priced on the day the (bounded) batch time falls in. The failing seed is printed; replay it with AOC_SEED=<n>.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { forSeeds, type Rng } from '@aoc/kernel';
import { repoRoot } from './helpers';
import { bootProd, seedSession, type Prod } from './support/prod';

let p: Prod | null = null;
afterEach(async () => {
  await p?.close();
  p = null;
});

const KL = 8 * 3_600_000;
const localDay = (ms: number) => new Date(ms + KL).toISOString().slice(0, 10);
const HOUR = 3_600_000;

interface Rate {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWrite5mPerMTok: number;
  cacheWrite1hPerMTok: number;
}
const RATES = new Map<string, Rate>(
  (JSON.parse(readFileSync(join(repoRoot, 'config', 'rate-card.json'), 'utf8')) as { rates: (Rate & { model: string })[] }).rates.map((r) => [r.model, r]),
);
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

interface Tokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}
const FIELDS: (keyof Tokens)[] = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWrite5mTokens', 'cacheWrite1hTokens'];
const costOf = (model: string, t: Tokens): number => {
  const r = RATES.get(model)!;
  return (t.inputTokens * r.inputPerMTok + t.outputTokens * r.outputPerMTok + t.cacheReadTokens * r.cacheReadPerMTok + t.cacheWrite5mTokens * r.cacheWrite5mPerMTok + t.cacheWrite1hTokens * r.cacheWrite1hPerMTok) / 1e6;
};

interface Batch {
  /** The client's session reference: the aoc session id, or the claude session id of an observed session. */
  ref: string;
  session: string;
  observed: boolean;
  model: string;
  ids: string[];
  tokens: Tokens;
  firstAt: number;
  lastAt: number;
}

describe('usage reaches every ledger exactly once, however it is delivered (§10)', () => {
  it('sess_usage_daily, metering rows, session cost and credit usage equal the deduplicated sum by message id', async () => {
    const reached = { sent: 0, recorded: 0, duplicates: 0, rekeyed: 0, spooled: 0, late: 0, observed: 0 };
    await forSeeds(
      'usage pipeline',
      async (rng: Rng, seed) => {
        p = await bootProd({ now: '2026-10-09T06:00:00.000Z' });
        const prod = p;
        const owner = prod.user('builder', 'Owner');
        const managed = [seedSession(prod, { sessionId: 'ses_u1', ownerId: owner.user.id }), seedSession(prod, { sessionId: 'ses_u2', ownerId: owner.user.id })];
        const claudeObserved = '99999999-9999-4999-8999-999999999999';
        const hello = await prod.request('POST', '/ingest/hook', {
          headers: prod.ids.ingestHeaders('observer'),
          body: { mode: 'observed', aocSessionId: null, hook: { session_id: claudeObserved, hook_event_name: 'SessionStart', cwd: '/home/dev/app', transcript_path: '/home/dev/.claude/t.jsonl' }, sentAt: prod.clock.iso(), idempotencyKey: 'observed-start-key' },
        });
        expect(hello.status).toBe(200);
        const observedId = (prod.store.list({ types: ['session.observed'] })[0]!.meta as { sessionId: string }).sessionId;
        const sessionsStarted = prod.clock.now();

        const problems: string[] = [];
        // What the oracle expects, per session/model/day, plus the batches by identity (their message ids).
        const expected = new Map<string, Tokens & { cost: number }>();
        const recordedBatches = new Map<string, { receipt: number; batch: Batch }>();
        let messageNo = 0;
        let keyNo = 0;

        const round = async (n: number) => {
          // Messages of this hour, cut into batches.
          const batches: Batch[] = [];
          const now = prod.clock.now();
          for (const s of [...managed.map((m) => ({ ref: m.sessionId, session: m.sessionId, observed: false })), { ref: claudeObserved, session: observedId, observed: true }]) {
            for (let g = rng.int(0, 3); g > 0; g--) {
              const model = rng.pick(MODELS);
              const ids = Array.from({ length: rng.int(1, 4) }, () => `msg_${seed}_${++messageNo}`);
              const times = ids.map(() => now - rng.int(0, 50 * 60_000));
              batches.push({
                ref: s.ref,
                session: s.session,
                observed: s.observed,
                model,
                ids,
                tokens: {
                  inputTokens: rng.int(0, 300_000),
                  outputTokens: rng.int(1, 600_000),
                  cacheReadTokens: rng.int(0, 2_000_000),
                  cacheWrite5mTokens: rng.int(0, 100_000),
                  cacheWrite1hTokens: rng.int(0, 100_000),
                },
                firstAt: Math.min(...times),
                lastAt: Math.max(...times),
              });
            }
          }
          // Deliveries: every batch once, some again, in an order that has nothing to do with message time.
          type Delivery = { batch: Batch; key: string; spool: boolean };
          const plan: Delivery[] = [];
          for (const b of batches) {
            const key = `usage-${seed}-${++keyNo}-xx`;
            const spool = rng.chance(0.3);
            plan.push({ batch: b, key, spool });
            while (rng.chance(0.4)) {
              // The same request again (a retry after a lost response), or the same messages re-sent under a new key.
              const rekey = rng.chance(0.5);
              if (rekey) reached.rekeyed++;
              else reached.duplicates++;
              plan.push({ batch: b, key: rekey ? `usage-${seed}-${++keyNo}-xx` : key, spool: rng.chance(0.3) });
            }
          }
          for (const d of rng.shuffle(plan)) {
            const { batch: b } = d;
            const sent = b.ids.length ? rng.shuffle(b.ids) : b.ids;
            const body = {
              sessionId: b.ref,
              idempotencyKey: d.key,
              batches: [
                {
                  model: b.model,
                  ...b.tokens,
                  messageIds: sent,
                  firstAt: new Date(b.firstAt).toISOString(),
                  lastAt: new Date(b.lastAt).toISOString(),
                  contextTokens: 1000,
                },
              ],
            };
            // Hours late is fine: the batch time is bounded to the hour before receipt (R-08), and the oracle knows.
            if (rng.chance(0.15)) {
              prod.clock.advance(rng.int(1, 3) * HOUR);
              reached.late++;
            }
            const receipt = prod.clock.now();
            const headers = b.observed ? prod.ids.ingestHeaders('observer') : prod.ids.sidecarHeaders(b.session);
            const res = d.spool
              ? await prod.request('POST', '/ingest/spool', { headers, body: { items: [{ path: '/ingest/usage', body, queuedAt: prod.clock.iso() }] } })
              : await prod.request('POST', '/ingest/usage', { headers, body });
            await res.arrayBuffer();
            reached.sent++;
            if (d.spool) reached.spooled++;
            if (b.observed) reached.observed++;
            if (res.status !== 200) {
              problems.push(`round ${n}: HTTP ${res.status} for ${b.ids.join(',')}`);
              continue;
            }
            const identity = [...b.ids].sort().join('|');
            if (!recordedBatches.has(identity)) {
              recordedBatches.set(identity, { receipt, batch: b });
              reached.recorded++;
              // The first delivery decides the batch's day: its time is held within [max(start, receipt - 1h), receipt].
              const lo = Math.min(receipt, Math.max(sessionsStarted, receipt - HOUR));
              const lastAt = Math.min(receipt, Math.max(lo, b.lastAt));
              const key = `${b.session}|${b.model}|${localDay(lastAt)}`;
              const cur = expected.get(key) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cost: 0 };
              for (const f of FIELDS) cur[f] += b.tokens[f];
              cur.cost += costOf(b.model, b.tokens);
              expected.set(key, cur);
            }
          }
          await prod.aoc.runtime.drain();
          // The next hour (or, now and then, the next day).
          prod.clock.advance(rng.chance(0.25) ? 20 * HOUR : HOUR);
        };
        for (let r = 0; r < 6; r++) await round(r);

        // ── sess_usage_daily, per session, model and day ──
        const db = prod.store.db;
        const daily = db.prepare('SELECT session_id AS s, model, date, input, output, cache_read AS cr, cache_w5 AS c5, cache_w1 AS c1 FROM sess_usage_daily').all() as { s: string; model: string; date: string; input: number; output: number; cr: number; c5: number; c1: number }[];
        const seenKeys = new Set<string>();
        for (const r of daily) {
          const k = `${r.s}|${r.model}|${r.date}`;
          seenKeys.add(k);
          const w = expected.get(k);
          if (!w) {
            problems.push(`sess_usage_daily has ${k}, which nothing delivered`);
            continue;
          }
          const got = [r.input, r.output, r.cr, r.c5, r.c1];
          const want = [w.inputTokens, w.outputTokens, w.cacheReadTokens, w.cacheWrite5mTokens, w.cacheWrite1hTokens];
          if (got.join() !== want.join()) problems.push(`sess_usage_daily ${k}: ${got} ≠ ${want}`);
        }
        for (const k of expected.keys()) if (!seenKeys.has(k)) problems.push(`sess_usage_daily lacks ${k}`);

        // ── metering rows: tokens and priced cost per session, model and day ──
        const rows = db.prepare('SELECT session_id AS s, model, date, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cache_read_tokens) AS cr, SUM(cache_write_5m_tokens) AS c5, SUM(cache_write_1h_tokens) AS c1, SUM(cost_usd) AS cost, COUNT(*) AS n FROM mtr_usage GROUP BY session_id, model, date').all() as { s: string; model: string; date: string; i: number; o: number; cr: number; c5: number; c1: number; cost: number; n: number }[];
        for (const r of rows) {
          const k = `${r.s}|${r.model}|${r.date}`;
          const w = expected.get(k);
          if (!w) {
            problems.push(`mtr_usage has ${k}, which nothing delivered`);
            continue;
          }
          if ([r.i, r.o, r.cr, r.c5, r.c1].join() !== [w.inputTokens, w.outputTokens, w.cacheReadTokens, w.cacheWrite5mTokens, w.cacheWrite1hTokens].join()) problems.push(`mtr_usage ${k}: tokens differ`);
          if (Math.abs(r.cost - w.cost) > 1e-6) problems.push(`mtr_usage ${k}: cost ${r.cost} ≠ ${w.cost}`);
        }
        if (rows.length !== expected.size) problems.push(`mtr_usage holds ${rows.length} session/model/day groups, the oracle ${expected.size}`);
        const events = prod.store.list({ types: ['usage.recorded'] }).length;
        if (events !== recordedBatches.size) problems.push(`${events} usage.recorded events for ${recordedBatches.size} distinct batches`);

        // ── a session's cost, and the owner's credit usage ──
        const metering = prod.aoc.runtime.services.get('metering');
        for (const sid of [...managed.map((m) => m.sessionId), observedId]) {
          const want = [...expected].filter(([k]) => k.startsWith(`${sid}|`)).reduce((a, [, v]) => a + v.cost, 0);
          if (Math.abs(metering.sessionCostUsd(sid) - want) > 1e-6) problems.push(`sessionCostUsd(${sid}) = ${metering.sessionCostUsd(sid)}, the oracle ${want}`);
        }
        const credits = prod.aoc.runtime.services.get('credits');
        const months = new Set([...expected.keys()].map((k) => k.split('|')[2]!.slice(0, 7)));
        for (const month of months) {
          const want = [...expected].filter(([k]) => k.split('|')[2]!.startsWith(month) && managed.some((m) => k.startsWith(`${m.sessionId}|`))).reduce((a, [, v]) => a + v.cost, 0);
          const got = credits.balance(owner.user.id, month).usedUsd;
          if (Math.abs(got - Math.round(want * 1e4) / 1e4) > 2e-4) problems.push(`credits used in ${month}: ${got}, the oracle ${want}`);
        }
        // The observed session's usage is nobody's credit.
        // Rebuilding changes none of it.
        const dump = () => JSON.stringify(['sess_usage_daily', 'mtr_usage', 'crd_usage'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2, 3`).all()));
        const live = dump();
        prod.store.rebuildProjections();
        if (dump() !== live) problems.push('a rebuild changes the usage tables');

        expect(problems.join('\n'), `seed ${seed}`).toBe('');
        await prod.close();
        p = null;
      },
      { count: 6 },
    );
    expect(reached.recorded, 'distinct batches').toBeGreaterThan(40);
    expect(reached.duplicates, 'exact retries').toBeGreaterThan(8);
    expect(reached.rekeyed, 'same messages under a new key').toBeGreaterThan(8);
    expect(reached.spooled, 'deliveries through the spool').toBeGreaterThan(8);
    expect(reached.late, 'late deliveries').toBeGreaterThan(5);
    expect(reached.observed, 'observed-session deliveries').toBeGreaterThan(5);
  }, 120_000);
});
