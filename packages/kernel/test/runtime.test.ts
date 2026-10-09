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
