import { afterEach, describe, expect, it } from 'vitest';
import type {
  AnchorListDTO,
  AuditEventDetailDTO,
  AuditEventPageDTO,
  AuditHealthDTO,
  EraseResultDTO,
  ErasureReason,
  ErasureRequestDTO,
  VerifyReportDTO,
} from '@aoc/contracts';
import { payloadAccess } from '../src';
import { auditRuntime, nudge, type AuditTest } from './helpers';

let a: AuditTest | null = null;
afterEach(async () => {
  await a?.t.close();
  a = null;
});

/** The Builder asks to erase `scopeIds` and the Approver approves: the decision id an erasure needs (O-28). */
async function approvedErasure(at: AuditTest, scopeIds: string[], reason: ErasureReason = 'pdpa_request'): Promise<string> {
  const req = await at.t.json<ErasureRequestDTO>('POST', '/api/audit/erasure-requests', {
    headers: at.builder.headers,
    body: { scopeIds, reason, rationale: 'The data subject asked by email on 2026-10-01' },
    expect: 201,
  });
  await at.t.decisions!.resolve(req.decisionId, { optionId: 'approve' }, at.approver.user);
  return req.decisionId;
}

describe('permissions', () => {
  const routes: {
    method: string;
    path: string;
    perm: 'audit.view' | 'audit.verify' | 'audit.erase' | 'audit.erase_request';
    body?: unknown;
    /** The status a permitted caller gets (the erase body names no approved request). */
    ok?: number;
  }[] = [
    { method: 'GET', path: '/api/audit/events', perm: 'audit.view' },
    { method: 'GET', path: '/api/audit/events/1', perm: 'audit.view' },
    { method: 'GET', path: '/api/audit/anchors', perm: 'audit.view' },
    { method: 'GET', path: '/api/audit/health', perm: 'audit.view' },
    { method: 'GET', path: '/api/audit/verify', perm: 'audit.verify' },
    { method: 'POST', path: '/api/audit/anchor', perm: 'audit.verify' },
    {
      method: 'POST',
      path: '/api/audit/erase',
      perm: 'audit.erase',
      body: { scopeId: 'ses_nobody', decisionId: 'dec_nope' },
      ok: 422,
    },
    {
      method: 'POST',
      path: '/api/audit/erasure-requests',
      perm: 'audit.erase_request',
      body: { scopeIds: ['ses_nobody'], reason: 'retention', rationale: 'kept past its period' },
      ok: 201,
    },
  ];

  it.each(routes)('$method $path requires $perm', async ({ method, path, perm, body, ok = 200 }) => {
    a = await auditRuntime();
    const { t } = a;
    expect((await t.request(method, path, { body })).status).toBe(401);
    expect((await t.request(method, path, { headers: a.requester.headers, body })).status).toBe(403);
    const builder = await t.request(method, path, { headers: a.builder.headers, body });
    expect(builder.status).toBe(perm === 'audit.erase' ? 403 : ok);
    expect((await t.request(method, path, { headers: a.approver.headers, body })).status).toBe(ok);
  });
});

describe('audit read API', () => {
  it('lists headers only, with filters and pagination both ways', async () => {
    a = await auditRuntime();
    const { t } = a;
    const base = t.rt.store.head().seq;
    for (let i = 0; i < 5; i++) nudge(t, i % 2 ? 'ses_odd' : 'ses_even', `secret ${i}`);
    t.rt.store.append({
      type: 'session.restarted',
      actor: { kind: 'human', id: 'usr_x' },
      scope: { sessionId: 'ses_even', projectId: 'prj_1' },
      meta: { sessionId: 'ses_even' },
      source: 'api',
    });
    const h = a.builder.headers;

    const page1 = await t.json<AuditEventPageDTO>('GET', `/api/audit/events?fromSeq=${base + 1}&limit=2`, {
      headers: h,
    });
    expect(page1.events.map((e) => e.seq)).toEqual([base + 1, base + 2]);
    expect(page1.nextFromSeq).toBe(base + 3);
    expect(page1.nextToSeq).toBeNull();
    const row = page1.events[0]!;
    expect(row).toMatchObject({
      type: 'session.nudged',
      hasBody: true,
      scope: { sessionId: 'ses_even' },
      meta: { sessionId: 'ses_even' },
    });
    expect(row.payloadHashPrefix).toMatch(/^[0-9a-f]{16}$/);
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row).not.toHaveProperty('payload');
    expect(JSON.stringify(page1)).not.toContain('secret');

    const odd = await t.json<AuditEventPageDTO>('GET', '/api/audit/events?sessionId=ses_odd', { headers: h });
    expect(odd.events.map((e) => e.seq)).toEqual([base + 2, base + 4]);
    expect(
      (
        await t.json<AuditEventPageDTO>('GET', '/api/audit/events?projectId=prj_1', { headers: h })
      ).events.map((e) => e.type),
    ).toEqual(['session.restarted']);
    expect(
      (
        await t.json<AuditEventPageDTO>('GET', '/api/audit/events?type=session.restarted,user.created', {
          headers: h,
        })
      ).events.map((e) => e.type),
    ).toEqual(['user.created', 'user.created', 'user.created', 'session.restarted']);
    const prefixed = await t.json<AuditEventPageDTO>('GET', '/api/audit/events?typePrefix=session.', {
      headers: h,
    });
    expect(new Set(prefixed.events.map((e) => e.type))).toEqual(
      new Set(['session.nudged', 'session.restarted']),
    );

    const desc = await t.json<AuditEventPageDTO>('GET', '/api/audit/events?order=desc&limit=2', {
      headers: h,
    });
    expect(desc.events.map((e) => e.seq)).toEqual([desc.headSeq, desc.headSeq - 1]);
    expect(desc.nextToSeq).toBe(desc.headSeq - 2);
    expect((await t.request('GET', '/api/audit/events?limit=5000', { headers: h })).status).toBe(422);
    expect((await t.request('GET', '/api/audit/events?typePrefix=x%25', { headers: h })).status).toBe(422);
  });

  it('shows a body only to approvers, verifies it, and reports erased / missing bodies', async () => {
    a = await auditRuntime();
    const { t } = a;
    const e = nudge(t, 'ses_a', 'hello');
    const asBuilder = await t.json<AuditEventDetailDTO>('GET', `/api/audit/events/${e.seq}`, {
      headers: a.builder.headers,
    });
    expect(asBuilder).toMatchObject({
      seq: e.seq,
      body: 'present',
      erased: false,
      bodyVerified: true,
      payloadVisible: false,
      payloadWithheldReason: 'not_approver',
      payload: null,
      bodyScope: 'ses_a',
    });
    const asApprover = await t.json<AuditEventDetailDTO>('GET', `/api/audit/events/${e.seq}`, {
      headers: a.approver.headers,
    });
    expect(asApprover).toMatchObject({
      payloadVisible: true,
      payloadWithheldReason: null,
      payload: { text: 'hello' },
    });

    const ticket = t.rt.store.append({
      type: 'intake.submitted',
      actor: { kind: 'human', id: a.requester.user.id },
      scope: { ticketId: 'tkt_1' },
      meta: {
        ticketId: 'tkt_1',
        requesterId: a.requester.user.id,
        severity: 'high',
        attachmentCount: 0,
        attachmentHashes: [],
      },
      payload: { title: 'Broken', description: 'my phone is 012-3456789' },
      source: 'intake',
    });
    expect(
      (
        await t.json<AuditEventDetailDTO>('GET', `/api/audit/events/${ticket.seq}`, {
          headers: a.builder.headers,
        })
      ).payload,
    ).toBeNull();
    expect(
      (
        await t.json<AuditEventDetailDTO>('GET', `/api/audit/events/${ticket.seq}`, {
          headers: a.approver.headers,
        })
      ).payload,
    ).toMatchObject({ title: 'Broken' });

    await t.json('POST', '/api/audit/erase', {
      headers: a.approver.headers,
      body: { scopeId: 'ses_a', decisionId: await approvedErasure(a, ['ses_a']) },
    });
    expect(
      await t.json<AuditEventDetailDTO>('GET', `/api/audit/events/${e.seq}`, { headers: a.approver.headers }),
    ).toMatchObject({
      body: 'erased',
      erased: true,
      payload: null,
      payloadVisible: false,
      bodyVerified: null,
    });

    const lost = nudge(t, 'ses_b', 'x');
    t.rt.store.bodies.delete(lost.id);
    expect(
      await t.json<AuditEventDetailDTO>('GET', `/api/audit/events/${lost.seq}`, {
        headers: a.approver.headers,
      }),
    ).toMatchObject({ body: 'missing', erased: false });

    expect((await t.request('GET', '/api/audit/events/99999', { headers: a.builder.headers })).status).toBe(
      404,
    );
    expect((await t.request('GET', '/api/audit/events/abc', { headers: a.builder.headers })).status).toBe(
      422,
    );
  });

  it('withholds ticket bodies from viewers without ticket.media_view', () => {
    const e = { type: 'ticket.diagnosis_reported', bodyScope: 'tkt_9', scope: { ticketId: 'tkt_9' } };
    expect(payloadAccess(e, { role: 'approver', can: (p) => p !== 'ticket.media_view' })).toEqual({
      visible: false,
      reason: 'ticket_media',
    });
    expect(
      payloadAccess(
        { type: 'intake.attachment_stored', bodyScope: 'global', scope: {} },
        { role: 'approver', can: () => false },
      ),
    ).toEqual({ visible: false, reason: 'ticket_media' });
    expect(
      payloadAccess(
        { type: 'session.nudged', bodyScope: 'ses_1', scope: {} },
        { role: 'approver', can: () => false },
      ),
    ).toEqual({ visible: true, reason: null });
    expect(payloadAccess(e, { role: 'builder', can: () => true })).toEqual({
      visible: false,
      reason: 'not_approver',
    });
  });

  it('lists anchors and reports health: never anchored, fresh, stale (>26h), failures and job runs', async () => {
    a = await auditRuntime();
    const { t } = a;
    const h = a.builder.headers;
    let health = await t.json<AuditHealthDTO>('GET', '/api/audit/health', { headers: h });
    expect(health).toMatchObject({
      provider: 'git',
      offHost: false,
      lastAnchor: null,
      anchorStale: true,
      lastVerification: null,
    });
    expect(health.warnings).toEqual(expect.arrayContaining(['anchor_not_off_host', 'anchor_never']));

    await t.rt.runJob('audit.anchor');
    const anchors = await t.json<AnchorListDTO>('GET', '/api/audit/anchors', { headers: h });
    expect(anchors).toMatchObject({ provider: 'git', offHost: false });
    expect(anchors.anchors).toHaveLength(1);
    expect(anchors.anchors[0]).toMatchObject({ provider: 'git', signed: false, anchoredAt: t.clock.iso() });
    health = await t.json<AuditHealthDTO>('GET', '/api/audit/health', { headers: h });
    expect(health).toMatchObject({
      anchorStale: false,
      lastAnchor: { seq: anchors.anchors[0]!.seq, ageMs: 0 },
      lastVerification: { ok: true },
    });
    expect(health.jobs).toEqual([expect.objectContaining({ name: 'audit.anchor', lastStatus: 'ok' })]);
    expect(health.warnings).not.toContain('anchor_stale');

    t.clock.advance(27 * 3600_000);
    t.rt.store.db
      .prepare("INSERT INTO reactor_failures (reactor, seq, error, at) VALUES ('x.react', 1, 'boom', ?)")
      .run(t.clock.iso());
    t.rt.store.db
      .prepare(
        "INSERT INTO projection_health (name, status, last_error, failed_seq, updated_at) VALUES ('x', 'degraded', 'bug', 2, ?)",
      )
      .run(t.clock.iso());
    health = await t.json<AuditHealthDTO>('GET', '/api/audit/health', { headers: h });
    expect(health.anchorStale).toBe(true);
    expect(health.lastAnchor!.ageMs).toBe(27 * 3600_000);
    expect(health.reactorFailures).toEqual({
      total: 1,
      recent: [expect.objectContaining({ reactor: 'x.react', error: 'boom' })],
    });
    expect(health.warnings).toEqual(
      expect.arrayContaining(['anchor_stale', 'reactor_failures', 'projection_degraded']),
    );
  });

  it('with anchoring disabled: 409 on anchor, warnings on health and verify', async () => {
    a = await auditRuntime({ config: { audit: { anchorProvider: 'none' } } });
    const { t } = a;
    const res = await t.request('POST', '/api/audit/anchor', { headers: a.builder.headers });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('anchoring_disabled');
    expect(
      (await t.json<AuditHealthDTO>('GET', '/api/audit/health', { headers: a.builder.headers })).warnings,
    ).toContain('anchoring_disabled');
    const report = await t.json<VerifyReportDTO>('GET', '/api/audit/verify', { headers: a.builder.headers });
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual(
      expect.arrayContaining(['anchoring is disabled (audit.anchorProvider = none)']),
    );
  });
});

describe('erasure (crypto-shred)', () => {
  it('destroys the scope key: bodies gone, counts returned, chain and anchors still verify', async () => {
    a = await auditRuntime();
    const { t } = a;
    const p1 = nudge(t, 'ses_pdpa', 'my IC is 900101-14-5678');
    const p2 = nudge(t, 'ses_pdpa', 'call me at 012-3456789');
    const keep = nudge(t, 'ses_keep', 'keep me');
    await t.json('POST', '/api/audit/anchor', { headers: a.approver.headers });

    const decisionId = await approvedErasure(a, ['ses_pdpa']);
    expect(
      (
        await t.request('POST', '/api/audit/erase', {
          headers: a.builder.headers,
          body: { scopeId: 'ses_pdpa', decisionId },
        })
      ).status,
    ).toBe(403);
    const res = await t.json<EraseResultDTO>('POST', '/api/audit/erase', {
      headers: a.approver.headers,
      body: { scopeId: 'ses_pdpa', decisionId },
    });
    expect(res).toMatchObject({
      scopeId: 'ses_pdpa',
      reason: 'pdpa_request',
      bodiesErased: 2,
      eventsInScope: 2,
      decisionId,
    });
    const erased = t.rt.store.get(res.eventSeq)!;
    expect(erased.type).toBe('body.erased');
    expect(erased.meta).toEqual({
      scopeId: 'ses_pdpa',
      reason: 'pdpa_request',
      erasedBy: a.approver.user.id,
      bodyCount: 2,
      decisionId,
    });
    expect(erased.actor).toEqual({ kind: 'human', id: a.approver.user.id });

    expect(t.rt.store.readPayload(p1)).toBeNull();
    expect(t.rt.store.readPayload(p2)).toBeNull();
    expect(t.rt.store.readPayload(keep)).toEqual({ text: 'keep me' });
    expect(t.rt.store.get(p1.seq)!.payloadHash).toBe(p1.payloadHash);

    const report = await t.json<VerifyReportDTO>('GET', '/api/audit/verify', { headers: a.approver.headers });
    expect(report).toMatchObject({ ok: true, chainOk: true });
    expect(report.anchors[0]).toMatchObject({ matched: true, proofOk: true });

    const again = await t.json<EraseResultDTO>('POST', '/api/audit/erase', {
      headers: a.approver.headers,
      body: { scopeId: 'ses_pdpa', decisionId: await approvedErasure(a, ['ses_pdpa'], 'retention') },
    });
    expect(again).toMatchObject({ reason: 'retention', bodiesErased: 0 });
  });

  it('validates the request body', async () => {
    a = await auditRuntime();
    const { t } = a;
    for (const body of [
      { scopeId: 'ses a', decisionId: 'dec_x' },
      { scopeId: 'ses_a' },
      { scopeId: 'ses_a', decisionId: 'dec_x', reason: 'because' },
      { scopeId: 'ses_a', decisionId: 'dec_x', extra: 1 },
    ])
      expect((await t.request('POST', '/api/audit/erase', { headers: a.approver.headers, body })).status).toBe(422);
    for (const body of [
      { scopeIds: [], reason: 'retention', rationale: 'x' },
      { scopeIds: ['ses_a', 'ses_a'], reason: 'retention', rationale: 'x' },
      { scopeIds: ['../x'], reason: 'retention', rationale: 'x' },
      { scopeIds: ['ses_a'], reason: 'retention', rationale: '  ' },
    ])
      expect(
        (await t.request('POST', '/api/audit/erasure-requests', { headers: a.builder.headers, body })).status,
      ).toBe(422);
  });

  it('erases only under an approved erasure request that names the scope, once, by someone other than its requester (O-28, G-47)', async () => {
    a = await auditRuntime();
    const { t } = a;
    const h = a.approver.headers;
    nudge(t, 'ses_a', 'a leaked token');
    nudge(t, 'ses_b', 'another');
    const erase = (body: Record<string, unknown>, headers = h) => t.request('POST', '/api/audit/erase', { headers, body });

    // Any other decision, even a resolved one, does not authorise an erasure.
    expect((await erase({ scopeId: 'ses_a', decisionId: 'dec_nope' })).status).toBe(422);
    const other = t.decisions!.request(
      {
        kind: 'protected_operation',
        title: 'Erase leaked token',
        question: 'Erase?',
        options: [{ id: 'yes', label: 'Yes' }],
        subjectType: 'session',
        subjectId: 'ses_a',
        requesterId: a.builder.user.id,
      },
      { kind: 'human', id: a.builder.user.id },
    );
    await t.decisions!.resolve(other.id, { optionId: 'yes' }, a.approver.user);
    expect(await (await erase({ scopeId: 'ses_a', decisionId: other.id })).json()).toMatchObject({
      error: { code: 'not_an_erasure_request' },
    });

    // The request is a card for the Approver that its requester cannot resolve; open or rejected, it erases nothing.
    const req = await t.json<ErasureRequestDTO>('POST', '/api/audit/erasure-requests', {
      headers: a.builder.headers,
      body: { scopeIds: ['ses_a'], reason: 'secret_leak', rationale: 'A token was pasted into a prompt' },
      expect: 201,
    });
    expect(req).toMatchObject({ scopeIds: ['ses_a'], reason: 'secret_leak', requesterId: a.builder.user.id, eventsInScope: { ses_a: 1 } });
    const card = t.decisions!.get(req.decisionId)!;
    expect(card).toMatchObject({ kind: 'erasure_request', requiredRole: 'approver', requesterId: a.builder.user.id });
    expect(t.decisions!.canResolve(card, a.builder.user).ok).toBe(false);
    const requested = t.rt.store.list({ types: ['erasure.requested'] })[0]!;
    expect(requested.meta).toEqual({ requestId: req.requestId, decisionId: req.decisionId, scopeIds: ['ses_a'], reason: 'secret_leak' });
    expect(requested.actor).toEqual({ kind: 'human', id: a.builder.user.id });
    expect(t.rt.store.readPayload(requested)).toEqual({ rationale: 'A token was pasted into a prompt' });
    expect(await (await erase({ scopeId: 'ses_a', decisionId: req.decisionId })).json()).toMatchObject({
      error: { code: 'erasure_not_approved' },
    });

    const rejected = await t.json<ErasureRequestDTO>('POST', '/api/audit/erasure-requests', {
      headers: a.builder.headers,
      body: { scopeIds: ['ses_b'], reason: 'other', rationale: 'not needed after all' },
      expect: 201,
    });
    await t.decisions!.resolve(rejected.decisionId, { optionId: 'reject' }, a.approver.user);
    expect((await erase({ scopeId: 'ses_b', decisionId: rejected.decisionId })).status).toBe(409);

    await t.decisions!.resolve(req.decisionId, { optionId: 'approve' }, a.approver.user);
    // Approved, but only for the scope and the reason it names.
    expect(await (await erase({ scopeId: 'ses_b', decisionId: req.decisionId })).json()).toMatchObject({
      error: { code: 'scope_not_approved' },
    });
    expect(await (await erase({ scopeId: 'ses_a', decisionId: req.decisionId, reason: 'retention' })).json()).toMatchObject({
      error: { code: 'reason_mismatch' },
    });
    const res = await t.json<EraseResultDTO>('POST', '/api/audit/erase', {
      headers: h,
      body: { scopeId: 'ses_a', decisionId: req.decisionId },
    });
    expect(res).toMatchObject({ scopeId: 'ses_a', reason: 'secret_leak', decisionId: req.decisionId, bodiesErased: 1 });
    expect(t.rt.store.get(res.eventSeq)!.meta).toMatchObject({ decisionId: req.decisionId, reason: 'secret_leak' });

    // An approval is spent once its scope is erased: what is written to the scope later needs a new request.
    nudge(t, 'ses_a', 'written after the erasure');
    expect(await (await erase({ scopeId: 'ses_a', decisionId: req.decisionId })).json()).toMatchObject({
      error: { code: 'already_erased' },
    });
  });

  it('the Approver who requested an erasure cannot carry it out (O-28, G-47)', async () => {
    a = await auditRuntime();
    const { t } = a;
    const second = t.user('approver', 'Second approver');
    const req = await t.json<ErasureRequestDTO>('POST', '/api/audit/erasure-requests', {
      headers: a.approver.headers,
      body: { scopeIds: ['ses_a'], reason: 'retention', rationale: 'kept past its period' },
      expect: 201,
    });
    await t.decisions!.resolve(req.decisionId, { optionId: 'approve' }, second.user);
    const mine = await t.request('POST', '/api/audit/erase', {
      headers: a.approver.headers,
      body: { scopeId: 'ses_a', decisionId: req.decisionId },
    });
    expect(mine.status).toBe(403);
    expect(await mine.json()).toMatchObject({ error: { code: 'requester_cannot_erase' } });
    const theirs = await t.request('POST', '/api/audit/erase', {
      headers: second.headers,
      body: { scopeId: 'ses_a', decisionId: req.decisionId },
    });
    expect(theirs.status).toBe(200);
  });
});
