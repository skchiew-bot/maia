import { cx } from '../../lib/dom';
import { formatDuration, formatInteger, formatNumber, formatUsd } from '../../components';
import { SCOPE_LABEL, type PayoffRow } from './model';

export interface PayoffChartProps {
  rows: readonly PayoffRow[];
  onOpen?: (lessonId: string) => void;
}

function signed(n: number): string {
  const v = formatNumber(Math.abs(n), 1);
  return n > 0 ? `+${v}` : n < 0 ? `−${v}` : '0';
}

/**
 * Repeats prevented per lesson since binding, on one shared scale around zero. A bar left of zero means the
 * class recurred more than its baseline predicts: the lesson is not working and should be pruned. Every value
 * is printed as text beside its bar; the bars themselves are decoration for sighted readers.
 */
export function PayoffChart({ rows, onOpen }: PayoffChartProps) {
  const lo = Math.min(0, ...rows.map((r) => r.prevented));
  const hi = Math.max(0, ...rows.map((r) => r.prevented));
  const span = hi - lo || 1;
  const zero = (-lo / span) * 100;
  return (
    <ul className="knowledge-payoff" aria-label="Repeats prevented per lesson since binding">
      {rows.map((r) => {
        const l = r.lesson;
        const width = (Math.abs(r.prevented) / span) * 100;
        const negative = r.prevented < 0;
        const noEvidence = r.exposuresAfter === 0;
        const tip = noEvidence
          ? 'No runs in scope since binding yet'
          : `${signed(r.prevented)} repeats prevented over ${formatInteger(r.exposuresAfter)} runs in scope`;
        return (
          <li key={l.lessonId} className={cx('knowledge-payoff__row', negative && 'is-negative')}>
            <span className="knowledge-payoff__label">
              {onOpen ? (
                <button type="button" className="knowledge-payoff__rule" onClick={() => onOpen(l.lessonId)}>
                  {l.rule}
                </button>
              ) : (
                <span className="knowledge-payoff__rule">{l.rule}</span>
              )}
              <span className="knowledge-payoff__scope">
                {SCOPE_LABEL[l.scopeType]} · {l.scopeValue}
                {l.status === 'retired' ? ' · retired' : ''}
              </span>
            </span>
            <span className="knowledge-payoff__plot" aria-hidden="true" title={tip}>
              {lo < 0 && <span className="knowledge-payoff__zero" style={{ left: `${zero}%` }} />}
              {width > 0 && (
                <span
                  className="knowledge-payoff__bar"
                  style={{ left: `${negative ? zero - width : zero}%`, width: `${Math.max(width, 0.8)}%` }}
                />
              )}
            </span>
            <span className="knowledge-payoff__value">
              <strong className="aoc-num">
                {noEvidence ? '—' : signed(r.prevented)}
                <span className="aoc-sr-only"> repeats prevented</span>
              </strong>
              <span className="knowledge-payoff__saved aoc-num">
                {noEvidence
                  ? 'no runs in scope yet'
                  : negative
                    ? 'not working: prune'
                    : `${formatUsd(r.usdSaved)} · ${formatDuration(r.msSaved)} saved`}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
