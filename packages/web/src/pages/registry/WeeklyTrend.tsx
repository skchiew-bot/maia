import { useMemo } from 'react';
import { HitLayer, useElementWidth, type HitItem } from '../../charts';
import { Icon } from '../../components';
import { cx } from '../../lib/dom';
import { formatShortDate, formatSignedPercent } from '../../lib/format';
import { addDays, formatRunCost, type TrendView } from './registryModel';

export interface TrendMarker {
  weekStart: string;
  kind: 'approved' | 'retired';
  label: string;
}

export interface WeeklyTrendProps {
  /** Process type name, for the accessible summary. */
  name: string;
  view: TrendView;
  markers?: readonly TrendMarker[];
}

const H = 32;
const PAD = 4;

/**
 * Blended cost per run by week (Registry hero). Weeks without finished runs are gaps, never zeros. Playbook
 * approvals and retirements are vertical marks; each week is a focusable target with the same readout.
 */
export function WeeklyTrend({ name, view, markers = [] }: WeeklyTrendProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>(120);
  const n = view.points.length;
  const values = view.points.map((p) => p.value).filter((v): v is number => v !== null);
  const top = Math.max(...values, 1e-9);
  const x = (i: number) => PAD + (n <= 1 ? 0 : (i / (n - 1)) * (width - PAD * 2));
  const y = (v: number) => PAD + (H - PAD * 2) * (1 - v / top);

  const segments = useMemo(() => {
    const out: { x: number; y: number }[][] = [];
    let run: { x: number; y: number }[] = [];
    view.points.forEach((p, i) => {
      if (p.value === null) {
        if (run.length) out.push(run);
        run = [];
      } else run.push({ x: x(i), y: y(p.value) });
    });
    if (run.length) out.push(run);
    return out;
    // x/y derive from width, n and top, which the deps cover.
  }, [view.points, width, top, n]);

  const markerLines = markers.flatMap((m) => {
    const i = view.points.findIndex((p) => p.weekStart === m.weekStart);
    return i < 0 ? [] : [{ ...m, x: x(i) }];
  });

  const slot = n > 0 ? (width - PAD * 2) / Math.max(1, n - 1) : width;
  const hits: HitItem[] = view.points.map((p, i) => {
    const range = `${formatShortDate(p.weekStart)}–${formatShortDate(addDays(p.weekStart, 6))}`;
    const marks = markerLines.filter((m) => m.weekStart === p.weekStart).map((m) => m.label);
    const unpriced =
      p.unpricedRuns > 0
        ? `${p.unpricedRuns} unpriced run${p.unpricedRuns === 1 ? '' : 's'} counted at US$0`
        : null;
    const value =
      p.value === null
        ? 'no finished runs'
        : `${formatRunCost(p.value)} per run, ${p.runs} run${p.runs === 1 ? '' : 's'} (${p.discoveryRuns} discovery, ${p.executionRuns} execution)${unpriced ? `, ${unpriced}` : ''}`;
    return {
      key: p.weekStart,
      x: Math.max(0, x(i) - slot / 2),
      y: 0,
      width: Math.min(slot, width),
      height: H,
      label: `${p.label}, ${range}: ${value}${marks.length ? `. ${marks.join('. ')}` : ''}`,
      tooltip: (
        <>
          <span className="aoc-chart-tip__kind">
            {p.label} · {range}
          </span>
          {p.value === null ? (
            <span className="aoc-chart-tip__meta">No finished runs</span>
          ) : (
            <>
              <strong className="aoc-num">{formatRunCost(p.value)} per run</strong>
              <span className="aoc-chart-tip__meta">
                {p.runs} run{p.runs === 1 ? '' : 's'} · {p.discoveryRuns} discovery · {p.executionRuns} execution
              </span>
              {unpriced && <span className="aoc-chart-tip__meta">Includes {unpriced}</span>}
            </>
          )}
          {marks.map((m) => (
            <span key={m} className="aoc-chart-tip__meta">
              {m}
            </span>
          ))}
        </>
      ),
    };
  });

  const summary = `${name}, blended cost per run by week, ${view.points[0]?.label ?? ''} to ${
    view.points[n - 1]?.label ?? ''
  }: ${view.points
    .map((p) => (p.value === null ? 'no runs' : `${formatRunCost(p.value)}${p.unpricedRuns > 0 ? ' (partly unpriced)' : ''}`))
    .join(', ')}${
    markerLines.length ? `. ${markerLines.map((m) => `${m.label}`).join('. ')}` : ''
  }.`;

  const dir = view.change === null ? 'flat' : view.change > 0.0005 ? 'up' : view.change < -0.0005 ? 'down' : 'flat';
  const tone = dir === 'flat' ? 'neutral' : dir === 'down' ? 'ok' : 'danger';
  const last = view.last;

  return (
    <div className="reg-trend">
      <div className="reg-trend__plot aoc-chart__plot" ref={ref}>
        <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="img" aria-label={summary}>
          <line x1={PAD} x2={width - PAD} y1={H - PAD + 0.5} y2={H - PAD + 0.5} className="reg-trend__base" />
          {markerLines.map((m) => (
            <line
              key={`${m.kind}-${m.weekStart}`}
              x1={m.x}
              x2={m.x}
              y1={1}
              y2={H - PAD}
              className={cx('reg-trend__mark', `reg-trend__mark--${m.kind}`)}
            />
          ))}
          {segments.map((s) =>
            s.length > 1 ? (
              <g key={`${s[0]!.x}`}>
                <path
                  className="reg-trend__area"
                  d={`M${s[0]!.x},${H - PAD}${s.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('')}L${s[s.length - 1]!.x},${H - PAD}Z`}
                />
                <path
                  className="reg-trend__line"
                  d={s.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('')}
                />
              </g>
            ) : (
              <circle key={`${s[0]!.x}`} cx={s[0]!.x} cy={s[0]!.y} r={2.5} className="reg-trend__dot" />
            ),
          )}
          {view.points.map((p, i) =>
            p.value !== null && p.unpricedRuns > 0 ? (
              <circle key={p.weekStart} cx={x(i)} cy={y(p.value)} r={3} className="reg-trend__unpriced" />
            ) : null,
          )}
          {last && <circle cx={x(last.index)} cy={y(last.value)} r={3.5} className="reg-trend__end" />}
        </svg>
        <HitLayer items={hits} label={`${name}: weeks`} width={width} height={H} minSize={16} />
      </div>
      <span className="reg-trend__txt">
        <b className="aoc-num">{last ? formatRunCost(last.value) : '—'}</b>
        {view.change !== null && view.first ? (
          <span className={cx('reg-trend__delta', `aoc-tone-text--${tone}`)}>
            <Icon name={dir === 'up' ? 'arrow-up' : dir === 'down' ? 'arrow-down' : 'minus'} size={12} />
            <span className="aoc-num">{formatSignedPercent(view.change)}</span>
            <span className="reg-trend__since"> since {view.points[view.first.index]!.label}</span>
            {tone !== 'neutral' && (
              <span className="aoc-sr-only">{tone === 'ok' ? '(cheaper)' : '(costlier)'}</span>
            )}
          </span>
        ) : (
          <span className="reg-trend__since">
            {view.weeksWithRuns === 0
              ? `no runs in ${view.points.length} weeks`
              : `${view.weeksWithRuns} week${view.weeksWithRuns === 1 ? '' : 's'} with runs`}
          </span>
        )}
        {view.partlyUnpricedWeeks > 0 && (
          <span className="reg-trend__since">
            <span className="reg-trend__hollow" aria-hidden="true" /> {view.partlyUnpricedWeeks} week
            {view.partlyUnpricedWeeks === 1 ? '' : 's'} partly unpriced
          </span>
        )}
      </span>
    </div>
  );
}
