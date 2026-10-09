import { useEffect } from 'react';
import { BrowserRouter, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './api/auth';
import { setUnauthorizedHandler } from './api/client';
import { ToastProvider } from './components/Toast';
import { AppRoutes } from './routes';

/** Routes 401s from any API call to the right sign-in page through the router (no full reload). */
function UnauthorizedRedirect() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  useEffect(
    () =>
      setUnauthorizedHandler((loginPath) => {
        void refresh();
        navigate(loginPath, { replace: true });
      }),
    [navigate, refresh],
  );
  return null;
}

/** Root component: router, session, notifications, routes. */
export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <UnauthorizedRedirect />
          <AppRoutes />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
