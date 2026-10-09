import { Children, isValidElement, useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Sparkline } from '../charts/Sparkline';
import { cx } from '../lib/dom';
import { formatInteger, formatSignedPercent } from '../lib/format';
import { IconButton } from './Button';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';

export interface KpiDelta {
  /** Signed change. A ratio (0.12 = +12%) unless `kind` is `absolute`. */
  value: number;
  /** `ratio` (default) prints a percentage; `absolute` prints `format(value)` with a sign. */
  kind?: 'ratio' | 'absolute';
  /** Comparison period, e.g. "vs yesterday", "vs last week". */
  label?: string;
  /** Which direction is an improvement. Default `up`. `neutral` colours neither way. */
  good?: 'up' | 'down' | 'neutral';
  /** Formatter for `absolute` deltas. */
  format?: (v: number) => string;
}

export interface KpiTileProps {
  /** Metric name, sentence case ("Open decisions"). */
  label: string;
  /** The value. Always rendered as text; numbers go through `format` (default thousands-grouped). */
  value: string | number;
  format?: (v: number) => string;
  /** Unit after the value ("tokens", "APM", "%"). */
  unit?: string;
  delta?: KpiDelta;
  /** Optional trend series (oldest → newest) drawn as a small muted sparkline. */
  trend?: readonly number[];
  /** What the trend covers, for its accessible label ("last 14 days"). */
  trendLabel?: string;
  /** Definition / provenance tooltip. */
  info?: ReactNode;
  /** Drill-down route; makes the label a link. */
  href?: string;
  /** Attention state: adds an icon and tinted edge. Default `neutral`. */
  tone?: 'neutral' | 'warn' | 'danger';
  /** Small print under the value, e.g. "notional" or "resets 14:05". */
  footnote?: ReactNode;
}

function deltaText(d: KpiDelta): string {
  if (d.kind === 'absolute') {
    const f = d.format ?? formatInteger;
    if (d.value === 0) return f(0);
    return `${d.value > 0 ? '+' : '−'}${f(Math.abs(d.value))}`;
  }
  return formatSignedPercent(d.value);
}

/** One headline number: label, value as text, optional unit, delta and trend. */
export function KpiTile({
  label,
  value,
  format,
  unit,
  delta,
  trend,
  trendLabel,
  info,
  href,
  tone = 'neutral',
  footnote,
}: KpiTileProps) {
  const labelId = useId();
  const text = typeof value === 'number' ? (format ?? formatInteger)(value) : value;
  const direction = delta ? (delta.value > 0 ? 'up' : delta.value < 0 ? 'down' : 'flat') : 'flat';
  const good = delta?.good ?? 'up';
  const deltaTone =
    !delta || direction === 'flat' || good === 'neutral' ? 'neutral' : direction === good ? 'ok' : 'danger';

  return (
    <div
      className={cx('aoc-kpi', tone !== 'neutral' && `aoc-kpi--${tone}`)}
      role="group"
      aria-labelledby={labelId}
    >
      <div className="aoc-kpi__label-row">
        <span id={labelId} className="aoc-kpi__label">
          {tone !== 'neutral' && (
            <Icon name={tone === 'warn' ? 'warn' : 'danger'} size={12} className="aoc-kpi__tone-icon" />
          )}
          {href ? <Link to={href}>{label}</Link> : label}
        </span>
        {info && (
          <Tooltip content={info}>
            <IconButton icon="info" label={`About ${label}`} size="sm" noTooltip className="aoc-kpi__info" />
          </Tooltip>
        )}
      </div>
      <div className="aoc-kpi__value-row">
        <span className="aoc-kpi__value aoc-num">{text}</span>
        {unit && <span className="aoc-kpi__unit">{unit}</span>}
      </div>
      {delta && (
        <div className={cx('aoc-kpi__delta', `aoc-tone-text--${deltaTone}`)}>
          <Icon
            name={direction === 'up' ? 'arrow-up' : direction === 'down' ? 'arrow-down' : 'minus'}
            size={12}
          />
          <span className="aoc-num">{deltaText(delta)}</span>
          {deltaTone !== 'neutral' && (
            <span className="aoc-sr-only">{deltaTone === 'ok' ? '(improved)' : '(worse)'}</span>
          )}
          {delta.label && <span className="aoc-kpi__delta-label">{delta.label}</span>}
        </div>
      )}
      {footnote && <div className="aoc-kpi__footnote">{footnote}</div>}
      {trend && trend.length > 1 && (
        <Sparkline
          className="aoc-kpi__trend"
          values={trend}
          label={`${label}${trendLabel ? `, ${trendLabel}` : ''}`}
          format={format}
          height={24}
          tone="muted"
          showValue={false}
        />
      )}
    </div>
  );
}

export interface KpiStripProps {
  /** KpiTile elements. */
  children: ReactNode;
  /** Accessible name of the strip ("Today at a glance"). */
  label: string;
  className?: string;
}

/** Horizontal row of KpiTiles that wraps on narrow screens (two per row on phones). */
export function KpiStrip({ children, label, className }: KpiStripProps) {
  return (
    <div className={cx('aoc-kpis', className)} role="list" aria-label={label}>
      {Children.map(children, (child) =>
        isValidElement(child) ? (
          <div role="listitem" className="aoc-kpis__item">
            {child}
          </div>
        ) : null,
      )}
    </div>
  );
}
