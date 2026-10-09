import { useMemo } from 'react';
import { cx } from '../lib/dom';
import { formatInteger, formatNumber, formatPercent } from '../lib/format';
import { HitLayer, estimateTextWidth, useElementWidth, type HitItem } from './shared';
import type { PhaseProgress } from './types';

export interface StackedPhaseBarProps {
  phases: readonly PhaseProgress[];
  /** Name for the accessible summary. Default "Completion by phase". */
  label?: string;
  /** Bar height in px. Default 14. */
  height?: number;
  className?: string;
}

const GAP = 2;
const LABEL_ROW = 18;

function weightText(v: number): string {
  return Number.isInteger(v) ? formatInteger(v) : formatNumber(v, 1);
}

/**
 * Master-timeline completion (§9): one segment per phase, width proportional to its declared weight, filled
 * by its done weight. Measured, not estimated — the denominator moves visibly when the manifest is amended.
 */
export function StackedPhaseBar({
  phases,
  label = 'Completion by phase',
  height = 14,
  className,
}: StackedPhaseBarProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>(560);
  const visible = phases.filter((p) => p.declaredWeight > 0);
  const totalDeclared = visible.reduce((s, p) => s + p.declaredWeight, 0);
  const totalDone = visible.reduce((s, p) => s + Math.min(p.doneWeight, p.declaredWeight), 0);
  const hasTasks = visible.every((p) => p.doneTasks !== undefined && p.declaredTasks !== undefined);
  const tasksDone = hasTasks ? visible.reduce((s, p) => s + (p.doneTasks ?? 0), 0) : 0;
  const tasksDeclared = hasTasks ? visible.reduce((s, p) => s + (p.declaredTasks ?? 0), 0) : 0;
  const ratio = totalDeclared > 0 ? totalDone / totalDeclared : 0;

  const phaseCount = (p: PhaseProgress) =>
    p.doneTasks !== undefined && p.declaredTasks !== undefined
      ? `${formatInteger(p.doneTasks)}/${formatInteger(p.declaredTasks)}`
      : `${weightText(p.doneWeight)}/${weightText(p.declaredWeight)}`;

  const segments = useMemo(() => {
    const usable = Math.max(1, width - GAP * Math.max(0, visible.length - 1));
    let cursor = 0;
    return visible.map((p, i) => {
      const w = (p.declaredWeight / totalDeclared) * usable;
      const doneW = (Math.min(p.doneWeight, p.declaredWeight) / p.declaredWeight) * w;
      // Label under the segment only when it fits; otherwise its index (the numbered list below and the
      // tooltip carry the rest — never a clipped label, never a bare count without its phase).
      const full = `${p.label} ${phaseCount(p)}`;
      const text =
        estimateTextWidth(full) + 4 <= w
          ? full
          : estimateTextWidth(String(i + 1)) + 2 <= w
            ? String(i + 1)
            : '';
      const seg = { phase: p, x: cursor, w, doneW, text, fitsFull: text === full };
      cursor += w + GAP;
      return seg;
    });
  }, [visible, totalDeclared, width]);
  const allFit = segments.every((s) => s.fitsFull);

  const phaseSentence = (p: PhaseProgress) =>
    `${p.label}: ${phaseCount(p)} ${p.doneTasks !== undefined ? 'tasks' : 'weight'} (${formatPercent(
      p.declaredWeight > 0 ? Math.min(p.doneWeight, p.declaredWeight) / p.declaredWeight : 0,
    )})${p.state === 'active' ? ', active' : ''}`;

  const summary = `${label}: ${formatPercent(ratio)} of declared weight done${
    hasTasks ? `, ${formatInteger(tasksDone)} of ${formatInteger(tasksDeclared)} tasks` : ''
  }. ${visible.map(phaseSentence).join('; ')}.`;

  const hits: HitItem[] = segments.map((s) => ({
    key: s.phase.id,
    x: s.x,
    y: 0,
    width: Math.max(1, s.w),
    height,
    label: phaseSentence(s.phase),
    tooltip: (
      <>
        <strong>{s.phase.label}</strong>
        <span className="aoc-chart-tip__meta aoc-num">
          {phaseCount(s.phase)} {s.phase.doneTasks !== undefined ? 'tasks' : ''} ·{' '}
          {formatPercent(Math.min(s.phase.doneWeight, s.phase.declaredWeight) / s.phase.declaredWeight)}
        </span>
        <span className="aoc-chart-tip__meta aoc-num">
          weight {weightText(s.phase.doneWeight)} of {weightText(s.phase.declaredWeight)}
        </span>
      </>
    ),
  }));

  return (
    <figure className={cx('aoc-chart', 'aoc-phasebar', className)}>
      <figcaption className="aoc-phasebar__summary">
        <strong className="aoc-phasebar__pct aoc-num">{formatPercent(ratio)}</strong>
        <span>done by declared weight</span>
        {hasTasks && (
          <span className="aoc-phasebar__tasks aoc-num">
            {formatInteger(tasksDone)}/{formatInteger(tasksDeclared)} tasks
          </span>
        )}
      </figcaption>
      <div className="aoc-chart__plot" ref={ref}>
        <svg
          role="img"
          aria-label={summary}
          width={width}
          height={height + LABEL_ROW}
          viewBox={`0 0 ${width} ${height + LABEL_ROW}`}
        >
          {segments.map((s) => (
            <g key={s.phase.id}>
              <rect
                x={s.x}
                y={0}
                width={Math.max(0, s.w)}
                height={height}
                rx={3}
                className="aoc-phasebar__track"
              />
              {s.doneW > 0 && (
                <rect
                  x={s.x}
                  y={0}
                  width={Math.max(0, s.doneW)}
                  height={height}
                  rx={3}
                  className="aoc-phasebar__done"
                />
              )}
              {s.text && (
                <text
                  x={s.x}
                  y={height + 14}
                  className={cx('aoc-phasebar__label', s.phase.state === 'active' && 'is-active')}
                >
                  {s.text}
                </text>
              )}
            </g>
          ))}
        </svg>
        <HitLayer items={hits} label={`${label}: phases`} width={width} height={height} />
      </div>
      {!allFit && (
        <ol className="aoc-phasebar__list">
          {visible.map((p, i) => (
            <li
              key={p.id}
              className={cx(p.state === 'active' && 'is-active', p.state === 'done' && 'is-done')}
            >
              <span className="aoc-tl__phase-index aoc-num">{i + 1}</span>
              <span>{p.label}</span>
              <span className="aoc-num">{phaseCount(p)}</span>
            </li>
          ))}
        </ol>
      )}
    </figure>
  );
}
