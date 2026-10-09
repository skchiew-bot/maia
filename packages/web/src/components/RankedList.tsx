import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cx } from '../lib/dom';
import { formatInteger, type Instant } from '../lib/format';
import { Icon, type IconName } from './Icon';
import { RelativeTime } from './RelativeTime';

/** How urgent an attention item is. Shape (icon) and word travel with the colour. */
export type Severity = 'critical' | 'high' | 'medium' | 'low';

export const SEVERITY_META: Record<Severity, { word: string; icon: IconName; color: string }> = {
  critical: { word: 'Critical', icon: 'dead', color: 'var(--danger)' },
  high: { word: 'High', icon: 'warn', color: 'var(--warn)' },
  medium: { word: 'Medium', icon: 'info', color: 'var(--info)' },
  low: { word: 'Low', icon: 'dot', color: 'var(--text-3)' },
};

export interface RankedItem {
  id: string;
  severity: Severity;
  /** What needs attention ("Fix-plan sign-off for billing-revamp"). Untrusted text renders as text. */
  title: ReactNode;
  /** Router path; makes the title a link to the record. */
  href?: string;
  /** Context line: project · session · kind. */
  meta?: ReactNode;
  /** When it started needing attention; rendered as an age (`2h 14m`). */
  since?: Instant;
  /** Ranking score — higher is more urgent. Always printed as a number next to its bar. */
  score: number;
  /** Inline action, e.g. `<Button size="sm">Review</Button>`. */
  action?: ReactNode;
}

export interface RankedListProps {
  items: readonly RankedItem[];
  /** Accessible list name ("Needs attention"). */
  label: string;
  /** Top of the score scale. Default 100, or the highest score when larger. */
  scoreMax?: number;
  /** What the score measures, read before each number ("Attention score"). */
  scoreLabel?: string;
  formatScore?: (value: number) => string;
  /** Show the 1, 2, 3… rank column. Default true. */
  showRank?: boolean;
  /** `given` (default) keeps the server's ranking; `score` sorts highest first. */
  order?: 'given' | 'score';
  /** Reference time for ages (deterministic renders). */
  now?: number;
  /** Shown when there is nothing to attend to. */
  empty?: ReactNode;
  className?: string;
}

/**
 * The Control Tower's attention rows: severity mark (icon + colour + word for assistive tech), rank, title
 * and context, age, a score bar with its number as text, and an inline action — one scannable line each.
 */
export function RankedList({
  items,
  label,
  scoreMax,
  scoreLabel = 'Score',
  formatScore = (v) => formatInteger(v),
  showRank = true,
  order = 'given',
  now,
  empty,
  className,
}: RankedListProps) {
  if (items.length === 0) return <>{empty ?? null}</>;
  const rows = order === 'score' ? [...items].sort((a, b) => b.score - a.score) : items;
  const top = Math.max(scoreMax ?? 100, ...rows.map((r) => r.score), 1e-9);
  return (
    <ol className={cx('aoc-ranked', !showRank && 'aoc-ranked--no-rank', className)} aria-label={label}>
      {rows.map((it, i) => {
        const sev = SEVERITY_META[it.severity];
        const pct = Math.max(0, Math.min(1, it.score / top)) * 100;
        return (
          <li
            key={it.id}
            className="aoc-ranked__item"
            data-severity={it.severity}
            style={{ '--sev': sev.color } as CSSProperties}
          >
            {showRank && <span className="aoc-ranked__rank aoc-num">{i + 1}</span>}
            <span className="aoc-ranked__sev" title={sev.word}>
              <Icon name={sev.icon} size={14} />
              <span className="aoc-sr-only">{sev.word}: </span>
            </span>
            <div className="aoc-ranked__main">
              <span className="aoc-ranked__title">
                {it.href ? (
                  <Link to={it.href} className="aoc-ranked__link">
                    {it.title}
                  </Link>
                ) : (
                  it.title
                )}
              </span>
              {it.meta && <span className="aoc-ranked__meta">{it.meta}</span>}
            </div>
            <span className="aoc-ranked__age">
              {it.since !== undefined && <RelativeTime value={it.since} now={now} />}
            </span>
            <span className="aoc-ranked__score">
              <span className="aoc-ranked__bar" aria-hidden="true">
                <span className="aoc-ranked__fill" style={{ width: `${pct}%` }} />
              </span>
              <span className="aoc-ranked__score-num aoc-num">
                <span className="aoc-sr-only">{scoreLabel} </span>
                {formatScore(it.score)}
              </span>
            </span>
            {it.action && <span className="aoc-ranked__action">{it.action}</span>}
          </li>
        );
      })}
    </ol>
  );
}
