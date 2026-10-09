/**
 * Credits under random sequences (spec §10): allocations, usage, task boundaries, the once-per-period auto-grant,
 * top-up requests and their resolution, and the passage of time, on the production composition (real decisions,
 * sessions and metering; the rate card is read from its file, not from the module under test).
 *
 * A model of the rules (below) predicts, after every step, each account's allocation, grants, usage and balance and
 * the answer every task boundary must give. Invariants on the log: balance conservation, the cap and the auto-grant
 * only at task boundaries, at most one auto-grant per person per period and never a second one by the AI, every
 * grant traceable to a decision, nobody approves their own top-up, one terminal event per top-up request.
 * The failing seed is printed; replay it with AOC_SEED=<n>.
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

// ── the rules, restated ───────────────────────────────────────────────────────────────────────────────────

const KL = 8 * 3_600_000; // Asia/Kuala_Lumpur: UTC+8, no daylight saving
const localDay = (ms: number) => new Date(ms + KL).toISOString().slice(0, 10);
const periodOf = (ms: number) => localDay(ms).slice(0, 7);
const nextPeriod = (period: string) => {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
const r4 = (x: number) => (Math.round(x * 10_000) / 10_000 || 0);
const r2 = (x: number) => (Math.round(x * 100) / 100 || 0);

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

interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cache5m: number;
  cache1h: number;
}
const costOf = (model: string, t: Tokens): number => {
  const r = RATES.get(model)!;
  return (t.input * r.inputPerMTok + t.output * r.outputPerMTok + t.cacheRead * r.cacheReadPerMTok + t.cache5m * r.cacheWrite5mPerMTok + t.cache1h * r.cacheWrite1hPerMTok) / 1e6;
};

interface Grant {
  kind: 'auto' | 'topup';
  amount: number;
}

class Ledger {
  readonly alloc = new Map<string, number>();
  readonly grants = new Map<string, Grant[]>();
  readonly used = new Map<string, number>();
  readonly exempt = new Set<string>();
  constructor(
    readonly defaultAllocation: number,
    readonly pct: number,
  ) {}
  private key = (user: string, period: string) => `${user}|${period}`;
  allocation = (u: string, per: string) => this.alloc.get(this.key(u, per)) ?? this.defaultAllocation;
  grantsOf = (u: string, per: string) => this.grants.get(this.key(u, per)) ?? [];
  granted = (u: string, per: string) => r4(this.grantsOf(u, per).reduce((s, g) => s + g.amount, 0));
  usedBy = (u: string, per: string) => r4(this.used.get(this.key(u, per)) ?? 0);
  balance = (u: string, per: string) => r4(this.allocation(u, per) + this.granted(u, per) - this.usedBy(u, per));
  autoUsed = (u: string, per: string) => this.grantsOf(u, per).some((g) => g.kind === 'auto');
  spend(u: string, per: string, cost: number) {
    this.used.set(this.key(u, per), (this.used.get(this.key(u, per)) ?? 0) + cost);
  }
  allocate(u: string, per: string, amount: number) {
    this.alloc.set(this.key(u, per), amount);
  }
  grant(u: string, per: string, g: Grant) {
    this.grants.set(this.key(u, per), [...this.grantsOf(u, per), g]);
  }
  /** What a task boundary must answer for this person now, and its effects on the model. */
  boundary(u: string | null, per: string): { continue: boolean; autoGranted: boolean; capRecorded: boolean } {
    if (!u || this.exempt.has(u) || this.balance(u, per) > 0) return { continue: true, autoGranted: false, capRecorded: false };
    const auto = Math.max(0, r2((this.allocation(u, per) * this.pct) / 100));
    if (!this.autoUsed(u, per) && auto > 0) {
      const after = r4(this.balance(u, per) + auto);
      this.grant(u, per, { kind: 'auto', amount: auto });
      return { continue: after > 0, autoGranted: true, capRecorded: true };
    }
    return { continue: false, autoGranted: false, capRecorded: true };
  }
}

// ── the world ─────────────────────────────────────────────────────────────────────────────────────────────

describe('credit accounts under random sequences (§10)', () => {
  it('balances, caps, the once-per-period auto-grant and top-ups follow the rules for any interleaving', async () => {
    // What the random sequences actually reached, so a generator that stopped exercising a rule cannot pass quietly.
    const reached = { cap: 0, autoGrant: 0, topupGranted: 0, topupDenied: 0, topupWithdrawn: 0, periods: new Set<string>(), selfRefused: 0 };
    await forSeeds(
      'credits',
      async (rng: Rng, seed) => {
        p = await bootProd({ now: '2026-10-09T02:00:00.000Z', config: { credits: { defaultMonthlyAllocationUsd: 60, autoGrantPct: 25, exemptUserIds: [] } } });
        const prod = p;
        const credits = prod.aoc.runtime.services.get('credits');
        const people = {
          b1: prod.user('builder', 'Builder One'),
          b2: prod.user('builder', 'Builder Two'),
          b3: prod.user('builder', 'Builder Three'),
          bx: prod.user('builder', 'Exempt Builder'),
          a1: prod.user('approver', 'Approver One'),
          a2: prod.user('approver', 'Approver Two'),
        };
        prod.config.credits.exemptUserIds.push(people.bx.user.id);
        const model = new Ledger(60, 25);
        model.exempt.add(people.bx.user.id);
        const nameOf = new Map(Object.entries(people).map(([k, v]) => [v.user.id, k]));
        const sessions: { id: string; owner: keyof typeof people | null }[] = [
          { id: 'ses_c1', owner: 'b1' },
          { id: 'ses_c2', owner: 'b1' },
          { id: 'ses_c3', owner: 'b2' },
          { id: 'ses_c4', owner: 'b3' },
          { id: 'ses_c5', owner: 'a1' },
          { id: 'ses_cx', owner: 'bx' },
          { id: 'ses_c0', owner: null },
        ];
        for (const s of sessions) seedSession(prod, { sessionId: s.id, ownerId: s.owner ? people[s.owner].user.id : null });
        await prod.aoc.runtime.drain();

        const problems: string[] = [];
        const log: string[] = [];
        const note = (s: string) => log.push(s);
        const boundaryWindows: [number, number][] = [];
        const pending = new Map<string, { requestId: string; decisionId: string; amount: number }>(); // by requester
        let message = 0;
        const now = () => prod.clock.now();

        const spend = async () => {
          const s = rng.pick(sessions);
          const modelName = rng.pick(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
          const t: Tokens = {
            input: rng.int(0, 2_000_000),
            output: rng.int(100_000, 2_500_000),
            cacheRead: rng.int(0, 5_000_000),
            cache5m: rng.int(0, 500_000),
            cache1h: rng.int(0, 500_000),
          };
          const res = await prod.request('POST', '/ingest/usage', {
            headers: prod.ids.sidecarHeaders(s.id),
            body: {
              sessionId: s.id,
              idempotencyKey: `credit-usage-${++message}-xx`,
              batches: [
                {
                  model: modelName,
                  inputTokens: t.input,
                  outputTokens: t.output,
                  cacheReadTokens: t.cacheRead,
                  cacheWrite5mTokens: t.cache5m,
                  cacheWrite1hTokens: t.cache1h,
                  messageIds: [`msg_credit_${message}`],
                  firstAt: prod.clock.iso(),
                  lastAt: prod.clock.iso(),
                  contextTokens: 1000,
                },
              ],
            },
          });
          await res.arrayBuffer();
          if (res.status !== 200) return problems.push(`usage for ${s.id}: HTTP ${res.status}`);
          const owner = s.owner ? people[s.owner].user.id : null;
          if (owner) model.spend(owner, periodOf(now()), costOf(modelName, t));
          note(`spend ${s.id} ${modelName} ≈ $${r4(costOf(modelName, t))}`);
        };

        const boundary = async () => {
          const s = rng.pick(sessions);
          const owner = s.owner ? people[s.owner].user.id : null;
          const per = periodOf(now());
          const want = model.boundary(owner, per);
          const before = prod.store.head().seq;
          const got = credits.checkBoundary(s.id, `task_${rng.int(1, 3)}`, { kind: 'agent', id: s.id });
          const after = prod.store.head().seq;
          boundaryWindows.push([before + 1, after]);
          note(`boundary ${s.id} → ${got.continue ? 'continue' : 'stop'}${want.autoGranted ? ' (auto-grant)' : ''}`);
          if (got.continue !== want.continue) problems.push(`boundary ${s.id} (${s.owner}) in ${per}: continue=${got.continue}, rules say ${want.continue}`);
          if (!got.continue && got.reason !== 'credit_cap') problems.push(`boundary ${s.id}: stopped with reason ${got.reason}`);
          const written = prod.store.list({ fromSeq: before + 1, toSeq: after }).map((e) => e.type);
          const grants = written.filter((t) => t === 'credit.auto_granted').length;
          if (grants !== (want.autoGranted ? 1 : 0)) problems.push(`boundary ${s.id}: ${grants} auto-grant events, rules say ${want.autoGranted ? 1 : 0}`);
          const unexpected = written.filter((t) => !['credit.cap_reached', 'credit.auto_granted', 'decision.requested', 'decision.resolved'].includes(t));
          if (unexpected.length) problems.push(`boundary ${s.id}: unexpected events ${unexpected}`);
          if (!want.capRecorded && written.length) problems.push(`boundary ${s.id}: nothing should be written while the balance is positive, got ${written}`);
        };

        const allocate = async () => {
          const by = rng.pick([people.a1, people.a2]);
          const target = rng.pick(Object.values(people));
          const per = rng.pick([periodOf(now()), nextPeriod(periodOf(now()))]);
          const amount = rng.pick([0, 20, 60, 100, 250]);
          const res = await prod.request('POST', '/api/credits/allocations', { headers: by.headers, body: { userId: target.user.id, period: per, amountUsd: amount } });
          await res.arrayBuffer();
          const self = target.user.id === by.user.id;
          if (self && res.status !== 403) problems.push(`${nameOf.get(by.user.id)} allocated to themselves: HTTP ${res.status}`);
          if (!self && res.status !== 201) problems.push(`allocation of $${amount} for ${per}: HTTP ${res.status}`);
          if (!self && res.status === 201) model.allocate(target.user.id, per, amount);
          note(`allocate ${nameOf.get(target.user.id)} ${per} $${amount} by ${nameOf.get(by.user.id)}${self ? ' (self)' : ''}`);
        };

        const requestTopup = async () => {
          const who = rng.pick([people.b1, people.b2, people.b3, people.a1, people.a2, people.bx]);
          const amount = rng.pick([5, 20.5, 75, 150]);
          const res = await prod.request('POST', '/api/credits/topup-requests', { headers: who.headers, body: { amountUsd: amount, reason: 'Finish the migration for the ticket' } });
          const body = (await res.json()) as { requestId?: string; decisionId?: string };
          const exempt = who.user.id === people.bx.user.id;
          const wantStatus = exempt ? 409 : pending.has(who.user.id) ? 409 : 201;
          if (res.status !== wantStatus) problems.push(`top-up request by ${nameOf.get(who.user.id)}: HTTP ${res.status}, rules say ${wantStatus}`);
          if (res.status === 201) pending.set(who.user.id, { requestId: body.requestId!, decisionId: body.decisionId!, amount });
          note(`request top-up ${nameOf.get(who.user.id)} $${amount} → ${res.status}`);
        };

        const settleTopup = async () => {
          if (!pending.size) return;
          const [userId, req] = rng.pick([...pending]);
          const requester = Object.values(people).find((x) => x.user.id === userId)!;
          const how = rng.weighted<string>([
            ['approve_other', 5],
            ['deny_other', 2],
            ['approve_self', 2],
            ['builder_tries', 1],
            ['withdraw_requester', 1],
            ['withdraw_approver', 1],
            ['expire', 1],
          ]);
          const other = requester.user.id === people.a1.user.id ? people.a2 : people.a1;
          const resolve = async (who: typeof requester, optionId: string) => {
            const res = await prod.request('POST', `/api/decisions/${req.decisionId}/resolve`, { headers: who.headers, body: { optionId } });
            await res.arrayBuffer();
            return res.status;
          };
          if (how === 'approve_other' || how === 'deny_other') {
            const status = await resolve(other, how === 'approve_other' ? 'approve' : 'deny');
            if (status !== 200) problems.push(`${how}: HTTP ${status}`);
            else {
              if (how === 'approve_other') model.grant(userId, periodOf(now()), { kind: 'topup', amount: req.amount });
              pending.delete(userId);
            }
          } else if (how === 'approve_self') {
            const status = await resolve(requester, 'approve');
            if (requester.user.role === 'approver' && status !== 403) problems.push(`${nameOf.get(userId)} approved their own top-up: HTTP ${status}`);
            if (requester.user.role !== 'approver' && status !== 403) problems.push(`a builder resolved a top-up: HTTP ${status}`);
          } else if (how === 'builder_tries') {
            const builder = [people.b1, people.b2, people.b3].find((b) => b.user.id !== userId)!;
            const status = await resolve(builder, 'approve');
            if (status !== 403) problems.push(`builder ${nameOf.get(builder.user.id)} resolved a top-up: HTTP ${status}`);
          } else {
            const by = how === 'withdraw_requester' ? requester : other;
            const res = await prod.request('POST', `/api/decisions/${req.decisionId}/withdraw`, { headers: by.headers, body: how === 'expire' ? { reason: 'expired' } : { reason: 'no_longer_needed' } });
            await res.arrayBuffer();
            if (res.status === 200) pending.delete(userId);
            else problems.push(`${how}: HTTP ${res.status}`);
          }
          await prod.aoc.runtime.drain();
          note(`settle ${nameOf.get(userId)} ${how}`);
        };

        const tick = () => {
          prod.clock.advance(rng.weighted<number>([
            [rng.int(1, 3) * 3_600_000, 6],
            [rng.int(1, 5) * 86_400_000, 3],
            [rng.int(26, 40) * 86_400_000, 1],
          ]));
          note(`time → ${prod.clock.iso()}`);
        };

        for (let step = 0; step < 55; step++) {
          const op = rng.weighted<() => Promise<unknown> | void>([
            [spend, 8],
            [boundary, 7],
            [allocate, 2],
            [requestTopup, 2],
            [settleTopup, 3],
            [tick, 2],
          ]);
          await op();
          await prod.aoc.runtime.drain();
        }

        // ── balances, per person and period ──
        for (const [key, person] of Object.entries(people)) {
          for (const per of new Set([periodOf(now()), nextPeriod(periodOf(now())), '2026-10', '2026-11', '2026-12'])) {
            const b = credits.balance(person.user.id, per);
            const w = { allocationUsd: model.allocation(person.user.id, per), grantedUsd: model.granted(person.user.id, per), usedUsd: model.usedBy(person.user.id, per), balanceUsd: model.balance(person.user.id, per), autoGrantUsed: model.autoUsed(person.user.id, per) };
            for (const k of Object.keys(w) as (keyof typeof w)[]) {
              const same = typeof w[k] === 'number' ? Math.abs((b[k] as number) - (w[k] as number)) < 2e-3 : b[k] === w[k];
              if (!same) problems.push(`${key} ${per}: ${k} = ${b[k]}, rules say ${w[k]}`);
            }
          }
        }

        // ── invariants on the log ──
        const store = prod.store;
        const autoByPeriod = new Map<string, number>();
        for (const e of store.list({ types: ['credit.auto_granted'] })) {
          const m = e.meta as { userId: string; period: string; amountUsd: number; decisionId: string | null; allocationUsd: number };
          const k = `${m.userId}|${m.period}`;
          autoByPeriod.set(k, (autoByPeriod.get(k) ?? 0) + 1);
          if (Math.abs(m.amountUsd - r2((m.allocationUsd * 25) / 100)) > 1e-9) problems.push(`auto-grant ${k}: $${m.amountUsd} is not 25% of the allocation $${m.allocationUsd}`);
          const card = m.decisionId ? prod.aoc.runtime.services.get('decisions').get(m.decisionId) : null;
          if (!card || card.status !== 'resolved' || card.resolution?.method !== 'policy' || card.kind !== 'credit_topup') problems.push(`auto-grant ${k}: no policy-resolved credit_topup decision behind it (${m.decisionId})`);
        }
        for (const [k, n] of autoByPeriod) if (n > 1) problems.push(`${k}: ${n} auto-grants in one period`);
        const terminal = new Map<string, string[]>();
        for (const e of store.list({ typePrefix: 'credit.topup_' })) {
          const m = e.meta as { requestId: string; userId: string; approverId?: string };
          if (e.type === 'credit.topup_requested') continue;
          terminal.set(m.requestId, [...(terminal.get(m.requestId) ?? []), e.type]);
          if (e.type === 'credit.topup_granted' && m.approverId === m.userId) problems.push(`${m.requestId}: ${m.userId} approved their own top-up`);
        }
        for (const [id, types] of terminal) if (types.length > 1) problems.push(`${id}: ${types.length} terminal events ${types}`);
        // The cap and the grant happen only at task boundaries: every such event sits inside a boundary call.
        for (const e of store.list({ types: ['credit.cap_reached', 'credit.auto_granted'] })) {
          if (!boundaryWindows.some(([from, to]) => e.seq >= from && e.seq <= to)) problems.push(`${e.type} #${e.seq} was written outside a task boundary`);
        }
        reached.cap += store.list({ types: ['credit.cap_reached'] }).length;
        reached.autoGrant += store.list({ types: ['credit.auto_granted'] }).length;
        reached.topupGranted += store.list({ types: ['credit.topup_granted'] }).length;
        reached.topupDenied += store.list({ types: ['credit.topup_denied'] }).length;
        reached.topupWithdrawn += store.list({ types: ['credit.topup_withdrawn'] }).length;
        reached.selfRefused += log.filter((l) => l.endsWith('approve_self')).length;
        for (const e of store.list({ types: ['usage.recorded'] })) reached.periods.add(periodOf(Date.parse(e.ts)));
        // Whatever was written, the projection is what the log makes of it.
        const dump = () => JSON.stringify(['crd_allocations', 'crd_usage', 'crd_grants', 'crd_caps', 'crd_topups'].map((t) => store.db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()));
        const live = dump();
        store.rebuildProjections(['credits']);
        if (dump() !== live) problems.push('rebuilding the credits projection changes it');

        expect(problems.length ? `${problems.join('\n')}\n--- steps ---\n${log.join('\n')}` : '', `seed ${seed}`).toBe('');
        await prod.close();
        p = null;
      },
      { count: 6 },
    );
    expect(reached.cap, 'seeds that reach a credit cap').toBeGreaterThan(5);
    expect(reached.autoGrant, 'seeds that auto-grant').toBeGreaterThan(3);
    expect(reached.topupGranted, 'approved top-ups').toBeGreaterThan(2);
    expect(reached.topupDenied + reached.topupWithdrawn, 'denied or withdrawn top-ups').toBeGreaterThan(1);
    expect(reached.selfRefused, 'attempts to approve one\'s own top-up').toBeGreaterThan(0);
    expect(reached.periods.size, 'periods with usage').toBeGreaterThan(1);
  }, 120_000);
});
