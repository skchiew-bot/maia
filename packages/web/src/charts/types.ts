/**
 * Data shapes for the chart kit. Charts take plain arrays/objects — map daemon DTOs into these in the page,
 * never inside a chart. All times are epoch milliseconds; all labels are untrusted text (rendered as text).
 */

/** Epoch milliseconds. */
export type EpochMs = number;

/** Turns a value into display text (`formatUsd`, `formatTokens`, …). */
export type ValueFormatter = (value: number) => string;

/** Values sampled at equal intervals, oldest first (e.g. actions per minute, one per minute). */
export type Series = readonly number[];

/** One phase band on a TimelineStrip. Width is proportional to elapsed time. */
export interface TimelinePhase {
  id: string;
  /** Phase name from the manifest ("Discovery", "Build"). */
  label: string;
  start: EpochMs;
  /** Omit for the active phase — it runs to `now`. */
  end?: EpochMs;
}

/**
 * Timeline mark kinds (§12 session hero): tool-call ticks, decision diamonds, amber drift marks, rollback
 * and enhancement marks.
 */
export type TimelineMarkKind = 'tool' | 'decision' | 'drift' | 'rollback' | 'enhancement';

export interface TimelineMark {
  id: string;
  kind: TimelineMarkKind;
  at: EpochMs;
  /** Short title ("Approve schema migration"). Tool ticks usually omit it. */
  label?: string;
  /** Second line ("approved by CEO · 2h 14m"). */
  detail?: string;
}

/** Per-phase completion for StackedPhaseBar: weighted done vs declared (§4, §9). */
export interface PhaseProgress {
  id: string;
  label: string;
  /** Sum of declared sizes of tasks done with evidence. */
  doneWeight: number;
  /** Sum of declared sizes of all tasks in the phase — the denominator; amendments move it. */
  declaredWeight: number;
  /** Task counts for the text label. */
  doneTasks?: number;
  declaredTasks?: number;
  /** Emphasis only; the numbers already say it. */
  state?: 'done' | 'active' | 'pending';
}

/** One process type in the Registry hero: what a discovery-class run costs vs. its distilled execution. */
export interface PairedBarRow {
  id: string;
  /** Process type name. */
  label: string;
  /** Mean cost per discovery run (series-1). */
  discovery: number;
  /** Mean cost per distilled execution run (series-2). */
  execution: number;
  /** Runs behind the means (shown as context). */
  runs?: number;
}

/** Colour a segment may wear: categorical slots (identity) or reserved status tones (meaning). */
export type SegmentTone =
  'series-1' | 'series-2' | 'series-3' | 'series-4' | 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

export interface Segment {
  id: string;
  label: string;
  value: number;
  /** Defaults to the next categorical slot in fixed order. Use status tones only when the segment means good/bad. */
  tone?: SegmentTone;
}

/** A daily rollup value. `date` is a calendar day, `YYYY-MM-DD`. */
export interface DailyValue {
  date: string;
  value: number;
  /** Tooltip note, e.g. "FX carried forward from Oct 4". */
  note?: string;
}

/** §11 repeat-offence lifecycle. */
export type RecurrenceStage = 'detected' | 'root_caused' | 'fix_applied' | 'verified_closed';

export interface WeeklyCount {
  /** Week label as displayed ("W39" or "Sep 22"). */
  week: string;
  count: number;
}

/** One root-cause class in RecurrenceTrend (never a person — §11). */
export interface RecurrenceClass {
  id: string;
  label: string;
  /** Oldest first. */
  weeks: readonly WeeklyCount[];
  stage?: RecurrenceStage;
  /** Context line, e.g. "≈ US$42 per recurrence". */
  note?: string;
}
