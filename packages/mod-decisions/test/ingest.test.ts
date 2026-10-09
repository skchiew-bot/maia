import { afterEach, describe, expect, it } from 'vitest';
import {
  INGEST_PATHS,
  type McpIngestRequest,
  type RequestDecisionInput,
  type RequestDecisionResult,
} from '@aoc/contracts';
import { harness, type Harness } from './helpers';

const PATH = INGEST_PATHS.mcp('request_decision');

let h: Harness | undefined;
afterEach(async () => {
  await h?.t.close();
  h = undefined;
});

const input = (over: Partial<RequestDecisionInput> = {}): RequestDecisionInput => ({
  test: 'main',
  question: 'Push the migration fix straight to main?',
  options: [
    { id: 'push', label: 'Push to main' },
    { id: 'hold', label: 'Open a PR instead', description: 'Safer; waits for review' },
  ],
  recommendation: { option_id: 'hold', rationale: 'CI on main is red' },
  context: 'Branch fix/migration is 2 commits ahead.',
  ...over,
});

async function setup() {
  const hx = (h = await harness());
  hx.t.sessions!.add({ sessionId: 'ses_1', ownerId: hx.builderA.user.id, projectId: 'prj_1' });
  return hx;
}

describe('POST /ingest/mcp/request_decision', () => {
  it('raises an agent decision for the session owner and tells the agent to end its turn', async () => {
    const { t, engine, builderA, approver } = await setup();
    const body: McpIngestRequest<RequestDecisionInput> = { sessionId: 'ses_1', input: input() };
    const res = await t.json<RequestDecisionResult>('POST', PATH, {
      headers: t.ingestHeaders('ses_1'),
      body,
    });
    expect(res.ok).toBe(true);
    expect(res.instruction).toMatch(/END YOUR TURN NOW/);
    expect(res.instruction).toContain(res.decision_id);

    const card = engine.get(res.decision_id)!;
    expect(card).toMatchObject({
      kind: 'agent_decision',
      test: 'main',
      status: 'open',
      title: 'Touches main / protected branch',
      question: 'Push the migration fix straight to main?',
      options: input().options,
      recommendation: { optionId: 'hold', rationale: 'CI on main is red' },
      context: 'Branch fix/migration is 2 commits ahead.',
      requiredRole: 'approver',
      requiresPasskey: false,
      // The agent is the requester, so the owner is not excluded by separation of duties.
      requesterId: 'session:ses_1',
      excludedApproverIds: ['session:ses_1'],
      subjectType: 'session',
      subjectId: 'ses_1',
      sessionId: 'ses_1',
      projectId: 'prj_1',
    });
    const [ev] = t.rt.store.list({ types: ['decision.requested'] });
    expect(ev).toMatchObject({
      actor: { kind: 'agent', id: 'ses_1' },
      source: 'mcp',
      scope: { sessionId: 'ses_1', projectId: 'prj_1', decisionId: card.id },
    });
    expect(engine.canResolve(card, builderA.user).reason).toBe('role') // main bounces to the Approver; the owner is not SoD-excluded from their agent's cards;
    expect(engine.canResolve(card, approver.user).ok).toBe(true);

    // Self-reported tests stay with Builders.
    const ambiguity = await t.json<RequestDecisionResult>('POST', PATH, {
      headers: t.ingestHeaders('ses_1'),
      body: {
        sessionId: 'ses_1',
        input: input({ test: 'ambiguity', question: 'Which date format does the spec mean?' }),
      },
    });
    expect(engine.get(ambiguity.decision_id)?.requiredRole).toBe('builder');
  });

  it('returns the same open card for a retried identical request', async () => {
    const { t, engine } = await setup();
    const send = () =>
      t.json<RequestDecisionResult>('POST', PATH, {
        headers: t.ingestHeaders('ses_1'),
        body: { sessionId: 'ses_1', input: input() },
      });
    const first = await send();
    const retry = await send();
    expect(retry.decision_id).toBe(first.decision_id);
    expect(t.rt.store.list({ types: ['decision.requested'] })).toHaveLength(1);

    // Once answered, asking again is a new decision.
    engine.withdraw(first.decision_id, 'superseded', { kind: 'system', id: 'supervisor' });
    const again = await send();
    expect(again.decision_id).not.toBe(first.decision_id);
  });

  it('validates the input against the MCP schema (422 with issues)', async () => {
    const { t } = await setup();
    const post = (body: unknown) => t.request('POST', PATH, { headers: t.ingestHeaders('ses_1'), body });
    const issues = async (body: unknown) => {
      const res = await post(body);
      expect(res.status).toBe(422);
      return ((await res.json()) as { error: { details: { path: string }[] } }).error.details.map(
        (d) => d.path,
      );
    };
    expect(
      await issues({
        sessionId: 'ses_1',
        input: input({ question: 'Hm?', options: [{ id: 'only', label: 'Only' }] }),
      }),
    ).toEqual(expect.arrayContaining(['input.question', 'input.options']));
    expect(await issues({ sessionId: 'ses_1', input: { ...input(), test: 'vibes' } })).toEqual([
      'input.test',
    ]);
    expect(
      await issues({
        sessionId: 'ses_1',
        input: input({ recommendation: { option_id: 'merge', rationale: 'because' } }),
      }),
    ).toEqual(['input.recommendation.option_id']);
    expect(
      await issues({
        sessionId: 'ses_1',
        input: input({
          options: [
            { id: 'a', label: 'A' },
            { id: 'a', label: 'B' },
          ],
          recommendation: { option_id: 'a', rationale: 'fine' },
        }),
      }),
    ).toEqual(['input.options']);
    expect(await issues({ input: input() })).toEqual(['sessionId']);
    expect(
      (
        await t.request('POST', PATH, {
          headers: { ...t.ingestHeaders('ses_1'), 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(400);
    expect(t.rt.store.list({ types: ['decision.requested'] })).toHaveLength(0);
  });

  it('authenticates the session token and knows its sessions', async () => {
    const { t, approver } = await setup();
    const body = (sessionId: string) => ({ sessionId, input: input() });
    expect((await t.request('POST', PATH, { body: body('ses_1') })).status).toBe(401);
    expect((await t.request('POST', PATH, { headers: approver.headers, body: body('ses_1') })).status).toBe(
      401,
    );
    expect(
      (await t.request('POST', PATH, { headers: t.ingestHeaders('observer'), body: body('ses_1') })).status,
    ).toBe(403);
    expect(
      (await t.request('POST', PATH, { headers: t.ingestHeaders('system'), body: body('ses_1') })).status,
    ).toBe(403);
    expect(
      (await t.request('POST', PATH, { headers: t.ingestHeaders('ses_other'), body: body('ses_1') })).status,
    ).toBe(403);
    const unknown = await t.request('POST', PATH, {
      headers: t.ingestHeaders('ses_ghost'),
      body: body('ses_ghost'),
    });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe('unknown_session');
    expect(t.rt.store.list({ types: ['decision.requested'] })).toHaveLength(0);
  });

  it('makes the session the requester even when no owner is mapped', async () => {
    const { t, engine, builderA } = await setup();
    t.sessions!.add({ sessionId: 'ses_orphan', ownerId: null, projectId: null });
    const res = await t.json<RequestDecisionResult>('POST', PATH, {
      headers: t.ingestHeaders('ses_orphan'),
      body: { sessionId: 'ses_orphan', input: input({ test: 'ambiguity' }) },
    });
    const card = engine.get(res.decision_id)!;
    expect(card).toMatchObject({
      requesterId: 'session:ses_orphan',
      excludedApproverIds: ['session:ses_orphan'],
      projectId: null,
      requiredRole: 'builder',
    });
    expect(engine.canResolve(card, builderA.user).ok).toBe(true);
  });

  it("lets the owner answer their own agent's Builder-level question, recorded as self-approval", async () => {
    const { t, engine, builderA } = await setup();
    const res = await t.json<RequestDecisionResult>('POST', PATH, {
      headers: t.ingestHeaders('ses_1'),
      body: { sessionId: 'ses_1', input: input({ test: 'ambiguity' }) },
    });
    expect(engine.canResolve(engine.get(res.decision_id)!, builderA.user).ok).toBe(true);
    const done = await engine.resolve(res.decision_id, { optionId: engine.get(res.decision_id)!.options[0]!.id }, builderA.user);
    expect(done.resolution?.selfApproved).toBe(true);
  });
});
