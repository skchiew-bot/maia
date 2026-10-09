import { cx } from '../lib/dom';
import { formatInteger, formatTokens } from '../lib/format';

export interface TokenCountProps {
  /** Exact token count. */
  value: number;
  /** Unit word after the number. Default "tokens"; pass "" to omit. */
  unit?: string;
  className?: string;
}

/** `1.2M tokens` with the exact count (`1,234,567 tokens`) in the title. */
export function TokenCount({ value, unit = 'tokens', className }: TokenCountProps) {
  return (
    <span
      className={cx('aoc-tokens', 'aoc-num', className)}
      title={`${formatInteger(value)}${unit ? ` ${unit}` : ''}`}
    >
      {formatTokens(value)}
      {unit && <span className="aoc-tokens__unit"> {unit}</span>}
    </span>
  );
}
