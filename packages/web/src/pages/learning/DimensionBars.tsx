import { formatInteger, formatUsd } from '../../components';
import type { DimensionShare } from './model';

export interface DimensionBarsProps {
  shares: readonly DimensionShare[];
}

/**
 * Cost of recurrence by root-cause dimension: one hue (a single series), values printed at the bar tips, and
 * the class and occurrence counts as text. Bars share one scale so lengths compare honestly. Each row reads
 * as one sentence to screen readers.
 */
export function DimensionBars({ shares }: DimensionBarsProps) {
  const max = Math.max(1e-9, ...shares.map((s) => s.costUsd));
  return (
    <ul className="learning-dims" aria-label="Cost of recurrence by root-cause dimension">
      {shares.map((s) => {
        const pct = Math.max(s.costUsd > 0 ? 1.5 : 0, (s.costUsd / max) * 100);
        const classes = `${formatInteger(s.classes)} class${s.classes === 1 ? '' : 'es'}`;
        const detail = `${s.label}: ${formatUsd(s.costUsd)} notional, ${classes}, ${formatInteger(
          s.occurrences,
        )} occurrences. ${s.hint}.`;
        return (
          <li key={s.dimension} className="learning-dims__row" title={detail}>
            <span className="learning-dims__label" aria-hidden="true">
              <span className="learning-dims__name">{s.label}</span>
              <span className="learning-dims__count aoc-num">
                {classes} · {formatInteger(s.occurrences)} occ.
              </span>
            </span>
            <span className="learning-dims__track" aria-hidden="true">
              <span className="learning-dims__bar" style={{ width: `${pct}%` }} />
            </span>
            <span className="learning-dims__value aoc-num" aria-hidden="true">
              {formatUsd(s.costUsd)}
            </span>
            <span className="aoc-sr-only">{detail}</span>
          </li>
        );
      })}
    </ul>
  );
}
