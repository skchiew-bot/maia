import { Link } from 'react-router-dom';
import { LivenessBadge } from '../../components/liveness';
import { formatClock } from '../../lib/format';
import type { FeedItem } from './model';

export interface EventFeedProps {
  items: readonly FeedItem[];
  /** Session titles for the lines that name a session. */
  titles: ReadonlyMap<string, string>;
}

/**
 * The latest events as they arrive (newest first). It is the only text that changes on its own, and only
 * because an event arrived; polite, additions only, so screen readers hear each new line once.
 */
export function EventFeed({ items, titles }: EventFeedProps) {
  if (!items.length) {
    return <p className="sc-feed__empty">Waiting for the next event. Nothing here moves until one arrives.</p>;
  }
  return (
    <ol className="sc-feed" aria-live="polite" aria-relevant="additions">
      {items.map((it) => {
        const title = it.sessionId ? titles.get(it.sessionId) : undefined;
        return (
          <li key={it.key} className="sc-feed__item">
            <time className="sc-feed__time aoc-num" dateTime={it.at}>
              {formatClock(it.at)}
            </time>
            <span className="sc-feed__what">
              {it.liveness ? <LivenessBadge state={it.liveness} size="sm" /> : <span className="sc-feed__word">{it.word}</span>}
              {it.kind === 'tool' && it.count > 1 ? (
                <span className="sc-feed__detail aoc-num">×{it.count}</span>
              ) : (
                it.detail && <span className="sc-feed__detail">{it.detail}</span>
              )}
              {it.sessionId &&
                (title ? (
                  <Link className="sc-feed__session" to={`/sessions/${encodeURIComponent(it.sessionId)}`} title={title}>
                    {title}
                  </Link>
                ) : (
                  <code className="sc-feed__session">{it.sessionId.slice(-6)}</code>
                ))}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
