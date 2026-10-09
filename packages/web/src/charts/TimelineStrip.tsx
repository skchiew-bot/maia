import { useMemo, type ReactNode } from 'react';
import { cx } from '../lib/dom';
import { formatAge, formatClock, formatInteger } from '../lib/format';
import { ChartTable, HitLayer, estimateTextWidth, useElementWidth, type HitItem } from './shared';
import type { EpochMs, TimelineMark, TimelineMarkKind, TimelinePhase } from './types';

export interface TimelineStripProps {
  /** Left edge of the scale (session/project start). */
  start: EpochMs;
  /**
   * The present. Bands open to the right end at `now` and the now-marker sits here. Feed it from event
   * timestamps or the page clock — the strip never advances on its own.
   */
  now: EpochMs;
  /** Right edge of the scale. Default `now`; set later to show a fixed window with the now-marker inside. */
  end?: EpochMs;
  phases: readonly TimelinePhase[];
  marks: readonly TimelineMark[];
  /** Name for the accessible summary. Default "Session timeline". */
  label?: string;
  /** Enter / click on a focusable mark (decision, drift, rollback, enhancement). */
  onMarkSelect?: (mark: TimelineMark) => void;
  /** Adds a collapsible table of phases and marks. */
  tableView?: boolean;
  className?: string;
}

const KIND_WORD: Record<TimelineMarkKind, string> = {
  tool: 'Tool call',
  decision: 'Decision',
  drift: 'Drift',
  rollback: 'Rollback',
  enhancement: 'Enhancement',
};

const KIND_LEGEND: Record<TimelineMarkKind, string> = {
  tool: 'Tool calls',
  decision: 'Decisions',
  drift: 'Drift',
  rollback: 'Rollbacks',
  enhancement: 'Enhancements',
};

const KIND_PLURAL: Record<TimelineMarkKind, string> = {
  tool: 'tool calls',
  decision: 'decisions',
  drift: 'drift marks',
  rollback: 'rollbacks',
  enhancement: 'enhancements',
};

// Vertical layout (px).
const BAND_Y = 0;
const BAND_H = 22;
const TICK_Y = 26;
const TICK_H = 12;
const MARK_CY = 47;
const MARK_R = 5.5;
const AXIS_Y = 58;
const LABEL_Y = 72;
const HEIGHT = 76;
const PAD_X = 8;

/** Mark glyph centred at (x, y); shape differs per kind so colour is never the only cue. */
export function MarkShape({
  kind,
  x,
  y,
  r = MARK_R,
}: {
  kind: TimelineMarkKind;
  x: number;
  y: number;
  r?: number;
}) {
  const cls = `aoc-tl__mark aoc-tl__mark--${kind}`;
  switch (kind) {
    case 'decision':
      return (
        <path
          className={cls}
          d={`M${x},${y - r - 1}L${x + r + 1},${y}L${x},${y + r + 1}L${x - r - 1},${y}Z`}
        />
      );
    case 'drift':
      return (
        <path
          className={cls}
          d={`M${x},${y - r - 0.5}L${x + r + 0.5},${y + r - 0.5}L${x - r - 0.5},${y + r - 0.5}Z`}
        />
      );
    case 'rollback':
      return (
        <rect
          className={cls}
          x={x - r + 0.5}
          y={y - r + 0.5}
          width={(r - 0.5) * 2}
          height={(r - 0.5) * 2}
          rx={1.5}
        />
      );
    case 'enhancement':
      return <circle className={cls} cx={x} cy={y} r={r} />;
    case 'tool':
      return <rect className={cls} x={x - 0.5} y={y - r} width={1.5} height={r * 2} />;
  }
}

/** Legend swatch: the same glyph at legend size. */
function LegendGlyph({ kind }: { kind: TimelineMarkKind | 'now' }) {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden="true" className="aoc-legend__glyph">
      {kind === 'now' ? (
        <rect x={6} y={1} width={2} height={12} className="aoc-tl__now" />
      ) : (
        <MarkShape kind={kind} x={7} y={7} r={4.5} />
      )}
    </svg>
  );
}

function niceStep(spanMs: number, widthPx: number): number {
  const minutes = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080];
  const maxTicks = Math.max(1, Math.floor(widthPx / 90));
  for (const m of minutes) if (spanMs / (m * 60_000) <= maxTicks) return m * 60_000;
  return 10080 * 60_000;
}

/**
 * The session hero (§12): phases as bands to scale by elapsed time, tool-call ticks, decision diamonds,
 * amber drift marks, rollback/enhancement marks and a now-marker. Marks are keyboard-focusable (one tab stop,
 * arrow keys) with tooltips; counts and phase durations are always printed as text.
 */
export function TimelineStrip({
  start,
  now,
  end,
  phases,
  marks,
  label = 'Session timeline',
  onMarkSelect,
  tableView,
  className,
}: TimelineStripProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>(640);
  const scaleEnd = Math.max(end ?? now, start + 1);
  const span = scaleEnd - start;
  const innerW = Math.max(1, width - PAD_X * 2);
  const x = (t: number) => PAD_X + ((Math.min(Math.max(t, start), scaleEnd) - start) / span) * innerW;

  const counts = useMemo(() => {
    const c: Record<TimelineMarkKind, number> = {
      tool: 0,
      decision: 0,
      drift: 0,
      rollback: 0,
      enhancement: 0,
    };
    for (const m of marks) c[m.kind] += 1;
    return c;
  }, [marks]);

  const bands = useMemo(
    () =>
      phases.map((p) => {
        const pEnd = p.end ?? now;
        const x0 = x(p.start);
        const x1 = x(pEnd);
        const duration = Math.max(0, pEnd - p.start);
        const w = Math.max(0, x1 - x0 - 2);
        // In-band label only when it fits: "name · duration", else the name, else nothing (the phase list
        // below then carries it — labels are never clipped).
        const full = `${p.label} · ${formatAge(duration)}`;
        const text =
          estimateTextWidth(full) + 12 <= w ? full : estimateTextWidth(p.label) + 12 <= w ? p.label : '';
        return { phase: p, x0, w, duration, text, fullFit: text === full, active: p.end === undefined };
      }),
    // x depends on start/scaleEnd/innerW, all listed.
    [phases, now, start, scaleEnd, innerW],
  );
  const allBandsLabelled = bands.every((b) => b.fullFit);

  const focusable = useMemo(
    () =>
      marks
        .filter((m) => m.kind !== 'tool')
        .slice()
        .sort((a, b) => a.at - b.at),
    [marks],
  );

  const hits: HitItem[] = useMemo(
    () =>
      focusable.map((m) => {
        const mx = x(m.at);
        const when = formatClock(m.at);
        const ago = formatAge(now - m.at);
        const tooltip: ReactNode = (
          <>
            <span className="aoc-chart-tip__kind">{KIND_WORD[m.kind]}</span>
            {m.label && <strong>{m.label}</strong>}
            <span className="aoc-chart-tip__meta aoc-num">
              {when} · {ago} ago
            </span>
            {m.detail && <span className="aoc-chart-tip__meta">{m.detail}</span>}
          </>
        );
        return {
          key: m.id,
          x: mx - MARK_R,
          y: MARK_CY - MARK_R,
          width: MARK_R * 2,
          height: MARK_R * 2,
          label: `${KIND_WORD[m.kind]}${m.label ? `: ${m.label}` : ''}, ${when}, ${ago} ago${m.detail ? `. ${m.detail}` : ''}`,
          tooltip,
          onActivate: onMarkSelect ? () => onMarkSelect(m) : undefined,
        };
      }),
    [focusable, now, onMarkSelect, start, scaleEnd, innerW],
  );

  const ticks = useMemo(() => {
    const step = niceStep(span, width);
    const out: number[] = [];
    const first = Math.ceil(start / step) * step;
    for (let t = first; t < scaleEnd; t += step) out.push(t);
    return out;
  }, [span, width, start, scaleEnd]);

  const nowX = x(now);
  const startLabel = formatClock(start);
  const nowLabel = `now ${formatClock(now)}`;
  const nowLabelW = estimateTextWidth(nowLabel);
  const nowAnchor = nowX + nowLabelW / 2 > width ? 'end' : nowX - nowLabelW / 2 < 0 ? 'start' : 'middle';
  const nowLeft =
    nowAnchor === 'end' ? nowX - nowLabelW : nowAnchor === 'start' ? nowX : nowX - nowLabelW / 2;
  const tickLabels = ticks.filter((t) => {
    const tx = x(t);
    const w = estimateTextWidth(formatClock(t));
    return (
      tx - w / 2 > PAD_X + estimateTextWidth(startLabel) + 8 &&
      (tx + w / 2 < nowLeft - 8 || tx - w / 2 > nowLeft + nowLabelW + 8)
    );
  });

  const elapsed = formatAge(now - start);
  const phaseText = bands
    .map((b) => `${b.phase.label} ${formatAge(b.duration)}${b.active ? ' (active)' : ''}`)
    .join(', ');
  const markText = (['tool', 'decision', 'drift', 'rollback', 'enhancement'] as const)
    .filter((k) => counts[k] > 0)
    .map((k) => `${formatInteger(counts[k])} ${KIND_PLURAL[k]}`)
    .join(', ');
  const summary = `${label}: ${elapsed} elapsed since ${startLabel}. ${phaseText ? `Phases: ${phaseText}.` : 'No phases yet.'} ${
    markText || 'No marks yet.'
  }`;

  return (
    <figure className={cx('aoc-chart', 'aoc-tl', className)}>
      <div className="aoc-chart__plot" ref={ref}>
        <svg role="img" aria-label={summary} width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`}>
          {bands.map((b) => (
            <g key={b.phase.id}>
              <rect
                x={b.x0}
                y={BAND_Y}
                width={b.w}
                height={BAND_H}
                rx={3}
                className={cx('aoc-tl__band', b.active && 'is-active')}
              />
              {b.text && (
                <text
                  x={b.x0 + 6}
                  y={BAND_Y + 15}
                  className={cx('aoc-tl__band-label', b.active && 'is-active')}
                >
                  {b.text}
                </text>
              )}
            </g>
          ))}
          {marks
            .filter((m) => m.kind === 'tool')
            .map((m) => (
              <rect
                key={m.id}
                x={x(m.at) - 0.5}
                y={TICK_Y}
                width={1}
                height={TICK_H}
                className="aoc-tl__tick"
              />
            ))}
          {marks
            .filter((m) => m.kind === 'drift')
            .map((m) => (
              <line
                key={`${m.id}-rule`}
                x1={x(m.at)}
                x2={x(m.at)}
                y1={BAND_Y}
                y2={MARK_CY}
                className="aoc-tl__drift-rule"
              />
            ))}
          <line x1={PAD_X} x2={width - PAD_X} y1={AXIS_Y} y2={AXIS_Y} className="aoc-tl__axis" />
          {ticks.map((t) => (
            <line key={t} x1={x(t)} x2={x(t)} y1={AXIS_Y} y2={AXIS_Y + 4} className="aoc-tl__axis" />
          ))}
          {focusable.map((m) => (
            <MarkShape key={m.id} kind={m.kind} x={x(m.at)} y={MARK_CY} />
          ))}
          <line x1={nowX} x2={nowX} y1={BAND_Y} y2={AXIS_Y} className="aoc-tl__now" />
          <text x={PAD_X} y={LABEL_Y} className="aoc-tl__axis-label">
            {startLabel}
          </text>
          {tickLabels.map((t) => (
            <text key={t} x={x(t)} y={LABEL_Y} textAnchor="middle" className="aoc-tl__axis-label">
              {formatClock(t)}
            </text>
          ))}
          <text x={nowX} y={LABEL_Y} textAnchor={nowAnchor} className="aoc-tl__axis-label aoc-tl__now-label">
            {nowLabel}
          </text>
        </svg>
        <HitLayer
          items={hits}
          label={`${label} marks: use arrow keys to move between them`}
          width={width}
          height={HEIGHT}
        />
      </div>
      <figcaption className="aoc-legend">
        <span className="aoc-legend__item">
          <strong className="aoc-num">{elapsed}</strong> elapsed
        </span>
        {(['decision', 'drift', 'rollback', 'enhancement', 'tool'] as const).map((k) => (
          <span key={k} className={cx('aoc-legend__item', counts[k] === 0 && 'is-zero')}>
            <LegendGlyph kind={k} />
            <span>{KIND_LEGEND[k]}</span>
            <strong className="aoc-num">{formatInteger(counts[k])}</strong>
          </span>
        ))}
        <span className="aoc-legend__item">
          <LegendGlyph kind="now" />
          <span>Now</span>
        </span>
      </figcaption>
      {bands.length > 0 && !allBandsLabelled && (
        <ol className="aoc-tl__phases">
          {bands.map((b, i) => (
            <li key={b.phase.id} className={cx(b.active && 'is-active')}>
              <span className="aoc-tl__phase-index aoc-num">{i + 1}</span>
              <span>{b.phase.label}</span>
              <span className="aoc-num aoc-tl__phase-dur">{formatAge(b.duration)}</span>
              {b.active && <span className="aoc-tl__phase-active">active</span>}
            </li>
          ))}
        </ol>
      )}
      {tableView && (
        <ChartTable
          caption={`${label} marks`}
          columns={['Time', 'Kind', 'Label', 'Detail']}
          rows={[...marks]
            .filter((m) => m.kind !== 'tool')
            .sort((a, b) => a.at - b.at)
            .map((m) => [formatClock(m.at), KIND_WORD[m.kind], m.label ?? '', m.detail ?? ''])}
        />
      )}
    </figure>
  );
}
