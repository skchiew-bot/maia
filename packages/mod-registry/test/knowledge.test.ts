import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { KnowledgeSearchResponse, StoredEvent } from '@aoc/contracts';
import type { TestRuntime, TestUser } from '@aoc/kernel';
import { createKnowledgeProjector } from '../src/knowledge';
import { retirePlaybook, seedPlaybook, start } from './helpers';

const INTAKE = { kind: 'system', id: 'intake' } as const;

function diagnose(
  t: TestRuntime,
  ticketId: string,
  sessionId: string,
  confidence: number,
  rootCause: string,
  fixPlan: string,
  rootCauseClass: string | null = null,
): void {
  t.rt.store.append({
    type: 'ticket.diagnosis_reported',
    actor: { kind: 'agent', id: sessionId },
    scope: { ticketId, sessionId, projectId: 'prj_shop' },
    meta: { ticketId, sessionId, confidence },
    payload: { rootCause, fixPlan, affectedAreas: ['src/checkout'], ...(rootCauseClass ? { rootCauseClass } : {}) },
    source: 'mcp',
  });
}
function close(t: TestRuntime, ticketId: string, resolution: 'fixed' | 'wont_fix'): void {
  t.rt.store.append({
    type: 'ticket.closed',
    actor: INTAKE,
    scope: { ticketId },
    meta: { ticketId, resolution },
    payload: { note: 'requester said thanks, Mrs Tan' },
    source: 'intake',
  });
}
function lesson(t: TestRuntime, lessonId: string, rule: string, fix: string, bind: boolean): void {
  t.rt.store.append({
    type: 'lesson.proposed',
    actor: { kind: 'system', id: 'learning' },
    scope: {},
    meta: {
      lessonId,
      classId: null,
      scopeType: 'process_type',
      scopeValue: 'bug-fix',
      decisionId: `dec_${lessonId}`,
    },
    payload: { rule, fix },
    source: 'system',
    bodyScope: lessonId,
  });
  if (bind)
    t.rt.store.append({
      type: 'lesson.bound',
      actor: { kind: 'human', id: 'usr_ceo' },
      scope: {},
      meta: { lessonId, decisionId: `dec_${lessonId}` },
      source: 'system',
    });
}

async function seedKnowledge(t: TestRuntime): Promise<{ decisionId: string }> {
  // Requester-supplied intake text must never become searchable.
  t.rt.store.append({
    type: 'intake.submitted',
    actor: { kind: 'human', id: 'usr_req' },
    scope: { ticketId: 'tkt_A' },
    meta: {
      ticketId: 'tkt_A',
      requesterId: 'usr_req',
      severity: 'high',
      attachmentCount: 0,
      attachmentHashes: [],
    },
    payload: { title: 'Checkout explodes for Mrs Tan in Zanzibar', description: 'zanzibar phone 0123456789' },
    source: 'intake',
  });
  diagnose(
    t,
    'tkt_A',
    'ses_tri1',
    0.9,
    'Expired cookie leaves a null session in the checkout handler',
    'Guard the session lookup and return 401',
    'null-session-guard',
  );
  diagnose(t, 'tkt_A', 'ses_tri2', 0.95, 'Quokka cache stampede', 'Add jitter');
  t.rt.store.append({
    type: 'ticket.fix_plan_submitted',
    actor: INTAKE,
    scope: { ticketId: 'tkt_A' },
    meta: { ticketId: 'tkt_A', decisionId: 'dec_fix', sourceSessionId: 'ses_tri1' },
    payload: { fixPlan: 'Guard it' },
    source: 'intake',
  });
  t.clock.advance(60_000);
  close(t, 'tkt_A', 'fixed');
  diagnose(t, 'tkt_B', 'ses_tri3', 0.8, 'Wombat locale bug', 'Use Intl');
  close(t, 'tkt_B', 'wont_fix');
  diagnose(t, 'tkt_C', 'ses_tri4', 0.8, 'Dingo timezone drift in checkout', 'Use UTC'); // still open

  lesson(t, 'les_1', 'Refresh the cookie before the checkout redirect', 'Call refreshSession() first', true);
  lesson(t, 'les_2', 'Echidna lessons are pending', 'n/a', false);
  lesson(t, 'les_3', 'Bilby rule that was retired', 'n/a', true);
  t.rt.store.append({
    type: 'lesson.retired',
    actor: { kind: 'system', id: 'learning' },
    scope: {},
    meta: { lessonId: 'les_3', reason: 'unused', runsUnused: 20 },
    source: 'system',
  });

  seedPlaybook(t, {
    playbookId: 'pbk_co',
    processType: 'bug-fix',
    title: 'Checkout bug-fix playbook',
    steps: [
      { id: 'repro', title: 'Reproduce the checkout failure with a test', detail: 'test/checkout' },
      { id: 'guard', title: 'Add the session guard', detail: 'src/checkout' },
    ],
  });

  const dev = t.user('builder', 'Dev');
  const lead = t.user('builder', 'Lead');
  const asked = t.decisions!.request(
    {
      kind: 'agent_decision',
      test: 'ambiguity',
      title: 'Retry policy',
      question: 'Should checkout retry when the session lookup returns null?',
      options: [
        { id: 'retry', label: 'Retry once' },
        { id: 'fail', label: 'Fail with 401' },
      ],
      subjectType: 'session',
      subjectId: 'ses_b1',
      sessionId: 'ses_b1',
      projectId: 'prj_shop',
      requesterId: dev.user.id,
    },
    { kind: 'agent', id: 'ses_b1' },
  );
  await t.decisions!.resolve(
    asked.id,
    { optionId: 'fail', comment: 'Retrying would hide the missing guard' },
    lead.user,
  );
  t.decisions!.request(
    {
      kind: 'agent_decision',
      test: 'ambiguity',
      title: 'Open question',
      question: 'Narwhal: still unanswered?',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      subjectType: 'session',
      subjectId: 'ses_b1',
      sessionId: 'ses_b1',
      requesterId: dev.user.id,
    },
    { kind: 'agent', id: 'ses_b1' },
  );
  const bare = t.decisions!.request(
    {
      kind: 'agent_decision',
      test: 'ambiguity',
      title: 'Bare click',
      question: 'Wallaby: resolved without any reasoning?',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      subjectType: 'session',
      subjectId: 'ses_b1',
      sessionId: 'ses_b1',
      requesterId: dev.user.id,
    },
    { kind: 'agent', id: 'ses_b1' },
  );
  await t.decisions!.resolve(bare.id, { optionId: 'a' }, lead.user);
  const requester = t.user('requester', 'Requester');
  const uat = t.decisions!.request(
    {
      kind: 'uat_signoff',
      title: 'UAT',
      question: 'Does the fix work for you?',
      options: [
        { id: 'pass', label: 'Pass' },
        { id: 'fail', label: 'Fail' },
      ],
      subjectType: 'ticket',
      subjectId: 'tkt_A',
      requesterId: dev.user.id,
      eligibleUserIds: [requester.user.id],
    },
    { kind: 'system', id: 'intake' },
  );
  await t.decisions!.resolve(uat.id, { optionId: 'pass', comment: 'Platypus works now' }, requester.user);
  await t.drain();
  return { decisionId: asked.id };
}

const search = (t: TestRuntime, u: TestUser, qs: string) =>
  t.json<KnowledgeSearchResponse>('GET', `/api/knowledge/search?${qs}`, { headers: u.headers });

describe('team knowledge layer (§14)', () => {
  it('indexes resolved tickets (diagnosis only), approved playbooks, bound lessons and resolved decisions', async () => {
    const t = await start();
    const { decisionId } = await seedKnowledge(t);
    const builder = t.user('builder');

    const all = await search(t, builder, 'q=checkout');
    expect(all.match).toBe('all');
    expect(new Set(all.results.map((r) => r.kind))).toEqual(
      new Set(['ticket', 'lesson', 'playbook', 'decision']),
    );

    const ticket = (await search(t, builder, 'q=expired%20cookie')).results[0]!;
    expect(ticket).toMatchObject({
      docId: 'ticket:tkt_A',
      kind: 'ticket',
      title: 'null-session-guard',
      refs: { ticketId: 'tkt_A', sessionId: 'ses_tri1', projectId: 'prj_shop' },
    });
    expect(ticket.date).toBe(t.rt.store.list({ types: ['ticket.closed'] })[0]!.ts);
    expect(ticket.snippetParts.filter((p) => p.hit).map((p) => p.text.toLowerCase())).toEqual(
      expect.arrayContaining(['expired', 'cookie']),
    );
    expect(ticket.snippet).toContain('Expired cookie leaves a null session');
    expect(ticket.snippet).not.toMatch(/[\u0002\u0003]/);
    expect(ticket.score).toBeGreaterThan(0);

    const decision = (await search(t, builder, 'q=retry&kind=decision')).results;
    expect(decision).toHaveLength(1);
    expect(decision[0]).toMatchObject({
      docId: `decision:${decisionId}`,
      refs: { decisionId, sessionId: 'ses_b1', projectId: 'prj_shop' },
    });
    expect((await search(t, builder, 'q=hide%20missing%20guard')).results.map((r) => r.docId)).toContain(
      `decision:${decisionId}`,
    ); // the comment
    expect((await search(t, builder, 'q=fail%20401&kind=decision')).results).toHaveLength(1); // the chosen option

    const pb = (await search(t, builder, 'q=reproduce&kind=playbook')).results[0]!;
    expect(pb).toMatchObject({
      docId: 'playbook:pbk_co',
      refs: { playbookId: 'pbk_co', processType: 'bug-fix' },
    });

    // Never indexed: requester intake text, the non-chosen diagnosis, won't-fix and open tickets,
    // pending/retired lessons, unresolved decisions, decisions resolved without a comment, UAT sign-off comments.
    for (const term of [
      'zanzibar',
      '0123456789',
      'tan',
      'quokka',
      'wombat',
      'dingo',
      'echidna',
      'bilby',
      'narwhal',
      'wallaby',
      'platypus',
    ]) {
      expect((await search(t, builder, `q=${term}`)).results, term).toEqual([]);
    }
    await t.close();
  });

  it('ranks title matches above body-only matches (bm25), filters by kind, prefix-matches the last term and falls back to any-term', async () => {
    const t = await start();
    await seedKnowledge(t);
    const builder = t.user('builder');
    // "cookie": lesson title vs ticket body.
    const cookie = await search(t, builder, 'q=cookie');
    expect(cookie.results.map((r) => r.docId)).toEqual(['lesson:les_1', 'ticket:tkt_A']);
    expect(cookie.results[0]!.score).toBeGreaterThan(cookie.results[1]!.score);
    expect((await search(t, builder, 'q=cookie&kind=ticket')).results.map((r) => r.docId)).toEqual([
      'ticket:tkt_A',
    ]);
    expect((await search(t, builder, 'q=check')).results.length).toBeGreaterThan(0); // prefix
    const any = await search(t, builder, 'q=checkout%20zebra');
    expect(any.match).toBe('any');
    expect(any.results.length).toBeGreaterThan(0);
    expect((await search(t, builder, 'q=checkout&limit=2')).results).toHaveLength(2);
    // FTS syntax in user input is data, not query language.
    for (const q of ['"checkout', 'checkout AND (', 'title:checkout', 'NEAR(checkout', '*', '-checkout']) {
      const res = await t.request('GET', `/api/knowledge/search?q=${encodeURIComponent(q)}`, {
        headers: builder.headers,
      });
      expect(res.status, q).toBe(200);
    }
    expect((await search(t, builder, `q=${encodeURIComponent('!!!')}`)).results).toEqual([]);
    expect(
      (await t.request('GET', '/api/knowledge/search?q=checkout&kind=email', { headers: builder.headers }))
        .status,
    ).toBe(422);
    expect((await t.request('GET', '/api/knowledge/search', { headers: builder.headers })).status).toBe(422);
    await t.close();
  });

  it('removes knowledge on crypto-shred (live and after a rebuild) and when a playbook is retired', async () => {
    const t = await start();
    const { decisionId } = await seedKnowledge(t);
    const builder = t.user('builder');
    const ids = async (q: string) => (await search(t, builder, `q=${q}`)).results.map((r) => r.docId);
    expect(await ids('checkout')).toEqual(
      expect.arrayContaining(['ticket:tkt_A', `decision:${decisionId}`, 'lesson:les_1', 'playbook:pbk_co']),
    );

    // PDPA erasure of the ticket: its diagnosis body lives in the triage session scope, but the
    // document is linked to the ticket too, so it goes.
    t.rt.store.eraseScope('tkt_A', { actor: { kind: 'human', id: 'usr_ceo' }, reason: 'pdpa_request' });
    // Retention purge of the session that raised the decision.
    t.rt.store.eraseScope('ses_b1', { actor: { kind: 'human', id: 'usr_ceo' }, reason: 'retention' });
    let left = await ids('checkout');
    expect(left).not.toContain('ticket:tkt_A');
    expect(left).not.toContain(`decision:${decisionId}`);
    expect(left).toEqual(expect.arrayContaining(['lesson:les_1', 'playbook:pbk_co']));

    // A rebuild from the log reproduces the post-erasure index exactly.
    t.rt.store.rebuildProjections();
    left = await ids('checkout');
    expect(left.sort()).toEqual(['lesson:les_1', 'playbook:pbk_co']);
    expect(await ids('cookie')).toEqual(['lesson:les_1']);

    retirePlaybook(t, 'pbk_co');
    expect(await ids('reproduce')).toEqual([]);
    await t.close();
  });

  it('keeps the class of a diagnosis whose log chained it in meta, and none once the body is erased', () => {
    const projector = createKnowledgeProjector();
    const db = new DatabaseSync(':memory:');
    for (const sql of projector.ddl) db.exec(sql);
    const legacy = {
      type: 'ticket.diagnosis_reported',
      seq: 1,
      ts: '2026-10-01T00:00:00.000Z',
      scope: { ticketId: 'tkt_old' },
      bodyScope: 'tkt_old',
      meta: { ticketId: 'tkt_old', sessionId: 'ses_old', confidence: 0.8, rootCauseClass: 'null-check' },
    } as unknown as StoredEvent;
    const cls = () => (db.prepare('SELECT root_cause_class AS cls FROM reg_kn_diagnoses').get() as { cls: string | null }).cls;
    projector.apply({ db, replaying: true }, legacy, { rootCause: 'Null check missing', fixPlan: 'Add a guard' });
    expect(cls()).toBe('null-check');
    projector.apply({ db, replaying: true }, legacy, null);
    expect(cls()).toBeNull();
    db.close();
  });

  it('is internal: builders and approvers search it, requesters and anonymous callers never', async () => {
    const t = await start();
    await seedKnowledge(t);
    expect(
      (await t.request('GET', '/api/knowledge/search?q=checkout', { headers: t.user('approver').headers }))
        .status,
    ).toBe(200);
    expect(
      (await t.request('GET', '/api/knowledge/search?q=checkout', { headers: t.user('builder').headers }))
        .status,
    ).toBe(200);
    expect(
      (await t.request('GET', '/api/knowledge/search?q=checkout', { headers: t.user('requester').headers }))
        .status,
    ).toBe(403);
    expect((await t.request('GET', '/api/knowledge/search?q=checkout')).status).toBe(401);
    await t.close();
  });
});
