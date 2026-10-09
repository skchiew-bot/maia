import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG } from '@aoc/contracts';
import { createMeteringModule } from '../src';
import {
  closeDays,
  HOUR,
  launch,
  meteringRuntime,
  myt,
  taskDone,
  throttleCleared,
  throttleHit,
  usage,
} from './helpers';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const sources = readdirSync(SRC)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ file: f, text: readFileSync(join(SRC, f), 'utf8') }));
const ownedByMetering = [...EVENT_CATALOG.values()].filter((d) => d.owner === 'metering').map((d) => d.type);
/** What gating looks like in the log: blocks, denials, decision cards and anything credit. */
const isGating = (type: string) =>
  type === 'session.blocked' ||
  type === 'tool.denied' ||
  type.startsWith('decision.') ||
  type.startsWith('credit.');

describe('metering observes; it never gates (§10)', () => {
  it('registers no PreToolUse guard and no reactor', () => {
    const m = createMeteringModule();
    expect(m.guards ?? []).toEqual([]);
    expect(m.reactors ?? []).toEqual([]);
  });

  it('its source appends only metering-owned events and never names a gating or credit event', () => {
    expect(ownedByMetering.sort()).toEqual(['ratecard.published', 'rollup.closed', 'subscription.updated']);
    const appended = sources.flatMap(({ text }) =>
      [...text.matchAll(/\.append(?:Many)?\(\s*\{\s*type:\s*'([^']+)'/g)].map((m) => m[1]!),
    );
    expect([...new Set(appended)].sort()).toEqual(ownedByMetering);
    const gatingTypes = [...EVENT_CATALOG.keys()].filter(isGating);
    expect(gatingTypes).toEqual(expect.arrayContaining(['session.blocked', 'credit.cap_reached']));
    for (const { file, text } of sources) {
      expect(
        gatingTypes.filter((type) => text.includes(`'${type}'`)),
        file,
      ).toEqual([]);
      expect(text, file).not.toMatch(
        /services\.(get|maybe)\(\s*'(credits|policy|supervisor|decisions)'\s*\)/,
      );
    }
  });

  it('however much a session spends or idles, the log gains only rate cards, subscriptions and rollups', async () => {
    const t = await meteringRuntime({ now: myt('2026-10-09', '09:00') });
    const approver = t.user('approver');
    const dev = t.user('builder');
    const fromTest = new Set(t.rt.store.list().map((e) => e.id)); // the seeded v1 rate card and subscription included
    const record = () => {
      for (const e of t.rt.store.list()) fromTest.add(e.id);
    };

    launch(t, { sessionId: 'ses_big', ownerId: dev.user.id });
    launch(t, { sessionId: 'ses_idle', ownerId: dev.user.id });
    // Far beyond any credit allocation: 2 billion opus input tokens ≈ $8,000 notional.
    for (let i = 0; i < 4; i++) usage(t, 'ses_big', { input: 500_000_000, output: 5_000_000 });
    throttleHit(t, 'ses_idle');
    t.clock.set(myt('2026-10-09', '15:00'));
    throttleCleared(t, 'ses_idle', 6 * HOUR);
    taskDone(t, { sessionId: 'ses_big', taskId: 't1' });
    record();

    // Every read surface, then every write path of the module.
    for (const path of [
      '/api/metering/summary',
      '/api/metering/daily?from=2026-10-09&to=2026-10-09',
      '/api/metering/throttle?from=2026-10-09&to=2026-10-09',
      '/api/metering/sessions/ses_big',
      '/api/metering/cost-per-outcome',
      '/api/metering/migration',
      '/api/ratecard',
      '/api/ratecard/versions',
      '/api/metering/subscription',
    ])
      await t.json('GET', path, { headers: approver.headers });
    const card = await t.json<{ active: { rates: unknown[] } | null }>('GET', '/api/ratecard', {
      headers: approver.headers,
    });
    await t.json('PUT', '/api/ratecard', {
      headers: approver.headers,
      body: { rates: card.active!.rates, note: 'repriced' },
      expect: 201,
    });
    await t.json('PUT', '/api/metering/subscription', {
      headers: approver.headers,
      body: { plan: 'max', seats: 9, monthlyUsdPerSeat: 200 },
      expect: 201,
    });
    t.clock.set(myt('2026-10-10', '00:20'));
    await closeDays(t);
    await t.drain();

    const byModule = t.rt.store.list().filter((e) => !fromTest.has(e.id));
    expect([...new Set(byModule.map((e) => e.type))].sort()).toEqual(ownedByMetering);
    expect(t.rt.store.list().filter((e) => isGating(e.type))).toEqual([]);
    await t.close();
  });
});
