import { LivenessBadge } from '../../components/liveness/LivenessBadge';
import { LIVENESS_META } from '../../components/liveness/liveness';
import { cx } from '../../lib/dom';
import type { LiveState } from './model';

export interface FleetCountsProps {
  counts: readonly { state: LiveState; count: number }[];
  /** The liveness filter currently applied, if any. */
  active: LiveState | '';
  onSelect: (state: LiveState | '') => void;
}

/**
 * Live sessions per liveness state in §4 precedence order. Each count is a filter toggle; the sentence for
 * screen readers is a polite live region, so a state change is announced once, not per tile.
 */
export function FleetCounts({ counts, active, onSelect }: FleetCountsProps) {
  const sentence = counts.map((c) => `${c.count} ${LIVENESS_META[c.state].word}`).join(', ');
  return (
    <div className="console-fleet">
      <ol className="console-fleet__list" aria-label="Live sessions by liveness, highest precedence first">
        {counts.map(({ state, count }, i) => {
          const pressed = active === state;
          return (
            <li key={state} className={cx('console-fleet__item', count === 0 && 'is-zero')}>
              <button
                type="button"
                className={cx('console-fleet__btn', pressed && 'is-pressed')}
                aria-pressed={pressed}
                onClick={() => onSelect(pressed ? '' : state)}
                title={pressed ? 'Show every state' : `Show only ${LIVENESS_META[state].word}`}
              >
                <LivenessBadge state={state} size="sm" />
                <span className="console-fleet__n aoc-num">{count}</span>
              </button>
              {i < counts.length - 1 && (
                <span className="console-fleet__sep" aria-hidden="true">
                  ›
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p className="aoc-sr-only" aria-live="polite" aria-atomic="true">
        Live sessions: {sentence}.
      </p>
    </div>
  );
}
