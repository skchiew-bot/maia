import { setTimeout as delay } from 'node:timers/promises';

/** Thrown when the run is aborted (SIGINT/SIGTERM in the CLI, or the caller's AbortSignal in-process). */
export class SimAbortError extends Error {
  constructor(readonly reason: unknown) {
    super('claude-sim run aborted');
    this.name = 'SimAbortError';
  }
}

/**
 * Wall-clock pacing for simulated work. Every scenario duration is multiplied by `speed`
 * (CLAUDE_SIM_SPEED, e.g. 0.01 in tests) so long sessions can be replayed quickly.
 */
export class Pacer {
  constructor(
    readonly speed: number,
    private readonly signal?: AbortSignal,
  ) {}

  scaled(ms: number): number {
    return Math.max(0, Math.round(ms * this.speed));
  }

  /** Sleep for an already-scaled number of milliseconds. */
  async sleepRaw(ms: number): Promise<void> {
    this.throwIfAborted();
    if (ms <= 0) return;
    try {
      await delay(ms, undefined, this.signal ? { signal: this.signal } : undefined);
    } catch (error) {
      if (this.signal?.aborted) throw new SimAbortError(this.signal.reason);
      throw error;
    }
  }

  throwIfAborted(): void {
    if (this.signal?.aborted) throw new SimAbortError(this.signal.reason);
  }
}

/** CLAUDE_SIM_SPEED: a non-negative multiplier; anything unparsable means real time. */
export function parseSpeed(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 1;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 1;
}
