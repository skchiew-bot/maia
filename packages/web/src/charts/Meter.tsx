import type { ReactNode } from 'react';
import { cx } from '../lib/dom';
import { formatPercent } from '../lib/format';
import { Icon } from '../components/Icon';

export interface MeterProps {
  /** Amount used (same unit as `max`). */
  value: number;
  /** Capacity, e.g. the context window. */
  max: number;
  /** What is measured ("Context used"). */
  label: string;
  /** Ratio where the fill turns to warning. Default 0.7. */
  warnAt?: number;
  /** Ratio where the fill turns to danger. Default 0.9. */
  dangerAt?: number;
  /** Detail text, e.g. "124K / 200K tokens". Also read in the accessible summary when it is a string. */
  detail?: ReactNode;
  /** `sm` hides the label row (use inside tables). Default `md`. */
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * A single ratio against a limit (context window used). The fill carries severity — accent, then warning,
 * then danger — always with a word and icon; the track is a lighter step of the same ramp.
 */
export function Meter({
  value,
  max,
  label,
  warnAt = 0.7,
  dangerAt = 0.9,
  detail,
  size = 'md',
  className,
}: MeterProps) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const level = ratio >= dangerAt ? 'danger' : ratio >= warnAt ? 'warn' : 'normal';
  const word = level === 'danger' ? 'near limit' : level === 'warn' ? 'high' : undefined;
  const summary = `${label}: ${formatPercent(ratio)}${word ? `, ${word}` : ''}${typeof detail === 'string' ? ` (${detail})` : ''}`;
  return (
    <div
      className={cx('aoc-meter', `aoc-meter--${level}`, `aoc-meter--${size}`, className)}
      role="img"
      aria-label={summary}
    >
      {size === 'md' && (
        <div className="aoc-meter__row">
          <span className="aoc-meter__label">{label}</span>
          <span className="aoc-meter__value">
            {level !== 'normal' && (
              <Icon name={level === 'danger' ? 'danger' : 'warn'} size={12} className="aoc-meter__icon" />
            )}
            <strong className="aoc-num">{formatPercent(ratio)}</strong>
            {word && <span className="aoc-meter__word">{word}</span>}
          </span>
        </div>
      )}
      <div className="aoc-meter__track">
        <div className="aoc-meter__fill" style={{ width: `${ratio * 100}%` }} />
      </div>
      {size === 'sm' && <span className="aoc-meter__inline aoc-num">{formatPercent(ratio)}</span>}
      {detail && size === 'md' && <div className="aoc-meter__detail aoc-num">{detail}</div>}
    </div>
  );
}
