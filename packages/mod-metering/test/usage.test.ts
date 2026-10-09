import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MeteringDailyDTO, MeteringSessionDTO, MeteringSummaryDTO, RateCardRate } from '@aoc/contracts';
import { closeDays, launch, meteringRuntime, myt, RATE_CARD_FILE, taskDone, usage } from './helpers';

const fileRates = (JSON.parse(readFileSync(RATE_CARD_FILE, 'utf8')) as { rates: RateCardRate[] }).rates;

describe('usage projection', () => {
  it('resolves the owner from the launch actor, the parent session, a rollover predecessor or the sessions directory', async () => {
    const t = await meteringRuntime();
    const approver = t.user('approver');
    const alice = t.user('builder', 'Alice');
    const bob = t.user('builder', 'Bob');
    launch(t, { sessionId: 'ses_a', ownerId: alice.user.id, projectId: 'prj_a' });
    usage(t, 'ses_a', { input: 1_000_000 }); // $4
    launch(t, { sessionId: 'ses_child', ownerId: null, parentSessionId: 'ses_a', projectId: 'prj_a' });
    usage(t, 'ses_child', { output: 1_000_000 }); // $20
    // successor launched by the supervisor; ownership arrives with the rollover event, after usage
    launch(t, { sessionId: 'ses_next', ownerId: null, projectId: 'prj_a' });
    usage(t, 'ses_next', { cacheRead: 1_000_000 }); // $0.2
    t.rt.store.append({
      type: 'session.rollover_completed',
      actor: { kind: 'system', id: 'supervisor' },
      meta: { threadId: 'thr_1', fromSessionId: 'ses_a', toSessionId: 'ses_next' },
      source: 'supervisor',
    });
    // observed session: the sessions directory maps it to Bob
    t.sessions!.add({
      sessionId: 'ses_obs',
      mode: 'observed',
      ownerId: bob.user.id,
      projectId: 'prj_b',
      processType: null,
    });
    t.rt.store.append({
      type: 'session.observed',
      actor: { kind: 'system', id: 'hooks' },
      meta: { sessionId: 'ses_obs', claudeSessionId: 'c-1', projectId: 'prj_b' },
      payload: { cwd: '/tmp', transcriptPath: '/tmp/t.jsonl' },
      source: 'hook',
    });
    usage(t, 'ses_obs', { model: 'claude-sonnet-5-5', input: 1_000_000 }); // $2

    const byActor = await t.json<MeteringSummaryDTO>('GET', '/api/metering/summary?groupBy=actor', {
      headers: approver.headers,
    });
    // people are listed by id, never ranked by spend
    const expected = [
      [alice.user.id, 'Alice', 24.2],
      [bob.user.id, 'Bob', 2],
    ].sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
    expect(byActor.rows.map((r) => [r.key, r.label, r.notionalUsd])).toEqual(expected);
    const byProject = await t.json<MeteringSummaryDTO>('GET', '/api/metering/summary?groupBy=project', {
      headers: approver.headers,
    });
    expect(byProject.rows.map((r) => [r.key, r.notionalUsd])).toEqual([
      ['prj_a', 24.2],
      ['prj_b', 2],
    ]);
    expect(t.rt.services.get('metering').sessionCostUsd('ses_a')).toBeCloseTo(4, 9);
    await t.close();
  });

  it('attributes unattributed usage to the next task closed, never repricing it', async () => {
    const t = await meteringRuntime();
    const approver = t.user('approver');
    const alice = t.user('builder', 'Alice');
    launch(t, { sessionId: 'ses_1', ownerId: alice.user.id, projectId: 'prj_a', phaseId: 'ph1' });
    usage(t, 'ses_1', { input: 1_000_000 }); // $4
    usage(t, 'ses_1', { output: 1_000_000 }); // $20
    taskDone(t, { sessionId: 'ses_1', taskId: 't1', phaseId: 'ph1' });
    usage(t, 'ses_1', { cw5m: 1_000_000, cw1h: 1_000_000 }); // $13
    taskDone(t, { sessionId: 'ses_1', taskId: 't2', phaseId: 'ph2' });
    usage(t, 'ses_1', { input: 500_000 }); // $2, not yet attributed

    // a dearer card from tomorrow must not touch any of today's rows, even when they are attributed tomorrow
    const dearer = fileRates.map((r) => ({ ...r, inputPerMTok: r.inputPerMTok * 10 }));
    await t.json('PUT', '/api/ratecard', { headers: approver.headers, body: { rates: dearer }, expect: 201 });
    t.clock.set(myt('2026-10-10', '09:00'));
    taskDone(t, { sessionId: 'ses_1', taskId: 't3', phaseId: 'ph2' });
    usage(t, 'ses_1', { input: 100_000 }); // $4 at v2 (0.1M × $40), unattributed

    const s = await t.json<MeteringSessionDTO>('GET', '/api/metering/sessions/ses_1', {
      headers: alice.headers,
    });
    expect(s).toMatchObject({
      sessionId: 'ses_1',
      ownerId: alice.user.id,
      projectId: 'prj_a',
      processType: 'feature',
    });
    expect(s.byTask.map((r) => [r.key, r.notionalUsd])).toEqual([
      ['prj_a/t1', 24],
      ['prj_a/t2', 13],
      ['prj_a/t3', 2],
      [null, 4],
    ]);
    expect(s.byTask[1]).toMatchObject({
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
      cacheWriteTokens: 2_000_000,
    });
    expect(s.byDay.map((d) => [d.date, d.notionalUsd])).toEqual([
      ['2026-10-09', 39],
      ['2026-10-10', 4],
    ]);
    expect(s.totals.notionalUsd).toBe(43);
    expect(t.rt.services.get('metering').sessionCostUsd('ses_1')).toBeCloseTo(43, 9);

    const byTask = await t.json<MeteringSummaryDTO>(
      'GET',
      '/api/metering/summary?groupBy=task&from=2026-10-09&to=2026-10-10',
      { headers: approver.headers },
    );
    expect(byTask.rows.find((r) => r.key === 'prj_a/t1')?.notionalUsd).toBe(24);

    // without metering access the caller cannot even learn whether a session exists
    const requester = t.user('requester');
    const status = async (path: string, headers: Record<string, string>) =>
      (await t.request('GET', path, { headers })).status;
    expect(await status('/api/metering/sessions/ses_1', requester.headers)).toBe(403);
    expect(await status('/api/metering/sessions/ses_nope', requester.headers)).toBe(403);
    expect(await status('/api/metering/sessions/ses_nope', approver.headers)).toBe(404);
    await t.close();
  });

  it('books usage for a closed or implausibly old day on its arrival day, and clamps future timestamps', async () => {
    const t = await meteringRuntime();
    const approver = t.user('approver');
    launch(t, { sessionId: 'ses_1', ownerId: approver.user.id });
    usage(t, 'ses_1', { input: 1_000_000 }); // 10-09
    t.clock.set(myt('2026-10-10', '00:20'));
    await closeDays(t);
    usage(t, 'ses_1', { input: 1_000_000, at: myt('2026-10-09', '23:58') }); // late for closed 10-09
    usage(t, 'ses_1', { input: 1_000_000, at: myt('2026-08-01', '10:00') }); // older than the back-date window
    usage(t, 'ses_1', { input: 1_000_000, at: myt('2026-10-12', '10:00') }); // sidecar clock ahead
    const daily = await t.json<MeteringDailyDTO>('GET', '/api/metering/daily?from=2026-10-09&to=2026-10-12', {
      headers: approver.headers,
    });
    expect(daily.days.map((d) => [d.date, d.status, d.notionalUsd])).toEqual([
      ['2026-10-09', 'closed', 4],
      ['2026-10-10', 'open', 12],
    ]);
    const late = t.rt.ctx.db.prepare('SELECT source_date, date, late FROM mtr_usage ORDER BY seq').all();
    expect(late.map((r) => [r.source_date, r.date, r.late])).toEqual([
      ['2026-10-09', '2026-10-09', 0],
      ['2026-10-09', '2026-10-10', 1],
      ['2026-08-01', '2026-10-10', 1],
      ['2026-10-12', '2026-10-10', 0],
    ]);
    await t.close();
  });
});
