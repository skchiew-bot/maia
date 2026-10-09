import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { AocConfigSchema } from '@aoc/contracts';
import {
  AocRuntime,
  createTestRuntime,
  FakeClock,
  HttpError,
  readJson,
  requirePermission,
  silentLogger,
  type AocModule,
  type Job,
  type Logger,
  type ModuleContext,
} from '../src';
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

describe('drain', () => {
  it('is a promise whether or not anything is queued, so callers can chain on it', async () => {
    const t = await createTestRuntime({ modules: [] });
    const idle = t.rt.drain();
    expect(idle).toBeInstanceOf(Promise);
    await expect(idle.then(() => 'drained')).resolves.toBe('drained');

    let reacted = 0;
    const busy = await createTestRuntime({
      modules: [{ name: 'slow', reactors: [{ name: 'slow.react', handles: ['session.nudged'], async react() { await new Promise((r) => setTimeout(r, 10)); reacted++; } }] }],
    });
    busy.rt.store.append({ type: 'session.nudged', actor: { kind: 'human', id: 'usr_1' }, meta: { sessionId: 'ses_z' }, payload: { text: 'x' }, source: 'api' });
    await busy.rt.drain().then(() => expect(reacted).toBe(1));
    await expect(busy.rt.drain().then(() => 'idle again')).resolves.toBe('idle again');
    await Promise.all([t.close(), busy.close()]);
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

describe('AocRuntime.stop()', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A job that says when it has started and ends only when released; `onEnd` runs just before it returns. */
  function gated(name: string, onEnd?: (ctx: ModuleContext) => void) {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const running = new Promise<void>((resolve) => (started = resolve));
    const job: Job = {
      name,
      schedule: { everyMs: 1 },
      async run(ctx) {
        started();
        await gate;
        onEnd?.(ctx);
      },
    };
    return { job, release, running };
  }
  /** Did `p` settle within a moment? */
  const settles = (p: Promise<unknown>) =>
    Promise.race([
      p.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 60)),
    ]);
  const jobRun = (dataDir: string, name: string) => {
    const db = new DatabaseSync(join(dataDir, 'aoc.db'), { readOnly: true });
    try {
      return db.prepare('SELECT last_status, last_error FROM job_runs WHERE name = ?').get(name);
    } finally {
      db.close();
    }
  };

  it('waits for a job tick that is running, which records its run before the store closes', async () => {
    const slow = gated('slow');
    const t = await createTestRuntime({ modules: [{ name: 'slow', jobs: [slow.job] }], onDisk: true });
    const tick = t.rt.tickJobs();
    await slow.running;

    const stopping = t.rt.stop();
    expect(await settles(stopping)).toBe(false); // the job is mid-run: the store stays open
    slow.release();
    await stopping;

    expect(await tick).toEqual(['slow']);
    expect(jobRun(t.dataDir, 'slow')).toEqual({ last_status: 'ok', last_error: null });
    await t.rt.stop(); // a second stop() is the same shutdown, not a second close
    await t.close();
  });

  it('starts no further job once it is stopping', async () => {
    const first = gated('first');
    let secondRuns = 0;
    const second: Job = { name: 'second', schedule: { everyMs: 1 }, run: () => void secondRuns++ };
    const t = await createTestRuntime({
      modules: [{ name: 'jobs', jobs: [first.job, second] }],
      onDisk: true,
    });
    const tick = t.rt.tickJobs();
    await first.running;

    const stopping = t.rt.stop();
    first.release();
    await stopping;

    expect(await tick).toEqual(['first']);
    expect(secondRuns).toBe(0);
    await expect(t.rt.runJob('second')).rejects.toThrow(/stopping/);
    await t.close();
  });

  it('stops waiting for a job that never ends, and records nothing once the store is closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aoc-stop-'));
    dirs.push(dir);
    const stuck = gated('stuck');
    const logged: string[] = [];
    const log: Logger = {
      ...silentLogger,
      warn: (msg) => void logged.push(`warn: ${msg}`),
      error: (msg) => void logged.push(`error: ${msg}`),
      child: () => log,
    };
    const rt = await AocRuntime.create({
      config: AocConfigSchema.parse({ dataDir: dir }),
      modules: [{ name: 'stuck', jobs: [stuck.job] }],
      clock: new FakeClock(),
      log,
      masterKey: randomBytes(32),
      jobStopGraceMs: 40,
    });
    const tick = rt.tickJobs();
    await stuck.running;

    await rt.stop(); // gives up after the grace period instead of hanging shutdown
    expect(logged).toContain('error: job still running at shutdown; closing the store without it');
    stuck.release();
    await expect(tick).resolves.toEqual(['stuck']); // finishes without touching the closed store
    expect(logged).toContain('warn: job finished after the store was closed; its run is not recorded');
  });

  it('waits for a reaction in flight and for the follow-up it appends', async () => {
    let finished = false;
    const slowReactor: AocModule = {
      name: 'slow-react',
      reactors: [
        {
          name: 'slow',
          handles: ['session.nudged'],
          async react(e, _p, ctx) {
            await new Promise((resolve) => setTimeout(resolve, 40));
            ctx.store.append({
              type: 'session.restarted',
              actor: { kind: 'system', id: 'slow' },
              meta: { sessionId: 'ses_x' },
              source: 'system',
              causationId: e.id,
            });
            finished = true;
          },
        },
      ],
    };
    const t = await createTestRuntime({ modules: [slowReactor], onDisk: true });
    t.rt.store.append({
      type: 'session.nudged',
      actor: { kind: 'human', id: 'usr_1' },
      meta: { sessionId: 'ses_x' },
      payload: { text: 'go' },
      source: 'api',
    });
    await t.rt.stop();
    expect(finished).toBe(true);
    const db = new DatabaseSync(join(t.dataDir, 'aoc.db'), { readOnly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'session.restarted'").get()).toEqual({
      n: 1,
    });
    db.close();
    await t.close();
  });

  it('delivers at the next start a reaction that the shutdown could not run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aoc-stop-'));
    dirs.push(dir);
    const masterKey = randomBytes(32);
    const reacted: number[] = [];
    const late = gated('late', (ctx) =>
      ctx.store.append({
        type: 'session.nudged',
        actor: { kind: 'human', id: 'usr_1' },
        meta: { sessionId: 'ses_late' },
        payload: { text: 'appended by the job as it finished' },
        source: 'api',
      }),
    );
    const boot = () =>
      AocRuntime.create({
        config: AocConfigSchema.parse({ dataDir: dir }),
        modules: [
          {
            name: 'late',
            jobs: [late.job],
            reactors: [
              { name: 'late.react', handles: ['session.nudged'], react: (e) => void reacted.push(e.seq) },
            ],
          },
        ],
        clock: new FakeClock(),
        log: silentLogger,
        masterKey,
      });

    const first = await boot();
    const tick = first.tickJobs();
    await late.running;
    const stopping = first.stop();
    late.release();
    await stopping;
    await tick;
    expect(reacted).toEqual([]); // reactions are switched off while the modules stop

    const second = await boot();
    expect(reacted).toHaveLength(1); // catch-up from the reactor cursor
    await second.stop();
  });
});
