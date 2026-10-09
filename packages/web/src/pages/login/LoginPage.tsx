import { useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ROLE_LANDING, useAuth, type AuthUser } from '../../api/auth';
import { safeNextPath } from '../../api/client';
import { InlineAlert } from '../../components';
import { useDocumentTitle } from '../../lib/documentTitle';
import { TokenSignInForm } from './TokenSignInForm';

/** Requesters always land in the portal; operators return to where they were, else their role's home. */
function destinationFor(user: AuthUser, next: string | null): string {
  return user.role === 'requester' ? ROLE_LANDING.requester : safeNextPath(next, ROLE_LANDING[user.role]);
}

/** Operator sign-in (paste-token → cookie session). */
export default function LoginPage() {
  const { status, user } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const nextParam = params.get('next');
  useDocumentTitle('Sign in');

  const go = (u: AuthUser) => navigate(destinationFor(u, nextParam), { replace: true });

  // Already signed in (or just signed in elsewhere): continue.
  useEffect(() => {
    if (status === 'authenticated' && user) navigate(destinationFor(user, nextParam), { replace: true });
  }, [status, user, nextParam, navigate]);

  return (
    <div className="aoc-standalone aoc-login">
      <main id="main" className="aoc-login__card">
        <span className="aoc-mark" aria-hidden="true">
          <span className="aoc-mark__tile">AOC</span>
          <span className="aoc-mark__name">Agent Ops Console</span>
        </span>
        <div>
          <h1 className="aoc-login__title">Sign in</h1>
          <p className="aoc-login__lede">Paste the access token issued to you for the operator console.</p>
        </div>
        <TokenSignInForm label="Access token" onSignedIn={go} />
        <InlineAlert tone="info" title="Attribution, not signed approval">
          A v1 bearer token proves which token was used, not who used it. Your actions are recorded against
          this token&apos;s owner. Go-live and rollback approvals will require a per-decision passkey.
        </InlineAlert>
        <p className="aoc-login__foot">
          Reporting a problem? Use the <Link to="/portal/login">support portal</Link>.
        </p>
      </main>
    </div>
  );
}
