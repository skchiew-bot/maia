import { randomBytes } from 'node:crypto';

export interface PackJobLimits {
  /** Pack requests one user may make per rolling hour. */
  perUserPerHour: number;
  /** Requests that may wait behind the pack being built. */
  maxQueued: number;
}

export const DEFAULT_PACK_JOB_LIMITS: PackJobLimits = { perUserPerHour: 12, maxQueued: 4 };

export type PackJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface PackJob<R, I = unknown> {
  id: string;
  userId: string;
  /** What was asked for (e.g. the range), echoed back on status reads. */
  info: I;
  requestedAt: number;
  status: PackJobStatus;
  result: R | null;
  error: unknown;
  /** Settles (never rejects) with the outcome once the job is done or failed. */
  finished: Promise<'done' | 'failed'>;
}

export interface Refusal {
  code: 'pack_pending' | 'rate_limited' | 'queue_full';
  message: string;
  retryAfterMs: number;
  jobId: string | null;
}

const HOUR_MS = 3_600_000;
const KEPT_FINISHED = 100;

/**
 * Evidence packs are built one at a time (R-05): a build re-hashes the whole chain, so concurrent builds would
 * multiply the load on the sole writer's thread. A user has at most one pack pending and a rolling hourly budget,
 * and the queue is bounded. Jobs are operational state, not domain state: each finished pack is an event.
 */
export class PackJobQueue<R, I = unknown> {
  private running: PackJob<R, I> | null = null;
  private readonly waiting: { job: PackJob<R, I>; run: () => Promise<R>; settle: (outcome: 'done' | 'failed') => void }[] = [];
  private readonly jobs = new Map<string, PackJob<R, I>>();
  private readonly requests = new Map<string, number[]>();
  private readonly limits: PackJobLimits;

  constructor(
    limits: Partial<PackJobLimits>,
    private readonly now: () => number,
  ) {
    this.limits = { ...DEFAULT_PACK_JOB_LIMITS, ...limits };
  }

  /** Why `userId` may not request a pack now, or null. */
  refusal(userId: string): Refusal | null {
    const pending = [...this.jobs.values()].find(
      (j) => j.userId === userId && (j.status === 'queued' || j.status === 'running'),
    );
    if (pending)
      return {
        code: 'pack_pending',
        message: 'Your previous evidence pack is still being built',
        retryAfterMs: 10_000,
        jobId: pending.id,
      };
    const recent = this.recentRequests(userId);
    if (recent.length >= this.limits.perUserPerHour)
      return {
        code: 'rate_limited',
        message: `At most ${this.limits.perUserPerHour} evidence packs per user per hour`,
        retryAfterMs: Math.max(1000, recent[0]! + HOUR_MS - this.now()),
        jobId: null,
      };
    if (this.running && this.waiting.length >= this.limits.maxQueued)
      return {
        code: 'queue_full',
        message: 'Too many evidence packs are waiting to be built',
        retryAfterMs: 30_000,
        jobId: null,
      };
    return null;
  }

  /** Queues `run` (callers check refusal() first); it starts at once when nothing else is being built. */
  submit(userId: string, info: I, run: () => Promise<R>): PackJob<R, I> {
    let settle!: (outcome: 'done' | 'failed') => void;
    const job: PackJob<R, I> = {
      id: `evj_${randomBytes(12).toString('hex')}`,
      userId,
      info,
      requestedAt: this.now(),
      status: 'queued',
      result: null,
      error: null,
      finished: new Promise<'done' | 'failed'>((r) => (settle = r)),
    };
    this.jobs.set(job.id, job);
    this.recentRequests(userId).push(job.requestedAt);
    this.waiting.push({ job, run, settle });
    this.next();
    return job;
  }

  get(id: string): PackJob<R, I> | null {
    return this.jobs.get(id) ?? null;
  }

  /** 1 for the next job to run; null once it has started. */
  position(job: PackJob<R, I>): number | null {
    const i = this.waiting.findIndex((w) => w.job === job);
    return i < 0 ? null : i + 1;
  }

  private next(): void {
    if (this.running) return;
    const w = this.waiting.shift();
    if (!w) return;
    this.running = w.job;
    w.job.status = 'running';
    void w
      .run()
      .then(
        (result) => {
          w.job.result = result;
          w.job.status = 'done';
        },
        (err: unknown) => {
          w.job.error = err;
          w.job.status = 'failed';
        },
      )
      .finally(() => {
        this.running = null;
        this.forgetOldJobs();
        w.settle(w.job.status === 'failed' ? 'failed' : 'done');
        this.next();
      });
  }

  private recentRequests(userId: string): number[] {
    const since = this.now() - HOUR_MS;
    const kept = (this.requests.get(userId) ?? []).filter((at) => at > since);
    this.requests.set(userId, kept);
    return kept;
  }

  private forgetOldJobs(): void {
    const finished = [...this.jobs.values()].filter((j) => j.status === 'done' || j.status === 'failed');
    for (const j of finished.slice(0, Math.max(0, finished.length - KEPT_FINISHED))) this.jobs.delete(j.id);
  }
}

/** Hands the event loop back after every `sliceMs` of work, so hooks and the API are served while a pack builds. */
export class Pacer {
  private last = performance.now();

  constructor(private readonly sliceMs = 10) {}

  async yield(): Promise<void> {
    if (performance.now() - this.last < this.sliceMs) return;
    await new Promise<void>((r) => setImmediate(r));
    this.last = performance.now();
  }
}
