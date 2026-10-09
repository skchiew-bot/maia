import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../api/auth';
import { safeNextPath } from '../../api/client';
import { useDocumentTitle } from '../../lib/documentTitle';
import { TokenSignInForm } from '../login/TokenSignInForm';

/** Requester sign-in. Plain language only — no internal terminology (§7). */
export default function PortalLoginPage() {
  const { status } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNextPath(params.get('next'), '/portal');
  useDocumentTitle('Sign in');

  useEffect(() => {
    if (status === 'authenticated') navigate(next, { replace: true });
  }, [status, next, navigate]);

  return (
    <div className="aoc-login aoc-login--embedded">
      <section className="aoc-login__card" aria-labelledby="portal-sign-in">
        <div>
          <h1 id="portal-sign-in" className="aoc-login__title">
            Sign in
          </h1>
          <p className="aoc-login__lede">Sign in to report a problem or follow up on one you reported.</p>
        </div>
        <TokenSignInForm
          label="Access code"
          hint="Use the access code you were given."
          onSignedIn={() => navigate(next, { replace: true })}
        />
      </section>
    </div>
  );
}
