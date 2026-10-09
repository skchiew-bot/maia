import type { ReactNode } from 'react';
import { ApiError } from '../api/client';
import { cx } from '../lib/dom';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { STATUS_ICON, STATUS_WORD, type StatusTone } from './tone';

export interface EmptyStateProps {
  /** What is empty, stated plainly ("No open decisions"). */
  title: string;
  /** Why it is empty or what will fill it. */
  body?: ReactNode;
  /** Optional glyph above the title. */
  icon?: IconName;
  /** One next step (a Button or ButtonLink). */
  action?: ReactNode;
  /** `sm` for inside tables and widgets; `md` (default) for whole pages. */
  size?: 'sm' | 'md';
  className?: string;
}

/** Calm placeholder for an empty collection or a not-yet-built area. */
export function EmptyState({ title, body, icon, action, size = 'md', className }: EmptyStateProps) {
  return (
    <div className={cx('aoc-empty', `aoc-empty--${size}`, className)}>
      {icon && <Icon name={icon} size={size === 'sm' ? 16 : 20} className="aoc-empty__icon" />}
      <p className="aoc-empty__title">{title}</p>
      {body && <div className="aoc-empty__body">{body}</div>}
      {action && <div className="aoc-empty__action">{action}</div>}
    </div>
  );
}

export interface ErrorStateProps {
  /** Headline. Default "Couldn't load this". */
  title?: string;
  /** The caught error; ApiErrors show their status, code and message. */
  error?: unknown;
  /** Extra guidance. */
  body?: ReactNode;
  /** Shows a Retry button. */
  onRetry?: () => void;
  size?: 'sm' | 'md';
  className?: string;
}

/** Human-readable detail line for any thrown value. */
export function describeError(error: unknown): string | undefined {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'The AOC daemon could not be reached.';
    return `${error.message} (HTTP ${error.status}${error.code ? ` · ${error.code}` : ''})`;
  }
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return undefined;
}

/** Failure placeholder with the error detail and an optional retry. */
export function ErrorState({
  title = "Couldn't load this",
  error,
  body,
  onRetry,
  size = 'md',
  className,
}: ErrorStateProps) {
  const detail = describeError(error);
  return (
    <div className={cx('aoc-empty', 'aoc-empty--error', `aoc-empty--${size}`, className)} role="alert">
      <Icon name="danger" size={size === 'sm' ? 16 : 20} className="aoc-empty__icon aoc-tone-text--danger" />
      <p className="aoc-empty__title">{title}</p>
      {detail && <p className="aoc-empty__detail">{detail}</p>}
      {body && <div className="aoc-empty__body">{body}</div>}
      {onRetry && (
        <div className="aoc-empty__action">
          <Button size="sm" icon="retry" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}

export interface InlineAlertProps {
  /** `info` (default), `ok`, `warn` or `danger`. Icon and a screen-reader word come with each tone. */
  tone?: StatusTone;
  /** Bold lead line. */
  title?: string;
  children?: ReactNode;
  /** Trailing action (a small Button or link). */
  action?: ReactNode;
  /**
   * Announce when it appears (after a user action). Danger uses `role="alert"`, others `role="status"`.
   * Leave off for alerts that are simply part of the page on load.
   */
  live?: boolean;
  /** Adds a dismiss button. */
  onDismiss?: () => void;
  className?: string;
}

/** In-flow message banner (validation results, policy notes, degraded data). */
export function InlineAlert({
  tone = 'info',
  title,
  children,
  action,
  live,
  onDismiss,
  className,
}: InlineAlertProps) {
  const role = live ? (tone === 'danger' ? 'alert' : 'status') : undefined;
  return (
    <div className={cx('aoc-alert', `aoc-alert--${tone}`, className)} role={role}>
      <Icon name={STATUS_ICON[tone]} size={16} className="aoc-alert__icon" />
      <div className="aoc-alert__content">
        <span className="aoc-sr-only">{STATUS_WORD[tone]}: </span>
        {title && <p className="aoc-alert__title">{title}</p>}
        {children && <div className="aoc-alert__body">{children}</div>}
      </div>
      {action && <div className="aoc-alert__action">{action}</div>}
      {onDismiss && (
        <button type="button" className="aoc-alert__dismiss" aria-label="Dismiss" onClick={onDismiss}>
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}
