import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import { Navigate, Outlet, Route, Routes, useParams } from 'react-router-dom';
import { OPERATOR_ROLES, ROLE_LANDING, RequireRole, useAuth, type Role } from './api/auth';
import { decisionHref } from './lib/links';
import { OperatorLayout, PageLoading } from './shell/OperatorLayout';
import { PortalLayout } from './shell/PortalLayout';

// Every page is its own chunk (React.lazy). Page files live in src/pages/<area>/<Name>Page.tsx.
const ControlTowerPage = lazy(() => import('./pages/tower/ControlTowerPage'));
const ConsolePage = lazy(() => import('./pages/console/ConsolePage'));
const SessionPage = lazy(() => import('./pages/sessions/SessionPage'));
const ProjectsPage = lazy(() => import('./pages/projects/ProjectsPage'));
const ProjectPage = lazy(() => import('./pages/projects/ProjectPage'));
const DecisionsPage = lazy(() => import('./pages/decisions/DecisionsPage'));
const ChangesPage = lazy(() => import('./pages/changes/ChangesPage'));
const ChangePage = lazy(() => import('./pages/changes/ChangePage'));
const RollbacksPage = lazy(() => import('./pages/rollbacks/RollbacksPage'));
const RegistryPage = lazy(() => import('./pages/registry/RegistryPage'));
const MeteringPage = lazy(() => import('./pages/metering/MeteringPage'));
const CreditsPage = lazy(() => import('./pages/credits/CreditsPage'));
const LearningPage = lazy(() => import('./pages/learning/LearningPage'));
const KnowledgePage = lazy(() => import('./pages/knowledge/KnowledgePage'));
const AuditPage = lazy(() => import('./pages/audit/AuditPage'));
const CompliancePage = lazy(() => import('./pages/compliance/CompliancePage'));
const TicketsPage = lazy(() => import('./pages/tickets/TicketsPage'));
const TicketPage = lazy(() => import('./pages/tickets/TicketPage'));
const AdminUsersPage = lazy(() => import('./pages/admin/AdminUsersPage'));
const ShowcasePage = lazy(() => import('./pages/showcase/ShowcasePage'));
const NotFoundPage = lazy(() => import('./pages/notfound/NotFoundPage'));
const LoginPage = lazy(() => import('./pages/login/LoginPage'));
const PortalHomePage = lazy(() => import('./pages/portal/PortalHomePage'));
const PortalNewRequestPage = lazy(() => import('./pages/portal/PortalNewRequestPage'));
const PortalTicketPage = lazy(() => import('./pages/portal/PortalTicketPage'));
const PortalLoginPage = lazy(() => import('./pages/portal/PortalLoginPage'));
const PortalNotFoundPage = lazy(() => import('./pages/portal/PortalNotFoundPage'));
const GalleryPage = lazy(() => import('./pages/dev/GalleryPage'));

const ALL_ROLES: readonly Role[] = ['approver', 'builder', 'requester'];

function page(Component: LazyExoticComponent<ComponentType>) {
  return <Component />;
}

/** `/` lands each role on its home view: Approvers → Control Tower, Builders → Console. */
function RoleLanding() {
  const { user } = useAuth();
  return <Navigate to={ROLE_LANDING[user?.role ?? 'builder']} replace />;
}

/** `/decisions/:id` is the link the daemon puts in notifications and webhooks; the inbox selects a card with `?focus=`. */
function DecisionRedirect() {
  const { id = '' } = useParams();
  return <Navigate to={decisionHref(id)} replace />;
}

/** Pages outside any layout get their own Suspense boundary. */
function Standalone({ Component }: { Component: LazyExoticComponent<ComponentType> }) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Component />
    </Suspense>
  );
}

/**
 * Route table. Operator routes sit under the authenticated OperatorLayout (approver/builder; requesters are
 * sent to the portal). The portal has its own plain layout; `/portal/login` is its only public page.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Standalone Component={LoginPage} />} />
      <Route path="/dev/gallery" element={<Standalone Component={GalleryPage} />} />

      <Route path="/portal" element={<PortalLayout />}>
        <Route path="login" element={page(PortalLoginPage)} />
        <Route
          element={
            <RequireRole roles={ALL_ROLES}>
              <Outlet />
            </RequireRole>
          }
        >
          <Route index element={page(PortalHomePage)} />
          <Route path="new" element={page(PortalNewRequestPage)} />
          <Route path="tickets/:id" element={page(PortalTicketPage)} />
          <Route path="*" element={page(PortalNotFoundPage)} />
        </Route>
      </Route>

      <Route
        element={
          <RequireRole roles={OPERATOR_ROLES}>
            <OperatorLayout />
          </RequireRole>
        }
      >
        <Route index element={<RoleLanding />} />
        <Route path="tower" element={page(ControlTowerPage)} />
        <Route path="console" element={page(ConsolePage)} />
        <Route path="sessions/:id" element={page(SessionPage)} />
        <Route path="projects" element={page(ProjectsPage)} />
        <Route path="projects/:id" element={page(ProjectPage)} />
        <Route path="decisions" element={page(DecisionsPage)} />
        <Route path="decisions/:id" element={<DecisionRedirect />} />
        <Route path="changes" element={page(ChangesPage)} />
        <Route path="changes/:id" element={page(ChangePage)} />
        <Route path="rollbacks" element={page(RollbacksPage)} />
        <Route path="registry" element={page(RegistryPage)} />
        <Route path="metering" element={page(MeteringPage)} />
        <Route path="credits" element={page(CreditsPage)} />
        <Route path="learning" element={page(LearningPage)} />
        <Route path="knowledge" element={page(KnowledgePage)} />
        <Route path="audit" element={page(AuditPage)} />
        <Route path="compliance" element={page(CompliancePage)} />
        <Route path="tickets" element={page(TicketsPage)} />
        <Route path="tickets/:id" element={page(TicketPage)} />
        <Route
          path="admin/users"
          element={<RequireRole roles={['approver']}>{page(AdminUsersPage)}</RequireRole>}
        />
        <Route path="showcase" element={page(ShowcasePage)} />
        <Route path="*" element={page(NotFoundPage)} />
      </Route>
    </Routes>
  );
}
