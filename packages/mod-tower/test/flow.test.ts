import { afterEach, describe, expect, it } from 'vitest';
import type { LedgerService, Progress } from '@aoc/contracts';
import {
  ago,
  amend,
  decide,
  DAY,
  HOUR,
  hours,
  launch,
  minutes,
  plan,
  project,
  resolveDecision,
  setup,
  sys,
  taskDone,
  ticket,
  ticketEvent,
  type Harness,
} from './helpers';

let h: Harness;
afterEach(async () => h?.close());

const at = (iso: string) => Date.parse(iso);

describe('flow', () => {
  it('verified vs flagged closes per local hour, same-hour 7-day baseline and the same-time-of-day KPI', async () => {
    h = await setup({ now: '2026-10-09T06:30:00.000Z' }); // 14:30 in Kuala Lumpur
    launch(h, 'ses_1', { at: at('2026-09-30T00:00:00.000Z') });
    let n = 0;
    const done = (iso: string, o: { evidenceVerified?: boolean; flag?: 'no_file_change' | null } = {}) =>
      taskDone(h, 'ses_1', `t${++n}`, { at: at(iso), ...o });
    // today (local): 01:30 (before the 12h window), 13:10 ×2, 13:20 flagged, 14:10 unverified, 14:20
    done('2026-10-08T17:30:00.000Z');
    done('2026-10-09T05:10:00.000Z');
    done('2026-10-09T05:11:00.000Z');
    done('2026-10-09T05:20:00.000Z', { flag: 'no_file_change' });
    done('2026-10-09T06:10:00.000Z', { evidenceVerified: false });
    done('2026-10-09T06:20:00.000Z');
    // previous 7 days: one verified close at 13:15 local each day
    for (let d = 1; d <= 7; d++) done(new Date(at('2026-10-09T05:15:00.000Z') - d * DAY).toISOString());
    done('2026-10-08T07:00:00.000Z'); // yesterday 15:00 — after the current time of day, outside the window
    done('2026-10-07T05:20:00.000Z', { evidenceVerified: false }); // flagged: never in a baseline
    done('2026-10-05T19:30:00.000Z'); // 03:30 local three days ago → first hour of the window
    done('2026-10-01T05:15:00.000Z'); // 8 days ago: outside the baseline

    const s = await h.snap();
    expect(s.flow.tasksPerHour.map((x) => x.hour)).toEqual(
      Array.from({ length: 12 }, (_, i) => `2026-10-09T${String(3 + i).padStart(2, '0')}:00:00+08:00`),
    );
    expect(s.flow.tasksPerHour[10]).toEqual({ hour: '2026-10-09T13:00:00+08:00', verified: 2, flagged: 1 });
    expect(s.flow.tasksPerHour[11]).toEqual({ hour: '2026-10-09T14:00:00+08:00', verified: 1, flagged: 1 });
    expect(s.flow.tasksPerHour.slice(0, 10).every((x) => x.verified === 0 && x.flagged === 0)).toBe(true);
    expect(s.flow.baselinePerHour).toEqual([0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
    expect(s.kpis.tasksVerifiedToday).toBe(4);
    expect(s.kpis.tasksVerifiedBaseline).toBe(1.1); // 8 closes before 14:30 on the previous 7 days ÷ 7
    expect(s.summary).toContain('Flow 4 verified tasks vs 1 baseline.');
  });

  it('ticket funnel: count, oldest and median age in stage; bottleneck = highest median age × count', async () => {
    h = await setup();
    const triage = (id: string, ms: number) =>
      ticketEvent(
        h,
        {
          type: 'ticket.triage_started',
          actor: sys,
          scope: { ticketId: id },
          meta: { ticketId: id, sessionIds: [], budgetTokens: 1, budgetMinutes: 1 },
          source: 'intake',
        },
        ms,
      );
    const build = (id: string, ms: number) =>
      ticketEvent(
        h,
        {
          type: 'ticket.build_started',
          actor: sys,
          scope: { ticketId: id },
          meta: { ticketId: id, sessionId: `ses_${id}`, changeId: null },
          source: 'intake',
        },
        ms,
      );
    const close = (id: string, resolution: 'fixed' | 'wont_fix', ms: number) =>
      ticketEvent(
        h,
        {
          type: 'ticket.closed',
          actor: sys,
          scope: { ticketId: id },
          meta: { ticketId: id, resolution },
          payload: {},
          source: 'intake',
        },
        ms,
      );
    ticket(h, 'tkt_rec', 'low', { at: ago(h, minutes(30)) });
    for (const [id, hrs] of [
      ['tkt_t1', 1],
      ['tkt_t2', 2],
      ['tkt_t3', 3],
    ] as const) {
      ticket(h, id, 'low', { at: ago(h, hours(5)) });
      triage(id, ago(h, hours(hrs)));
    }
    ticket(h, 'tkt_fp', 'low', { at: ago(h, hours(12)) });
    ticketEvent(
      h,
      {
        type: 'ticket.fix_plan_submitted',
        actor: sys,
        scope: { ticketId: 'tkt_fp' },
        meta: { ticketId: 'tkt_fp', decisionId: 'dec_fp', sourceSessionId: null },
        payload: { fixPlan: 'x' },
        source: 'intake',
      },
      ago(h, hours(10)),
    );
    ticket(h, 'tkt_b1', 'low', { at: ago(h, hours(6)) });
    build('tkt_b1', ago(h, hours(4)));
    ticket(h, 'tkt_b2', 'low', { at: ago(h, hours(9)) });
    build('tkt_b2', ago(h, hours(7)));
    for (const [id, days, res] of [
      ['tkt_c1', 1, 'fixed'],
      ['tkt_c2', 2, 'fixed'],
      ['tkt_c3', 10, 'fixed'],
      ['tkt_w', 1, 'wont_fix'],
    ] as const) {
      ticket(h, id, 'low', { at: ago(h, (days + 1) * DAY) });
      close(id, res, ago(h, days * DAY));
    }

    const s = await h.snap();
    const iso = (ms: number) => new Date(ms).toISOString();
    expect(s.flow.ticketFunnel).toEqual([
      {
        stage: 'received',
        count: 1,
        oldestSince: iso(ago(h, minutes(30))),
        medianAgeMs: minutes(30),
        bottleneck: false,
      },
      {
        stage: 'triage',
        count: 3,
        oldestSince: iso(ago(h, hours(3))),
        medianAgeMs: hours(2),
        bottleneck: false,
      },
      { stage: 'awaiting_human', count: 0, oldestSince: null, medianAgeMs: null, bottleneck: false },
      {
        stage: 'fix_plan_gate',
        count: 1,
        oldestSince: iso(ago(h, hours(10))),
        medianAgeMs: hours(10),
        bottleneck: false,
      },
      {
        stage: 'building',
        count: 2,
        oldestSince: iso(ago(h, hours(7))),
        medianAgeMs: hours(5.5),
        bottleneck: true,
      },
      { stage: 'uat', count: 0, oldestSince: null, medianAgeMs: null, bottleneck: false },
      { stage: 'go_live_gate', count: 0, oldestSince: null, medianAgeMs: null, bottleneck: false },
      { stage: 'completed', count: 2, oldestSince: null, medianAgeMs: null, bottleneck: false },
      { stage: 'closed', count: 1, oldestSince: null, medianAgeMs: null, bottleneck: false },
    ]);
    expect(s.kpis.openTickets).toBe(7);
    expect(s.kpis.oldestTicketSince).toBe(iso(ago(h, hours(12))));
  });

  it('decision latency by kind: p50/p90 of human resolutions in 7d, open count, SLA breaches; gate KPI excludes UAT', async () => {
    h = await setup();
    const resolved = (
      id: string,
      kind: Parameters<typeof decide>[2],
      latencyMs: number,
      resolvedAgo: number,
      method: 'button' | 'policy' = 'button',
    ) => {
      decide(h, id, kind, { at: ago(h, resolvedAgo + latencyMs) });
      resolveDecision(h, id, kind, ago(h, resolvedAgo), method);
    };
    [10, 20, 30, 40, 180].forEach((m, i) => resolved(`dec_gl${i}`, 'go_live', minutes(m), 2 * DAY));
    resolved('dec_gl_old', 'go_live', minutes(5), 8 * DAY);
    decide(h, 'dec_gl_open', 'go_live', { at: ago(h, hours(3)) });
    resolved('dec_bg1', 'break_glass', minutes(10), DAY);
    resolved('dec_bg2', 'break_glass', minutes(30), DAY);
    decide(h, 'dec_bg_open', 'break_glass', { at: ago(h, minutes(20)) });
    resolved('dec_auto', 'credit_topup', 0, DAY, 'policy');
    resolved('dec_uat', 'uat_signoff', hours(5), DAY);

    const s = await h.snap();
    expect(s.flow.decisionLatency).toEqual([
      {
        kind: 'go_live',
        open: 1,
        resolved7d: 5,
        p50Ms: minutes(30),
        p90Ms: minutes(124),
        slaMs: hours(2),
        breaches: 2,
      },
      {
        kind: 'break_glass',
        open: 1,
        resolved7d: 2,
        p50Ms: minutes(20),
        p90Ms: minutes(28),
        slaMs: minutes(15),
        breaches: 2,
      },
      {
        kind: 'uat_signoff',
        open: 0,
        resolved7d: 1,
        p50Ms: hours(5),
        p90Ms: hours(5),
        slaMs: hours(24),
        breaches: 0,
      },
    ]);
    expect(s.kpis).toMatchObject({
      gateLatencyP50Ms: minutes(30),
      gateLatencyP90Ms: minutes(96),
      gateSlaMs: HOUR,
    });
    expect(s.summary).toContain('Gate latency p50 30m (SLA 1h).');
  });

  it('WIP by project: active sessions, open tasks (declared + added − closed, carried once), progress from the ledger or own weights', async () => {
    const pct: Record<string, number> = { prj_a: 77.7 };
    const ledger = {
      projectProgress: (id: string) => (id in pct ? ({ pct: pct[id] } as Progress) : null),
    } as unknown as LedgerService;
    for (const withLedger of [false, true]) {
      h = await setup({ services: withLedger ? { ledger } : {} });
      project(h, 'prj_a', 'Claims Intake Bot');
      project(h, 'prj_b', 'CX Copilot');
      project(h, 'prj_c', 'Done Project');
      launch(h, 'ses_a1', { at: ago(h, hours(3)) });
      launch(h, 'ses_a2', { at: ago(h, hours(3)) });
      h.emit({
        type: 'session.lifecycle_changed',
        actor: sys,
        scope: { sessionId: 'ses_a2' },
        meta: { sessionId: 'ses_a2', from: 'running', to: 'waiting_decision', reason: 'decision' },
        source: 'supervisor',
      });
      launch(h, 'ses_a3', { at: ago(h, hours(3)) });
      h.emit({
        type: 'session.ended',
        actor: sys,
        scope: { sessionId: 'ses_a3' },
        meta: { sessionId: 'ses_a3', outcome: 'completed' },
        source: 'supervisor',
      });
      plan(h, 'ses_a1', ['s', 'm', 'l']);
      taskDone(h, 'ses_a1', 't1', { weight: 2 });
      taskDone(h, 'ses_a1', 't1', { weight: 2 }); // a repeated close never double-counts
      amend(h, 'ses_a1', { prev: 10, next: 13, add: [{ id: 't4', size: 'm' }] });
      plan(h, 'ses_a2', ['xs', 'xs']);
      // Rollover: the successor re-declares the predecessor's open task t2 in the same thread — counted once.
      launch(h, 'ses_r1', { projectId: 'prj_d', threadId: 'thr_d', at: ago(h, hours(6)) });
      plan(h, 'ses_r1', ['s', 'm'], { projectId: 'prj_d', threadId: 'thr_d' });
      taskDone(h, 'ses_r1', 't1', { projectId: 'prj_d', weight: 2 });
      h.emit({
        type: 'session.ended',
        actor: sys,
        scope: { sessionId: 'ses_r1' },
        meta: { sessionId: 'ses_r1', outcome: 'retired' },
        source: 'supervisor',
      });
      launch(h, 'ses_r2', { projectId: 'prj_d', threadId: 'thr_d', at: ago(h, hours(1)) });
      plan(h, 'ses_r2', ['m', 's'], {
        projectId: 'prj_d',
        threadId: 'thr_d',
        ids: ['t2', 't3'],
        carriedOver: 1,
      });
      launch(h, 'ses_b1', { projectId: 'prj_b', at: ago(h, hours(9)) });
      plan(h, 'ses_b1', ['m'], { projectId: 'prj_b' });
      h.emit({
        type: 'session.ended',
        actor: sys,
        scope: { sessionId: 'ses_b1' },
        meta: { sessionId: 'ses_b1', outcome: 'failed' },
        source: 'supervisor',
      });
      launch(h, 'ses_c1', { projectId: 'prj_c', at: ago(h, hours(9)) });
      plan(h, 'ses_c1', ['s'], { projectId: 'prj_c' });
      taskDone(h, 'ses_c1', 't1', { projectId: 'prj_c', weight: 2 });
      h.emit({
        type: 'session.ended',
        actor: sys,
        scope: { sessionId: 'ses_c1' },
        meta: { sessionId: 'ses_c1', outcome: 'completed' },
        source: 'supervisor',
      });

      const s = await h.snap();
      expect(s.flow.wipByProject).toEqual([
        {
          projectId: 'prj_a',
          name: 'Claims Intake Bot',
          activeSessions: 2,
          openTasks: 5,
          progressPct: withLedger ? 77.7 : 13.3,
        }, // 2 of 15
        { projectId: 'prj_d', name: 'prj_d', activeSessions: 1, openTasks: 2, progressPct: 28.6 }, // 2 of 7 (t2 once)
        { projectId: 'prj_b', name: 'CX Copilot', activeSessions: 0, openTasks: 1, progressPct: 0 },
      ]);
      if (!withLedger) await h.close();
    }
  });
});
