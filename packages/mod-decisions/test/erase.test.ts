import { afterEach, describe, expect, it } from 'vitest';
import type { DecisionCardView } from '@aoc/contracts';
import { ERASED } from '../src';
import { decisionInput, harness, human, type Harness } from './helpers';

let h: Harness | undefined;
afterEach(async () => {
  await h?.t.close();
  h = undefined;
});

const shred = (hx: Harness, scopeId: string) =>
  hx.t.rt.store.eraseScope(scopeId, {
    actor: { kind: 'human', id: hx.approver.user.id },
    reason: 'pdpa_request',
  });

describe('crypto-shred (§13)', () => {
  it('degrades erased cards to "[erased]" from ids in meta — live scrub and rebuild agree', async () => {
    const hx = (h = await harness());
    const { t, engine, approver, builderA } = hx;
    const resolved = engine.request(
      decisionInput({
        kind: 'fix_plan',
        requesterId: builderA.user.id,
        sessionId: 'ses_pii',
        context: 'Customer Jane Doe, IC 900101-14-5555',
      }),
      human(builderA),
    );
    await engine.resolve(resolved.id, { optionId: 'reject', comment: 'Call Jane back first' }, approver.user);
    const withdrawn = engine.request(
      decisionInput({ kind: 'fix_plan', requesterId: builderA.user.id, sessionId: 'ses_pii' }),
      human(builderA),
    );
    engine.withdraw(withdrawn.id, 'superseded', human(builderA), 'Jane withdrew the request');
    const open = engine.request(
      decisionInput({
        kind: 'go_live',
        requesterId: builderA.user.id,
        sessionId: 'ses_pii',
        recommendation: null,
      }),
      human(builderA),
    );
    const untouched = engine.request(
      decisionInput({ kind: 'fix_plan', requesterId: builderA.user.id, sessionId: 'ses_other' }),
      human(builderA),
    );

    shred(hx, 'ses_pii');
    const live = [resolved.id, withdrawn.id, open.id].map((id) => engine.get(id)!);
    expect(live[0]).toMatchObject({
      title: ERASED,
      question: ERASED,
      context: ERASED,
      options: [
        { id: 'approve', label: ERASED },
        { id: 'reject', label: ERASED },
      ],
      recommendation: { optionId: 'approve', rationale: ERASED },
      status: 'resolved',
      requesterId: builderA.user.id,
      resolution: { optionId: 'reject', resolvedBy: approver.user.id, comment: ERASED },
    });
    expect(live[0]!.options[0]).not.toHaveProperty('description');
    expect(engine.record(withdrawn.id)?.withdrawal?.note).toBe(ERASED);
    expect(live[2]).toMatchObject({
      title: ERASED,
      recommendation: null,
      status: 'open',
      requiredRole: 'approver',
      requiresPasskey: true,
    });
    expect(engine.get(untouched.id)).toMatchObject({ title: 'Ship it?', question: 'Promote build 42?' });

    t.rt.store.rebuildProjections(['decisions']);
    expect([resolved.id, withdrawn.id, open.id].map((id) => engine.get(id))).toEqual(live);
    expect(engine.record(withdrawn.id)?.withdrawal?.note).toBe(ERASED);
    expect(engine.get(untouched.id)).toMatchObject({ title: 'Ship it?' });

    // Still governable: an erased open card resolves by option id; the API flags it.
    const view = await t.json<DecisionCardView>('POST', `/api/decisions/${open.id}/resolve`, {
      headers: approver.headers,
      body: { optionId: 'approve', passkeyAssertion: { id: 'cred' } },
    });
    expect(view).toMatchObject({
      erased: true,
      status: 'resolved',
      resolution: { optionId: 'approve', method: 'passkey' },
    });
    expect(JSON.stringify(engine.list())).not.toMatch(/Jane|900101/);
    expect(t.rt.store.verifyChain().ok).toBe(true);
  });

  it('keeps ticket decisions in the ticket’s body scope so erasing the ticket shreds them', async () => {
    const hx = (h = await harness());
    const { t, engine, builderA } = hx;
    const card = engine.request(
      decisionInput({
        kind: 'low_confidence_diagnosis',
        requesterId: builderA.user.id,
        sessionId: 'ses_triage',
        subjectType: 'ticket',
        subjectId: 'tkt_42',
        question: 'Is the export bug the same as Jane’s report?',
      }),
      human(builderA),
    );
    const [ev] = t.rt.store.list({ types: ['decision.requested'] });
    expect(ev).toMatchObject({
      bodyScope: 'tkt_42',
      scope: { ticketId: 'tkt_42', sessionId: 'ses_triage', decisionId: card.id },
    });
    shred(hx, 'ses_triage');
    expect(engine.get(card.id)?.question).toContain('Jane');
    shred(hx, 'tkt_42');
    expect(engine.get(card.id)?.question).toBe(ERASED);
  });

  it('keeps a card’s text in the body scope its requester names, resolution comment included', async () => {
    const hx = (h = await harness());
    const { t, engine, approver, builderA } = hx;
    const card = engine.request(
      decisionInput({
        kind: 'change_request',
        changeScope: 'main',
        requesterId: builderA.user.id,
        sessionId: 'ses_fix',
        subjectType: 'change',
        subjectId: 'chg_7',
        question: 'Ship the fix for Jane’s export bug?',
        bodyScope: 'tkt_43',
      }),
      human(builderA),
    );
    await engine.resolve(card.id, { optionId: 'approve', comment: 'Tell Jane it is fixed' }, approver.user);
    const bodies = t.rt.store
      .list({ types: ['decision.requested', 'decision.resolved'] })
      .map((e) => e.bodyScope);
    expect(bodies).toEqual(['tkt_43', 'tkt_43']);
    shred(hx, 'ses_fix');
    expect(engine.get(card.id)?.question).toContain('Jane');
    shred(hx, 'tkt_43');
    expect(engine.get(card.id)).toMatchObject({ question: ERASED, resolution: { comment: ERASED } });
    expect(() =>
      engine.request(
        decisionInput({ kind: 'fix_plan', requesterId: builderA.user.id, bodyScope: 'not a scope' }),
        human(builderA),
      ),
    ).toThrow(/Invalid decision request/);
  });
});
