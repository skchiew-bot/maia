import { Suspense, useLayoutEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../api/auth';
import { EventStreamProvider, useStreamStatus } from '../api/stream';
import { Drawer } from '../components/Dialog';
import { useDocumentBadge, useDocumentProduct } from '../lib/documentTitle';
import { readPref, writePref } from '../lib/dom';
import { markRouteChange } from '../lib/routeFocus';
import { useOpenDecisionCount } from '../pages/decisions/inbox';
import { ErrorBoundary } from './ErrorBoundary';
import { navItemsFor } from './navItems';
import { SideNav } from './SideNav';
import { TopBar } from './TopBar';

const NAV_PREF = 'aoc.nav';

/** Quiet fallback while a page chunk loads — text, no spinner. */
export function PageLoading() {
  return (
    <p className="aoc-loading" role="status">
      Loading…
    </p>
  );
}

function OperatorFrame() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const connection = useStreamStatus();
  const inboxCount = useOpenDecisionCount();
  const [collapsed, setCollapsed] = useState(
    () => readPref(NAV_PREF, 'expanded', ['expanded', 'collapsed']) === 'collapsed',
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const firstPath = useRef(location.pathname);

  useDocumentProduct('AOC');
  useDocumentBadge(inboxCount);

  // Layout effect: runs before the new page's passive effects, so its PageHeader sees the mark.
  useLayoutEffect(() => {
    if (firstPath.current === location.pathname) return;
    firstPath.current = location.pathname;
    setDrawerOpen(false);
    markRouteChange();
    window.scrollTo?.(0, 0);
  }, [location.pathname]);

  if (!user) return null;
  const items = navItemsFor(user.role);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      writePref(NAV_PREF, c ? 'expanded' : 'collapsed');
      return !c;
    });
  };

  const signOut = () => {
    void logout().finally(() => navigate('/login', { replace: true }));
  };

  return (
    <div className={`aoc-app${collapsed ? ' is-nav-collapsed' : ''}`}>
      <a href="#main" className="aoc-skip-link">
        Skip to content
      </a>
      <TopBar
        connection={connection}
        inboxCount={inboxCount}
        user={user}
        onSignOut={signOut}
        onOpenNav={() => setDrawerOpen(true)}
        navOpen={drawerOpen}
      />
      <aside className="aoc-sidebar">
        <SideNav
          items={items}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
          inboxCount={inboxCount}
        />
      </aside>
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Navigation"
        side="left"
        width={280}
      >
        <SideNav
          id="aoc-nav-drawer"
          items={items}
          inboxCount={inboxCount}
          onNavigate={() => setDrawerOpen(false)}
        />
      </Drawer>
      <main id="main" className="aoc-main" tabIndex={-1}>
        <div className="aoc-main__inner">
          <ErrorBoundary key={location.pathname}>
            <Suspense fallback={<PageLoading />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}

/**
 * Operator surface layout: skip link, compact top bar, collapsible left nav (a drawer on ≤768px), and the
 * page outlet. Owns the single event-stream connection for every operator page.
 */
export function OperatorLayout() {
  return (
    <EventStreamProvider>
      <OperatorFrame />
    </EventStreamProvider>
  );
}
