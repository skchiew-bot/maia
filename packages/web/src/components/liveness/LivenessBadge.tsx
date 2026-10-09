import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../../lib/dom';
import { Icon } from '../Icon';
import { LIVENESS_META, livenessColors, type LivenessState } from './liveness';

export interface LivenessBadgeProps {
  /** Daemon-derived state. */
  state: LivenessState;
  /** Context after the word, e.g. "resets 14:05" (throttled) or "decision 2h 14m" (waiting on you). */
  detail?: ReactNode;
  /** `sm` for table rows, `md` (default) elsewhere. */
  size?: 'sm' | 'md';
  /**
   * Announce state changes politely (use on a single-session header, never in lists — a table of live
   * regions would talk over itself).
   */
  announce?: boolean;
  /** Native tooltip, e.g. the daemon's reason code. */
  title?: string;
  className?: string;
}

/**
 * Liveness is always this badge — colour + icon + word, never a chart (§12). The word stays in primary ink
 * (AA in both themes); the state colour lives on the icon and the tint.
 */
export function LivenessBadge({
  state,
  detail,
  size = 'md',
  announce,
  title,
  className,
}: LivenessBadgeProps) {
  const meta = LIVENESS_META[state];
  const colors = livenessColors(meta.tone);
  const style = { '--lv-fg': colors.fg, '--lv-bg': colors.bg } as CSSProperties;
  return (
    <span
      className={cx('aoc-liveness', `aoc-liveness--${size}`, className)}
      data-state={state}
      data-tone={meta.tone}
      style={style}
      title={title}
      role={announce ? 'status' : undefined}
    >
      <Icon name={meta.icon} size={size === 'sm' ? 12 : 14} className="aoc-liveness__icon" />
      <span className="aoc-liveness__word">{meta.word}</span>
      {detail && (
        <>
          <span className="aoc-sr-only">, </span>
          <span className="aoc-liveness__detail">{detail}</span>
        </>
      )}
    </span>
  );
}
