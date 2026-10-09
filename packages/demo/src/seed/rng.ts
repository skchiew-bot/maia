/** Deterministic randomness: the demo history is reproducible for a given day. */
const SEED = 20261009;
let state = SEED;

/** Every seeding run starts from the same sequence, however many ran before it in the process. */
export const resetRandom = (): void => {
  state = SEED;
};
export const rnd = (): number => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
export const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
export const between = (a: number, b: number): number => Math.round(a + rnd() * (b - a));
