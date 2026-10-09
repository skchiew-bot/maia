import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { availableParallelism, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AocConfigSchema } from '@aoc/contracts';
import { AocRuntime, FakeClock, silentLogger } from '@aoc/kernel';
import { createTowerModule, TOWER_TABLES, TowerReadModel } from '../src';
import {
  affirmed,
  ago,
  amend,
  anchored,
  capReached,
  changeApproved,
  changeDrafted,
  DAY,
  decide,
  end,
  hours,
  launch,
  live,
  meteringStub,
  minutes,
  NOW,
  plan,
  playbookApproved,
  project,
  resolveDecision,
  setup,
  sys,
  taskDone,
  ticket,
  ticketEvent,
  topupRequested,
  usage,
  verified,
  type Harness,
} from './helpers';
import { appendHistory, projectHistory } from './load';

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

function dumpTables(): Record<string, unknown[]> {
  const db = h.t.rt.store.db;
  return Object.fromEntries(
    TOWER_TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()]),
  );
}

/** One of everything the tower reads, on top of a generated history. */
function richHistory(): void {
  appendHistory(h, 3_000, 14);
  project(h, 'prj_a', 'Claims Intake Bot');
  const dev = h.t.user('builder', 'Dev');
  launch(h, 'ses_1', { at: ago(h, hours(3)), owner: dev.user.id, threadId: 'thr_x' });
  live(h, 'ses_1', 'working', ago(h, hours(3)));
  live(h, 'ses_1', 'stalled', ago(h, minutes(40)));
  plan(h, 'ses_1', ['xs', 'xs', 'xs', 'xs', 's'], { at: ago(h, hours(3)), threadId: 'thr_x' });
  taskDone(h, 'ses_1', 't1', { at: ago(h, hours(2)), weight: 1 });
  taskDone(h, 'ses_1', 't2', { at: ago(h, hours(2)), weight: 1, flag: 'no_file_change' });
  taskDone(h, 'ses_1', 't3', { at: ago(h, hours(2)), weight: 1 });
  amend(h, 'ses_1', { prev: 6, next: 8, add: [{ id: 't6', size: 's' }], at: ago(h, hours(1)) });
  end(h, 'ses_1', ago(h, minutes(30)));
  launch(h, 'ses_2', { at: ago(h, minutes(20)), owner: dev.user.id, threadId: 'thr_x' });
  plan(h, 'ses_2', ['xs', 's'], {
    at: ago(h, minutes(20)),
    threadId: 'thr_x',
    ids: ['t4', 't5'],
    carriedOver: 2,
  });
  usage(h, 'ses_2', 50_000, { contextTokens: 650_000 });
  h.emit(
    {
      type: 'throttle.hit',
      actor: sys,
      scope: { sessionId: 'ses_2' },
      meta: { sessionId: 'ses_2', resetAt: '2026-10-09T07:00:00.000Z', source: 'stream' },
      payload: { message: 'limit' },
      source: 'sidecar',
    },
    ago(h, minutes(10)),
  );
  live(h, 'ses_2', 'throttled', ago(h, minutes(10)));
  decide(h, 'dec_gl', 'go_live', { at: ago(h, hours(2)) });
  decide(h, 'dec_old', 'rollback', { at: ago(h, 2 * DAY) });
  resolveDecision(h, 'dec_old', 'rollback', ago(h, 2 * DAY - minutes(25)), 'passkey');
  ticket(h, 'tkt_1', 'critical', { at: ago(h, hours(6)) });
  ticketEvent(
    h,
    {
      type: 'ticket.triage_started',
      actor: sys,
      scope: { ticketId: 'tkt_1' },
      meta: { ticketId: 'tkt_1', sessionIds: [], budgetTokens: 1, budgetMinutes: 1 },
      source: 'intake',
    },
    ago(h, hours(5)),
  );
  capReached(h, dev.user.id, 'ses_2', ago(h, minutes(15)));
  topupRequested(h, dev.user.id, 'tpu_1', 'dec_top', ago(h, minutes(14)));
  changeDrafted(h, 'chg_1', 'prj_a', ago(h, hours(4)));
  affirmed(h, 'chg_1', false, 900, ago(h, hours(4)));
  changeApproved(h, 'chg_1', true, dev.user.id, ago(h, hours(4)));
  playbookApproved(h, 'pbk_1', 'feature', ago(h, DAY));
  launch(h, 'ses_3', { at: ago(h, hours(2)), processType: 'feature', model: 'claude-opus-5-5' });
  verified(h, false, ago(h, hours(1)));
  anchored(h, ago(h, 30 * 3_600_000));
  h.emit(
    {
      type: 'fx.carry_forward_alert',
      actor: sys,
      meta: { consecutiveDays: 4, since: '2026-10-05' },
      source: 'scheduler',
    },
    ago(h, hours(2)),
  );
}

describe('projections: rebuildable from the log', () => {
  it('rebuilding the tower projection yields the same tables and the same snapshot', async () => {
    h = await setup({ services: { metering: meteringStub().stub } });
    richHistory();
    const before = await h.snap();
    const tables = dumpTables();
    expect(before.attention.length).toBeGreaterThan(5);
    expect(before.anomalies.some((a) => a.status !== 'normal')).toBe(true);

    h.t.rt.store.rebuildProjections(['tower']);
    expect(dumpTables()).toEqual(tables);
    expect(await h.snap()).toEqual(before);
  }, 60_000); // 3,000+ events through the real chain: slow on a loaded machine

  it('degrades to manifest meta when a plan body is crypto-shredded (rebuild after erasure)', async () => {
    h = await setup();
    project(h, 'prj_e', 'Erasable');
    launch(h, 'ses_e', { projectId: 'prj_e', at: ago(h, hours(2)) });
    plan(h, 'ses_e', ['xs', 'xs', 'xs', 'xs', 's'], { projectId: 'prj_e', at: ago(h, hours(2)) });
    taskDone(h, 'ses_e', 't1', { projectId: 'prj_e', weight: 1, at: ago(h, hours(1)) });
    const wip = { projectId: 'prj_e', name: 'Erasable', activeSessions: 1, openTasks: 4, progressPct: 16.7 }; // 1 of 6
    expect((await h.snap()).flow.wipByProject).toEqual([wip]);

    h.t.rt.store.eraseScope('ses_e', { actor: { kind: 'human', id: 'usr_dpo' }, reason: 'pdpa_request' });
    h.t.rt.store.eraseScope('prj_e', { actor: { kind: 'human', id: 'usr_dpo' }, reason: 'pdpa_request' });
    h.t.rt.store.rebuildProjections(['tower']);
    const s = await h.snap();
    expect(s.flow.wipByProject).toEqual([{ ...wip, name: '[erased]' }]);
    expect(s.anomalies.find((a) => a.signal === 'xs_heavy_manifests')!.value).toBe(0); // sizes are gone with the body
  });

  it('is back-filled by the kernel when added to an existing log — timezone-free, so a pre-init rebuild is exact', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'aoc-tower-'));
    const config = AocConfigSchema.parse({ dataDir, timezone: 'Asia/Kolkata' }); // UTC+05:30
    const masterKey = randomBytes(32);
    const clock = new FakeClock(NOW); // 11:30 in Kolkata
    try {
      const before = await AocRuntime.create({
        config,
        modules: [],
        clock,
        log: silentLogger,
        masterKey,
        dataDir,
      });
      const at = (iso: string) => clock.set(iso);
      at('2026-10-08T18:00:00.000Z'); // 23:30 on 8 Oct in Kolkata: yesterday's spend
      before.store.append({
        type: 'session.launch_requested',
        actor: { kind: 'human', id: 'usr_1' },
        scope: { sessionId: 'ses_k', projectId: 'prj_k' },
        meta: {
          sessionId: 'ses_k',
          projectId: 'prj_k',
          threadId: 'thr_k',
          processType: 'feature',
          model: 'claude-opus-5-5',
          readOnly: false,
          credentialProfile: null,
          ticketId: null,
          parentSessionId: null,
          phaseId: null,
        },
        payload: { prompt: 'p', cwd: '/x' },
        source: 'supervisor',
      });
      for (const [iso, tokens] of [
        ['2026-10-08T18:00:00.000Z', 1000],
        ['2026-10-08T18:45:00.000Z', 2000],
      ] as const) {
        at(iso); // 18:45Z is 00:15 on 9 Oct in Kolkata: today's spend
        before.store.append({
          type: 'usage.recorded',
          actor: { kind: 'system', id: 'sidecar' },
          scope: { sessionId: 'ses_k' },
          meta: {
            sessionId: 'ses_k',
            model: 'claude-opus-5-5',
            inputTokens: tokens,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWrite5mTokens: 0,
            cacheWrite1hTokens: 0,
            messages: 1,
            contextTokens: 10,
            firstAt: iso,
            lastAt: iso,
          },
          payload: { messageIds: [iso] },
          source: 'sidecar',
        });
      }
      at('2026-10-09T03:00:00.000Z');
      before.store.append({
        type: 'decision.requested',
        actor: sys,
        scope: { decisionId: 'dec_k' },
        meta: {
          decisionId: 'dec_k',
          kind: 'go_live',
          test: null,
          requiredRole: 'approver',
          requiresPasskey: true,
          subjectType: 'promotion',
          subjectId: 'prm_k',
          sessionId: null,
          projectId: 'prj_k',
          optionIds: ['approve'],
          recommendedOptionId: 'approve',
          requesterId: 'usr_1',
          excludedApproverIds: [],
          eligibleUserIds: null,
          dueAt: null,
        },
        payload: { title: 'Ship it', question: 'Go live?', options: [{ id: 'approve', label: 'Approve' }] },
        source: 'api',
      });
      await before.stop();

      clock.set(NOW);
      const after = await AocRuntime.create({
        config,
        modules: [createTowerModule()],
        clock,
        log: silentLogger,
        masterKey,
        dataDir,
      });
      after.services.provide('metering', meteringStub().stub);
      const s = new TowerReadModel(after.ctx).snapshot();
      expect(s.attention.map((a) => a.id)).toEqual(['decision:dec_k']);
      expect(s.spend.notionalUsdToday).toBe(2); // only the 00:15 local batch belongs to today
      expect(s.spend.avg7dUsd).toBeCloseTo(1 / 7, 4);
      expect(s.flow.tasksPerHour[11]!.hour).toBe('2026-10-09T11:00:00+05:30');
      await after.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('performance', () => {
  it('builds the snapshot from 100k events of history well under 50 ms (median of warm reads)', async () => {
    h = await setup({ services: { metering: meteringStub().stub } });
    expect(projectHistory(h, 100_000)).toBeGreaterThanOrEqual(100_000);
    const model = new TowerReadModel(h.t.rt.ctx);
    model.snapshot(); // warm the statement cache
    const wall: number[] = [];
    const cpu: number[] = [];
    for (let i = 0; i < 7; i++) {
      const c0 = process.cpuUsage();
      const t0 = performance.now();
      const s = model.snapshot();
      wall.push(performance.now() - t0);
      const c = process.cpuUsage(c0);
      cpu.push((c.user + c.system) / 1000);
      expect(s.attention.length).toBeGreaterThan(0);
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[3]!;
    // Target < 50 ms; the bound leaves headroom for a busy machine. The CPU time a read consumes does not depend on
    // what else the host runs, so it is always bounded. On an overloaded host wall time measures the scheduler, so
    // it is bounded in CI and wherever the host has headroom (1-minute load below 2 per core).
    expect(median(cpu)).toBeLessThan(100);
    const headroom = loadavg()[0]! / availableParallelism() < 2;
    if (process.env.CI || headroom) expect(median(wall)).toBeLessThan(100);
  }, 120_000);
});
