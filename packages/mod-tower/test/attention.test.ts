import { afterEach, describe, expect, it } from 'vitest';
import type { TowerAttentionItem } from '@aoc/contracts';
import {
  ago,
  capReached,
  decide,
  hours,
  launch,
  live,
  minutes,
  resolveDecision,
  setup,
  sys,
  ticket,
  ticketEvent,
  topupGranted,
  topupRequested,
  usage,
  type Harness,
} from './helpers';

let h: Harness;
afterEach(async () => h?.close());

const byId = (items: TowerAttentionItem[], id: string) => {
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`no attention item ${id} in [${items.map((i) => i.id).join(', ')}]`);
  return item;
};

describe('attention queue: ranked by cost of delay', () => {
  it('ranks mixed kinds by base × age factor × blast radius — cost of delay beats age', async () => {
    h = await setup();
    decide(h, 'dec_bg', 'break_glass', { at: ago(h, minutes(1)) });
    decide(h, 'dec_lesson', 'lesson_binding', { at: ago(h, hours(12)), projectId: null });
    decide(h, 'dec_change', 'change_request', { at: ago(h, hours(2)) });
    launch(h, 'ses_dead', { at: ago(h, hours(3)) });
    live(h, 'ses_dead', 'working', ago(h, hours(3)));
    live(h, 'ses_dead', 'dead', ago(h, minutes(10)));
    h.emit(
      {
        type: 'fx.carry_forward_alert',
        actor: sys,
        meta: { consecutiveDays: 4, since: '2026-10-05' },
        source: 'scheduler',
      },
      ago(h, hours(6)),
    );

    const s = await h.snap();
    // Raw costs 132.9 > 104.7 > 99.1 > 84.7 > 70.5, published on the 0–100 scale.
    expect(s.attention.map((a) => [a.id, a.costOfDelay.score, a.severity])).toEqual([
      ['decision:dec_change', 84.8, 'critical'], // 40 × (1 + log2 5)
      ['decision:dec_bg', 78.9, 'critical'], // 100, a minute old
      ['session_dead:ses_dead', 77.5, 'critical'], // 70 × 1.415
      ['decision:dec_lesson', 70.5, 'high'], // the oldest item (12h) still ranks below fresher, costlier ones
      ['fx_carry_forward', 58.8, 'high'],
    ]);
    expect(s.attention.map((a) => a.costOfDelay.basis)).toEqual([
      'Change request · 2h',
      'Break-glass promotion · 1m',
      'Dead session · 10m',
      'Lesson binding · 12h',
      'FX carried forward · 4 days · alert 6h old',
    ]);
    expect(s.kpis.needsYou).toBe(5);
    expect(s.kpis.oldestNeedsYouSince).toBe('2026-10-08T18:00:00.000Z');
    expect(s.summary).toBe(
      '5 items need you; oldest 12h. Flow 0 verified tasks vs 0 baseline. No gate decisions resolved in 7d.',
    );
    expect(byId(s.attention, 'session_dead:ses_dead')).toMatchObject({
      since: '2026-10-09T05:50:00.000Z',
      ageMs: minutes(10),
      projectId: 'prj_a',
    });
  });

  it('gives each kind its inline intervention; passkey only for go-live, rollback and break-glass', async () => {
    h = await setup();
    for (const [id, kind] of [
      ['dec_go', 'go_live'],
      ['dec_rb', 'rollback'],
      ['dec_bg', 'break_glass'],
      ['dec_po', 'protected_operation'],
      ['dec_cr', 'change_request'],
      ['dec_tr', 'triage_reconciliation'],
      ['dec_uat', 'uat_signoff'],
    ] as const) {
      decide(h, id, kind, { at: ago(h, minutes(5)) });
    }
    launch(h, 'ses_mig', { at: ago(h, hours(1)), processType: 'migration' });
    decide(h, 'dec_main', 'agent_decision', { at: ago(h, minutes(5)), test: 'main', sessionId: 'ses_mig' });
    launch(h, 'ses_dead', { at: ago(h, hours(1)) });
    live(h, 'ses_dead', 'dead', ago(h, minutes(3)));
    launch(h, 'ses_stall', { at: ago(h, hours(1)), processType: 'bug-fix' });
    usage(h, 'ses_stall', 10, { contextTokens: 640_000, at: ago(h, minutes(30)) });
    live(h, 'ses_stall', 'stalled', ago(h, minutes(7)));
    launch(h, 'ses_thr', { at: ago(h, hours(1)) });
    h.emit(
      {
        type: 'throttle.hit',
        actor: sys,
        scope: { sessionId: 'ses_thr' },
        meta: { sessionId: 'ses_thr', resetAt: '2026-10-09T07:30:00.000Z', source: 'stream' },
        payload: { message: 'limit' },
        source: 'sidecar',
      },
      ago(h, minutes(20)),
    );
    live(h, 'ses_thr', 'throttled', ago(h, minutes(20)));
    // Observed sessions are read-only: never an intervention item.
    h.emit({
      type: 'session.observed',
      actor: sys,
      scope: { sessionId: 'ses_obs' },
      meta: { sessionId: 'ses_obs', claudeSessionId: 'c-1', projectId: 'prj_a' },
      payload: { cwd: '/x', transcriptPath: '/x.jsonl' },
      source: 'hook',
    });
    live(h, 'ses_obs', 'dead');

    const s = await h.snap();
    expect(s.attention.map((a) => a.id).sort()).toEqual(
      [
        'decision:dec_bg',
        'decision:dec_cr',
        'decision:dec_go',
        'decision:dec_main',
        'decision:dec_po',
        'decision:dec_rb',
        'decision:dec_tr',
        'session_dead:ses_dead',
        'session_stalled:ses_stall',
        'session_throttled:ses_thr',
      ].sort(),
    );
    for (const id of ['dec_go', 'dec_rb', 'dec_bg']) {
      expect(byId(s.attention, `decision:${id}`).action).toEqual({
        kind: 'resolve_decision',
        label: 'Approve with passkey',
        href: `/decisions?id=${id}`,
        decisionId: id,
        requiresPasskey: true,
      });
      expect(byId(s.attention, `decision:${id}`).chips).toContain('Passkey');
    }
    for (const id of ['dec_po', 'dec_cr', 'dec_main']) {
      expect(byId(s.attention, `decision:${id}`).action).toMatchObject({
        kind: 'resolve_decision',
        label: 'Approve',
        requiresPasskey: false,
      });
    }
    expect(byId(s.attention, 'decision:dec_tr').action).toMatchObject({
      kind: 'resolve_decision',
      label: 'Review',
      requiresPasskey: false,
    });
    expect(byId(s.attention, 'decision:dec_main')).toMatchObject({
      detail: 'Touches main / protected branch',
      costOfDelay: { score: 61.1, basis: 'Agent decision (test 1: main) · 5m · holds a migration session' }, // raw 60 × 1.222
      chips: ['test main'],
    });
    expect(byId(s.attention, 'session_dead:ses_dead').action).toEqual({
      kind: 'restart',
      label: 'Restart',
      href: '/sessions/ses_dead',
      sessionId: 'ses_dead',
    });
    expect(byId(s.attention, 'session_stalled:ses_stall')).toMatchObject({
      title: 'Stalled session: bug-fix',
      costOfDelay: { basis: 'Stalled session · 7m · process alive but silent at 64% context' },
      action: { kind: 'nudge', label: 'Nudge…', href: '/sessions/ses_stall', sessionId: 'ses_stall' },
    });
    expect(byId(s.attention, 'session_throttled:ses_thr')).toMatchObject({
      title: 'Throttled session: feature (resets 15:30)',
      costOfDelay: { basis: 'Plan limit · idle 20m · resets 15:30' },
      action: { kind: 'open', label: 'Open', href: '/sessions/ses_thr' },
      chips: ['Resets 15:30'],
    });
  });

  it('decisions past their SLA say so in the basis', async () => {
    h = await setup();
    decide(h, 'dec_rb', 'rollback', { at: ago(h, minutes(47)) });
    decide(h, 'dec_data', 'agent_decision', { at: ago(h, minutes(134)), test: 'data' });
    decide(h, 'dec_fp', 'fix_plan', { at: ago(h, hours(3)) });
    const s = await h.snap();
    expect(byId(s.attention, 'decision:dec_rb')).toMatchObject({
      costOfDelay: { basis: 'Rollback gate · 47m · past the 30m SLA' },
      chips: ['Passkey', 'Past SLA'],
    });
    expect(byId(s.attention, 'decision:dec_data').costOfDelay.basis).toBe(
      'Agent decision (test 5: data) · 2h 14m · past the 1h SLA',
    );
    expect(byId(s.attention, 'decision:dec_fp').costOfDelay.basis).toBe('Fix-plan gate · 3h'); // within its 4h SLA
  });

  it('customers waiting beyond the severity SLA (critical 1h, high 4h, medium 24h, low 72h) — including on the requester in UAT', async () => {
    h = await setup();
    ticket(h, 'tkt_c59', 'critical', { at: ago(h, minutes(59)) });
    ticket(h, 'tkt_c61', 'critical', { at: ago(h, minutes(61)) });
    ticket(h, 'tkt_h239', 'high', { at: ago(h, hours(4) - minutes(1)) });
    ticket(h, 'tkt_h241', 'high', { at: ago(h, hours(4) + minutes(1)) });
    ticket(h, 'tkt_m', 'medium', { at: ago(h, hours(24) + minutes(1)) });
    ticket(h, 'tkt_l71', 'low', { at: ago(h, hours(72) - minutes(1)) });
    ticket(h, 'tkt_l73', 'low', { at: ago(h, hours(72) + minutes(1)) });
    ticket(h, 'tkt_uat', 'critical', { at: ago(h, hours(5)) });
    ticketEvent(
      h,
      {
        type: 'ticket.uat_ready',
        actor: sys,
        scope: { ticketId: 'tkt_uat' },
        meta: { ticketId: 'tkt_uat', uatRef: 'uat/1', uatSha: 'abcdef1', decisionId: 'dec_u' },
        source: 'intake',
      },
      ago(h, hours(1)),
    );
    decide(h, 'dec_u', 'uat_signoff', { at: ago(h, hours(1)), subjectType: 'ticket', subjectId: 'tkt_uat' });
    ticket(h, 'tkt_done', 'critical', { at: ago(h, hours(5)) });
    ticketEvent(
      h,
      {
        type: 'ticket.closed',
        actor: sys,
        scope: { ticketId: 'tkt_done' },
        meta: { ticketId: 'tkt_done', resolution: 'fixed' },
        payload: {},
        source: 'intake',
      },
      ago(h, hours(1)),
    );
    ticketEvent(
      h,
      {
        type: 'ticket.triage_started',
        actor: sys,
        scope: { ticketId: 'tkt_h241' },
        meta: { ticketId: 'tkt_h241', sessionIds: [], budgetTokens: 1, budgetMinutes: 1 },
        source: 'intake',
      },
      ago(h, hours(3)),
    );

    const s = await h.snap();
    expect(s.attention.map((a) => a.id)).toEqual([
      'ticket_waiting:tkt_uat', // waiting on the requester (the UAT sign-off decision itself is not an item)
      'ticket_waiting:tkt_c61',
      'ticket_waiting:tkt_h241',
      'ticket_waiting:tkt_m',
      'ticket_waiting:tkt_l73',
    ]);
    expect(byId(s.attention, 'ticket_waiting:tkt_c61')).toMatchObject({
      title: 'Critical ticket waiting for triage',
      since: new Date(ago(h, minutes(1))).toISOString(), // started needing attention when the SLA ran out
      ageMs: minutes(1),
      severity: 'critical',
      costOfDelay: { score: 76.2, basis: 'Critical ticket · 1m past the 1h SLA · waiting for triage' },
      action: { kind: 'open', label: 'Open ticket', href: '/tickets/tkt_c61' },
      chips: ['Critical', 'SLA breached'],
    });
    expect(byId(s.attention, 'ticket_waiting:tkt_uat')).toMatchObject({
      title: 'Critical ticket in UAT, waiting on the requester',
      costOfDelay: { basis: 'Critical ticket · 4h past the 1h SLA · in UAT, waiting on the requester' },
    });
    expect(byId(s.attention, 'ticket_waiting:tkt_h241')).toMatchObject({
      title: 'High ticket in triage',
      severity: 'high',
      costOfDelay: { score: 61.1 },
    });
    expect(byId(s.attention, 'ticket_waiting:tkt_m')).toMatchObject({
      severity: 'medium',
      costOfDelay: { score: 34.9 },
    });
    expect(byId(s.attention, 'ticket_waiting:tkt_l73')).toMatchObject({
      severity: 'low',
      costOfDelay: { score: 17.5 },
    });
    // Ticket text is user-entered (PII): never in the queue.
    expect(JSON.stringify(s.attention)).not.toMatch(/jane|0123456789|Login broken/);
    expect(s.kpis.openTickets).toBe(8);
  });

  it('a gate carries its ticket as blast radius ("blocks a UAT-signed fix") instead of a duplicate ticket item', async () => {
    h = await setup();
    ticket(h, 'tkt_1', 'high', { at: ago(h, hours(3)) });
    ticketEvent(
      h,
      {
        type: 'ticket.uat_ready',
        actor: sys,
        scope: { ticketId: 'tkt_1' },
        meta: { ticketId: 'tkt_1', uatRef: 'uat/1', uatSha: 'abcdef1', decisionId: 'dec_uat' },
        source: 'intake',
      },
      ago(h, minutes(160)),
    );
    decide(h, 'dec_uat', 'uat_signoff', {
      at: ago(h, minutes(160)),
      subjectType: 'ticket',
      subjectId: 'tkt_1',
    });
    ticketEvent(
      h,
      {
        type: 'ticket.uat_result',
        actor: { kind: 'human', id: 'usr_customer' },
        scope: { ticketId: 'tkt_1' },
        meta: { ticketId: 'tkt_1', requesterId: 'usr_customer', verdict: 'pass' },
        payload: {},
        source: 'intake',
      },
      ago(h, minutes(140)),
    );
    resolveDecision(h, 'dec_uat', 'uat_signoff', ago(h, minutes(140)));
    ticketEvent(
      h,
      {
        type: 'ticket.golive_requested',
        actor: sys,
        scope: { ticketId: 'tkt_1' },
        meta: { ticketId: 'tkt_1', decisionId: 'dec_gl', promotionId: 'prm_1' },
        source: 'intake',
      },
      ago(h, minutes(134)),
    );
    decide(h, 'dec_gl', 'go_live', {
      at: ago(h, minutes(134)),
      subjectType: 'promotion',
      subjectId: 'prm_1',
    });

    // A critical ticket past its SLA, waiting at the fix-plan gate.
    ticket(h, 'tkt_2', 'critical', { at: ago(h, hours(3)) });
    ticketEvent(
      h,
      {
        type: 'ticket.fix_plan_submitted',
        actor: sys,
        scope: { ticketId: 'tkt_2' },
        meta: { ticketId: 'tkt_2', decisionId: 'dec_fp', sourceSessionId: null },
        payload: { fixPlan: 'x' },
        source: 'intake',
      },
      ago(h, hours(1)),
    );
    decide(h, 'dec_fp', 'fix_plan', { at: ago(h, hours(1)), subjectType: 'ticket', subjectId: 'tkt_2' });

    const s = await h.snap();
    expect(s.attention.map((a) => a.id)).toEqual(['decision:dec_gl', 'decision:dec_fp']);
    expect(byId(s.attention, 'decision:dec_gl')).toMatchObject({
      costOfDelay: {
        score: 99.7,
        basis: 'Go-live gate · 2h 14m · blocks a UAT-signed fix · high ticket · past the 2h SLA',
      }, // raw 90 × 3.45 × 1.55
      chips: ['Passkey', 'High ticket', 'UAT signed', 'Past SLA'],
      detail: 'Ticket tkt_1 at the go-live gate',
    });
    expect(byId(s.attention, 'decision:dec_fp')).toMatchObject({
      costOfDelay: { basis: 'Fix-plan gate · 1h · critical ticket · customer past the 1h SLA' },
      chips: ['Critical ticket', 'SLA breached'],
    });
  });

  it('credit caps: one item per builder, 45 + 10 per blocked session, top-up decisions fold in, cleared by funding', async () => {
    h = await setup();
    const dev = h.t.user('builder', 'Dana Developer');
    launch(h, 'ses_c1', { at: ago(h, hours(5)), owner: dev.user.id });
    launch(h, 'ses_c2', { at: ago(h, hours(5)), owner: dev.user.id });
    capReached(h, dev.user.id, 'ses_c1', ago(h, hours(3)));
    capReached(h, dev.user.id, 'ses_c2', ago(h, hours(2)));

    let s = await h.snap();
    expect(byId(s.attention, `credit_blocked:${dev.user.id}`)).toMatchObject({
      kind: 'credit_blocked',
      title: 'Builder at credit cap; no top-up requested',
      detail: 'Dana Developer · 2 sessions held at a task boundary',
      projectId: 'prj_a',
      since: new Date(ago(h, hours(3))).toISOString(),
      costOfDelay: { score: 95.9, basis: 'Credit cap · 3h · 2 sessions blocked · no top-up requested' }, // raw (45 + 2 × 10) × 3.81
      action: { kind: 'open', label: 'Open credits', href: `/credits?userId=${dev.user.id}` },
    });

    topupRequested(h, dev.user.id, 'tpu_1', 'dec_top', ago(h, hours(1)));
    decide(h, 'dec_top', 'credit_topup', { at: ago(h, hours(1)), requesterId: dev.user.id });
    s = await h.snap();
    expect(s.attention.map((a) => a.id)).toEqual([`credit_blocked:${dev.user.id}`]); // no separate top-up decision item
    expect(s.attention[0]).toMatchObject({
      title: 'Builder at credit cap; top-up of $50.00 pending',
      costOfDelay: { basis: 'Credit cap · 3h · 2 sessions blocked · top-up pending' },
      action: {
        kind: 'resolve_decision',
        label: 'Approve top-up',
        href: '/decisions?id=dec_top',
        decisionId: 'dec_top',
        requiresPasskey: false,
      },
      chips: ['2 blocked', 'Top-up pending'],
    });
    expect(s.attention[0]!.title).not.toContain('Dana'); // titles stay PII-free; the name is only in the detail

    topupGranted(h, dev.user.id, 'tpu_1', 'dec_top');
    resolveDecision(h, 'dec_top', 'credit_topup');
    s = await h.snap();
    expect(s.attention).toEqual([]);

    // A top-up decision the credit events never explained still surfaces as a credit item.
    decide(h, 'dec_orphan', 'credit_topup', { at: ago(h, minutes(30)), requesterId: 'usr_other' });
    s = await h.snap();
    expect(s.attention.map((a) => [a.id, a.title, a.detail, a.costOfDelay.basis])).toEqual([
      [
        'credit_blocked:usr_other',
        'Credit top-up pending',
        null,
        'Credit top-up · 30m · waiting for approval',
      ],
    ]);
  });

  it('decision titles come from the decision payload, PII-scrubbed and capped at 120 characters', async () => {
    h = await setup();
    h.t.decisions!.request(
      {
        kind: 'fix_plan',
        title: `Fix plan for tkt_9: Login broken for jane.doe@example.com, call 0123456789 ${'and more '.repeat(20)}`,
        question: 'Approve?',
        options: [{ id: 'approve', label: 'Approve' }],
        subjectType: 'ticket',
        subjectId: 'tkt_9',
        projectId: 'prj_a',
        requesterId: 'usr_x',
      },
      sys,
    );
    decide(h, 'dec_unknown_to_service', 'rollback');
    const s = await h.snap();
    const fix = s.attention.find((a) => a.title.startsWith('Fix plan'))!;
    expect(fix.title.startsWith('Fix plan for tkt_9: Login broken for [email], call [number] and more')).toBe(
      true,
    );
    expect(fix.title.length).toBeLessThanOrEqual(120);
    expect(byId(s.attention, 'decision:dec_unknown_to_service').title).toBe('Rollback gate');
  });

  it('resolved, withdrawn and expired decisions leave the queue', async () => {
    h = await setup();
    decide(h, 'dec_1', 'fix_plan', { at: ago(h, hours(1)) });
    decide(h, 'dec_2', 'change_request', { at: ago(h, hours(1)) });
    decide(h, 'dec_3', 'lesson_binding', { at: ago(h, hours(1)) });
    resolveDecision(h, 'dec_1', 'fix_plan');
    h.emit({
      type: 'decision.withdrawn',
      actor: sys,
      scope: { decisionId: 'dec_2' },
      meta: { decisionId: 'dec_2', reason: 'superseded' },
      payload: {},
      source: 'api',
    });
    h.emit({
      type: 'decision.expired',
      actor: sys,
      scope: { decisionId: 'dec_3' },
      meta: { decisionId: 'dec_3', ageMs: hours(1) },
      source: 'scheduler',
    });
    expect((await h.snap()).attention).toEqual([]);
  });
});

describe('GET /api/tower', () => {
  it('serves Approvers and Builders (audit.view); requesters get 403, anonymous 401', async () => {
    h = await setup();
    const builder = h.t.user('builder');
    const requester = h.t.user('requester');
    expect((await h.t.request('GET', '/api/tower', { headers: builder.headers })).status).toBe(200);
    expect((await h.t.request('GET', '/api/tower', { headers: h.approver.headers })).status).toBe(200);
    const res = await h.t.request('GET', '/api/tower', { headers: requester.headers });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect((await h.t.request('GET', '/api/tower')).status).toBe(401);
  });

  it('?projectId= narrows every project-scoped section', async () => {
    h = await setup();
    decide(h, 'dec_a', 'go_live', { at: ago(h, hours(1)), projectId: 'prj_a' });
    decide(h, 'dec_b', 'go_live', { at: ago(h, hours(1)), projectId: 'prj_b' });
    decide(h, 'dec_global', 'lesson_binding', { at: ago(h, hours(1)), projectId: null });
    launch(h, 'ses_b', { projectId: 'prj_b', at: ago(h, hours(2)) });
    live(h, 'ses_b', 'stalled', ago(h, hours(1)));
    const all = await h.snap();
    expect(all.attention).toHaveLength(4);
    const b = await h.snap('?projectId=prj_b');
    expect(b.attention.map((a) => a.id).sort()).toEqual(['decision:dec_b', 'session_stalled:ses_b']);
    expect(b.fleet.byLiveness.stalled).toBe(1);
    expect(b.flow.decisionLatency).toEqual([expect.objectContaining({ kind: 'go_live', open: 1 })]);
    expect(b.anomalies.every((a) => a.scope === 'project:prj_b')).toBe(true);
    expect((await h.snap('?projectId=prj_none')).attention).toEqual([]);
    expect(
      (await h.t.request('GET', `/api/tower?projectId=${'x'.repeat(65)}`, { headers: h.approver.headers }))
        .status,
    ).toBe(422);
  });
});
