import type { ReactNode } from 'react';
import { cx } from '../lib/dom';
import { Icon, type IconName } from './Icon';
import type { Tone } from './tone';

export interface BadgeProps {
  /** Semantic tone. Status tones (`ok`/`warn`/`danger`/`info`) must carry a word or icon too. Default `neutral`. */
  tone?: Tone;
  /** `soft` tinted (default), `solid` for counts that must pop, `outline` for quiet labels. */
  variant?: 'soft' | 'solid' | 'outline';
  /** Leading icon. */
  icon?: IconName;
  /** Native tooltip with the exact value when the badge shows a rounded one. */
  title?: string;
  className?: string;
  children: ReactNode;
}

/** Small non-interactive label: counts, states, versions. */
export function Badge({ tone = 'neutral', variant = 'soft', icon, title, className, children }: BadgeProps) {
  return (
    <span className={cx('aoc-badge', `aoc-badge--${variant}`, `aoc-tone--${tone}`, className)} title={title}>
      {icon && <Icon name={icon} size={12} />}
      <span>{children}</span>
    </span>
  );
}

export interface CountBadgeProps {
  /** The count. Nothing renders for 0 / null unless `showZero`. */
  count: number | null | undefined;
  /** Counts above this read `max+` (exact value in the title). Default 99. */
  max?: number;
  tone?: Tone;
  showZero?: boolean;
  /** Screen-reader suffix, e.g. "open decisions". */
  label?: string;
}

/** Numeric pill for inbox-style counts. */
export function CountBadge({ count, max = 99, tone = 'accent', showZero, label }: CountBadgeProps) {
  if (count === null || count === undefined || (!showZero && count <= 0)) return null;
  const text = count > max ? `${max}+` : String(count);
  return (
    <span
      className={cx('aoc-badge', 'aoc-badge--solid', 'aoc-badge--count', `aoc-tone--${tone}`)}
      title={String(count)}
    >
      {text}
      {label && <span className="aoc-sr-only"> {label}</span>}
    </span>
  );
}
