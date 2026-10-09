import { afterEach, describe, expect, it } from 'vitest';
import type { Actor, MetaOf, StoredEvent } from '@aoc/contracts';
import { createTestRuntime, type TestRuntime } from '@aoc/kernel';
import { gateVerdict, proposeForApproval, type ApproverGate } from '../src';

const GATE: ApproverGate = { kind: 'playbook_approval', approveOptionId: 'approve' };
const SYSTEM: Actor = { kind: 'system', id: 'distill-test' };
const OPTIONS = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject' },
];

let t: TestRuntime;
let open: TestRuntime | null = null;
const boot = async () => (open = t = await createTestRuntime({ modules: [] }));
afterEach(async () => {
  await open?.close();
  open = null;
});

const request = (requesterId: string) => ({
  title: 'Approve playbook',
  question: 'Approve?',
  options: OPTIONS,
  subjectType: 'playbook',
  subjectId: 'pbk_1',
  requesterId,
});

const lastOf = (type: string): StoredEvent => t.rt.store.list({ types: [type], order: 'desc', limit: 1 })[0]!;

describe('proposeForApproval', () => {
  it('raises the gate decision for the Approver, then records the proposal against it', async () => {
    await boot();
    const curator = t.user('builder');
    const actor: Actor = { kind: 'human', id: curator.user.id };
    const { card, recorded } = proposeForApproval({
      decisions: t.decisions!,
      gate: GATE,
      request: request(curator.user.id),
      actor,
      withdrawAs: SYSTEM,
      record: (c) => `proposal for ${c.id}`,
    });
    expect(card).toMatchObject({ kind: 'playbook_approval', requiredRole: 'approver', status: 'open' });
    expect(card.excludedApproverIds).toContain(curator.user.id);
    expect(recorded).toBe(`proposal for ${card.id}`);
    expect(lastOf('decision.requested').actor).toEqual(actor);
  });

  it('withdraws the card when the proposal cannot be recorded, and rethrows', async () => {
    await boot();
    expect(() =>
      proposeForApproval({
        decisions: t.decisions!,
        gate: GATE,
        request: request('usr_x'),
        actor: SYSTEM,
        withdrawAs: SYSTEM,
        record: () => {
          throw new Error('append failed');
        },
      }),
    ).toThrow('append failed');
    const withdrawn = lastOf('decision.withdrawn');
    expect(withdrawn.meta).toMatchObject({ reason: 'proposal_failed' });
    expect(withdrawn.actor).toEqual(SYSTEM);
    expect(t.decisions!.list({ status: ['open'] })).toEqual([]);
  });

  it('refuses a card that cannot bind (no approve option) before raising anything', async () => {
    await boot();
    expect(() =>
      proposeForApproval({
        decisions: t.decisions!,
        gate: GATE,
        request: { ...request('usr_x'), options: [{ id: 'ok', label: 'OK' }] },
        actor: SYSTEM,
        withdrawAs: SYSTEM,
        record: () => null,
      }),
    ).toThrow(/must offer the 'approve' option/);
    expect(t.rt.store.list({ types: ['decision.requested'] })).toEqual([]);
  });
});

describe('gateVerdict: only a person binds', () => {
  it('reads real resolutions: a person approves or rejects; a policy approval rejects', async () => {
    await boot();
    const ceo = t.user('approver');
    const raise = () =>
      proposeForApproval({
        decisions: t.decisions!,
        gate: GATE,
        request: request('usr_curator'),
        actor: SYSTEM,
        withdrawAs: SYSTEM,
        record: () => null,
      }).card;

    await t.decisions!.resolve(raise().id, { optionId: 'approve' }, ceo.user);
    expect(gateVerdict(GATE, lastOf('decision.resolved'))).toBe('approved');
    await t.decisions!.resolve(raise().id, { optionId: 'reject' }, ceo.user);
    expect(gateVerdict(GATE, lastOf('decision.resolved'))).toBe('rejected');
    t.decisions!.resolveByPolicy(raise().id, 'approve', SYSTEM);
    expect(lastOf('decision.resolved').meta).toMatchObject({ method: 'policy', optionId: 'approve' });
    expect(gateVerdict(GATE, lastOf('decision.resolved'))).toBe('rejected');
    t.decisions!.withdraw(raise().id, 'playbook_retired', SYSTEM);
    expect(gateVerdict(GATE, lastOf('decision.withdrawn'))).toBe('withdrawn');
    // A card that expires unanswered never binds either (decision.expired, G-33).
    const lapsed = raise();
    t.rt.store.append({
      type: 'decision.expired',
      actor: SYSTEM,
      scope: { decisionId: lapsed.id },
      meta: { decisionId: lapsed.id, ageMs: 86_400_000 },
      source: 'system',
    });
    expect(gateVerdict(GATE, lastOf('decision.expired'))).toBe('withdrawn');
  });

  const resolved = (meta: Partial<MetaOf<'decision.resolved'>>, actor: Actor): StoredEvent =>
    ({
      type: 'decision.resolved',
      actor,
      meta: {
        decisionId: 'dec_1',
        kind: 'playbook_approval',
        optionId: 'approve',
        resolvedBy: actor.id,
        method: 'button',
        passkeyVerified: false,
        selfApproved: false,
        ageMs: 1,
        ...meta,
      },
    }) as unknown as StoredEvent;

  it('a non-human actor never approves, and other kinds or events are not this gate’s', () => {
    expect(gateVerdict(GATE, resolved({}, { kind: 'human', id: 'usr_ceo' }))).toBe('approved');
    expect(gateVerdict(GATE, resolved({}, { kind: 'system', id: 'job' }))).toBe('rejected');
    expect(gateVerdict(GATE, resolved({}, { kind: 'agent', id: 'ses_1' }))).toBe('rejected');
    expect(
      gateVerdict(GATE, resolved({ kind: 'lesson_binding' }, { kind: 'human', id: 'usr_ceo' })),
    ).toBeNull();
    expect(
      gateVerdict(GATE, { ...resolved({}, { kind: 'human', id: 'u' }), type: 'decision.requested' }),
    ).toBeNull();
  });
});
