import { afterEach, describe, expect, it } from 'vitest';
import { end, launch, live, setup, sys, usage, type Harness } from './helpers';

let h: Harness;
afterEach(async () => h?.close());

const at = (iso: string) => Date.parse(iso);

describe('fleet', () => {
  it('replays the liveness history into a 2h trend of 5-minute buckets and derives today’s rates', async () => {
    h = await setup(); // now 06:00Z = 14:00 local; local midnight = 2026-10-08T16:00Z
    launch(h, 'ses_a', { at: at('2026-10-08T14:00:00.000Z') });
    live(h, 'ses_a', 'working', at('2026-10-08T15:00:00.000Z'));
    live(h, 'ses_a', 'stalled', at('2026-10-09T05:02:00.000Z'));
    live(h, 'ses_a', 'working', at('2026-10-09T05:31:00.000Z'));
    launch(h, 'ses_b', { at: at('2026-10-09T04:30:00.000Z') });
    live(h, 'ses_b', 'thinking', at('2026-10-09T04:31:00.000Z'));
    live(h, 'ses_b', 'dead', at('2026-10-09T05:12:00.000Z'));
    end(h, 'ses_b', at('2026-10-09T05:40:00.000Z'));
    launch(h, 'ses_c', { at: at('2026-10-09T01:00:00.000Z') });
    h.emit(
      {
        type: 'throttle.hit',
        actor: sys,
        scope: { sessionId: 'ses_c' },
        meta: { sessionId: 'ses_c', resetAt: null, source: 'exit' },
        payload: { message: 'limit' },
        source: 'sidecar',
      },
      at('2026-10-09T02:00:00.000Z'),
    );
    live(h, 'ses_c', 'throttled', at('2026-10-09T02:00:00.000Z'));
    launch(h, 'ses_d', { at: at('2026-10-09T00:30:00.000Z') });
    live(h, 'ses_d', 'working', at('2026-10-09T01:00:00.000Z'));
    end(h, 'ses_d', at('2026-10-09T03:00:00.000Z'));
    launch(h, 'ses_e', { at: at('2026-10-07T10:00:00.000Z') });
    live(h, 'ses_e', 'working', at('2026-10-07T10:00:00.000Z'));
    h.emit(
      {
        type: 'throttle.cleared',
        actor: sys,
        scope: { sessionId: 'ses_e' },
        meta: { sessionId: 'ses_e', idleMs: 3_600_000 },
        source: 'sidecar',
      },
      at('2026-10-08T09:00:00.000Z'),
    );
    end(h, 'ses_e', at('2026-10-08T10:00:00.000Z'));
    launch(h, 'ses_f', { at: at('2026-10-09T00:00:00.000Z') });
    h.emit(
      {
        type: 'throttle.hit',
        actor: sys,
        scope: { sessionId: 'ses_f' },
        meta: { sessionId: 'ses_f', resetAt: null, source: 'exit' },
        payload: { message: 'limit' },
        source: 'sidecar',
      },
      at('2026-10-09T01:00:00.000Z'),
    );
    h.emit(
      {
        type: 'throttle.cleared',
        actor: sys,
        scope: { sessionId: 'ses_f' },
        meta: { sessionId: 'ses_f', idleMs: 1_800_000 },
        source: 'sidecar',
      },
      at('2026-10-09T01:30:00.000Z'),
    );
    live(h, 'ses_f', 'working', at('2026-10-09T01:30:00.000Z'));
    end(h, 'ses_f', at('2026-10-09T02:00:00.000Z'));
    usage(h, 'ses_a', 10, { contextTokens: 700_000 });
    usage(h, 'ses_c', 10, { contextTokens: 500_000, at: at('2026-10-09T01:30:00.000Z') });
    usage(h, 'ses_b', 10, { contextTokens: 900_000, at: at('2026-10-09T05:00:00.000Z') });

    const { fleet } = await h.snap();
    expect(fleet.trend).toHaveLength(24);
    expect(fleet.trend[0]!.at).toBe('2026-10-09T04:05:00.000Z');
    expect(fleet.trend[23]!.at).toBe('2026-10-09T06:00:00.000Z');
    const zero = { working: 0, thinking: 0, stalled: 0, dead: 0, throttled: 0, waiting_on_you: 0 };
    const point = (i: number) => {
      const { at: _at, ...counts } = fleet.trend[i]!;
      return counts;
    };
    expect(point(0)).toEqual({ ...zero, working: 1, throttled: 1 }); // 04:05
    expect(point(6)).toEqual({ ...zero, working: 1, thinking: 1, throttled: 1 }); // 04:35
    expect(point(12)).toEqual({ ...zero, stalled: 1, thinking: 1, throttled: 1 }); // 05:05
    expect(point(14)).toEqual({ ...zero, stalled: 1, dead: 1, throttled: 1 }); // 05:15
    expect(point(18)).toEqual({ ...zero, working: 1, dead: 1, throttled: 1 }); // 05:35
    expect(point(19)).toEqual({ ...zero, working: 1, throttled: 1 }); // 05:40: ses_b ended
    expect(point(23)).toEqual({ ...zero, working: 1, throttled: 1 });

    expect(fleet.byLiveness).toEqual({
      waiting_on_you: 0,
      throttled: 1,
      dead: 0,
      stalled: 0,
      thinking: 0,
      working: 1,
      ended_today: 3,
    });
    expect(fleet.stallRatePct).toBe(20); // ses_a stalled today; live today: a, b, c, d, f
    expect(fleet.throttleLostMsToday).toBe(4 * 3_600_000 + 1_800_000); // ses_c still throttled since 02:00 + ses_f's 30m
    expect(fleet.rolloverPressure).toBe(1); // ses_a at 70% of a 1M window
  });

  it('counts nothing for an empty fleet', async () => {
    h = await setup();
    const { fleet } = await h.snap();
    expect(fleet).toMatchObject({ stallRatePct: 0, throttleLostMsToday: 0, rolloverPressure: 0 });
    expect(
      fleet.trend.every(
        (p) => p.working + p.thinking + p.stalled + p.dead + p.throttled + p.waiting_on_you === 0,
      ),
    ).toBe(true);
  });
});
