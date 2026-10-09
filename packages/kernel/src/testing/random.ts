/**
 * Seeded randomness for property-style tests.
 *
 * Every randomized test runs through `forSeeds`, which names the failing seed in the error it rethrows, so each
 * failure is reproducible: run again with `AOC_SEED=<seed>` and then pin the seed in the test (`pinned`) as a
 * deterministic regression case. `AOC_SEEDS=<n>` raises the number of seeds per test for a longer soak.
 */

/** mulberry32: a 32-bit-state generator, plenty for generating test input (not for anything secret). */
export class Rng {
  private state: number;

  constructor(readonly seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  chance(p = 0.5): boolean {
    return this.next() < p;
  }

  pick<T>(xs: readonly T[]): T {
    if (!xs.length) throw new Error('Rng.pick: empty list');
    return xs[Math.floor(this.next() * xs.length)]!;
  }

  /** One of `items` with probability proportional to its weight. */
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((a, [, w]) => a + w, 0);
    let x = this.next() * total;
    for (const [v, w] of items) {
      x -= w;
      if (x < 0) return v;
    }
    return items[items.length - 1]![0];
  }

  shuffle<T>(xs: readonly T[]): T[] {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  /** `n` distinct items (fewer when the list is shorter), in random order. */
  sample<T>(xs: readonly T[], n: number): T[] {
    return this.shuffle(xs).slice(0, n);
  }

  /** Lower-case hex string of `bytes` random bytes. */
  hex(bytes = 4): string {
    let s = '';
    for (let i = 0; i < bytes; i++) s += this.int(0, 255).toString(16).padStart(2, '0');
    return s;
  }

  /** An independent stream: later draws from this generator do not depend on how much the child consumes. */
  fork(): Rng {
    return new Rng(Math.floor(this.next() * 4294967296));
  }
}

export interface SeedOptions {
  /** Seeds to run when AOC_SEEDS is not set. */
  count?: number;
  /** Known-bad seeds from earlier failures: always run first, in addition to the generated ones. */
  pinned?: readonly number[];
}

function envSeeds(): { only: number[] | null; count: number | null } {
  const only = process.env.AOC_SEED?.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n));
  const count = Number(process.env.AOC_SEEDS);
  return { only: only?.length ? only : null, count: Number.isInteger(count) && count > 0 ? count : null };
}

/** The seeds a property runs with: AOC_SEED pins exactly these; otherwise pinned regressions then 1..count. */
export function seedsFor(opts: SeedOptions = {}): number[] {
  const env = envSeeds();
  if (env.only) return env.only;
  const generated = Array.from({ length: env.count ?? opts.count ?? 25 }, (_, i) => i + 1);
  return [...new Set([...(opts.pinned ?? []), ...generated])];
}

/**
 * Run `fn` once per seed. A failure is rethrown with the seed in its message (and on stderr), so the log of a
 * failed run always says which seed to replay.
 */
export async function forSeeds(
  label: string,
  fn: (rng: Rng, seed: number) => void | Promise<void>,
  opts: SeedOptions = {},
): Promise<void> {
  for (const seed of seedsFor(opts)) {
    try {
      await fn(new Rng(seed), seed);
    } catch (err) {
      const hint = `[${label}] FAILED with seed=${seed}. Replay: AOC_SEED=${seed} (then pin it in the test)`;
      console.error(hint);
      if (err instanceof Error) {
        err.message = `${hint}\n${err.message}`;
        throw err;
      }
      throw new Error(`${hint}\n${String(err)}`);
    }
  }
}
