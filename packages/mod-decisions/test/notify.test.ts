import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecisionWebhookPayload } from '@aoc/contracts';
import { captureNotifications, decisionInput, harness, human, memoryLogger, type Harness } from './helpers';

const HOOK = 'https://hooks.example.test/aoc';
const SECRET = 'SECRET-PDPA';

let h: Harness | undefined;
afterEach(async () => {
  await h?.t.close();
  h = undefined;
  vi.restoreAllMocks();
});

const okFetch = () =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 204 }));
const bodyOf = (call: unknown[]) =>
  JSON.parse((call[1] as RequestInit).body as string) as DecisionWebhookPayload;

/** A card whose free text all carries a marker that must never leave the box. */
const secretInput = (requesterId: string) =>
  decisionInput({
    kind: 'go_live',
    requesterId,
    title: `${SECRET} title`,
    question: `${SECRET} question about Jane's account`,
    options: [
      { id: 'approve', label: `${SECRET} approve`, description: `${SECRET} description` },
      { id: 'reject', label: `${SECRET} reject` },
    ],
    recommendation: { optionId: 'approve', rationale: `${SECRET} rationale` },
    context: `${SECRET} context`,
  });

describe('decision.new notifications', () => {
  it('notify the roles that can act, once, with no decision text', async () => {
    const { t, engine, mod, builderA, requester } = (h = await harness());
    const toApprover = captureNotifications(t, 'approver');
    const toBuilder = captureNotifications(t, 'builder');
    const toRequester = captureNotifications(t, 'requester');

    const gate = engine.request(secretInput(builderA.user.id), human(builderA));
    const triage = engine.request(
      decisionInput({ kind: 'triage_reconciliation', requesterId: builderA.user.id }),
      human(builderA),
    );
    engine.request(
      decisionInput({
        kind: 'uat_signoff',
        requesterId: requester.user.id,
        subjectType: 'ticket',
        subjectId: 'tkt_1',
      }),
      human(builderA),
    );
    await t.drain();

    expect(toApprover.map((n) => [n.kind, n.refs?.decisionId])).toEqual([
      ['decision.new', gate.id],
      ['decision.new', triage.id],
    ]);
    expect(toBuilder.map((n) => n.refs?.decisionId)).toEqual([triage.id]);
    expect(toRequester).toEqual([]);
    expect(toApprover[0]).toMatchObject({
      title: 'Decision needed: Go-live',
      audience: ['approver'],
      severity: 'warn',
      link: `/decisions/${gate.id}`,
      refs: { decisionId: gate.id, kind: 'go_live', sessionId: 'ses_1', projectId: 'prj_1' },
    });
    expect(toApprover[1]).toMatchObject({ audience: ['builder', 'approver'], severity: 'info' });
    expect(JSON.stringify(toApprover)).not.toContain(SECRET);

    // At-least-once delivery: a replayed reaction does not notify again.
    const ev = t.rt.store.list({ types: ['decision.requested'], decisionId: gate.id })[0]!;
    await mod.reactors![0]!.react(ev, t.rt.store.readPayload(ev), t.rt.ctx);
    expect(toApprover).toHaveLength(2);
  });

  it('name the test a guard-raised card tripped, as the card of an agent decision does', async () => {
    const { t, engine } = (h = await harness());
    const toApprover = captureNotifications(t, 'approver');
    const agent = { kind: 'agent' as const, id: 'ses_1' };
    const raise = (kind: 'protected_operation' | 'agent_decision', test: 'main' | 'data') =>
      engine.request(decisionInput({ kind, test, requesterId: 'session:ses_1' }), agent);
    raise('protected_operation', 'main');
    raise('agent_decision', 'data');
    await t.drain();
    expect(toApprover.map((n) => n.title)).toEqual([
      'Decision needed: Protected operation — Touches main / protected branch',
      'Decision needed: Agent decision — Touches data (migrations, deletes, PII)',
    ]);
  });

  it('skip cards already closed when the reaction runs (policy auto-grant)', async () => {
    const { t, engine, builderA } = (h = await harness());
    const toApprover = captureNotifications(t, 'approver');
    const policy = { kind: 'system' as const, id: 'policy:credits' };
    const card = engine.request(
      decisionInput({ kind: 'credit_topup', requesterId: builderA.user.id }),
      policy,
    );
    engine.resolveByPolicy(card.id, 'approve', policy);
    await t.drain();
    expect(toApprover).toEqual([]);
  });

  it('tell the Approvers when a card is escalated to them', async () => {
    const { t, engine, builderA, builderB } = (h = await harness());
    const toApprover = captureNotifications(t, 'approver');
    const toBuilder = captureNotifications(t, 'builder');
    const card = engine.request(
      decisionInput({ kind: 'low_confidence_diagnosis', requesterId: builderA.user.id }),
      human(builderA),
    );
    await t.drain();
    engine.escalate(card.id, { reason: 'needs_ceo' }, human(builderB));
    await t.drain();
    expect(toApprover.map((n) => n.title)).toEqual([
      'Decision needed: Low-confidence diagnosis',
      'Decision escalated: Low-confidence diagnosis',
    ]);
    expect(toBuilder).toHaveLength(1);
  });
});

describe('opt-in webhook', () => {
  it('posts ids, kind and age only — never decision text (PDPA)', async () => {
    const fetchImpl = okFetch();
    const { t, engine, builderA } = (h = await harness({
      module: { fetchImpl },
      config: { decisions: { webhookUrl: HOOK } },
    }));
    const card = engine.request(secretInput(builderA.user.id), human(builderA));
    await engine.resolve(
      engine.request(decisionInput({ kind: 'fix_plan', requesterId: builderA.user.id }), human(builderA)).id,
      { optionId: 'approve', comment: `${SECRET} comment` },
      h.approver.user,
    );
    await t.drain();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(HOOK);
    expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' } });
    expect(String(init!.body)).not.toContain(SECRET);
    const body = bodyOf(fetchImpl.mock.calls[0]!);
    expect(Object.keys(body).sort()).toEqual(
      [
        'ageMs',
        'createdAt',
        'decisionId',
        'kind',
        'link',
        'projectId',
        'reminder',
        'requiredRole',
        'requiresPasskey',
        'sentAt',
        'sessionId',
        'type',
      ].sort(),
    );
    expect(body).toEqual({
      type: 'decision.new',
      decisionId: card.id,
      kind: 'go_live',
      requiredRole: 'approver',
      requiresPasskey: true,
      sessionId: 'ses_1',
      projectId: 'prj_1',
      createdAt: card.createdAt,
      ageMs: 0,
      reminder: 0,
      link: `http://localhost:7420/decisions/${card.id}`,
      sentAt: t.clock.iso(),
    });

    t.clock.advance(31 * 60_000);
    await t.rt.runJob('decisions.aging');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    const aging = bodyOf(fetchImpl.mock.calls[1]!);
    expect(aging).toMatchObject({
      type: 'decision.aging',
      decisionId: card.id,
      reminder: 1,
      ageMs: 31 * 60_000,
    });
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain(SECRET);
  });

  it('is off without a URL and never blocks or throws when the receiver hangs or fails', async () => {
    const quiet = okFetch();
    const off = (h = await harness({ module: { fetchImpl: quiet } }));
    off.engine.request(
      decisionInput({ kind: 'go_live', requesterId: off.builderA.user.id }),
      human(off.builderA),
    );
    await off.t.drain();
    expect(quiet).not.toHaveBeenCalled();
    await off.t.close();

    const log = memoryLogger();
    const hanging = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    const slow = (h = await harness({
      module: { fetchImpl: hanging, webhookTimeoutMs: 20 },
      config: { decisions: { webhookUrl: HOOK } },
      log,
    }));
    const toApprover = captureNotifications(slow.t, 'approver');
    slow.engine.request(
      decisionInput({ kind: 'go_live', requesterId: slow.builderA.user.id }),
      human(slow.builderA),
    );
    await slow.t.drain(); // returns while the webhook is still in flight
    expect(toApprover).toHaveLength(1);
    await vi.waitFor(() =>
      expect(log.warns).toContainEqual(
        expect.objectContaining({
          msg: 'decision webhook failed',
          fields: expect.objectContaining({ reason: 'timeout' }),
        }),
      ),
    );
    await slow.t.close();

    const broken = vi.fn(() => {
      throw new Error('ECONNREFUSED');
    });
    const failing = (h = await harness({
      module: { fetchImpl: broken },
      config: { decisions: { webhookUrl: HOOK } },
      log,
    }));
    failing.engine.request(
      decisionInput({ kind: 'go_live', requesterId: failing.builderA.user.id }),
      human(failing.builderA),
    );
    await failing.t.drain();
    await vi.waitFor(() =>
      expect(log.warns.filter((w) => w.msg === 'decision webhook failed')).toHaveLength(2),
    );
    const failures = failing.t.rt.store.db.prepare('SELECT COUNT(*) AS n FROM reactor_failures').get() as {
      n: number;
    };
    expect(failures.n).toBe(0);
  });
});

describe('aging reminders (R15)', () => {
  it('fire once per elapsed multiple of remindAfterMinutes while the card stays open', async () => {
    const { t, engine, approver, builderA } = (h = await harness({
      config: { decisions: { remindAfterMinutes: 30 } },
    }));
    const toApprover = captureNotifications(t, 'approver');
    const aging = () => toApprover.filter((n) => n.kind === 'decision.aging');
    const at = async (minutes: number) => {
      t.clock.set(Date.parse(card.createdAt) + minutes * 60_000);
      await t.rt.runJob('decisions.aging');
      return aging().length;
    };
    const card = engine.request(
      decisionInput({ kind: 'go_live', requesterId: builderA.user.id }),
      human(builderA),
    );
    await t.drain();

    expect(await at(29)).toBe(0);
    expect(await at(30)).toBe(1);
    expect(aging()[0]).toMatchObject({
      title: 'Waiting 30m: Go-live',
      severity: 'warn',
      refs: { decisionId: card.id },
    });
    expect(await at(45)).toBe(1);
    expect(await at(60)).toBe(2);
    expect(aging()[1]?.title).toBe('Waiting 1h: Go-live');
    expect(await at(60)).toBe(2);
    expect(await at(125)).toBe(3); // missed multiples are not replayed as a burst
    expect(aging()[2]?.title).toBe('Waiting 2h 5m: Go-live');

    await engine.resolve(card.id, { optionId: 'approve', passkeyAssertion: {} }, approver.user);
    expect(await at(240)).toBe(3);
  });

  it('run every minute from the scheduler, flag overdue cards and leave UAT to the portal', async () => {
    const { t, engine, builderA, requester } = (h = await harness());
    const toApprover = captureNotifications(t, 'approver');
    const toBuilder = captureNotifications(t, 'builder');
    const due = new Date(t.clock.now() + 10 * 60_000).toISOString();
    engine.request(
      decisionInput({ kind: 'triage_reconciliation', requesterId: builderA.user.id, dueAt: due }),
      human(builderA),
    );
    engine.request(
      decisionInput({
        kind: 'uat_signoff',
        requesterId: requester.user.id,
        subjectType: 'ticket',
        subjectId: 'tkt_1',
      }),
      human(builderA),
    );
    await t.drain();
    expect(await t.rt.tickJobs()).toEqual(['decisions.aging']);
    expect(await t.rt.tickJobs()).toEqual([]);
    t.clock.advance(30 * 60_000); // default remindAfterMinutes
    expect(await t.rt.tickJobs()).toEqual(['decisions.aging']);
    const reminders = toBuilder.filter((n) => n.kind === 'decision.aging');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({ severity: 'danger', audience: ['builder', 'approver'] });
    expect(toApprover.filter((n) => n.kind === 'decision.aging')).toHaveLength(1);
  });

  it('never repeat a reminder when the interval grows (config change on restart)', async () => {
    const { t, engine, builderA } = (h = await harness({
      config: { decisions: { remindAfterMinutes: 30 } },
    }));
    const toApprover = captureNotifications(t, 'approver');
    const card = engine.request(
      decisionInput({ kind: 'go_live', requesterId: builderA.user.id }),
      human(builderA),
    );
    const at = async (minutes: number) => {
      t.clock.set(Date.parse(card.createdAt) + minutes * 60_000);
      await t.rt.runJob('decisions.aging');
      return toApprover.filter((n) => n.kind === 'decision.aging').length;
    };
    expect(await at(90)).toBe(1); // third multiple of 30m
    t.config.decisions.remindAfterMinutes = 60;
    expect(await at(100)).toBe(1); // first multiple of 60m is older than what was already sent
    expect(await at(240)).toBe(2);
  });

  it('survive a projection rebuild without re-notifying', async () => {
    const { t, engine, builderA } = (h = await harness());
    const toApprover = captureNotifications(t, 'approver');
    engine.request(decisionInput({ kind: 'go_live', requesterId: builderA.user.id }), human(builderA));
    await t.drain();
    t.clock.advance(30 * 60_000);
    await t.rt.runJob('decisions.aging');
    t.rt.store.rebuildProjections(['decisions']);
    await t.rt.runJob('decisions.aging');
    expect(toApprover.map((n) => n.kind)).toEqual(['decision.new', 'decision.aging']);
  });
});
