import type { CSSProperties } from 'react';
import { ErrorState } from '../../components/EmptyState';
import './shared.css';

export interface SkeletonProps {
  /** Announced while loading ("Loading change requests"). */
  label: string;
  /** Block heights in px, top to bottom, roughly matching the loaded layout. */
  blocks: readonly number[];
}

/** First-load placeholder that holds the page layout. Static on purpose: nothing moves while waiting (§12). */
export function Skeleton({ label, blocks }: SkeletonProps) {
  return (
    <div className="audit-skeleton" role="status" aria-live="polite">
      <span className="aoc-sr-only">{label}…</span>
      {blocks.map((h, i) => (
        <div
          key={i}
          className="audit-skeleton__block"
          style={{ height: h } as CSSProperties}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}

/** First-load failure with the daemon's reason and a retry. */
export function LoadFailed({ what, error, onRetry }: { what: string; error: unknown; onRetry: () => void }) {
  return <ErrorState title={`Couldn't load ${what}`} error={error} onRetry={onRetry} />;
}
