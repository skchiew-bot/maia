import type { ReactNode } from 'react';
import type { ResourceState } from '../api/useResource';
import { cx } from '../lib/dom';
import { describeError, EmptyState, ErrorState, InlineAlert } from './EmptyState';

export interface ResourceViewProps<T> {
  /** Result of `useResource`. */
  resource: ResourceState<T>;
  /** Renders loaded data. */
  children: (data: T) => ReactNode;
  /** Decides emptiness (default: empty array). */
  isEmpty?: (data: T) => boolean;
  /** Shown when empty. Default: "Nothing here yet". */
  empty?: ReactNode;
  /** First-load text, e.g. "Loading decisions…". Default "Loading…". */
  loadingText?: string;
  /** Headline when the first load fails. */
  errorTitle?: string;
  className?: string;
}

/**
 * The standard loading / error / empty / data states for anything fetched with `useResource`:
 * - first load: one quiet line of text (no spinner, no skeleton);
 * - refetch: the previous render stays, dimmed, with `aria-busy`;
 * - failed refetch: the stale data stays, with a warning and Retry;
 * - failed first load: ErrorState with Retry.
 */
export function ResourceView<T>({
  resource,
  children,
  isEmpty = (d) => Array.isArray(d) && d.length === 0,
  empty,
  loadingText = 'Loading…',
  errorTitle,
  className,
}: ResourceViewProps<T>) {
  const { data, error, loading, reload } = resource;
  if (data === undefined) {
    if (error)
      return <ErrorState title={errorTitle} error={error} onRetry={reload} size="sm" className={className} />;
    return (
      <p className={cx('aoc-loading', className)} role="status">
        {loadingText}
      </p>
    );
  }
  return (
    <div className={cx('aoc-resource', loading && 'is-busy', className)} aria-busy={loading || undefined}>
      {error !== undefined && (
        <InlineAlert
          tone="warn"
          title="Showing the last loaded data"
          action={
            <button type="button" className="aoc-link-button" onClick={reload}>
              Retry
            </button>
          }
        >
          {describeError(error) ?? 'The latest refresh failed.'}
        </InlineAlert>
      )}
      {isEmpty(data) ? (empty ?? <EmptyState title="Nothing here yet" size="sm" />) : children(data)}
    </div>
  );
}
