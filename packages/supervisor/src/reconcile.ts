/**
 * Per-turn usage reconciliation (G-44, threat model O-5): the usage the sidecar recorded from the transcript against
 * the claude process's own figures. Neither is trusted alone: the transcript is agent-writable and the sidecar's token
 * is readable by anything that shares its OS user, while the stream-json `result` reaches only the supervisor.
 *
 * `result.modelUsage` is cumulative for the whole conversation: an invocation resumes from the cost state the previous
 * one saved (research §3.3, C14), so a turn's own figures are the difference from the previous turn's. They include
 * compaction and side queries, which never reach the transcript; otherwise the two agree to the token (research §6.3).
 */
import type { MetaOf, UsageReconciliationStatus } from '@aoc/contracts';

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export type ModelTokens = Record<string, TokenCounts>;

export interface PreviousCheck {
  turn: number;
  /** That turn's result carried the process's figures (else its cumulative was carried forward). */
  reported: boolean;
  cumulative: ModelTokens;
}

export interface ReconcileInput {
  turn: number;
  /** The process's cumulative figures from this turn's result; null when the turn ended without one. */
  cumulative: ModelTokens | null;
  /** This turn started the conversation (`--session-id`), so it resumed from nothing. */
  fresh: boolean;
  /** The session's latest check (null when none was ever made). */
  previous: PreviousCheck | null;
  /** usage.recorded since the previous check, per model. */
  sidecar: ModelTokens;
  /** The turn compacted its context. */
  compacted: boolean;
}

export interface ReconcileRow {
  model: string;
  process: TokenCounts | null;
  sidecar: TokenCounts;
  cumulative: TokenCounts | null;
}

export interface ReconcileResult {
  status: UsageReconciliationStatus;
  models: ReconcileRow[];
}

const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
const ZERO: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** Differences within this many tokens, or this share of the larger figure, are not discrepancies. */
export const RECONCILE_TOLERANCE = { tokens: 16, share: 0.005 } as const;
/** Rows an event carries (the contract's cap); extra sidecar-only models are folded into one. */
const MAX_ROWS = 32;
const FOLDED = 'other';

/** One spelling per model on both sides: transcripts name `claude-opus-5-5`, modelUsage may add a `[1m]` suffix. */
export function normalizeModel(model: string): string {
  return model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').slice(0, 80) || 'unknown';
}

function add(a: TokenCounts, b: TokenCounts): TokenCounts {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

function normalized(m: ModelTokens): ModelTokens {
  const out: ModelTokens = {};
  for (const [model, t] of Object.entries(m)) {
    const k = normalizeModel(model);
    out[k] = add(out[k] ?? ZERO, t);
  }
  return out;
}

/** The sidecar's usage.recorded batches, per model (cache writes of both lifetimes together, as modelUsage has them). */
export function sidecarTotals(batches: readonly MetaOf<'usage.recorded'>[]): ModelTokens {
  const out: ModelTokens = {};
  for (const b of batches) {
    const k = normalizeModel(b.model);
    out[k] = add(out[k] ?? ZERO, {
      input: b.inputTokens,
      output: b.outputTokens,
      cacheRead: b.cacheReadTokens,
      cacheWrite: b.cacheWrite5mTokens + b.cacheWrite1hTokens,
    });
  }
  return out;
}

/** What the next turn needs from a recorded check. */
export function previousCheckOf(meta: MetaOf<'usage.reconciled'>): PreviousCheck {
  const cumulative: ModelTokens = {};
  for (const r of meta.models) if (r.cumulative) cumulative[r.model] = r.cumulative;
  return { turn: meta.turn, reported: meta.reported, cumulative };
}

export function reconcileTurnUsage(i: ReconcileInput): ReconcileResult {
  const sidecar = normalized(i.sidecar);
  // Only usage of this turn is in the window when the previous check was of the previous turn.
  const contiguous = (i.previous?.turn ?? 0) === i.turn - 1;
  const baseline: ModelTokens | null = i.fresh ? {} : i.previous ? normalized(i.previous.cumulative) : null;
  // An earlier turn without a result may still have saved a cost state this turn resumed from.
  const exact = contiguous && (i.fresh || !!i.previous?.reported);

  if (!i.cumulative) {
    return { status: 'unverified', models: rows(sidecar, null, baseline) };
  }
  const cumulative = normalized(i.cumulative);
  if (!baseline) return { status: 'unverified', models: rows(sidecar, null, cumulative) };

  const turn: ModelTokens = {};
  let regressed = false;
  for (const model of new Set([...Object.keys(cumulative), ...Object.keys(baseline)])) {
    const now = cumulative[model] ?? ZERO;
    const before = baseline[model] ?? ZERO;
    const d = { input: now.input - before.input, output: now.output - before.output, cacheRead: now.cacheRead - before.cacheRead, cacheWrite: now.cacheWrite - before.cacheWrite };
    // A cumulative figure only grows: lower than before, the cost state the process resumed from was edited. Flagged
    // once; the next turn is measured from the figures the process reports now.
    if (FIELDS.some((f) => d[f] < 0)) regressed = true;
    turn[model] = d;
  }
  if (regressed) return { status: 'regressed', models: rows(sidecar, null, cumulative) };
  if (!contiguous) return { status: 'unverified', models: rows(sidecar, turn, cumulative) };

  let over = false;
  let under = false;
  for (const model of new Set([...Object.keys(turn), ...Object.keys(sidecar)])) {
    const p = turn[model] ?? ZERO;
    const s = sidecar[model] ?? ZERO;
    for (const f of FIELDS) {
      const tol = Math.max(RECONCILE_TOLERANCE.tokens, Math.ceil(Math.max(p[f], s[f]) * RECONCILE_TOLERANCE.share));
      if (s[f] - p[f] > tol) over = true;
      if (p[f] - s[f] > tol) under = true;
    }
  }
  const status: UsageReconciliationStatus = over
    ? 'over_reported'
    : !under
      ? 'match'
      : !exact
        ? 'unverified'
        : i.compacted
          ? 'overhead'
          : 'under_reported';
  return { status, models: rows(sidecar, turn, cumulative) };
}

/**
 * Event rows, by model. Beyond the cap (only a flood of made-up model names gets there) the smallest rows are folded
 * into one, the process's own models last: they carry the next baseline.
 */
function rows(sidecar: ModelTokens, turn: ModelTokens | null, cumulative: ModelTokens | null): ReconcileRow[] {
  const own = new Set([...Object.keys(turn ?? {}), ...Object.keys(cumulative ?? {})]);
  const out: ReconcileRow[] = [...new Set([...own, ...Object.keys(sidecar)])].sort().map((model) => ({
    model,
    process: turn ? (turn[model] ?? { ...ZERO }) : null,
    sidecar: sidecar[model] ?? { ...ZERO },
    cumulative: cumulative?.[model] ?? null,
  }));
  if (out.length <= MAX_ROWS) return out;
  const size = (r: ReconcileRow) => total(r.sidecar) + total(r.process ?? ZERO) + total(r.cumulative ?? ZERO);
  const ranked = [...out].sort((a, b) => Number(own.has(b.model)) - Number(own.has(a.model)) || size(b) - size(a));
  const rest = ranked.slice(MAX_ROWS - 1);
  const sum = (pick: (r: ReconcileRow) => TokenCounts) => rest.reduce((acc, r) => add(acc, pick(r)), { ...ZERO });
  return [
    ...ranked.slice(0, MAX_ROWS - 1).sort((a, b) => a.model.localeCompare(b.model)),
    { model: FOLDED, process: turn ? sum((r) => r.process ?? ZERO) : null, sidecar: sum((r) => r.sidecar), cumulative: null },
  ];
}

function total(t: TokenCounts): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}
