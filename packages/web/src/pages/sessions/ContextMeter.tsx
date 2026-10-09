import { Icon } from '../../components/Icon';
import { cx } from '../../lib/dom';
import { formatPercent, formatTokens } from '../../lib/format';
import './contextMeter.css';

export interface ContextMeterProps {
  /** Share of the context window in use, 0–100 (the daemon's figure). */
  pct: number | null;
  /** Rollover threshold for the process type, 0–100 (§5). */
  rolloverPct: number;
  /** Tokens in context and the window size, when known, for the text line. */
  tokens?: number | null;
  windowTokens?: number | null;
  /** `tile`: compact (Console); `panel`: with the tokens line (Session). */
  variant?: 'tile' | 'panel';
  className?: string;
}

/**
 * Context window use against the rollover threshold: a thin bar with a tick at the threshold. At or past
 * the tick the fill turns amber and says "rollover due" — rollover pressure, not an error (§5).
 */
export function ContextMeter({
  pct,
  rolloverPct,
  tokens,
  windowTokens,
  variant = 'tile',
  className,
}: ContextMeterProps) {
  if (pct === null) {
    return <span className={cx('session-ctx__none', className)}>no usage yet</span>;
  }
  const ratio = Math.max(0, Math.min(1, pct / 100));
  const due = pct >= rolloverPct;
  const windowText = windowTokens ? `of ${formatTokens(windowTokens)} window` : 'of the window';
  const label = `Context ${formatPercent(ratio)} ${windowText}; rollover at ${rolloverPct}%${due ? ', rollover due' : ''}`;
  return (
    <div className={cx('session-ctx', `session-ctx--${variant}`, due && 'is-due', className)}>
      <div className="session-ctx__bar" role="img" aria-label={label}>
        <span className="session-ctx__fill" style={{ width: `${ratio * 100}%` }} />
        <span className="session-ctx__tick" style={{ left: `${rolloverPct}%` }} />
      </div>
      <span className="session-ctx__sub">
        {due ? (
          <>
            <Icon name="warn" size={12} className="session-ctx__warn" />
            rollover due
          </>
        ) : variant === 'panel' && tokens != null ? (
          <>
            <span className="aoc-num">{formatTokens(tokens)}</span> {windowText} · rollover at {rolloverPct}%
          </>
        ) : (
          windowText
        )}
      </span>
    </div>
  );
}
