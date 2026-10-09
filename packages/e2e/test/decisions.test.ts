/**
 * (c) A protected operation attempted through Bash becomes a decision card; (d) agent-raised decisions through the
 * MCP server, with the §6 routing (owner answers Builder-level tests, the Approver answers main/production/data).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DecisionCardView, DecisionListResponse, SessionDetail } from '@aoc/contracts';
import { ClaudeSession, denyReason } from './claude';
import { Harness, waitFor } from './harness';

let h: Harness;
beforeAll(async () => {
  h = await Harness.start();
});
afterAll(async () => {
  await h?.close();
});

const PLAN = { phases: [{ id: 'p1', name: 'Ship', tasks: [{ id: 't1', title: 'Ship it', size: 's' }] }] };

describe('(c) protected operation', () => {
  it('git push origin main → deny relayed by the hook → decision card (mod-change protected-op guard) → Waiting on you → resolved by the Approver', async () => {
    const owner = await h.user('builder', 'Dev');
    const ceo = await h.user('approver', 'CEO');
    const { projectId } = await h.project(owner, 'Push');
    const s = await h.launch(owner, { projectId });
    const claude = new ClaudeSession(h, s);
    claude.startSidecar();
    await claude.start();
    await claude.aoc('declare_plan', PLAN);
    const detail = () => h.api<SessionDetail>('GET', `/api/sessions/${s.sessionId}`, { as: ceo });
    await waitFor(async () => (await detail()).liveness?.state === 'thinking', { what: 'Thinking' });

    const push = await claude.bash('git push origin main');
    // JSON deny (exit 0): Claude reads the reason as the tool result and ends its turn.
    expect(push.decision).toBe('deny');
    expect(push.pre.code).toBe(0);
    expect(denyReason(push.pre)).toMatch(/END YOUR TURN/);

    const denied = h.events({ types: ['tool.denied'], sessionId: s.sessionId });
    expect(denied).toHaveLength(1);
    const decisionId = denied[0]!.meta.decisionId as string;
    expect(denied[0]!.meta).toMatchObject({ toolName: 'Bash', guard: 'protected-op', decision: 'deny' });
    expect(denyReason(push.pre)).toContain(decisionId);
    expect(h.events({ types: ['session.blocked'], sessionId: s.sessionId }).map((e) => e.meta.reason)).toEqual(['protected_operation']);

    const card = await h.api<DecisionCardView>('GET', `/api/decisions/${decisionId}`, { as: ceo });
    // mod-change raises guard cards as agent_decision (test main); the domain also defines protected_operation.
    expect(card).toMatchObject({
      kind: 'agent_decision',
      status: 'open',
      test: 'main',
      title: 'Protected operation: git push to main',
      context: 'git push origin main',
      requiredRole: 'approver',
      sessionId: s.sessionId,
      projectId,
      requesterId: `session:${s.sessionId}`,
      viewer: { canResolve: true },
    });

    await waitFor(async () => (await detail()).liveness?.state === 'waiting_on_you', { what: 'Waiting on you' });
    const d = await detail();
    expect(d.openDecision).toMatchObject({ decisionId, kind: 'agent_decision' });
    const consoleView = await h.api<{ kpis: { waitingOnYou: number } }>('GET', '/api/console', { as: ceo });
    expect(consoleView.kpis.waitingOnYou).toBeGreaterThanOrEqual(1);
    expect((await h.api<{ resolvableByMe: number }>('GET', '/api/decisions/summary', { as: ceo })).resolvableByMe).toBeGreaterThanOrEqual(1);

    // The turn ends cleanly; waiting costs nothing (§2.3).
    await claude.hook('Stop', { stop_hook_active: false, last_assistant_message: 'Waiting for the push decision.' });

    // main bounces to the Approver: the owner (a Builder) cannot answer it.
    const refused = await h.request('POST', `/api/decisions/${decisionId}/resolve`, { as: owner, body: { optionId: 'approve' } });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('role');

    const resolved = await h.api<DecisionCardView>('POST', `/api/decisions/${decisionId}/resolve`, { as: ceo, body: { optionId: 'approve', comment: 'Release window is open.' } });
    expect(resolved).toMatchObject({ status: 'resolved', resolution: { optionId: 'approve', resolvedBy: ceo.user.id, method: 'button', selfApproved: false } });
    const r = h.events({ types: ['decision.resolved'], decisionId })[0]!;
    expect(r.meta).toMatchObject({ kind: 'agent_decision', optionId: 'approve', resolvedBy: ceo.user.id });
    await waitFor(async () => (await detail()).liveness?.state !== 'waiting_on_you', { what: 'no longer waiting once answered' });
    expect((await detail()).openDecision).toBeNull();

    await claude.close();
    expect(h.store.verifyChain().ok).toBe(true);
  });
});

describe('(d) agent decisions via MCP request_decision', () => {
  it('END-TURN instruction; the session is the requester; the owner answers ambiguity, only the Approver answers main', async () => {
    const owner = await h.user('builder', 'Owner');
    const otherBuilder = await h.user('builder', 'Peer');
    const ceo = await h.user('approver', 'CEO');
    const { projectId } = await h.project(owner, 'Decide');
    const s = await h.launch(owner, { projectId });
    const claude = new ClaudeSession(h, s);
    await claude.start();
    await claude.aoc('declare_plan', PLAN);

    const ambiguity = {
      test: 'ambiguity',
      question: 'Should rejected claims be kept for the audit trail?',
      options: [
        { id: 'keep', label: 'Keep them' },
        { id: 'drop', label: 'Drop them' },
      ],
      recommendation: { option_id: 'keep', rationale: 'Auditors ask for rejected claims.' },
    };
    const amb = await claude.aoc('request_decision', ambiguity);
    expect(amb.isError).toBe(false);
    expect(amb.data).toMatchObject({ ok: true });
    const ambId = amb.data.decision_id as string;
    expect(amb.data.instruction).toMatch(/END YOUR TURN/);
    // The MCP server appends its own unmissable instruction to the tool text.
    expect(amb.text).toMatch(/END YOUR TURN NOW\. The supervisor will resume this session/);
    // A retried call does not raise a duplicate card.
    expect((await claude.aoc('request_decision', ambiguity)).data.decision_id).toBe(ambId);

    const main = await claude.aoc('request_decision', {
      test: 'main',
      question: 'Merge the parser branch into main now?',
      options: [
        { id: 'merge', label: 'Merge' },
        { id: 'wait', label: 'Wait for review' },
      ],
      recommendation: { option_id: 'wait', rationale: 'A second review is due.' },
    });
    const mainId = main.data.decision_id as string;

    const list = await h.api<DecisionListResponse>('GET', `/api/decisions?sessionId=${s.sessionId}`, { as: owner });
    expect(list.decisions.map((c) => c.id).sort()).toEqual([ambId, mainId].sort());
    const ambCard = list.decisions.find((c) => c.id === ambId)!;
    const mainCard = list.decisions.find((c) => c.id === mainId)!;
    expect(ambCard).toMatchObject({ kind: 'agent_decision', test: 'ambiguity', requiredRole: 'builder', requesterId: `session:${s.sessionId}`, sessionId: s.sessionId, viewer: { canResolve: true } });
    expect(mainCard).toMatchObject({ kind: 'agent_decision', test: 'main', requiredRole: 'approver', requesterId: `session:${s.sessionId}`, viewer: { canResolve: false, reason: 'role' } });
    expect(h.events({ types: ['decision.requested'], sessionId: s.sessionId }).map((e) => [e.actor.kind, e.source])).toEqual([
      ['agent', 'mcp'],
      ['agent', 'mcp'],
    ]);
    const detail = () => h.api<SessionDetail>('GET', `/api/sessions/${s.sessionId}`, { as: owner });
    await waitFor(async () => (await detail()).liveness?.state === 'waiting_on_you', { what: 'Waiting on you' });

    // The owner may answer their session's Builder-level question (recorded as self-approval) …
    const answered = await h.api<DecisionCardView>('POST', `/api/decisions/${ambId}/resolve`, { as: owner, body: { optionId: 'keep' } });
    expect(answered.resolution).toMatchObject({ optionId: 'keep', resolvedBy: owner.user.id, selfApproved: true });
    // … but not the main one; nor may another Builder.
    for (const who of [owner, otherBuilder]) {
      const res = await h.request('POST', `/api/decisions/${mainId}/resolve`, { as: who, body: { optionId: 'merge' } });
      expect(res.status).toBe(403);
    }
    const approved = await h.api<DecisionCardView>('POST', `/api/decisions/${mainId}/resolve`, { as: ceo, body: { optionId: 'wait' } });
    expect(approved.resolution).toMatchObject({ optionId: 'wait', resolvedBy: ceo.user.id, selfApproved: false });

    await waitFor(async () => (await detail()).openDecision === null, { what: 'no open decision' });
    const status = await claude.aoc('get_status', {});
    expect(status.data.openDecisions).toEqual([]);
    await claude.close();
    expect(h.store.verifyChain().ok).toBe(true);
  });
});
