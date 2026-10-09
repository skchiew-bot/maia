export interface Clock {
  now(): number;
  iso(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
};

/** Deterministic clock for tests. */
export class FakeClock implements Clock {
  private t: number;
  constructor(start: number | string = '2026-10-09T01:00:00.000Z') {
    this.t = typeof start === 'number' ? start : Date.parse(start);
  }
  now(): number {
    return this.t;
  }
  iso(): string {
    return new Date(this.t).toISOString();
  }
  set(t: number | string): void {
    this.t = typeof t === 'number' ? t : Date.parse(t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
