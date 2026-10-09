import { cx } from '../lib/dom';
import { formatMyr, formatUsd } from '../lib/format';

export interface MoneyProps {
  /** Amount in US dollars. */
  usd: number;
  /**
   * Same amount in ringgit, as computed by the daemon with that day's stamped BNM rate. Never converted in the
   * browser (rate changes apply forward only, §10). Omit when unknown.
   */
  myr?: number | null;
  /**
   * Marks a synthetic API-equivalent cost (metering on a Max plan has no per-token bill, §10). Adds a visible
   * "notional" tag and says so in the title.
   */
  notional?: boolean;
  /** `US$1.2K` style. */
  compact?: boolean;
  /** Fraction digits when not compact. Default 2. */
  decimals?: number;
  /** `inline` (default): US$ · RM on one line; `stacked`: RM under US$ (table cells, tiles). */
  layout?: 'inline' | 'stacked';
  /** Show only USD (RM still in the title) for very narrow cells. */
  usdOnly?: boolean;
  className?: string;
}

/** USD + RM pair. Numbers are tabular so columns of money align. */
export function Money({
  usd,
  myr,
  notional,
  compact,
  decimals,
  layout = 'inline',
  usdOnly,
  className,
}: MoneyProps) {
  const opts = { compact, decimals };
  const usdText = formatUsd(usd, opts);
  const myrText = myr === null || myr === undefined ? undefined : formatMyr(myr, opts);
  const title = [
    formatUsd(usd, { decimals: decimals ?? 2 }),
    myrText ? formatMyr(myr as number, { decimals: decimals ?? 2 }) : undefined,
    notional ? 'notional API-equivalent cost, not a bill' : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span className={cx('aoc-money', `aoc-money--${layout}`, 'aoc-num', className)} title={title}>
      <span className="aoc-money__usd">{usdText}</span>
      {myrText && !usdOnly && <span className="aoc-money__myr">{myrText}</span>}
      {notional && <span className="aoc-money__tag">notional</span>}
    </span>
  );
}
