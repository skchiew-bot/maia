/** Token buckets per key on the injected clock (never wall time, so tests stay deterministic). */
export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    private readonly now: () => number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Takes `cost` tokens from `key`'s bucket: 0 when allowed, otherwise the ms until it would be. */
  take(key: string, cost = 1): number {
    const now = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.prune(now);
      b = { tokens: this.capacity, at: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + Math.max(0, now - b.at) * this.refillPerMs);
    b.at = now;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return 0;
    }
    return Math.ceil((cost - b.tokens) / this.refillPerMs);
  }

  /** Full buckets carry no state: drop them (and, past the bound, the oldest) so keys cannot grow memory. */
  private prune(now: number): void {
    for (const [k, b] of this.buckets)
      if (b.tokens + (now - b.at) * this.refillPerMs >= this.capacity) this.buckets.delete(k);
    for (const k of this.buckets.keys()) {
      if (this.buckets.size < this.maxKeys) break;
      this.buckets.delete(k);
    }
  }
}

export interface ObserverLimits {
  /** Sustained observed-ingest requests per minute per observer token (a spool item counts as one request). */
  requestsPerMinute: number;
  /** Requests a token may send at once before the sustained rate applies (covers a full spool flush). */
  requestBurst: number;
  /** Observed sessions one observer token may create per hour. */
  newSessionsPerHour: number;
}

export const DEFAULT_OBSERVER_LIMITS: ObserverLimits = { requestsPerMinute: 600, requestBurst: 1000, newSessionsPerHour: 60 };

export interface SessionLimits {
  /** Sustained ingest requests per minute per managed session and token kind (a spool item counts as one). */
  requestsPerMinute: number;
  /** Requests a session may send at once before the sustained rate applies. */
  requestBurst: number;
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = { requestsPerMinute: 600, requestBurst: 1000 };

/**
 * A managed session's token sits in the model's environment (threat model, D: event floods), so per session its
 * ingest is rate limited. The session token and the sidecar token have separate budgets: a model flooding with its
 * own token cannot starve the sidecar's heartbeats and usage reports.
 */
export class SessionLimiter {
  private readonly requests: TokenBuckets;

  constructor(limits: Partial<SessionLimits>, now: () => number) {
    const l = { ...DEFAULT_SESSION_LIMITS, ...limits };
    this.requests = new TokenBuckets(l.requestBurst, l.requestsPerMinute / 60_000, now);
  }

  /** 0 when allowed, else ms to wait. */
  request(kind: 'session' | 'sidecar', sessionId: string, cost = 1): number {
    return this.requests.take(`${kind}:${sessionId}`, cost);
  }
}

/**
 * The observer token is a shared bearer on developer machines (threat model T-12): per token, observed ingest is
 * rate limited and so is the creation of observed sessions, so one holder can neither flood the sole writer nor
 * create sessions without bound.
 */
export class ObserverLimiter {
  private readonly requests: TokenBuckets;
  private readonly sessions: TokenBuckets;

  constructor(limits: Partial<ObserverLimits>, now: () => number) {
    const l = { ...DEFAULT_OBSERVER_LIMITS, ...limits };
    this.requests = new TokenBuckets(l.requestBurst, l.requestsPerMinute / 60_000, now);
    this.sessions = new TokenBuckets(l.newSessionsPerHour, l.newSessionsPerHour / 3_600_000, now);
  }

  /** 0 when allowed, else ms to wait. */
  request(tokenId: string, cost = 1): number {
    return this.requests.take(tokenId, cost);
  }

  newSession(tokenId: string): number {
    return this.sessions.take(tokenId);
  }
}
