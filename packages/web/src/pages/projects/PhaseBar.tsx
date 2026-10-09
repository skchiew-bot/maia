import { useMemo } from 'react';
import { HitLayer, useElementWidth, type HitItem } from '../../charts';
import { estimateTextWidth } from '../../charts/shared';
import { cx } from '../../lib/dom';
import { formatInteger, formatPercent } from '../../lib/format';
import { totalsOf, weightText, type PhaseStat } from './model';

export interface PhaseBarProps {
  phases: readonly PhaseStat[];
  /** Accessible name, e.g. "CX Copilot completion by phase". */
  label: string;
  /** Bar height in px. Default 10. */
  height?: number;
  /** Print "P1 Name" (or "P1") under segments where it fits. */
  showLabels?: boolean;
  /** Emphasised phase (the current one). */
  currentId?: string | null;
  /** Enter / click on a segment. */
  onSelect?: (phaseId: string) => void;
  className?: string;
}

const GAP = 2;
const LABEL_ROW = 16;

/** One segment: the declared extent (outlined track), done with evidence, then done but flagged. */
export function SegmentFill({
  x,
  width,
  verified,
  flagged,
  height,
}: {
  x: number;
  width: number;
  verified: number;
  flagged: number;
  height: number;
}) {
  return (
    <>
      <rect x={x} y={0} width={Math.max(0, width)} height={height} rx={2} className="prj-phasebar__track" />
      {verified > 0 && (
        <rect x={x} y={0} width={verified} height={height} rx={2} className="prj-phasebar__done" />
      )}
      {flagged > 0 && (
        <rect
          x={x + verified}
          y={0}
          width={flagged}
          height={height}
          rx={verified > 0 ? 0 : 2}
          className="prj-phasebar__flagged"
        />
      )}
    </>
  );
}

export function phaseSentence(p: PhaseStat): string {
  const pct = p.totalWeight > 0 ? p.doneWeight / p.totalWeight : 0;
  const flagged = p.flaggedTasks > 0 ? `, ${formatInteger(p.flaggedTasks)} flagged` : '';
  return `P${p.index} ${p.name}: ${weightText(p.doneWeight)} of ${weightText(p.totalWeight)} weight done (${formatPercent(
    pct,
  )}), ${formatInteger(p.doneTasks)} of ${formatInteger(p.totalTasks)} tasks${flagged}`;
}

/**
 * Master-timeline completion (§9): one segment per phase, width = declared weight, filled by done weight. Done
 * weight closed without a file change is drawn amber at the end of the fill — it counts until reviewed (CEO
 * decision 8), and the flag stays visible.
 */
export function PhaseBar({
  phases,
  label,
  height = 10,
  showLabels = false,
  currentId,
  onSelect,
  className,
}: PhaseBarProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>(480);
  const visible = phases.filter((p) => p.totalWeight > 0);
  const total = totalsOf(visible);

  const segments = useMemo(() => {
    const usable = Math.max(1, width - GAP * Math.max(0, visible.length - 1));
    let x = 0;
    return visible.map((p) => {
      const w = (p.totalWeight / Math.max(1, total.totalWeight)) * usable;
      const done = (Math.min(p.doneWeight, p.totalWeight) / p.totalWeight) * w;
      const flagged = Math.min(done, (p.flaggedWeight / p.totalWeight) * w);
      const full = `P${p.index} ${p.name}`;
      const text = !showLabels
        ? ''
        : estimateTextWidth(full) + 4 <= w
          ? full
          : estimateTextWidth(`P${p.index}`) + 2 <= w
            ? `P${p.index}`
            : '';
      const seg = { phase: p, x, w, verified: done - flagged, flagged, text };
      x += w + GAP;
      return seg;
    });
  }, [visible, total.totalWeight, width, showLabels]);

  const svgHeight = height + (showLabels ? LABEL_ROW : 0);
  const summary = `${label}: ${formatPercent(
    total.totalWeight > 0 ? total.doneWeight / total.totalWeight : 0,
  )} of declared weight done, ${formatInteger(total.doneTasks)} of ${formatInteger(total.totalTasks)} tasks${
    total.flaggedTasks > 0 ? `, ${formatInteger(total.flaggedTasks)} flagged` : ''
  }. ${visible.map(phaseSentence).join('; ')}.`;

  const hits: HitItem[] = segments.map((s) => ({
    key: s.phase.id,
    x: s.x,
    y: 0,
    width: Math.max(1, s.w),
    height,
    label: phaseSentence(s.phase),
    onActivate: onSelect ? () => onSelect(s.phase.id) : undefined,
    tooltip: (
      <>
        <span className="aoc-chart-tip__kind">Phase P{s.phase.index}</span>
        <strong>{s.phase.name}</strong>
        <span className="aoc-chart-tip__meta aoc-num">
          {weightText(s.phase.doneWeight)}/{weightText(s.phase.totalWeight)} weight ·{' '}
          {formatInteger(s.phase.doneTasks)}/{formatInteger(s.phase.totalTasks)} tasks
        </span>
        {s.phase.flaggedTasks > 0 && (
          <span className="aoc-chart-tip__meta">
            {formatInteger(s.phase.flaggedTasks)} flagged: closed with no file change
          </span>
        )}
      </>
    ),
  }));

  if (visible.length === 0) {
    return (
      <div className={cx('prj-phasebar', 'prj-phasebar--empty', className)} style={{ height }}>
        <span className="aoc-sr-only">{label}: no tasks declared yet.</span>
      </div>
    );
  }

  return (
    <div className={cx('aoc-chart', 'prj-phasebar', className)}>
      <div className="aoc-chart__plot" ref={ref}>
        <svg
          role="img"
          aria-label={summary}
          width={width}
          height={svgHeight}
          viewBox={`0 0 ${width} ${svgHeight}`}
        >
          {segments.map((s) => (
            <g key={s.phase.id} className={cx(s.phase.id === currentId && 'is-current')}>
              <SegmentFill x={s.x} width={s.w} verified={s.verified} flagged={s.flagged} height={height} />
              {s.text && (
                <text
                  x={s.x}
                  y={height + 12}
                  className={cx('prj-phasebar__label', s.phase.id === currentId && 'is-current')}
                >
                  {s.text}
                </text>
              )}
            </g>
          ))}
        </svg>
        <HitLayer items={hits} label={`${label}: phases`} width={width} height={height} />
      </div>
    </div>
  );
}
