import { useId, useMemo } from 'react';
import { cx } from '../lib/dom';
import { formatCompact, formatPercent } from '../lib/format';
import { CATEGORICAL, toneColor, useElementWidth } from './shared';
import type { Segment, SegmentTone, ValueFormatter } from './types';

export interface SegmentBarProps {
  /** Parts, in display order. */
  segments: readonly Segment[];
  /** What the bar shows ("Spend by model") — names the accessible summary. */
  label: string;
  /** Capacity of the bar (e.g. a budget). When larger than the sum, the rest is drawn as empty track. */
  total?: number;
  format?: ValueFormatter;
  /** Bar height in px. Default 12. */
  height?: number;
  /** Legend with values and shares. Default true. */
  legend?: boolean;
  /**
   * Distinct coloured parts before the tail folds into "Other". Default (and maximum) 4 — beyond that the
   * categorical palette stops being distinguishable, so more parts belong in a table.
   */
  maxSegments?: number;
  className?: string;
}

const GAP = 2;

interface ResolvedSegment {
  id: string;
  label: string;
  value: number;
  tone: SegmentTone;
}

/** Generic part-to-whole bar with 2px surface gaps between parts and a legend carrying every value. */
export function SegmentBar({
  segments,
  label,
  total,
  format = formatCompact,
  height = 12,
  legend = true,
  maxSegments = 4,
  className,
}: SegmentBarProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>(480);
  const clipId = `segclip-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const resolved = useMemo<ResolvedSegment[]>(() => {
    const cap = Math.max(1, Math.min(maxSegments, CATEGORICAL.length));
    const positive = segments.filter((s) => s.value > 0);
    const head = positive.length > cap ? positive.slice(0, cap - 1) : positive;
    const tail = positive.length > cap ? positive.slice(cap - 1) : [];
    let slot = 0;
    const out: ResolvedSegment[] = head.map((s) => ({
      id: s.id,
      label: s.label,
      value: s.value,
      tone: s.tone ?? CATEGORICAL[slot++ % CATEGORICAL.length]!,
    }));
    if (tail.length > 0) {
      out.push({
        id: '__other',
        label: `Other (${tail.length})`,
        value: tail.reduce((a, s) => a + s.value, 0),
        tone: 'neutral',
      });
    }
    return out;
  }, [segments, maxSegments]);

  const sum = resolved.reduce((a, s) => a + s.value, 0);
  const capacity = Math.max(total ?? sum, sum, 1e-9);
  const usable = Math.max(1, width - GAP * Math.max(0, resolved.length - 1));
  let cursor = 0;
  const rects = resolved.map((s) => {
    const w = (s.value / capacity) * usable;
    const r = { seg: s, x: cursor, w };
    cursor += w + GAP;
    return r;
  });

  const share = (v: number) => formatPercent(v / capacity);
  const summary = `${label}: ${resolved.map((s) => `${s.label} ${format(s.value)} (${share(s.value)})`).join(', ')}${
    total !== undefined && total > sum
      ? `; ${format(total - sum)} unused of ${format(total)}`
      : `; total ${format(sum)}`
  }.`;

  return (
    <figure className={cx('aoc-chart', 'aoc-segbar', className)}>
      <div className="aoc-chart__plot" ref={ref}>
        <svg role="img" aria-label={summary} width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          <defs>
            <clipPath id={clipId}>
              <rect x={0} y={0} width={width} height={height} rx={Math.min(4, height / 2)} />
            </clipPath>
          </defs>
          <g clipPath={`url(#${clipId})`}>
            <rect x={0} y={0} width={width} height={height} className="aoc-segbar__track" />
            {rects.map((r) => (
              <rect
                key={r.seg.id}
                x={r.x}
                y={0}
                width={Math.max(0, r.w)}
                height={height}
                style={{ fill: toneColor(r.seg.tone) }}
              />
            ))}
          </g>
        </svg>
      </div>
      {legend && (
        <figcaption className="aoc-legend">
          {resolved.map((s) => (
            <span key={s.id} className="aoc-legend__item">
              <span
                className="aoc-legend__swatch"
                style={{ background: toneColor(s.tone) }}
                aria-hidden="true"
              />
              <span>{s.label}</span>
              <strong className="aoc-num">{format(s.value)}</strong>
              <span className="aoc-legend__share aoc-num">{share(s.value)}</span>
            </span>
          ))}
          {total !== undefined && total > sum && (
            <span className="aoc-legend__item">
              <span className="aoc-legend__swatch aoc-legend__swatch--track" aria-hidden="true" />
              <span>Unused</span>
              <strong className="aoc-num">{format(total - sum)}</strong>
            </span>
          )}
        </figcaption>
      )}
    </figure>
  );
}
