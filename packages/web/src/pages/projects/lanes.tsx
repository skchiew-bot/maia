import { useMemo } from 'react';
import { HitLayer, MarkShape, useElementWidth, type HitItem } from '../../charts';
import { estimateTextWidth } from '../../charts/shared';
import { cx } from '../../lib/dom';
import { formatDateTime, formatInteger, formatShortDate } from '../../lib/format';

/**
 * Time lanes of the master timeline: every lane shares one calendar scale (project start → now), so a close,
 * a pin or a drift mark lines up across phases. Marks are events from the log; nothing moves on a timer.
 */
export interface TimeScale {
  start: number;
  end: number;
  now: number;
}

const PAD = 6;
const DAY = 86_400_000;

export function xAt(scale: TimeScale, width: number, t: number): number {
  const span = Math.max(1, scale.end - scale.start);
  const clamped = Math.min(Math.max(t, scale.start), scale.end);
  return PAD + ((clamped - scale.start) / span) * Math.max(1, width - PAD * 2);
}

function localMidnight(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Day boundaries to label, spaced so labels never collide (1, 2, 3, 7 or 14 days apart). */
export function dayTicks(scale: TimeScale, width: number): number[] {
  const perDay = (Math.max(1, width - PAD * 2) * DAY) / Math.max(1, scale.end - scale.start);
  const step = [1, 2, 3, 7, 14, 28].find((d) => d * perDay >= 64) ?? 28;
  const out: number[] = [];
  for (let t = localMidnight(scale.start) + DAY; t < scale.end; t += DAY) {
    const day = Math.round((t - localMidnight(scale.start)) / DAY);
    if (day % step === 0) out.push(t);
  }
  return out;
}

/** Header row: day labels on the shared scale and the now label. */
export function TimeAxis({ scale }: { scale: TimeScale }) {
  const [ref, width] = useElementWidth<HTMLDivElement>(480);
  const nowX = xAt(scale, width, scale.now);
  const nowLabel = 'now';
  const ticks = dayTicks(scale, width).filter((t) => {
    const x = xAt(scale, width, t);
    const w = estimateTextWidth(formatShortDate(t));
    return x - w / 2 > PAD && Math.abs(x - nowX) > w / 2 + estimateTextWidth(nowLabel);
  });
  return (
    <div className="prj-axis" ref={ref} aria-hidden="true">
      <svg width={width} height={18} viewBox={`0 0 ${width} 18`}>
        <text x={PAD} y={12} className="prj-axis__label">
          {formatShortDate(scale.start)}
        </text>
        {ticks.map((t) => (
          <text key={t} x={xAt(scale, width, t)} y={12} textAnchor="middle" className="prj-axis__label">
            {formatShortDate(t)}
          </text>
        ))}
        <text x={Math.min(nowX, width - 2)} y={12} textAnchor="end" className="prj-axis__label prj-axis__now">
          {nowLabel}
        </text>
      </svg>
    </div>
  );
}

export interface LaneClose {
  at: number;
  flagged: boolean;
}
export interface LanePin {
  at: number;
  label: string;
}

/** Closes that fall in the same few pixels stack into one column, so density reads as height. */
export function bucketCloses(
  closes: readonly LaneClose[],
  xOf: (t: number) => number,
  px = 3,
): Array<{ x: number; verified: number; flagged: number }> {
  const buckets = new Map<number, { x: number; verified: number; flagged: number }>();
  for (const c of closes) {
    const key = Math.round(xOf(c.at) / px);
    const b = buckets.get(key) ?? { x: key * px, verified: 0, flagged: 0 };
    if (c.flagged) b.flagged += 1;
    else b.verified += 1;
    buckets.set(key, b);
  }
  return [...buckets.values()].sort((a, b) => a.x - b.x);
}

const LANE_H = 28;
const BASE = 23;
const UNIT = 3;
const MAX_COL = 14;

/**
 * A phase's activity on the shared calendar: its span (first session start → completion, or now while open), a
 * column per cluster of task closes (taller = more closes; amber = flagged), and a flag at every pinned tag.
 */
export function ActivityLane({
  scale,
  label,
  spanStart,
  spanEnd,
  closes,
  pins,
  open,
}: {
  scale: TimeScale;
  label: string;
  spanStart: number | null;
  spanEnd: number | null;
  closes: readonly LaneClose[];
  pins: readonly LanePin[];
  open: boolean;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>(480);
  const x = (t: number) => xAt(scale, width, t);
  const columns = bucketCloses(closes, x);
  const flagged = closes.filter((c) => c.flagged).length;
  const first = closes.length ? Math.min(...closes.map((c) => c.at)) : null;
  const last = closes.length ? Math.max(...closes.map((c) => c.at)) : null;
  const summary = `${label}: ${formatInteger(closes.length)} ${closes.length === 1 ? 'task' : 'tasks'} closed${
    first !== null && last !== null ? ` between ${formatShortDate(first)} and ${formatShortDate(last)}` : ''
  }${flagged ? `, ${formatInteger(flagged)} flagged` : ''}; ${formatInteger(pins.length)} ${
    pins.length === 1 ? 'pin' : 'pins'
  }; ${open ? 'open' : 'complete'}.`;
  return (
    <div className="prj-lane" ref={ref}>
      <svg role="img" aria-label={summary} width={width} height={LANE_H} viewBox={`0 0 ${width} ${LANE_H}`}>
        <line x1={PAD} x2={width - PAD} y1={BASE + 0.5} y2={BASE + 0.5} className="prj-lane__rule" />
        {spanStart !== null && (
          <rect
            x={x(spanStart)}
            y={BASE}
            width={Math.max(2, x(spanEnd ?? scale.now) - x(spanStart))}
            height={3}
            rx={1.5}
            className={cx('prj-lane__span', open && 'is-open')}
          />
        )}
        {columns.map((c) => {
          const total = Math.min(MAX_COL, (c.verified + c.flagged) * UNIT + 2);
          const flaggedH = c.flagged
            ? Math.max(UNIT, Math.round((c.flagged / (c.verified + c.flagged)) * total))
            : 0;
          return (
            <g key={c.x}>
              {c.verified > 0 && (
                <rect
                  x={c.x - 1}
                  y={BASE - total}
                  width={2.5}
                  height={total - flaggedH}
                  className="prj-lane__close"
                />
              )}
              {flaggedH > 0 && (
                <rect
                  x={c.x - 1}
                  y={BASE - flaggedH}
                  width={2.5}
                  height={flaggedH}
                  className="prj-lane__flagged"
                />
              )}
            </g>
          );
        })}
        {pins.map((p, i) => (
          <path key={`p${i}`} d={`M${x(p.at)},8V1h5l-1.25,2l1.25,2h-5`} className="prj-lane__pin" />
        ))}
        <line x1={x(scale.now)} x2={x(scale.now)} y1={1} y2={LANE_H - 1} className="prj-lane__now" />
      </svg>
    </div>
  );
}

export type EventKind = 'amendment' | 'enhancement' | 'drift' | 'rollback';

export interface LaneEvent {
  id: string;
  kind: EventKind;
  at: number;
  title: string;
  detail?: string;
}

const KIND_WORD: Record<EventKind, string> = {
  amendment: 'Amendment',
  enhancement: 'Enhancement',
  drift: 'Drift',
  rollback: 'Rollback',
};
const KIND_PLURAL: Record<EventKind, string> = {
  amendment: 'amendments',
  enhancement: 'enhancements',
  drift: 'drift marks',
  rollback: 'rollbacks',
};

/** Three rows, one glyph each: audited scope additions (⊕ teal), drift (▼ amber), rollbacks (red). */
type Row = 'scope' | 'drift' | 'rollback';
const ROW_OF: Record<EventKind, Row> = {
  amendment: 'scope',
  enhancement: 'scope',
  drift: 'drift',
  rollback: 'rollback',
};
const ROWS: readonly Row[] = ['scope', 'drift', 'rollback'];
const ROW_SHAPE: Record<Row, 'enhancement' | 'drift' | 'rollback'> = {
  scope: 'enhancement',
  drift: 'drift',
  rollback: 'rollback',
};
const ROW_WORD: Record<Row, string> = { scope: 'Scope', drift: 'Drift', rollback: 'Rollback' };

export interface Cluster {
  row: Row;
  x: number;
  events: LaneEvent[];
}

/** Marks in one row closer than `gap` px merge into one mark with a count, so glyphs never overlap. */
export function clusterEvents(events: readonly LaneEvent[], xOf: (t: number) => number, gap = 9): Cluster[] {
  const out: Cluster[] = [];
  for (const row of ROWS) {
    let current: Cluster | null = null;
    for (const e of events.filter((ev) => ROW_OF[ev.kind] === row).sort((a, b) => a.at - b.at)) {
      const ex = xOf(e.at);
      if (current && ex - current.x < gap) current.events.push(e);
      else {
        current = { row, x: ex, events: [e] };
        out.push(current);
      }
    }
  }
  return out;
}

function clusterLabel(c: Cluster): string {
  const head = c.events.length > 1 ? `${ROW_WORD[c.row]} ×${c.events.length}` : KIND_WORD[c.events[0]!.kind];
  const items = c.events
    .slice(0, 3)
    .map((e) => `${c.events.length > 1 ? `${KIND_WORD[e.kind]}: ` : ''}${e.title}, ${formatDateTime(e.at)}`)
    .join('; ');
  return `${head}: ${items}${c.events.length > 3 ? `; and ${c.events.length - 3} more` : ''}`;
}

/** Scope and drift on the shared scale, so a jump in the denominator lines up with the work around it. */
export function EventsLane({
  scale,
  events,
  label,
}: {
  scale: TimeScale;
  events: readonly LaneEvent[];
  label: string;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>(480);
  const H = 46;
  const rowY = (r: Row) => 9 + ROWS.indexOf(r) * 14;
  const clusters = useMemo(() => clusterEvents(events, (t) => xAt(scale, width, t)), [events, scale, width]);
  const counts = (['amendment', 'enhancement', 'drift', 'rollback'] as const)
    .map((k) => [k, events.filter((e) => e.kind === k).length] as const)
    .filter(([, n]) => n > 0);
  const summary = `${label}: ${
    counts.length
      ? counts
          .map(([k, n]) => `${formatInteger(n)} ${n === 1 ? KIND_WORD[k].toLowerCase() : KIND_PLURAL[k]}`)
          .join(', ')
      : 'none yet'
  }.`;
  const hits: HitItem[] = clusters.map((c, i) => ({
    key: `${c.row}-${i}`,
    x: c.x - 6,
    y: rowY(c.row) - 6,
    width: 12,
    height: 12,
    label: clusterLabel(c),
    tooltip: (
      <>
        <span className="aoc-chart-tip__kind">
          {c.events.length > 1 ? `${ROW_WORD[c.row]} ×${c.events.length}` : KIND_WORD[c.events[0]!.kind]}
        </span>
        {c.events.slice(0, 4).map((e) => (
          <span key={e.id} className="aoc-chart-tip__meta">
            <strong>{e.title}</strong> · {formatDateTime(e.at)}
            {e.detail ? ` · ${e.detail}` : ''}
          </span>
        ))}
        {c.events.length > 4 && <span className="aoc-chart-tip__meta">and {c.events.length - 4} more</span>}
      </>
    ),
  }));
  return (
    <div className="aoc-chart prj-lane prj-lane--events" ref={ref}>
      <div className="aoc-chart__plot">
        <svg role="img" aria-label={summary} width={width} height={H} viewBox={`0 0 ${width} ${H}`}>
          {ROWS.map((r) => (
            <line key={r} x1={PAD} x2={width - PAD} y1={rowY(r)} y2={rowY(r)} className="prj-lane__rule" />
          ))}
          {clusters.map((c, i) => (
            <g key={`${c.row}-${i}`}>
              {c.row === 'drift' && (
                <line x1={c.x} x2={c.x} y1={2} y2={H - 2} className="prj-lane__drift-rule" />
              )}
              <MarkShape kind={ROW_SHAPE[c.row]} x={c.x} y={rowY(c.row)} r={4.5} />
              {c.events.length > 1 && (
                <text x={c.x + 7} y={rowY(c.row) + 4} className="prj-lane__count">
                  ×{c.events.length}
                </text>
              )}
            </g>
          ))}
          <line
            x1={xAt(scale, width, scale.now)}
            x2={xAt(scale, width, scale.now)}
            y1={2}
            y2={H - 2}
            className="prj-lane__now"
          />
        </svg>
        <HitLayer
          items={hits}
          label={`${label}: use arrow keys to move between marks`}
          width={width}
          height={H}
        />
      </div>
    </div>
  );
}
