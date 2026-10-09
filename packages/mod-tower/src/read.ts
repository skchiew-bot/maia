import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { addDays, type EventStore } from '@aoc/kernel';
import type { TowerServices } from './services';
import { stmt } from './sql';
import { zonedEpoch } from './zoned';

/** Everything one snapshot read needs: the tower's tables, the optional services and a frozen "now". */
export interface ReadCtx {
  db: DatabaseSync;
  store: EventStore;
  svc: TowerServices;
  now: number;
  tz: string;
  /** Local date (YYYY-MM-DD) and the epoch of its local midnight. */
  today: string;
  midnight: number;
  projectId: string | null;
  projectNames: Map<string, string | null>;
}

export const iso = (ms: number) => new Date(ms).toISOString();

export function all<T>(r: ReadCtx, sql: string, ...args: SQLInputValue[]): T[] {
  return stmt(r.db, sql).all(...args) as unknown as T[];
}

export function one<T>(r: ReadCtx, sql: string, ...args: SQLInputValue[]): T | undefined {
  return stmt(r.db, sql).get(...args) as T | undefined;
}

/** SQL fragment + args restricting `col` to the requested project (no-op without a filter). */
export function inProject(r: ReadCtx, col: string): [string, SQLInputValue[]] {
  return r.projectId ? [` AND ${col} = ?`, [r.projectId]] : ['', []];
}

export function projectName(r: ReadCtx, projectId: string | null): string | null {
  return projectId ? (r.projectNames.get(projectId) ?? null) : null;
}

export interface UsageSums {
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_w5: number;
  cache_w1: number;
}

/**
 * `days` consecutive local days from `fromDate`: their dates, the epoch range they span, and a CASE expression
 * (with its bound args) giving the index of the local day a usage bucket (`u.bucket_ms`) falls in. Day bounds are
 * real local midnights, so DST days and :30/:45 offsets are exact.
 */
export function localDays(
  r: ReadCtx,
  fromDate: string,
  days: number,
): { dates: string[]; start: number; end: number; dayCase: string; dayArgs: number[] } {
  const dates = Array.from({ length: days }, (_, i) => addDays(fromDate, i));
  const bounds = [...dates, addDays(fromDate, days)].map((d) => zonedEpoch(d, '00:00', r.tz));
  const inner = bounds.slice(1, -1);
  return {
    dates,
    start: bounds[0]!,
    end: bounds[days]!,
    dayCase: inner.length
      ? `CASE ${inner.map((_, i) => `WHEN u.bucket_ms < ? THEN ${i}`).join(' ')} ELSE ${days - 1} END`
      : '0',
    dayArgs: inner,
  };
}

/** SELECT list summing the token columns of twr_usage (aliased `u`). */
export const USAGE_SUMS =
  'u.model AS model, SUM(u.input) AS input, SUM(u.output) AS output, SUM(u.cache_read) AS cache_read, SUM(u.cache_w5) AS cache_w5, SUM(u.cache_w1) AS cache_w1';

export function costOf(r: ReadCtx, row: UsageSums, date: string): number {
  return r.svc.costUsd(
    row.model,
    {
      inputTokens: row.input,
      outputTokens: row.output,
      cacheReadTokens: row.cache_read,
      cacheWrite5mTokens: row.cache_w5,
      cacheWrite1hTokens: row.cache_w1,
    },
    date,
  );
}
