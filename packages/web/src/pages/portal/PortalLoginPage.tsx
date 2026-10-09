import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth, type AuthUser } from '../../api/auth';
import { Icon } from '../../components/Icon';
import { useDocumentTitle } from '../../lib/documentTitle';
import { TokenSignInForm } from '../login/TokenSignInForm';
import { portalDestination } from './hooks';
import './portal.css';

/** Requester sign-in with the access code they were given. Plain language only — no internal terms (§7). */
export default function PortalLoginPage() {
  const { status, user } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = params.get('next');
  useDocumentTitle('Sign in');

  const go = (u: AuthUser) => navigate(portalDestination(u, next), { replace: true });

  useEffect(() => {
    if (status === 'authenticated' && user) navigate(portalDestination(user, next), { replace: true });
  }, [status, user, next, navigate]);

  return (
    <div className="aoc-login aoc-login--embedded portal-login">
      <section className="aoc-login__card" aria-labelledby="portal-sign-in">
        <div>
          <h1 id="portal-sign-in" className="aoc-login__title">
            Sign in
          </h1>
          <p className="aoc-login__lede">Report a problem, follow its progress and test the fix when it is ready.</p>
        </div>
        <TokenSignInForm label="Access code" hint="Use the access code you were given." onSignedIn={go} />
        <ul className="portal-login__points">
          <li>
            <Icon name="check" size={14} />
            Attach screenshots or a screen recording
          </li>
          <li>
            <Icon name="check" size={14} />
            See where each request stands at a glance
          </li>
          <li>
            <Icon name="check" size={14} />
            Tell us whether the fix works for you
          </li>
        </ul>
      </section>
    </div>
  );
}
