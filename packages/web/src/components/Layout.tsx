import type { ReactNode } from 'react';
import { cx } from '../lib/dom';

export interface DescriptionItem {
  /** Field name ("Rollback target"). */
  term: string;
  /** Value; use the value components (CopyableHash, RelativeTime, Money…) for typed values. */
  value: ReactNode;
}

export interface DescriptionListProps {
  items: readonly DescriptionItem[];
  /** Columns on wide screens (collapses to one on phones). Default 2. */
  columns?: 1 | 2 | 3;
  className?: string;
}

/** Key/value facts for detail pages (`<dl>`). */
export function DescriptionList({ items, columns = 2, className }: DescriptionListProps) {
  return (
    <dl className={cx('aoc-dl', `aoc-dl--${columns}`, className)}>
      {items.map((it) => (
        <div key={it.term} className="aoc-dl__item">
          <dt>{it.term}</dt>
          <dd>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface FilterBarProps {
  /** Filter controls (SegmentedControl for time ranges first, then Selects, Chips, search). */
  children: ReactNode;
  /** Right-aligned extras (result count, "Clear filters"). */
  end?: ReactNode;
  /** Accessible name. Default "Filters". */
  label?: string;
  className?: string;
}

/**
 * One left-aligned row of filters above the content it scopes — never inside a chart card, never per chart.
 * Every widget below re-renders against the same slice.
 */
export function FilterBar({ children, end, label = 'Filters', className }: FilterBarProps) {
  return (
    <div className={cx('aoc-filterbar', className)} role="group" aria-label={label}>
      <div className="aoc-filterbar__controls">{children}</div>
      {end && <div className="aoc-filterbar__end">{end}</div>}
    </div>
  );
}

export interface StackProps {
  children: ReactNode;
  /** Vertical gap token step: 2 = 8px, 3 = 12px, 4 = 16px (default), 6 = 24px. */
  gap?: 1 | 2 | 3 | 4 | 6;
  className?: string;
}

/** Vertical rhythm for page sections. */
export function Stack({ children, gap = 4, className }: StackProps) {
  return <div className={cx('aoc-stack', `aoc-stack--${gap}`, className)}>{children}</div>;
}
