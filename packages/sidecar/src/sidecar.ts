import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { INGEST_PATHS, type HeartbeatRequest, type UsageRequest } from '@aoc/contracts';
import { createClient, type AocClient } from '@aoc/client';
import { detectThrottle, parseTranscriptLine, TranscriptTailer, UsageAggregator } from './transcript';

export interface SidecarOptions {
  sessionId: string;
  pid: number;
  transcriptPath: string;
  daemonUrl: string;
  token: string;
  intervalMs?: number;
  flushEveryMs?: number;
  flushAtMessages?: number;
  stateDir: string;
  spoolDir?: string;
  client?: AocClient;
  isAlive?: (pid: number) => boolean;
  now?: () => Date;
}

interface PersistedState {
  offset: number;
  subOffsets?: Record<string, number>;
  counted: ReturnType<UsageAggregator['snapshot']>;
  throttleActive: boolean;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Per-session sidecar (§2.1): heartbeats come from this process (hooks cannot fire while the model
 * generates), and it tails the transcript for per-turn token usage and plan-limit hits.
 */
export class Sidecar {
  readonly client: AocClient;
  private readonly agg: UsageAggregator;
  private readonly tailer: TranscriptTailer;
  /** Subagent transcripts live in separate files: <transcript without .jsonl>/subagents/agent-*.jsonl. */
  private readonly subTailers = new Map<string, TranscriptTailer>();
  private readonly subOffsets: Record<string, number>;
  private hbTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private lastActivityPost = 0;
  private throttleActive: boolean;
  private stopped = false;
  private exiting: Promise<void> | null = null;
  private readonly stateFile: string;
  private readonly isAlive: (pid: number) => boolean;
  private readonly now: () => Date;

  constructor(private readonly o: SidecarOptions) {
    mkdirSync(o.stateDir, { recursive: true, mode: 0o700 });
    this.stateFile = join(o.stateDir, `${o.sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
    const st = this.loadState();
    this.agg = new UsageAggregator(st?.counted);
    this.throttleActive = st?.throttleActive ?? false;
    this.client = o.client ?? createClient({ daemonUrl: o.daemonUrl, token: o.token, spoolDir: o.spoolDir ?? join(o.stateDir, 'spool'), timeoutMs: 4000 });
    this.tailer = new TranscriptTailer(o.transcriptPath, (l) => this.onLine(l), { offset: st?.offset ?? 0 });
    this.subOffsets = st?.subOffsets ?? {};
    this.isAlive = o.isAlive ?? pidAlive;
    this.now = o.now ?? (() => new Date());
  }

  private loadState(): PersistedState | null {
    try {
      return JSON.parse(readFileSync(this.stateFile, 'utf8')) as PersistedState;
    } catch {
      return null;
    }
  }

  private saveState(): void {
    const tmp = `${this.stateFile}.tmp`;
    for (const [f, t] of this.subTailers) this.subOffsets[f] = t.committedOffset;
    const st: PersistedState = { offset: this.tailer.committedOffset, subOffsets: this.subOffsets, counted: this.agg.snapshot(), throttleActive: this.throttleActive };
    writeFileSync(tmp, JSON.stringify(st), { mode: 0o600 });
    renameSync(tmp, this.stateFile);
  }

  private onLine(raw: string): void {
    const line = parseTranscriptLine(raw);
    if (!line) return;
    this.agg.add(line);
    const t = detectThrottle(line, this.now());
    if (t && !this.throttleActive) {
      this.throttleActive = true;
      void this.client.post(INGEST_PATHS.throttle, { sessionId: this.o.sessionId, resetAt: t.resetAt, message: t.message, source: 'transcript' }, { spool: true });
    } else if (!t && line.type === 'assistant' && line.message?.usage) {
      this.throttleActive = false; // the model answered again: the episode is over
    }
    const nowMs = this.now().getTime();
    if (nowMs - this.lastActivityPost >= 2000) {
      this.lastActivityPost = nowMs;
      void this.client.post(INGEST_PATHS.activity, { sessionId: this.o.sessionId, kind: 'transcript', at: this.now().toISOString() });
    }
    if (this.agg.pendingMessages >= (this.o.flushAtMessages ?? 50)) void this.flush();
  }

  async heartbeat(): Promise<boolean> {
    const alive = this.isAlive(this.o.pid);
    const body: HeartbeatRequest = {
      sessionId: this.o.sessionId,
      pid: this.o.pid,
      alive,
      at: this.now().toISOString(),
      transcriptBytes: this.tailer.size,
      lastTranscriptWriteAt: this.tailer.lastWriteAt ? new Date(this.tailer.lastWriteAt).toISOString() : null,
    };
    await this.client.post(INGEST_PATHS.heartbeat, body, { retries: 1 });
    return alive;
  }

  /** Discover and read subagent transcripts (their usage never appears in the main file). */
  pollSubagents(): void {
    const dir = this.o.transcriptPath.replace(/\.jsonl$/, '') + '/subagents';
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      let t = this.subTailers.get(f);
      if (!t) {
        t = new TranscriptTailer(`${dir}/${f}`, (l) => this.onLine(l), { offset: this.subOffsets[f] ?? 0 });
        this.subTailers.set(f, t);
      }
      t.poll();
    }
  }

  async flush(): Promise<number> {
    this.tailer.poll();
    this.pollSubagents();
    const batches = this.agg.drain();
    this.saveState();
    if (!batches.length) return 0;
    const ids = batches.flatMap((b) => b.messageIds).sort();
    const body: UsageRequest = { sessionId: this.o.sessionId, batches, idempotencyKey: createHash('sha256').update(ids.join('\n')).digest('hex') };
    await this.client.post(INGEST_PATHS.usage, body, { spool: true });
    return batches.length;
  }

  async start(): Promise<void> {
    this.tailer.start();
    await this.client.flushSpool().catch(() => undefined);
    await this.tick();
    this.hbTimer = setInterval(() => void this.tick(), this.o.intervalMs ?? 5000);
    this.flushTimer = setInterval(() => void this.flush(), this.o.flushEveryMs ?? 10_000);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const alive = await this.heartbeat();
    if (!alive) await this.exit();
    else if (this.client.spooledCount() > 0) await this.client.flushSpool().catch(() => undefined);
  }

  /** The watched claude process is gone: report, final flush, stop. */
  exit(exitCode: number | null = null, signal: string | null = null): Promise<void> {
    if (this.exiting) return this.exiting;
    this.exiting = (async () => {
      this.stopped = true;
      if (this.hbTimer) clearInterval(this.hbTimer);
      if (this.flushTimer) clearInterval(this.flushTimer);
      this.tailer.poll();
      await this.flush();
      await this.client.post(INGEST_PATHS.process, { sessionId: this.o.sessionId, event: 'exited', exitCode, signal, at: this.now().toISOString() }, { spool: true });
      this.tailer.stop();
    })();
    return this.exiting;
  }

  stop(): void {
    this.stopped = true;
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.tailer.stop();
  }
}
