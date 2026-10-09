import { join } from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AocConfig, JsonValue, Notification, StoredEvent } from '@aoc/contracts';
import type { Clock } from '../clock';
import { loadOrCreateMasterKey } from '../crypto';
import { createGitService } from '../git';
import type { Logger } from '../logger';
import { EventStore } from '../store/event-store';
import { localParts } from '../time';
import { Broadcaster } from './broadcast';
import { bodyLimitFor, errorResponse, HttpError, tokenFrom } from './http';
import type { AocModule, AppEnv, Job, ModuleContext, Reactor } from './module';
import { GuardPolicy } from './policy';
import { ServiceRegistry } from './services';

export interface RuntimeOptions {
  config: AocConfig;
  modules: AocModule[];
  clock: Clock;
  log: Logger;
  /** Overrides the KEK (tests). */
  masterKey?: Buffer;
  /** ':memory:' for tests. Defaults to config.dataDir. */
  dataDir?: string;
}

interface QueuedReaction {
  reactor: Reactor;
  e: StoredEvent;
  payload: JsonValue | null;
}

/**
 * Composition core shared by aocd and the test kit: one EventStore (sole writer), modules, services,
 * guard policy, broadcaster, cursor-tracked reactors and the job scheduler.
 */
export class AocRuntime {
  readonly store: EventStore;
  readonly services = new ServiceRegistry();
  readonly policy = new GuardPolicy();
  readonly broadcaster: Broadcaster;
  readonly ctx: ModuleContext;
  private readonly queue: QueuedReaction[] = [];
  private draining: Promise<void> | null = null;
  private jobTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  private constructor(private readonly opts: RuntimeOptions) {
    const dataDir = opts.dataDir ?? opts.config.dataDir;
    const masterKey = opts.masterKey ?? loadOrCreateMasterKey(opts.config.keys.masterKeyFile ?? join(dataDir, 'master.key')).key;
    this.store = new EventStore({ dataDir, clock: opts.clock, log: opts.log, masterKey });
    this.broadcaster = new Broadcaster(() => opts.clock.iso());
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS reactor_cursors (name TEXT PRIMARY KEY, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reactor_failures (id INTEGER PRIMARY KEY AUTOINCREMENT, reactor TEXT NOT NULL, seq INTEGER NOT NULL, error TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_runs (name TEXT PRIMARY KEY, last_run_at TEXT, last_local_date TEXT, last_status TEXT, last_error TEXT);
    `);
    this.ctx = {
      config: opts.config,
      store: this.store,
      db: this.store.db,
      clock: opts.clock,
      log: opts.log,
      services: this.services,
      dataDir,
      notify: (n: Notification) => this.broadcaster.notify(n),
    };
    this.services.provide('policy', this.policy);
    this.services.provide('notifier', this.broadcaster);
    this.services.provide('git', createGitService());
  }

  static async create(opts: RuntimeOptions): Promise<AocRuntime> {
    const rt = new AocRuntime(opts);
    for (const m of opts.modules) for (const p of m.projectors ?? []) rt.store.registerProjector(p);
    for (const m of opts.modules) for (const g of m.guards ?? []) rt.policy.register(g);
    for (const m of opts.modules) await m.init?.(rt.ctx);
    rt.wireBus();
    for (const m of opts.modules) await m.start?.(rt.ctx);
    await rt.catchUpReactors();
    return rt;
  }

  get modules(): AocModule[] {
    return this.opts.modules;
  }

  private get reactors(): Reactor[] {
    return this.opts.modules.flatMap((m) => m.reactors ?? []);
  }

  private wireBus(): void {
    const head = this.store.head().seq;
    for (const r of this.reactors) {
      this.store.db.prepare('INSERT OR IGNORE INTO reactor_cursors (name, seq) VALUES (?, ?)').run(r.name, head);
    }
    this.store.subscribe((e, payload) => {
      this.broadcaster.publish({ event: 'aoc', data: EventStore.headerOf(e) });
      for (const r of this.reactors) if (r.handles.includes(e.type)) this.queue.push({ reactor: r, e, payload });
      if (this.queue.length) void this.drain();
    });
  }

  /** Replay events a reactor missed (crash between commit and reaction): at-least-once delivery. */
  private async catchUpReactors(): Promise<void> {
    for (const r of this.reactors) {
      const cursor = (this.store.db.prepare('SELECT seq FROM reactor_cursors WHERE name = ?').get(r.name) as { seq: number }).seq;
      const missed = this.store.list({ fromSeq: cursor + 1, types: [...r.handles], limit: 100_000 });
      for (const e of missed) this.queue.push({ reactor: r, e, payload: this.store.readPayload(e) });
    }
    await this.drain();
  }

  /** Resolves when every queued reaction has run (tests await this after actions). */
  drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      while (this.queue.length && !this.stopped) {
        const item = this.queue.shift()!;
        let lastErr: unknown = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await item.reactor.react(item.e, item.payload, this.ctx);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
          }
        }
        if (lastErr) {
          this.opts.log.error('reactor failed', { reactor: item.reactor.name, seq: item.e.seq, err: String(lastErr) });
          this.store.db
            .prepare('INSERT INTO reactor_failures (reactor, seq, error, at) VALUES (?,?,?,?)')
            .run(item.reactor.name, item.e.seq, String(lastErr).slice(0, 1000), this.opts.clock.iso());
        }
        this.store.db.prepare('UPDATE reactor_cursors SET seq = MAX(seq, ?) WHERE name = ?').run(item.e.seq, item.reactor.name);
      }
    })().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  /** Mount auth middleware, module routes and the error handler on a Hono app. */
  mount(app: Hono<AppEnv> = new Hono<AppEnv>()): Hono<AppEnv> {
    app.use('*', (c, next) => {
      const maxSize = bodyLimitFor(c.req.path, this.opts.config);
      return bodyLimit({
        maxSize,
        onError: () => {
          throw new HttpError(413, 'payload_too_large', `Request body exceeds ${maxSize} bytes`);
        },
      })(c, next);
    });
    app.use('*', async (c, next) => {
      c.set('requestId', c.req.header('x-request-id') ?? Math.random().toString(36).slice(2, 10));
      c.set('auth', null);
      c.set('ingest', null);
      const tok = tokenFrom(c);
      const identity = this.services.maybe('identity');
      if (c.req.path.startsWith('/ingest/')) {
        const principal = tok && identity ? identity.verifyIngestToken(tok.token) : null;
        // Every ingest route needs a token: refuse anonymous callers before any route parses their body.
        if (!principal) throw new HttpError(401, 'unauthenticated', 'Ingest token required');
        c.set('ingest', principal);
      } else if (tok && identity) {
        const auth = identity.authenticate(tok.token);
        if (auth) c.set('auth', { ...auth, method: tok.method });
      }
      await next();
    });
    for (const m of this.opts.modules) m.routes?.(app, this.ctx);
    app.onError((err, c) => {
      const res = errorResponse(err, c);
      if (res.status >= 500) this.opts.log.error('request failed', { path: c.req.path, err: String(err), stack: (err as Error).stack });
      return res;
    });
    return app;
  }

  // ── jobs ───────────────────────────────────────────────────────────────────
  private get jobs(): Job[] {
    return this.opts.modules.flatMap((m) => m.jobs ?? []);
  }

  /** Run every job that is due at clock.now(). Daily jobs run once per local date at/after `dailyAt`. */
  async tickJobs(): Promise<string[]> {
    const ran: string[] = [];
    const now = this.opts.clock.now();
    const local = localParts(now, this.opts.config.timezone);
    for (const job of this.jobs) {
      const row = this.store.db.prepare('SELECT last_run_at, last_local_date FROM job_runs WHERE name = ?').get(job.name) as
        | { last_run_at: string | null; last_local_date: string | null }
        | undefined;
      let due = false;
      if ('everyMs' in job.schedule) due = !row?.last_run_at || now - Date.parse(row.last_run_at) >= job.schedule.everyMs;
      else due = local.time >= job.schedule.dailyAt && row?.last_local_date !== local.date;
      if (!due) continue;
      await this.runJob(job.name);
      ran.push(job.name);
    }
    return ran;
  }

  async runJob(name: string): Promise<void> {
    const job = this.jobs.find((j) => j.name === name);
    if (!job) throw new Error(`unknown job ${name}`);
    const now = this.opts.clock.now();
    const local = localParts(now, this.opts.config.timezone);
    let status = 'ok';
    let error: string | null = null;
    try {
      await job.run(this.ctx);
    } catch (err) {
      status = 'error';
      error = String(err).slice(0, 1000);
      this.opts.log.error('job failed', { job: name, err: error });
    }
    this.store.db
      .prepare(
        `INSERT INTO job_runs (name, last_run_at, last_local_date, last_status, last_error) VALUES (?,?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET last_run_at=excluded.last_run_at, last_local_date=excluded.last_local_date, last_status=excluded.last_status, last_error=excluded.last_error`,
      )
      .run(name, new Date(now).toISOString(), local.date, status, error);
    await this.drain();
  }

  startJobs(intervalMs = 30_000): void {
    if (this.jobTimer) return;
    this.jobTimer = setInterval(() => void this.tickJobs(), intervalMs);
    this.jobTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.jobTimer) clearInterval(this.jobTimer);
    this.jobTimer = null;
    await this.drain();
    this.stopped = true;
    for (const m of [...this.opts.modules].reverse()) await m.stop?.();
    this.store.close();
  }
}
