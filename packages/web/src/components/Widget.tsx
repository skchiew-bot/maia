import { useId, type CSSProperties, type ReactNode } from 'react';
import { cx } from '../lib/dom';
import { IconButton } from './Button';
import { Tooltip } from './Tooltip';

/** Columns a widget spans in the 12-column WidgetGrid (collapses to halves, then full width, as space shrinks). */
export type WidgetSpan = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 'full';

export interface WidgetProps {
  /** Card title (sentence case, no trailing colon). */
  title: ReactNode;
  /** Short context next to the title, e.g. "last 30 days" or "as of 14:05". */
  subtitle?: ReactNode;
  /**
   * What the widget measures and where its number comes from. Shown behind an (i) button with a tooltip;
   * use it to say things like "notional API-equivalent cost, not a bill".
   */
  info?: ReactNode;
  /** Header actions (ghost/sm buttons, a Menu). */
  actions?: ReactNode;
  /** Footer: totals, "View all" links, provenance. */
  footer?: ReactNode;
  children: ReactNode;
  /** Columns spanned in a WidgetGrid. Default 4 (a third). */
  span?: WidgetSpan;
  /** Grid rows spanned. Default 1. */
  rowSpan?: number;
  /** Remove body padding (edge-to-edge tables and charts). */
  flush?: boolean;
  /** A refresh is in flight: the previous render stays visible at reduced opacity (no skeleton flash). */
  busy?: boolean;
  /** Heading level for the title. Default 2 (pages own the h1). */
  headingLevel?: 2 | 3;
  /** Anchor id for deep links. */
  id?: string;
  className?: string;
}

/**
 * The modular card every dashboard is built from: titled `<section>` with optional info tooltip, actions and
 * footer. Place widgets inside a WidgetGrid and choose `span` per widget.
 */
export function Widget({
  title,
  subtitle,
  info,
  actions,
  footer,
  children,
  span = 4,
  rowSpan,
  flush,
  busy,
  headingLevel = 2,
  id,
  className,
}: WidgetProps) {
  const titleId = useId();
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const style = rowSpan ? ({ gridRow: `span ${rowSpan}` } as CSSProperties) : undefined;
  return (
    <section
      id={id}
      className={cx('aoc-widget', className)}
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
      data-span={span}
      style={style}
    >
      <header className="aoc-widget__header">
        <div className="aoc-widget__titles">
          <div className="aoc-widget__title-row">
            <Heading id={titleId} className="aoc-widget__title">
              {title}
            </Heading>
            {info && (
              <Tooltip content={info}>
                <IconButton
                  icon="info"
                  label="About this widget"
                  size="sm"
                  noTooltip
                  className="aoc-widget__info"
                />
              </Tooltip>
            )}
          </div>
          {subtitle && <span className="aoc-widget__subtitle">{subtitle}</span>}
        </div>
        {actions && <div className="aoc-widget__actions">{actions}</div>}
      </header>
      <div className={cx('aoc-widget__body', flush && 'aoc-widget__body--flush', busy && 'is-busy')}>
        {children}
      </div>
      {footer && <footer className="aoc-widget__footer">{footer}</footer>}
    </section>
  );
}

export interface WidgetGridProps {
  children: ReactNode;
  /**
   * `columns` (default): 12-column grid driven by each Widget's `span`, responsive to the grid's own width
   * (container queries), so it adapts when the nav collapses. `auto`: equal tiles of at least `minTileWidth`
   * — use for small multiples.
   */
  layout?: 'columns' | 'auto';
  /** Minimum tile width in px for `layout="auto"`. Default 240. */
  minTileWidth?: number;
  /** Accessible name when the grid is a meaningful group (e.g. "Agents"). */
  'aria-label'?: string;
  className?: string;
}

/** Responsive layout for Widgets and small multiples. */
export function WidgetGrid({
  children,
  layout = 'columns',
  minTileWidth = 240,
  className,
  ...rest
}: WidgetGridProps) {
  return (
    <div className={cx('aoc-wgrid', className)}>
      <div
        className={cx('aoc-wgrid__inner', `aoc-wgrid__inner--${layout}`)}
        style={layout === 'auto' ? ({ '--tile-min': `${minTileWidth}px` } as CSSProperties) : undefined}
        role={rest['aria-label'] ? 'group' : undefined}
        aria-label={rest['aria-label']}
      >
        {children}
      </div>
    </div>
  );
}
