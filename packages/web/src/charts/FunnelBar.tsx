import { cx } from '../lib/dom';
import { formatAge, formatInteger } from '../lib/format';
import { Icon } from '../components/Icon';

export interface FunnelStage {
  id: string;
  /** Stage name in flow order ("Diagnosis", "Fix-plan gate"). */
  label: string;
  /** Items currently in the stage. */
  count: number;
  /** Age of the oldest item in the stage (ms). */
  oldestAgeMs?: number;
  /** Median age of items in the stage (ms). */
  medianAgeMs?: number;
  /** A terminal stage (Done): drawn quieter and never the bottleneck. */
  terminal?: boolean;
}

export interface FunnelBarProps {
  /** Stages in flow order. */
  stages: readonly FunnelStage[];
  /** What flows through ("Ticket pipeline") — names the summary. */
  label: string;
  /** Unit word for counts ("tickets"). */
  unit?: string;
  /**
   * Stage to highlight. Default: the non-terminal stage holding the most waiting time (count × median age,
   * else count × oldest age, else count). `null` turns the highlight off.
   */
  bottleneck?: string | null;
  className?: string;
}

/** The default bottleneck: where the most item-time is waiting. Exported for tests and page logic. */
export function findBottleneck(stages: readonly FunnelStage[]): string | undefined {
  let best: FunnelStage | undefined;
  let bestScore = 0;
  for (const s of stages) {
    if (s.terminal || s.count <= 0) continue;
    const score = s.count * (s.medianAgeMs ?? s.oldestAgeMs ?? 1);
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best?.id;
}

function ageText(s: FunnelStage): string | undefined {
  const parts: string[] = [];
  if (s.oldestAgeMs !== undefined) parts.push(`oldest ${formatAge(s.oldestAgeMs)}`);
  if (s.medianAgeMs !== undefined) parts.push(`median ${formatAge(s.medianAgeMs)}`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * A work pipeline as stage columns in flow order: count (text), a bar on one shared scale, and how long work
 * has been waiting. The bottleneck stage is flagged with an icon and the word — not colour alone.
 */
export function FunnelBar({ stages, label, unit, bottleneck, className }: FunnelBarProps) {
  const flagged = bottleneck === null ? undefined : (bottleneck ?? findBottleneck(stages));
  // Terminal stages accumulate (Done this week), so they never set the shared scale.
  const max = Math.max(1, ...stages.filter((s) => !s.terminal).map((s) => s.count));
  const summary = `${label}: ${stages
    .map((s) => {
      const age = ageText(s);
      return `${s.label} ${formatInteger(s.count)}${unit ? ` ${unit}` : ''}${age ? ` (${age})` : ''}${
        s.id === flagged ? ', bottleneck' : ''
      }`;
    })
    .join('; ')}.`;

  return (
    <figure className={cx('aoc-chart', 'aoc-funnel', className)} role="img" aria-label={summary}>
      <ol
        className="aoc-funnel__stages"
        style={{ gridTemplateColumns: `repeat(${Math.max(1, stages.length)}, minmax(0, 1fr))` }}
      >
        {stages.map((s) => {
          const age = ageText(s);
          const isBottleneck = s.id === flagged;
          return (
            <li
              key={s.id}
              className={cx(
                'aoc-funnel__stage',
                isBottleneck && 'is-bottleneck',
                s.terminal && 'is-terminal',
              )}
            >
              <span className="aoc-funnel__name">{s.label}</span>
              <span className="aoc-funnel__count">
                <strong className="aoc-num">{formatInteger(s.count)}</strong>
                {unit && <span className="aoc-funnel__unit">{unit}</span>}
              </span>
              {s.terminal ? (
                <span className="aoc-funnel__bar aoc-funnel__bar--none" aria-hidden="true" />
              ) : (
                <span className="aoc-funnel__bar" aria-hidden="true">
                  <span className="aoc-funnel__fill" style={{ width: `${(s.count / max) * 100}%` }} />
                </span>
              )}
              <span className="aoc-funnel__age aoc-num">{age ?? ' '}</span>
              {isBottleneck && (
                <span className="aoc-funnel__flag">
                  <Icon name="warn" size={12} /> Bottleneck
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
