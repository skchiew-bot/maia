import type { ReactNode } from 'react';
import { cx } from '../lib/dom';
import { formatInteger, formatPercent } from '../lib/format';

/** ETA stays hidden until this many tasks are done (§4: "ETA is hidden until at least three tasks are done"). */
export const ETA_MIN_DONE = 3;

export interface ProgressBarProps {
  /** Completed amount (tasks done, or done weight). */
  done: number;
  /** Declared amount — the denominator. Manifest amendments change it, and the bar shows that visibly. */
  declared: number;
  /** Visible label before the numbers ("Tasks"). */
  label?: string;
  /** Unit for the accessible text ("tasks"). Default "tasks". */
  unit?: string;
  /** Also print the percentage. Default true. */
  showPercent?: boolean;
  /** Estimated completion, rendered only once `done >= 3`. */
  eta?: ReactNode;
  /** `sm` = 4px track (table cells), `md` = 6px (default). */
  size?: 'sm' | 'md';
  className?: string;
}

/** Measured progress as `done/declared` text plus a bar (`role="progressbar"`). */
export function ProgressBar({
  done,
  declared,
  label,
  unit = 'tasks',
  showPercent = true,
  eta,
  size = 'md',
  className,
}: ProgressBarProps) {
  const ratio = declared > 0 ? Math.min(1, Math.max(0, done / declared)) : 0;
  const valueText = `${formatInteger(done)} of ${formatInteger(declared)} ${unit} (${formatPercent(ratio)})`;
  return (
    <div className={cx('aoc-progress', `aoc-progress--${size}`, className)}>
      <div className="aoc-progress__text">
        {label && <span className="aoc-progress__label">{label}</span>}
        <span className="aoc-progress__count aoc-num">
          {formatInteger(done)}/{formatInteger(declared)}
        </span>
        {showPercent && <span className="aoc-progress__pct aoc-num">{formatPercent(ratio)}</span>}
        {eta && done >= ETA_MIN_DONE && <span className="aoc-progress__eta">{eta}</span>}
      </div>
      <div
        className="aoc-progress__track"
        role="progressbar"
        aria-label={label ?? 'Progress'}
        aria-valuemin={0}
        aria-valuemax={declared}
        aria-valuenow={Math.min(done, declared)}
        aria-valuetext={valueText}
      >
        <div className="aoc-progress__fill" style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}
