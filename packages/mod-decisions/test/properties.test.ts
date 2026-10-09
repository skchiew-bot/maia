/**
 * Decisions under random inputs and interleavings (spec §6, §8, §10, §11).
 *
 * 1. Who may resolve what is checked against an independent restatement of the rules (the oracle below) for random
 *    kinds, tests, scopes, requesters, exclusions, eligibility lists and role overrides: the engine's answer, its
 *    refusal, and what lands in the log must agree. Separation of duties is the property that matters most: nobody
 *    resolves a decision they raised (UAT excepted), however the card was shaped.
 * 2. A decision closes exactly once. Concurrent and duplicate resolve / withdraw / expire / policy calls, with the
 *    passkey check suspending a resolution half-way, leave one closing event per card, and the winner is somebody
 *    the rules allowed.
 * The failing seed is printed; replay it with AOC_SEED=<n>.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DECISION_KINDS,
  DECISION_TESTS,
  CHANGE_SCOPES,
  ROLES,
  type DecisionKind,
  type DecisionRequestInput,
  type Role,
  type User,
} from '@aoc/contracts';
import { forSeeds, type Rng } from '@aoc/kernel';
import { DecisionError } from '../src';
import { decisionInput, harness, human, type Harness } from './helpers';

let h: Harness | undefined;
afterEach(async () => {
  await h?.t.close();
  h = undefined;
});

// ── the rules, restated ───────────────────────────────────────────────────────────────────────────────────

const RANK: Record<Role, number> = { requester: 0, builder: 1, approver: 2 };

/** §6: main/production/irreversible/data and every gate go to the Approver; reversible off-main and ambiguity to a Builder. */
function oracleRole(i: Pick<DecisionRequestInput, 'kind' | 'test' | 'changeScope' | 'requiredRole'>): Role {
  let base: Role;
  if (i.kind === 'uat_signoff') base = 'requester';
  else if (i.kind === 'agent_decision') base = i.test && i.test !== 'ambiguity' ? 'approver' : 'builder';
  else if (i.kind === 'change_request') base = i.changeScope === 'reversible_off_main' ? 'builder' : 'approver';
  else if (i.kind === 'triage_reconciliation' || i.kind === 'low_confidence_diagnosis') base = 'builder';
  else base = 'approver';
  // An override only raises the role, and UAT sign-off is never re-routed.
  if (!i.requiredRole || base === 'requester' || i.requiredRole === 'requester') return base;
  return RANK[i.requiredRole] > RANK[base] ? i.requiredRole : base;
}

interface OracleCard {
  kind: DecisionKind;
  required: Role;
  requesterId: string;
  excluded: string[];
  eligible: string[] | null;
}

const uniq = (xs: string[]) => [...new Set(xs)];

function oracleCard(i: DecisionRequestInput): OracleCard {
  const uat = i.kind === 'uat_signoff';
  return {
    kind: i.kind,
    required: oracleRole(i),
    requesterId: i.requesterId,
    excluded: uat ? uniq(i.excludedApproverIds ?? []) : uniq([i.requesterId, ...(i.excludedApproverIds ?? [])]),
    eligible: i.eligibleUserIds ? uniq(i.eligibleUserIds) : uat ? [i.requesterId] : null,
  };
}

/** The card is open. May this person resolve it? */
function oracleMayResolve(c: OracleCard, u: User): boolean {
  if (!u.active) return false;
  if (c.eligible && !c.eligible.includes(u.id)) return false;
  if (c.excluded.includes(u.id)) return false;
  if (c.kind !== 'uat_signoff' && c.requesterId === u.id) return false;
  if (c.required === 'requester') return u.role === 'requester';
  if (c.required === 'builder') return u.role === 'builder' || u.role === 'approver';
  return u.role === 'approver';
}

const oracleHasResolver = (c: OracleCard, users: User[]) => users.some((u) => oracleMayResolve(c, u));

/**
 * A `decision.requested` event whose exclusion list does not name the requester, as a log written by another version
 * or writer may hold: the engine must still keep the requester away from their own request.
 */
function appendUnexcluded(hh: Harness, input: DecisionRequestInput, n: number): string {
  const id = `dec_raw_${n}`;
  hh.t.rt.store.append({
    type: 'decision.requested',
    actor: { kind: 'system', id: 'older-writer' },
    scope: { decisionId: id, sessionId: input.sessionId ?? undefined },
    meta: {
      decisionId: id,
      kind: input.kind,
      test: input.test ?? null,
      requiredRole: oracleRole(input),
      requiresPasskey: ['go_live', 'rollback', 'break_glass'].includes(input.kind),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      sessionId: input.sessionId ?? null,
      projectId: input.projectId ?? null,
      optionIds: input.options.map((o) => o.id),
      recommendedOptionId: input.recommendation?.optionId ?? null,
      requesterId: input.requesterId,
      excludedApproverIds: (input.excludedApproverIds ?? []).filter((u) => u !== input.requesterId),
      eligibleUserIds: input.eligibleUserIds ?? null,
      dueAt: null,
    },
    payload: { title: input.title, question: input.question, options: input.options },
    source: 'system',
  });
  return id;
}

// ── a population ──────────────────────────────────────────────────────────────────────────────────────────

function population(hh: Harness): User[] {
  const base = [hh.approver, hh.approver2, hh.builderA, hh.builderB, hh.requester, hh.requester2].map((u) => u.user);
  // People who left: they must not be able to resolve anything however the card is shaped.
  const left = (role: Role, n: number): User => ({ ...hh.builderA.user, id: `usr_left_${role}_${n}`, role, active: false });
  return [...base, left('approver', 1), left('builder', 1), left('requester', 1)];
}

function randomInput(rng: Rng, users: User[], n: number): DecisionRequestInput {
  const kind = rng.pick(DECISION_KINDS);
  const ids = users.map((u) => u.id);
  const requesterId = rng.weighted<string>([
    [rng.pick(ids), 6],
    [`session:ses_${rng.int(1, 3)}`, 2],
    [`usr_stranger_${rng.int(1, 3)}`, 1],
  ]);
  const subset = (max: number) => rng.shuffle([...ids]).slice(0, rng.int(0, max));
  return decisionInput({
    kind,
    requesterId,
    test: kind === 'agent_decision' || rng.chance(0.2) ? rng.pick(DECISION_TESTS) : null,
    changeScope: kind === 'change_request' || rng.chance(0.2) ? rng.pick(CHANGE_SCOPES) : null,
    excludedApproverIds: rng.chance(0.5) ? subset(3) : undefined,
    eligibleUserIds: rng.chance(0.4) ? rng.shuffle([...ids]).slice(0, rng.int(1, 4)) : null,
    requiredRole: rng.chance(0.25) ? rng.pick(ROLES) : undefined,
    subjectType: 'session',
    subjectId: `ses_${n}`,
    sessionId: `ses_${n}`,
  });
}

// ── 1. who may resolve ────────────────────────────────────────────────────────────────────────────────────

describe('separation of duties against an independent oracle (§6)', () => {
  it('canResolve, resolve and the log agree with the rules for random cards and people', async () => {
    await forSeeds(
      'decision authorization',
      async (rng, seed) => {
        h = await harness();
        const users = population(h);
        const byId = new Map(users.map((u) => [u.id, u]));
        const problems: string[] = [];
        for (let n = 0; n < 45; n++) {
          const input = randomInput(rng, users, n);
          const oc = oracleCard(input);
          // A quarter of the cards are written without the requester in the exclusion list (see appendUnexcluded).
          const raw = input.kind !== 'uat_signoff' && rng.chance(0.25);
          if (raw) oc.excluded = (input.excludedApproverIds ?? []).filter((u) => u !== input.requesterId);
          const impossible = !raw && oc.eligible !== null && oc.eligible.every((u) => oc.excluded.includes(u));
          let card;
          try {
            card = raw ? h.engine.get(appendUnexcluded(h, input, n))! : h.engine.request(input, { kind: 'system', id: 'test' });
          } catch (err) {
            if (!impossible || (err as DecisionError).code !== 'no_eligible_resolver')
              problems.push(`#${n} ${input.kind}: raising failed unexpectedly: ${String(err)}`);
            continue;
          }
          if (impossible) {
            problems.push(`#${n} ${input.kind}: raised although every eligible person is excluded`);
            continue;
          }
          const label = `#${n} ${input.kind}${input.test ? `/${input.test}` : ''}${input.changeScope ? `/${input.changeScope}` : ''} requester=${input.requesterId}`;
          if (card.requiredRole !== oc.required) problems.push(`${label}: routed to ${card.requiredRole}, rules say ${oc.required}`);
          if ([...card.excludedApproverIds].sort().join() !== [...oc.excluded].sort().join()) problems.push(`${label}: excluded ${card.excludedApproverIds} vs ${oc.excluded}`);
          if (JSON.stringify(card.eligibleUserIds?.slice().sort() ?? null) !== JSON.stringify(oc.eligible?.slice().sort() ?? null)) problems.push(`${label}: eligible ${card.eligibleUserIds} vs ${oc.eligible}`);

          const decided = rng.shuffle([...users]);
          for (const u of decided) {
            const can = h.engine.canResolve(card, u);
            if (can.ok !== oracleMayResolve(oc, u)) problems.push(`${label}: canResolve(${u.id} ${u.role}${u.active ? '' : ' inactive'}) = ${can.ok} (${can.reason}), rules say ${!can.ok}`);
            if (!can.ok && can.reason === null) problems.push(`${label}: a refusal without a reason for ${u.id}`);
          }
          // Somebody tries to resolve it for real: the engine and the log have to say what the rules say.
          const who = byId.get(rng.pick(users).id)!;
          const before = h.t.rt.store.head().seq;
          const option = rng.pick(input.options).id;
          let outcome: 'resolved' | string;
          try {
            await h.engine.resolve(card.id, { optionId: option, passkeyAssertion: { id: 'test-passkey' } }, who);
            outcome = 'resolved';
          } catch (err) {
            outcome = (err as DecisionError).code;
          }
          const wrote = h.t.rt.store.list({ fromSeq: before + 1, types: ['decision.resolved'] });
          const allowed = oracleMayResolve(oc, who);
          if (allowed && outcome !== 'resolved') problems.push(`${label}: ${who.id} may resolve but was refused (${outcome})`);
          if (!allowed && outcome === 'resolved') problems.push(`${label}: ${who.id} (${who.role}) resolved a card the rules forbid`);
          if (allowed && wrote.length !== 1) problems.push(`${label}: ${wrote.length} decision.resolved events for one resolution`);
          if (!allowed && wrote.length !== 0) problems.push(`${label}: a refused resolution wrote ${wrote.length} event(s)`);
          const m = wrote[0]?.meta as { resolvedBy?: string; selfApproved?: boolean } | undefined;
          if (m && m.resolvedBy !== who.id) problems.push(`${label}: resolved by ${m.resolvedBy}, not the caller ${who.id}`);
          if (m && m.selfApproved === true && who.id !== input.requesterId && !input.requesterId.startsWith('session:')) problems.push(`${label}: flagged self-approved for somebody who did not raise it`);
          if (m && who.id === input.requesterId && input.kind !== 'uat_signoff') problems.push(`${label}: the requester resolved their own decision`);
          // A second attempt at a closed card, by anyone, is refused and writes nothing.
          if (outcome === 'resolved') {
            const again = h.t.rt.store.head().seq;
            const second = await h.engine.resolve(card.id, { optionId: option, passkeyAssertion: { id: 'test-passkey' } }, rng.pick(users)).then(
              () => 'resolved',
              (err: DecisionError) => err.code,
            );
            if (second === 'resolved' || h.t.rt.store.head().seq !== again) problems.push(`${label}: resolved a second time`);
          }
        }
        expect(problems.join('\n'), `seed ${seed}`).toBe('');
        await h.t.close();
        h = undefined;
      },
      { count: 6 },
    );
  }, 60_000);
});

// ── 2. a decision closes exactly once ─────────────────────────────────────────────────────────────────────

describe('a decision closes exactly once (§2.3, §6)', () => {
  const CLOSING = ['decision.resolved', 'decision.withdrawn', 'decision.expired'];

  it('concurrent and duplicate resolve / withdraw / expire / policy calls, passkey checks suspended mid-way, leave one closing event per card', async () => {
    await forSeeds(
      'decision close',
      async (rng, seed) => {
        h = await harness();
        const identity = h.t.rt.services.get('identity') as unknown as {
          verifyDecisionPasskey(i: { userId: string; decisionId: string; optionId: string; assertion: unknown }): Promise<boolean>;
        };
        // The passkey check awaits (WebAuthn verification does): other calls run meanwhile.
        identity.verifyDecisionPasskey = async () => {
          for (let i = rng.int(0, 4); i > 0; i--) await new Promise<void>((r) => setImmediate(r));
          return true;
        };
        const users = population(h).filter((u) => u.active);
        const problems: string[] = [];
        const cards: { id: string; oc: OracleCard; kind: DecisionKind; options: string[]; requester: string }[] = [];
        for (let n = 0; n < 24; n++) {
          const kind = rng.pick(['go_live', 'rollback', 'break_glass', 'credit_topup', 'change_request', 'agent_decision', 'fx_discrepancy'] as const);
          const input = decisionInput({
            kind,
            requesterId: rng.pick(users).id,
            test: kind === 'agent_decision' ? rng.pick(DECISION_TESTS) : null,
            changeScope: kind === 'change_request' ? rng.pick(CHANGE_SCOPES) : null,
            subjectType: 'session',
            subjectId: `ses_${n}`,
            sessionId: `ses_${n}`,
          });
          const card = h.engine.request(input, { kind: 'system', id: 'test' });
          cards.push({ id: card.id, oc: oracleCard(input), kind, options: input.options.map((o) => o.id), requester: input.requesterId });
        }
        const yieldSome = async () => {
          for (let i = rng.int(0, 3); i > 0; i--) await new Promise<void>((r) => setImmediate(r));
        };
        const attempts: Promise<{ card: string; op: string; by: string; ok: boolean; code: string | null }>[] = [];
        for (const c of cards) {
          const valid = users.filter((u) => oracleMayResolve(c.oc, u));
          // Two people who may resolve it race, whatever else is thrown at the card.
          const planned: [string, User][] = valid.length ? rng.sample(valid, 2).map((u) => ['resolve', u] as [string, User]) : [];
          for (let k = rng.int(1, 5); k > 0; k--) {
            planned.push([
              rng.weighted<string>([
                ['resolve', 5],
                ['resolve_dup', 2],
                ['withdraw', 2],
                ['expire', 1],
                ['policy', c.kind === 'credit_topup' ? 2 : 0],
              ]),
              rng.pick(users),
            ]);
          }
          for (const [op, who] of planned) {
            const option = rng.pick(c.options);
            attempts.push(
              (async () => {
                await yieldSome();
                try {
                  if (op === 'resolve' || op === 'resolve_dup') await h!.engine.resolve(c.id, { optionId: option, passkeyAssertion: { id: 'test-passkey' } }, who);
                  else if (op === 'withdraw') h!.engine.withdraw(c.id, rng.chance(0.2) ? 'expired' : 'manual', { kind: 'human', id: who.id });
                  else if (op === 'expire') h!.engine.expire(c.id, { kind: 'system', id: 'sweeper' });
                  else h!.engine.resolveByPolicy(c.id, option, { kind: 'system', id: 'policy' });
                  return { card: c.id, op, by: who.id, ok: true, code: null };
                } catch (err) {
                  return { card: c.id, op, by: who.id, ok: false, code: (err as DecisionError).code ?? String(err) };
                }
              })(),
            );
          }
        }
        const results = await Promise.all(attempts);
        const store = h.t.rt.store;
        for (const c of cards) {
          const closing = store.list({ decisionId: c.id }).filter((e) => CLOSING.includes(e.type));
          const wins = results.filter((r) => r.card === c.id && r.ok);
          if (closing.length > 1) problems.push(`${c.id} (${c.kind}): ${closing.length} closing events [${closing.map((e) => e.type)}]`);
          if (closing.length !== wins.length) problems.push(`${c.id}: ${closing.length} closing events for ${wins.length} successful calls: ${wins.map((w) => `${w.op} by ${w.by}`).join(', ')}`);
          // Somebody allowed was trying to resolve it: the card cannot have stayed open.
          if (oracleHasResolver(c.oc, users) && closing.length === 0) problems.push(`${c.id} (${c.kind}): still open after ${results.filter((r) => r.card === c.id).length} calls including valid resolutions`);
          const losers = results.filter((r) => r.card === c.id && !r.ok && !['not_open', 'already_resolved', 'separation_of_duties', 'role', 'not_eligible', 'policy_exhausted', 'policy_not_allowed', 'unknown_option', 'forbidden', 'inactive'].includes(r.code ?? ''));
          for (const l of losers) problems.push(`${c.id}: ${l.op} by ${l.by} failed with unexpected ${l.code}`);
          const keyed = store.db.prepare('SELECT count(*) AS n FROM events WHERE idempotency_key = ?').get(`decision:${c.id}:closed`) as { n: number };
          if (keyed.n !== 1) problems.push(`${c.id}: ${keyed.n} events carry the close key`);
          const card = h.engine.get(c.id)!;
          const e = closing[0];
          if (e) {
            const status = { 'decision.resolved': 'resolved', 'decision.withdrawn': card.status === 'expired' ? 'expired' : 'withdrawn', 'decision.expired': 'expired' }[e.type];
            if (card.status !== status) problems.push(`${c.id}: the log closed it with ${e.type} but the card is ${card.status}`);
            const win = wins[0];
            if (e.type === 'decision.resolved') {
              const m = e.meta as { resolvedBy: string; method: string };
              const u = users.find((x) => x.id === m.resolvedBy);
              if (m.method === 'policy') {
                if (c.kind !== 'credit_topup') problems.push(`${c.id}: ${c.kind} was resolved by policy`);
              } else if (!u || !oracleMayResolve(c.oc, u)) problems.push(`${c.id}: resolved by ${m.resolvedBy}, whom the rules do not allow`);
              if (win && m.method !== 'policy' && win.by !== m.resolvedBy) problems.push(`${c.id}: the call by ${win.by} won but ${m.resolvedBy} is on record`);
            }
          }
        }
        // Whatever the interleaving, the projection is what the log makes of itself.
        const live = JSON.stringify(store.db.prepare('SELECT * FROM dec_decisions ORDER BY id').all());
        store.rebuildProjections(['decisions']);
        const rebuilt = JSON.stringify(store.db.prepare('SELECT * FROM dec_decisions ORDER BY id').all());
        if (live !== rebuilt) problems.push('rebuilding the decisions projection changes it');
        expect(problems.join('\n'), `seed ${seed}`).toBe('');
        await h.t.close();
        h = undefined;
      },
      { count: 5 },
    );
  }, 60_000);

  it('one credit auto-grant per requester per period, however the policy calls are interleaved; the next need goes to a person', async () => {
    h = await harness();
    const requesters = [h.builderA, h.builderB];
    const open = (who: (typeof requesters)[number], n: number) =>
      h!.engine.request(
        decisionInput({ kind: 'credit_topup', requesterId: who.user.id, subjectType: 'credit_account', subjectId: `acct_${who.user.id}_${n}`, sessionId: null, projectId: null }),
        { kind: 'system', id: 'credits' },
      );
    const tries = [open(requesters[0]!, 1), open(requesters[0]!, 2), open(requesters[0]!, 3), open(requesters[1]!, 1)];
    const outcomes = await Promise.all(
      tries.map(async (c) => {
        await new Promise<void>((r) => setImmediate(r));
        try {
          h!.engine.resolveByPolicy(c.id, 'approve', { kind: 'system', id: 'credits' });
          return 'granted';
        } catch (err) {
          return (err as DecisionError).code;
        }
      }),
    );
    expect(outcomes).toEqual(['granted', 'policy_exhausted', 'policy_exhausted', 'granted']);
    // The refused cards are still open for a person; the requester is not that person.
    const third = tries[2]!;
    expect(h.engine.get(third.id)!.status).toBe('open');
    expect(h.engine.canResolve(h.engine.get(third.id)!, requesters[0]!.user)).toEqual({ ok: false, reason: 'separation_of_duties' });
    expect(h.engine.canResolve(h.engine.get(third.id)!, h.approver.user).ok).toBe(true);
    // A new period (local month) brings a new grant.
    h.t.clock.advance(40 * 24 * 3_600_000);
    const next = open(requesters[0]!, 4);
    expect(() => h!.engine.resolveByPolicy(next.id, 'approve', { kind: 'system', id: 'credits' })).not.toThrow();
    // Only a platform actor may resolve by policy, and never a gate.
    const gate = h.engine.request(decisionInput({ kind: 'go_live', requesterId: h.builderA.user.id }), human(h.builderA));
    expect((() => { try { h!.engine.resolveByPolicy(gate.id, 'approve', { kind: 'system', id: 'x' }); return null; } catch (e) { return (e as DecisionError).code; } })()).toBe('policy_not_allowed');
    const topup = open(requesters[1]!, 9);
    expect((() => { try { h!.engine.resolveByPolicy(topup.id, 'approve', human(h!.approver)); return null; } catch (e) { return (e as DecisionError).code; } })()).toBe('policy_actor');
  });
});
