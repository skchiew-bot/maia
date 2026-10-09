import { useNow } from '../lib/clock';
import { cx } from '../lib/dom';
import { formatAge, formatDateTime, toEpoch, type Instant } from '../lib/format';

export interface RelativeTimeProps {
  /** The instant (epoch ms, ISO string or Date). */
  value: Instant;
  /** Reference time; defaults to the shared minute clock (`useNow`). Pass it for deterministic renders. */
  now?: number;
  /** Text before the age, e.g. "decision ". */
  prefix?: string;
  /** Text after the age, e.g. " ago". Default none — most labels read "waiting 2h 14m". */
  suffix?: string;
  className?: string;
}

/**
 * Compact age (`2h 14m`) inside a `<time>` whose title is the absolute local timestamp. Updates at most once a
 * minute — text only, never motion.
 */
export function RelativeTime({ value, now, prefix = '', suffix = '', className }: RelativeTimeProps) {
  const clockNow = useNow();
  const t = toEpoch(value);
  const ref = now ?? clockNow;
  if (!Number.isFinite(t)) return <span className={className}>—</span>;
  return (
    <time
      className={cx('aoc-reltime', 'aoc-num', className)}
      dateTime={new Date(t).toISOString()}
      title={formatDateTime(t)}
    >
      {prefix}
      {formatAge(ref - t)}
      {suffix}
    </time>
  );
}
