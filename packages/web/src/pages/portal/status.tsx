import type { CSSProperties } from 'react';
import { Icon } from '../../components/Icon';
import { cx } from '../../lib/dom';
import { STATUS_META, STEPS, type PortalStatus } from './model';

/** Status as icon + word on a soft tint (the requester-facing twin of the liveness badge). */
export function PortalStatusBadge({ status, size = 'md' }: { status: PortalStatus; size?: 'sm' | 'md' }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={cx('aoc-liveness', `aoc-liveness--${size}`, 'portal-status')}
      data-status={status}
      style={{ '--lv-fg': meta.color, '--lv-bg': meta.bg } as CSSProperties}
    >
      <Icon name={meta.icon} size={size === 'sm' ? 12 : 14} className="aoc-liveness__icon" />
      <span className="aoc-liveness__word">{meta.word}</span>
    </span>
  );
}

type StepState = 'done' | 'current' | 'todo';

function stepStates(status: PortalStatus): StepState[] | null {
  const current = STEPS.indexOf(status);
  if (current < 0) return null;
  return STEPS.map((_, i) => (i < current || status === 'completed' ? 'done' : i === current ? 'current' : 'todo'));
}

export interface StatusTrackerProps {
  status: PortalStatus;
  className?: string;
}

/**
 * Where a request is on its usual path: received → being worked on → ready for your testing → completed.
 * Position only — never dates, durations or what happens behind the scenes (§7). Closed requests have no path.
 */
export function StatusTracker({ status, className }: StatusTrackerProps) {
  const states = stepStates(status);
  if (!states) return null;
  return (
    <ol
      className={cx('portal-steps', className)}
      aria-label="Progress"
      style={{ '--step-color': STATUS_META[status].color } as CSSProperties}
    >
      {STEPS.map((step, i) => (
        <li
          key={step}
          className={cx('portal-steps__step', `is-${states[i]}`)}
          aria-current={states[i] === 'current' || (status === 'completed' && i === STEPS.length - 1) ? 'step' : undefined}
        >
          <span className="portal-steps__mark" aria-hidden="true">
            {states[i] === 'done' && <Icon name="check" size={12} />}
          </span>
          <span className="portal-steps__label">
            {STATUS_META[step].word}
            <span className="aoc-sr-only">
              {states[i] === 'done' ? ' (done)' : states[i] === 'current' ? ' (current step)' : ' (not yet)'}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** A row of dots for lists; the position is spoken as text. */
export function StatusDots({ status, className }: StatusTrackerProps) {
  const states = stepStates(status);
  if (!states) return null;
  const at = STEPS.indexOf(status);
  return (
    <span
      className={cx('portal-dots', className)}
      role="img"
      aria-label={`Step ${at + 1} of ${STEPS.length}: ${STATUS_META[status].word}`}
      style={{ '--step-color': STATUS_META[status].color } as CSSProperties}
    >
      {states.map((s, i) => (
        <span key={STEPS[i]} className={cx('portal-dots__dot', `is-${s}`)} />
      ))}
    </span>
  );
}
