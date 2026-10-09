import { describe, expect, it } from 'vitest';
import type { MeteringThrottleDTO } from '@aoc/contracts';
import { closeDays, HOUR, launch, meteringRuntime, myt, throttleCleared, throttleHit } from './helpers';

describe('throttle-loss metering', () => {
  it('splits idle across local days, counts open throttles up to now, and stops the clock when a session ends', async () => {
    const t = await meteringRuntime();
    const approver = t.user('approver');
    const alice = t.user('builder', 'Alice');
    const bob = t.user('builder', 'Bob');
    launch(t, { sessionId: 'ses_1', ownerId: alice.user.id, projectId: 'prj_a' });
    launch(t, { sessionId: 'ses_2', ownerId: bob.user.id, projectId: 'prj_b' });
    launch(t, { sessionId: 'ses_3', ownerId: alice.user.id, projectId: 'prj_a' });

    t.clock.set(myt('2026-10-09', '22:00'));
    throttleHit(t, 'ses_1');
    t.clock.set(myt('2026-10-10', '00:20'));
    await closeDays(t); // freezes 10-09 with the 2h of the still-open throttle
    t.clock.set(myt('2026-10-10', '01:30'));
    throttleCleared(t, 'ses_1', 3.5 * HOUR);
    t.clock.set(myt('2026-10-10', '01:31'));
    throttleCleared(t, 'ses_1', 3.5 * HOUR); // a repeated clear is not new idle time

    t.clock.set(myt('2026-10-10', '10:00'));
    throttleHit(t, 'ses_2');
    t.clock.set(myt('2026-10-10', '10:30'));
    throttleHit(t, 'ses_3');
    t.clock.set(myt('2026-10-10', '11:00'));
    throttleHit(t, 'ses_2'); // repeat hit while throttled: a hit, not a second interval
    t.clock.set(myt('2026-10-10', '11:30'));
    t.rt.store.append({
      type: 'session.ended',
      actor: { kind: 'system', id: 'supervisor' },
      meta: { sessionId: 'ses_3', outcome: 'killed' },
      source: 'supervisor',
    });
    t.clock.set(myt('2026-10-10', '12:00'));

    const dto = await t.json<MeteringThrottleDTO>(
      'GET',
      '/api/metering/throttle?from=2026-10-09&to=2026-10-10',
      { headers: approver.headers },
    );
    expect(dto.days).toEqual([
      { date: '2026-10-09', status: 'closed', hits: 1, idleMs: 2 * HOUR, idleHours: 2 },
      { date: '2026-10-10', status: 'open', hits: 3, idleMs: 4.5 * HOUR, idleHours: 4.5 }, // 1.5h + 2h (open, up to now) + 1h
    ]);
    expect(dto.totals).toEqual({ hits: 4, idleMs: 6.5 * HOUR, idleHours: 6.5, throttledNow: 1 });
    expect(dto.bySession).toEqual([
      {
        sessionId: 'ses_1',
        ownerId: alice.user.id,
        projectId: 'prj_a',
        hits: 1,
        idleMs: 3.5 * HOUR,
        idleHours: 3.5,
        throttledNow: false,
      },
      {
        sessionId: 'ses_2',
        ownerId: bob.user.id,
        projectId: 'prj_b',
        hits: 2,
        idleMs: 2 * HOUR,
        idleHours: 2,
        throttledNow: true,
      },
      {
        sessionId: 'ses_3',
        ownerId: alice.user.id,
        projectId: 'prj_a',
        hits: 1,
        idleMs: HOUR,
        idleHours: 1,
        throttledNow: false,
      },
    ]);
    const owners = Object.fromEntries(dto.byOwner.map((o) => [o.ownerName, [o.hits, o.idleHours]]));
    expect(owners).toEqual({ Alice: [2, 4.5], Bob: [2, 2] });

    // the open throttle keeps accruing until it clears
    t.clock.set(myt('2026-10-10', '13:00'));
    const later = await t.json<MeteringThrottleDTO>(
      'GET',
      '/api/metering/throttle?from=2026-10-10&to=2026-10-10',
      { headers: approver.headers },
    );
    expect(later.days[0]!.idleHours).toBe(5.5);

    const mine = await t.json<MeteringThrottleDTO>(
      'GET',
      '/api/metering/throttle?from=2026-10-09&to=2026-10-10&mine=1',
      { headers: bob.headers },
    );
    expect(mine.scope).toBe('mine');
    expect(mine.days.map((d) => d.idleHours)).toEqual([0, 3]);
    expect(mine.bySession.map((s) => s.sessionId)).toEqual(['ses_2']);
    expect(mine.byOwner.map((o) => o.ownerId)).toEqual([bob.user.id]);
    expect(t.rt.store.list({ types: ['rollup.closed'] })[0]!.meta).toMatchObject({
      throttleIdleMs: 2 * HOUR,
      throttleHits: 1,
    });
    await t.close();
  });
});
