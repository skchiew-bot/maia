import { describe, expect, it } from 'vitest';
import { createTestRuntime, HttpError, readJson, requirePermission, type AocModule } from '../src';
import { z } from 'zod';

describe('AocRuntime', () => {
  it('runs reactors after commit (idempotent follow-ups), routes with auth, and daily jobs once per local day', async () => {
    const reacted: number[] = [];
    let jobRuns = 0;
    const mod: AocModule = {
      name: 'demo',
      reactors: [
        {
          name: 'demo.react',
          handles: ['session.nudged'],
          react(e, _p, ctx) {
            reacted.push(e.seq);
            if (ctx.store.findByCausation(e.id, 'session.restarted').length) return;
            ctx.store.append({ type: 'session.restarted', actor: { kind: 'system', id: 'demo' }, meta: { sessionId: 'ses_x' }, source: 'system', causationId: e.id });
          },
        },
      ],
      jobs: [{ name: 'demo.daily', schedule: { dailyAt: '12:30' }, run: () => void jobRuns++ }],
      routes(app) {
        app.post('/api/demo', async (c) => {
          const auth = requirePermission(c, 'session.launch');
          const body = await readJson(c, z.object({ text: z.string() }));
          const e = c.get('requestId') ? 1 : 0;
          if (!body.text) throw new HttpError(422, 'empty', 'empty');
          return c.json({ by: auth.user.id, e });
        });
      },
    };
    const t = await createTestRuntime({ modules: [mod], now: '2026-10-09T04:00:00.000Z' }); // 12:00 MYT
    const builder = t.user('builder');
    const requester = t.user('requester');
    expect((await t.request('POST', '/api/demo', { body: { text: 'x' } })).status).toBe(401);
    expect((await t.request('POST', '/api/demo', { headers: requester.headers, body: { text: 'x' } })).status).toBe(403);
    expect((await t.request('POST', '/api/demo', { headers: builder.headers, body: {} })).status).toBe(422);
    expect(await t.json('POST', '/api/demo', { headers: builder.headers, body: { text: 'x' } })).toMatchObject({ by: builder.user.id });

    t.rt.store.append({ type: 'session.nudged', actor: { kind: 'human', id: builder.user.id }, meta: { sessionId: 'ses_x' }, payload: { text: 'go' }, source: 'api' });
    await t.drain();
    expect(reacted.length).toBe(1);
    expect(t.rt.store.list({ types: ['session.restarted'] }).length).toBe(1);

    expect(await t.rt.tickJobs()).toEqual([]); // 12:00 local < 12:30
    t.clock.advance(45 * 60_000); // 12:45 MYT
    expect(await t.rt.tickJobs()).toEqual(['demo.daily']);
    expect(await t.rt.tickJobs()).toEqual([]);
    expect(jobRuns).toBe(1);
    await t.close();
  });
});

describe('reactor drain', () => {
  it('tracks follow-ups appended synchronously by a reactor in the same drain', async () => {
    const order: string[] = [];
    const mod: AocModule = {
      name: 'chain',
      reactors: [
        {
          name: 'first',
          handles: ['session.nudged'],
          react(e, _p, ctx) {
            order.push('first');
            // synchronous follow-up append inside the reaction (no await before it)
            ctx.store.append({ type: 'session.restarted', actor: { kind: 'system', id: 't' }, meta: { sessionId: 'ses_y' }, source: 'system', causationId: e.id });
          },
        },
        {
          name: 'second',
          handles: ['session.restarted'],
          async react() {
            await new Promise((r) => setTimeout(r, 20));
            order.push('second');
          },
        },
      ],
    };
    const t = await createTestRuntime({ modules: [mod] });
    t.rt.store.append({ type: 'session.nudged', actor: { kind: 'human', id: 'usr_1' }, meta: { sessionId: 'ses_y' }, payload: { text: 'x' }, source: 'api' });
    await t.drain();
    expect(order).toEqual(['first', 'second']);
    await t.close();
  });
});

describe('projection back-fill on an existing log', () => {
  it('replays after module init, so projectors see module settings such as the configured timezone', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { randomBytes } = await import('node:crypto');
    const { AocConfigSchema } = await import('@aoc/contracts');
    const { AocRuntime, FakeClock, silentLogger } = await import('../src');
    const dataDir = mkdtempSync(join(tmpdir(), 'aoc-backfill-'));
    const masterKey = randomBytes(32);
    const config = AocConfigSchema.parse({ dataDir, timezone: 'Asia/Kolkata' });
    const boot = (modules: AocModule[]) =>
      AocRuntime.create({ config, modules, clock: new FakeClock('2026-10-09T00:00:00.000Z'), log: silentLogger, masterKey });

    const first = await boot([]);
    first.store.append({
      type: 'session.nudged',
      actor: { kind: 'human', id: 'usr_1' },
      scope: { sessionId: 'ses_1' },
      meta: { sessionId: 'ses_1' },
      payload: { text: 'hello' },
      source: 'api',
    });
    await first.stop();

    let tz = 'unset';
    const zoned: AocModule = {
      name: 'zoned',
      projectors: [
        {
          name: 'zoned',
          tables: ['t_zoned'],
          ddl: ['CREATE TABLE IF NOT EXISTS t_zoned (session_id TEXT, tz TEXT)'],
          handles: ['session.nudged'],
          apply({ db }, e) {
            db.prepare('INSERT INTO t_zoned VALUES (?, ?)').run(e.scope.sessionId ?? '', tz);
          },
        },
      ],
      init(ctx) {
        tz = ctx.config.timezone;
      },
    };
    const second = await boot([zoned]);
    expect(second.store.db.prepare('SELECT session_id, tz FROM t_zoned').all()).toEqual([
      { session_id: 'ses_1', tz: 'Asia/Kolkata' },
    ]);
    await second.stop();
  });
});
