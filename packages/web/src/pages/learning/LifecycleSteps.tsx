import type { OffenceState } from '@aoc/contracts';
import { RECURRENCE_STAGE_WORD } from '../../charts';
import { Badge } from '../../components';
import { cx } from '../../lib/dom';
import { LIFECYCLE, STATE_META, stageIndex } from './model';

export interface LifecycleStepsProps {
  state: OffenceState;
  reopenCount?: number;
  /** `compact`: dots and the state badge only (table cells). */
  compact?: boolean;
}

/**
 * The repeat-offence lifecycle of §11 — detected → root-caused → fix applied → verified closed — as four
 * steps plus a state badge (colour + icon + word). A reopened offence restarts at detection.
 */
export function LifecycleSteps({ state, reopenCount = 0, compact }: LifecycleStepsProps) {
  const at = stageIndex(state);
  const meta = STATE_META[state];
  const stepClass = (i: number) =>
    cx(
      'learning-steps__step',
      i < at && 'is-done',
      i === at && 'is-current',
      i === at && state === 'verified_closed' && 'is-closed',
    );
  const label = state === 'reopened' && reopenCount > 1 ? `${meta.label} ×${reopenCount}` : meta.label;
  return (
    <div className={cx('learning-steps', compact && 'learning-steps--compact')}>
      {compact ? (
        <span className="learning-steps__list" aria-hidden="true">
          {LIFECYCLE.map((stage, i) => (
            <span key={stage} className={stepClass(i)}>
              <span className="learning-steps__dot" />
            </span>
          ))}
        </span>
      ) : (
        <ol className="learning-steps__list" aria-label="Lifecycle">
          {LIFECYCLE.map((stage, i) => (
            <li key={stage} className={stepClass(i)} aria-current={i === at ? 'step' : undefined}>
              <span className="learning-steps__dot" aria-hidden="true" />
              <span className="learning-steps__label">{RECURRENCE_STAGE_WORD[stage]}</span>
            </li>
          ))}
        </ol>
      )}
      <Badge tone={meta.tone} icon={meta.icon}>
        {label}
      </Badge>
      {compact && (
        <span className="aoc-sr-only">
          , step {at + 1} of {LIFECYCLE.length}
        </span>
      )}
    </div>
  );
}
