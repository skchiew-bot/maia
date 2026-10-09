import { useMemo, useState, type PointerEvent } from 'react';
import { cx } from '../lib/dom';
import { formatCompact, formatSignedPercent } from '../lib/format';
import { Icon } from '../components/Icon';
import { expectsActivity, type LivenessState } from '../components/liveness/liveness';
import { useElementWidth } from './shared';
import type { Series, ValueFormatter } from './types';

export interface SparklineProps {
  /** Samples at equal intervals, oldest first (e.g. actions per minute, one per minute). */
  values: Series;
  /** What is plotted ("Actions per minute") — the start of the accessible summary. */
  label: string;
  /** Unit after the last value ("APM"). */
  unit?: string;
  /** Value formatter. Default compact (`1.2K`). */
  format?: ValueFormatter;
  /** Plot height in px. Default 32. */
  height?: number;
  /** Fixed width in px; omit to fill the container (ResizeObserver). */
  width?: number;
  /** `accent` (default) or `muted` (context trend: grey line, accent end dot). */
  tone?: 'accent' | 'muted';
  /** Print the last value beside the line. Default true. */
  showValue?: boolean;
  /** Soft area wash under the line (10% of the series hue). Default true. */
  area?: boolean;
  /**
   * Flat-line stall styling (off by default): when the last `flatAfter` or more samples are 0, that tail is
   * drawn in the stall colour and labelled "flat Nm" — the flat line that reveals a stall before any badge
   * (§12). Pair it with `liveness` so explained flats stay neutral.
   */
  flatAfter?: number;
  /**
   * Liveness of the session the series belongs to. Stall styling then applies only while the session is
   * expected to be active (Working, Stalled) — never while Thinking, Waiting on you, Throttled or ended.
   */
  liveness?: LivenessState;
  /** Minutes per sample, for the "flat Nm" text. Default 1. */
  sampleMinutes?: number;
  /** Shared y-maximum for small multiples, so a quiet agent looks quiet next to a busy one. */
  yMax?: number;
  /** Per-sample labels for the hover readout (e.g. clock times). */
  pointLabels?: readonly string[];
  className?: string;
}

const PAD = 4;

function trailingZeros(values: Series): number {
  let n = 0;
  for (let i = values.length - 1; i >= 0 && values[i] === 0; i -= 1) n += 1;
  return n;
}

/**
 * Small line chart for one series. Event-driven: it redraws only when `values` change. Pointer hover shows a
 * crosshair readout; the numbers are always available as text and in the accessible summary.
 */
export function Sparkline({
  values,
  label,
  unit,
  format = formatCompact,
  height = 32,
  width: fixedWidth,
  tone = 'accent',
  showValue = true,
  area = true,
  flatAfter = 0,
  liveness,
  sampleMinutes = 1,
  yMax,
  pointLabels,
  className,
}: SparklineProps) {
  const [measureRef, measured] = useElementWidth<HTMLDivElement>(fixedWidth ?? 160);
  const width = fixedWidth ?? measured;
  const [hover, setHover] = useState<number | null>(null);

  const n = values.length;
  const last = n > 0 ? values[n - 1]! : 0;
  const max = n > 0 ? Math.max(...values) : 0;
  const min = n > 0 ? Math.min(...values) : 0;
  const top = Math.max(yMax ?? max, 1);
  const flatRun = trailingZeros(values);
  const stallStyling = liveness === undefined || expectsActivity(liveness);
  const isFlat = stallStyling && flatAfter > 0 && n > 1 && flatRun >= flatAfter;
  const flatMinutes = Math.round(flatRun * sampleMinutes);

  const { points, linePath, areaPath, flatPath } = useMemo(() => {
    const innerW = Math.max(1, width - PAD * 2);
    const innerH = Math.max(1, height - PAD * 2);
    const pts = values.map((v, i) => ({
      x: PAD + (n <= 1 ? innerW : (i / (n - 1)) * innerW),
      y: PAD + innerH - (Math.max(0, v) / top) * innerH,
    }));
    const toPath = (ps: typeof pts) =>
      ps.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
    const flatStart = isFlat ? Math.max(0, n - flatRun - 1) : n - 1;
    const main = pts.slice(0, flatStart + 1);
    const base = PAD + innerH;
    return {
      points: pts,
      linePath: toPath(main),
      areaPath:
        main.length > 1
          ? `${toPath(main)}L${main[main.length - 1]!.x.toFixed(1)},${base}L${main[0]!.x.toFixed(1)},${base}Z`
          : '',
      flatPath: isFlat ? toPath(pts.slice(flatStart)) : '',
    };
  }, [values, n, width, height, top, isFlat, flatRun]);

  const lastPoint = points[n - 1];
  const fmt = (v: number) => `${format(v)}${unit ? ` ${unit}` : ''}`;
  const summary =
    n === 0
      ? `${label}: no data yet`
      : `${label}: last ${fmt(last)}, peak ${fmt(max)}, low ${fmt(min)} over ${n} samples${
          isFlat ? `; flat for the last ${flatMinutes} minutes` : ''
        }`;

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const i = n <= 1 ? 0 : Math.round(((x - PAD) / Math.max(1, width - PAD * 2)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const hp = hover !== null ? points[hover] : undefined;

  return (
    <div className={cx('aoc-spark', tone === 'muted' && 'aoc-spark--muted', isFlat && 'is-flat', className)}>
      <div
        className="aoc-spark__plot"
        ref={fixedWidth ? undefined : measureRef}
        style={fixedWidth ? { width: fixedWidth } : undefined}
      >
        <svg
          role="img"
          aria-label={summary}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {area && areaPath && <path d={areaPath} className="aoc-spark__area" />}
          {linePath && <path d={linePath} className="aoc-spark__line" />}
          {flatPath && <path d={flatPath} className="aoc-spark__flat" />}
          {lastPoint && (
            <circle
              cx={lastPoint.x}
              cy={lastPoint.y}
              r={3.5}
              className={cx('aoc-spark__end', isFlat && 'is-flat')}
            />
          )}
          {hp && (
            <>
              <line x1={hp.x} x2={hp.x} y1={0} y2={height} className="aoc-spark__crosshair" />
              <circle cx={hp.x} cy={hp.y} r={3.5} className="aoc-spark__hover-dot" />
            </>
          )}
        </svg>
        {hover !== null && hp && (
          <div
            className="aoc-chart-tip aoc-spark__tip"
            style={{ left: Math.max(0, Math.min(hp.x - 40, width - 80)), top: -30 }}
            aria-hidden="true"
          >
            <strong className="aoc-num">{fmt(values[hover]!)}</strong>
            {pointLabels?.[hover] && <span> · {pointLabels[hover]}</span>}
          </div>
        )}
      </div>
      {showValue && (
        <span className="aoc-spark__value aoc-num">
          {n === 0 ? '—' : fmt(last)}
          {isFlat && (
            <span className="aoc-spark__flat-note">
              <Icon name="minus" size={12} /> flat {flatMinutes}m
            </span>
          )}
        </span>
      )}
    </div>
  );
}

export interface TrendSparklineProps {
  /** Oldest first (e.g. weekly cost per run). */
  values: Series;
  /** What is measured ("Cost per run"). */
  label: string;
  format?: ValueFormatter;
  /** Which direction is an improvement. Default `down` (costs). */
  good?: 'up' | 'down';
  /** Comparison wording for the delta. Default "vs first". */
  compareLabel?: string;
  /** Plot width (px); omit to fill. */
  width?: number;
  height?: number;
  className?: string;
}

/**
 * Trend line with its latest value and the change since the first point, coloured by whether that change is
 * good (Registry hero: one per process type).
 */
export function TrendSparkline({
  values,
  label,
  format = formatCompact,
  good = 'down',
  compareLabel = 'vs first',
  width,
  height = 28,
  className,
}: TrendSparklineProps) {
  const n = values.length;
  const first = n > 0 ? values[0]! : 0;
  const last = n > 0 ? values[n - 1]! : 0;
  const change = first !== 0 ? (last - first) / Math.abs(first) : 0;
  const dir = change > 0.0005 ? 'up' : change < -0.0005 ? 'down' : 'flat';
  const tone = dir === 'flat' ? 'neutral' : dir === good ? 'ok' : 'danger';
  const deltaText = n > 1 && first !== 0 ? formatSignedPercent(change) : '—';
  return (
    <div className={cx('aoc-trend', className)}>
      <Sparkline
        values={values}
        label={`${label}, ${deltaText} ${compareLabel}`}
        format={format}
        height={height}
        width={width}
        tone="muted"
        showValue={false}
      />
      <span className="aoc-trend__value aoc-num">{n === 0 ? '—' : format(last)}</span>
      <span className={cx('aoc-trend__delta', `aoc-tone-text--${tone}`)}>
        <Icon name={dir === 'up' ? 'arrow-up' : dir === 'down' ? 'arrow-down' : 'minus'} size={12} />
        <span className="aoc-num">{deltaText}</span>
        {tone !== 'neutral' && (
          <span className="aoc-sr-only">{tone === 'ok' ? '(improved)' : '(worse)'}</span>
        )}
        <span className="aoc-trend__compare">{compareLabel}</span>
      </span>
    </div>
  );
}
