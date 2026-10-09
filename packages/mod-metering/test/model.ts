/** The rules of notional cost and the dollar-to-ringgit stamp, restated for the metering property tests. */
import { readFileSync } from 'node:fs';
import type { FxService } from '@aoc/contracts';
import { RATE_CARD_FILE } from './helpers';

export const KL = 8 * 3_600_000;
export const DAY = 86_400_000;
export const localDay = (ms: number) => new Date(ms + KL).toISOString().slice(0, 10);
export const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

export interface Rate {
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWrite5mPerMTok: number;
  cacheWrite1hPerMTok: number;
}
export interface Card {
  version: number;
  effectiveFrom: string;
  rates: Map<string, Rate>;
}
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
export const fileCard = JSON.parse(readFileSync(RATE_CARD_FILE, 'utf8')) as { effectiveFrom: string; rates: Rate[] };

export interface Tok {
  input: number;
  output: number;
  cacheRead: number;
  cw5m: number;
  cw1h: number;
}
export const costOf = (r: Rate, k: Tok) => (k.input * r.inputPerMTok + k.output * r.outputPerMTok + k.cacheRead * r.cacheReadPerMTok + k.cw5m * r.cacheWrite5mPerMTok + k.cw1h * r.cacheWrite1hPerMTok) / 1e6;

export type Stamp = { rate: number | null; status: 'live' | 'inherited' | 'missing'; sourceDate: string | null };

/** The FX figures the world holds (the fx service's contract: the day's own record, else the latest earlier one, inherited). */
export class FxWorld implements FxService {
  readonly records = new Map<string, { rate: number; status: 'live' | 'inherited'; sourceDate: string }>();
  rateFor(date: string) {
    const dates = [...this.records.keys()].filter((d) => d <= date).sort();
    const d = dates.at(-1);
    if (!d) return null;
    const r = this.records.get(d)!;
    return { rate: r.rate, status: d === date ? r.status : ('inherited' as const), sourceDate: r.sourceDate, session: null };
  }
  stamp(date: string): Stamp {
    const r = this.rateFor(date);
    return r ? { rate: r.rate, status: r.status, sourceDate: r.sourceDate } : { rate: null, status: 'missing', sourceDate: null };
  }
}
