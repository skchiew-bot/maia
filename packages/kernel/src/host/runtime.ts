import { join } from 'node:path';
import { Hono } from 'hono';
import type { AocConfig, JsonValue, Notification, StoredEvent } from '@aoc/contracts';
import type { Clock } from '../clock';
import { loadOrCreateMasterKey } from '../crypto';
import { createGitService } from '../git';
import type { Logger } from '../logger';
import { EventStore } from '../store/event-store';
import { localParts } from '../time';
import { Broadcaster } from './broadcast';
import { bodyLimitFor, capRequestBody, errorResponse, HttpError, tokenFrom } from './http';
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
  /** The environment the KEK may be read from (AOC_MASTER_KEY, development only). Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** ':memory:' for tests. Defaults to config.dataDir. */
  dataDir?: string;
  /** How long stop() waits for job ticks still running after the modules stopped (default 10 s). */
  jobStopGraceMs?: number;
}

const JOB_STOP_GRACE_MS = 10_000;

/**
 * The KEK: the explicit override, else loaded per docs/runbooks/key-custody.md. A development KEK taken from the
 * environment still works, with a loud warning (production refuses it).
 */
function resolveMasterKey(opts: RuntimeOptions, dataDir: string): Buffer {
  if (opts.masterKey) return opts.masterKey;
  const { key, source } = loadOrCreateMasterKey(
    opts.config.keys.masterKeyFile ?? join(dataDir, 'master.key'),
    opts.env ?? process.env,
    { production: opts.config.mode === 'production', dataDir },
  );
  if (source === 'env')
    opts.log.warn(
      'The KEK is taken from AOC_MASTER_KEY: development only. The variable sits in the process environment, ' +
        'where child processes, crash dumps and /proc/<pid>/environ can reach it, and "mode": "production" ' +
        'refuses it. Keep the key in keys.masterKeyFile (docs/runbooks/key-custody.md §2-§3)',
    );
  return key;
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
  /** Job ticks in flight, whoever started them: stop() waits for these before it closes the store. */
  private readonly runningJobs = new Set<Promise<unknown>>();
  /** stop() was called: no job starts from then on. */
  private stopRequested = false;
  private stopRun: Promise<void> | null = null;
  /** Reactors are off: the modules are stopping. */
  private stopped = false;
  /** The store is closed: nothing may be written any more. */
  private closed = false;

  private constructor(private readonly opts: RuntimeOptions) {
    const dataDir = opts.dataDir ?? opts.config.dataDir;
    const masterKey = resolveMasterKey(opts, dataDir);
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
    // Modules added to an existing install (or whose projection schema changed) back-fill from the log — after
    // init, so projectors that read module settings (e.g. the configured timezone) replay with them.
    const rebuilt = rt.store.rebuildStaleProjections();
    if (rebuilt.length) opts.log.info('projections rebuilt from the log', { projectors: rebuilt });
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

  /**
   * Resolves when every queued reaction has run (tests await this after actions). `draining` is set BEFORE the
   * loop starts, so a reactor that appends synchronously during its reaction joins this loop instead of starting
   * a second, untracked one (which would break ordering and let drain() resolve early). With nothing queued the
   * loop ends synchronously and clears `draining` before this returns, so the caller gets its own handle.
   */
  drain(): Promise<void> {
    if (this.draining) return this.draining;
    let done!: () => void;
    const settled = new Promise<void>((r) => (done = r));
    this.draining = settled;
    void (async () => {
      try {
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
      } finally {
        this.draining = null;
        done();
      }
    })();
    return settled;
  }

  /** Mount auth middleware, module routes and the error handler on a Hono app. */
  mount(app: Hono<AppEnv> = new Hono<AppEnv>()): Hono<AppEnv> {
    app.use('*', async (c, next) => {
      capRequestBody(c, bodyLimitFor(c.req.path, this.opts.config));
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

  /**
   * Run every job that is due at clock.now(). Daily jobs run once per local date at/after `dailyAt`. The tick is
   * tracked so that stop() waits for it, and no further job starts once the runtime is stopping.
   */
  tickJobs(): Promise<string[]> {
    return this.trackJob(() => this.runDueJobs());
  }

  private async runDueJobs(): Promise<string[]> {
    const ran: string[] = [];
    const now = this.opts.clock.now();
    const local = localParts(now, this.opts.config.timezone);
    for (const job of this.jobs) {
      if (this.stopRequested) break;
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

  runJob(name: string): Promise<void> {
    if (this.stopRequested) return Promise.reject(new Error(`cannot run job ${name}: the runtime is stopping`));
    return this.trackJob(() => this.execute(name));
  }

  private async execute(name: string): Promise<void> {
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
    if (this.closed) {
      // stop() gave up waiting for this job: the store it would record into is gone.
      this.opts.log.warn('job finished after the store was closed; its run is not recorded', {
        job: name,
        status,
      });
      return;
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
    if (this.jobTimer || this.stopRequested) return;
    this.jobTimer = setInterval(() => {
      this.tickJobs().catch((err: unknown) => this.opts.log.error('job tick failed', { err: String(err) }));
    }, intervalMs);
    this.jobTimer.unref();
  }

  private trackJob<T>(start: () => Promise<T>): Promise<T> {
    const running = start();
    this.runningJobs.add(running);
    const forget = () => void this.runningJobs.delete(running);
    running.then(forget, forget);
    return running;
  }

  /**
   * Orderly shutdown, idempotent: stop scheduling, let the reactors finish what is queued, switch them off, stop the
   * modules (which abort what they can), wait for job ticks still running, then close the store. Nothing may write
   * to the store after it is closed, so a job that is still running is awaited rather than left behind.
   */
  stop(): Promise<void> {
    this.stopRequested = true;
    this.stopRun ??= this.runShutdown();
    return this.stopRun;
  }

  private async runShutdown(): Promise<void> {
    if (this.jobTimer) clearInterval(this.jobTimer);
    this.jobTimer = null;
    await this.drain();
    this.stopped = true;
    try {
      for (const m of [...this.opts.modules].reverse()) await m.stop?.();
    } finally {
      await this.settleJobs();
      this.closed = true;
      this.store.close();
    }
  }

  /**
   * The modules have stopped, so what could be aborted has been. Wait for the job ticks that are still running, but
   * not forever: a hung job must not hold shutdown. Events a finishing job appends are not reacted to now (the
   * reactors are off); their reactor cursors replay them at the next start.
   */
  private async settleJobs(): Promise<void> {
    if (this.runningJobs.size) {
      let timer: NodeJS.Timeout | undefined;
      const gaveUp = await Promise.race([
        Promise.allSettled([...this.runningJobs]).then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), this.opts.jobStopGraceMs ?? JOB_STOP_GRACE_MS);
        }),
      ]);
      clearTimeout(timer);
      if (gaveUp)
        this.opts.log.error('job still running at shutdown; closing the store without it', {
          jobs: this.runningJobs.size,
        });
    }
    // A reaction that was already running when the reactors were switched off.
    await this.draining;
  }
}
