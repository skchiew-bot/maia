import { Suspense, useLayoutEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../api/auth';
import { useDocumentProduct } from '../lib/documentTitle';
import { markRouteChange } from '../lib/routeFocus';
import { cx } from '../lib/dom';
import { ErrorBoundary } from './ErrorBoundary';
import { PageLoading } from './OperatorLayout';

/**
 * Requester portal layout (§7): a plain header and centred content. No internal navigation and no internal
 * terminology — requesters see their requests and abstracted status only.
 */
export function PortalLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const firstPath = useRef(location.pathname);
  const onLogin = location.pathname === '/portal/login';

  useDocumentProduct('Support');

  // Layout effect: runs before the new page's passive effects, so its PageHeader sees the mark.
  useLayoutEffect(() => {
    if (firstPath.current === location.pathname) return;
    firstPath.current = location.pathname;
    markRouteChange();
    window.scrollTo?.(0, 0);
  }, [location.pathname]);

  return (
    <div className="aoc-portal">
      <a href="#main" className="aoc-skip-link">
        Skip to content
      </a>
      <header className="aoc-portal__header">
        <div className="aoc-portal__bar">
          <Link to="/portal" className="aoc-portal__brand">
            Support
          </Link>
          {user && !onLogin && (
            <nav aria-label="Requests" className="aoc-portal__nav">
              <NavLink
                to="/portal"
                end
                className={({ isActive }) => cx('aoc-portal__link', isActive && 'is-active')}
              >
                My requests
              </NavLink>
              <NavLink
                to="/portal/new"
                className={({ isActive }) => cx('aoc-portal__link', isActive && 'is-active')}
              >
                New request
              </NavLink>
            </nav>
          )}
          <div className="aoc-portal__spacer" />
          {user && !onLogin && (
            <div className="aoc-portal__user">
              <span className="aoc-portal__name">{user.name}</span>
              <button
                type="button"
                className="aoc-link-button"
                onClick={() => void logout().finally(() => navigate('/portal/login', { replace: true }))}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      <main id="main" className="aoc-portal__main" tabIndex={-1}>
        <ErrorBoundary key={location.pathname} title="Something went wrong on this page">
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}
