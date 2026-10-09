import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useDocumentTitle } from '../lib/documentTitle';
import { consumeRouteChange } from '../lib/routeFocus';

export interface Crumb {
  /** Visible text. */
  label: string;
  /** Router path; omit for the current (last) crumb. */
  to?: string;
}

export interface PageHeaderProps {
  /** The page's single `<h1>`. Also becomes the tab title unless `documentTitle` overrides it. */
  title: string;
  /** One line of context under the title. */
  subtitle?: ReactNode;
  /** Page-level actions, right-aligned (one `primary` at most). */
  actions?: ReactNode;
  /** Trail from the area root to this page, e.g. Projects › Billing revamp. */
  breadcrumbs?: readonly Crumb[];
  /** Status row under the title: liveness badge, ids, chips. */
  meta?: ReactNode;
  /** Tab title override; `false` leaves the document title alone. */
  documentTitle?: string | false;
}

/**
 * Top of every page. The `<h1>` is focusable (`tabIndex=-1`) so the shell can move focus to it on route
 * changes, which announces the new page to screen readers.
 */
export function PageHeader({ title, subtitle, actions, breadcrumbs, meta, documentTitle }: PageHeaderProps) {
  useDocumentTitle(documentTitle === false ? undefined : (documentTitle ?? title));
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (consumeRouteChange()) headingRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <header className="aoc-page-header">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="aoc-breadcrumbs">
          <ol>
            {breadcrumbs.map((c, i) => {
              const last = i === breadcrumbs.length - 1;
              return (
                <li key={`${c.label}-${i}`}>
                  {c.to && !last ? (
                    <Link to={c.to}>{c.label}</Link>
                  ) : (
                    <span aria-current={last ? 'page' : undefined}>{c.label}</span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      )}
      <div className="aoc-page-header__row">
        <div className="aoc-page-header__titles">
          <h1 ref={headingRef} tabIndex={-1} className="aoc-page-header__title">
            {title}
          </h1>
          {subtitle && <p className="aoc-page-header__subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="aoc-page-header__actions">{actions}</div>}
      </div>
      {meta && <div className="aoc-page-header__meta">{meta}</div>}
    </header>
  );
}
