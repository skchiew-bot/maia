import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../../api/client';
import { useAuth, type AuthUser } from '../../api/auth';
import { Button, Checkbox, describeError, TextField } from '../../components';

export interface TokenSignInFormProps {
  /** Field label ("Access token" / "Access code"). */
  label: string;
  /** Help under the field. */
  hint?: ReactNode;
  /** Called with the signed-in user. */
  onSignedIn: (user: AuthUser) => void;
}

/**
 * Paste-token sign-in: `POST /api/auth/login {token}` sets the cookie session, then `/api/auth/me` loads the
 * user. The token is never stored by the page.
 */
export function TokenSignInForm({ label, hint, onSignedIn }: TokenSignInFormProps) {
  const { login } = useAuth();
  const [token, setToken] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const value = token.trim();
    if (!value) {
      setError(`Paste your ${label.toLowerCase()} to continue.`);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const user = await login(value);
      if (!user) {
        setError('Signed in, but your account could not be loaded. Try again.');
        return;
      }
      setToken('');
      onSignedIn(user);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setError(`That ${label.toLowerCase()} was not recognised. Check it and try again.`);
      } else {
        setError(describeError(err) ?? 'Sign-in failed. Try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="aoc-login__form" onSubmit={onSubmit} noValidate>
      <TextField
        label={label}
        hint={hint}
        error={error}
        required
        name="token"
        type={reveal ? 'text' : 'password'}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={token}
        onChange={(e) => setToken(e.target.value)}
      />
      <Checkbox label="Show what I pasted" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
      <Button type="submit" variant="primary" loading={busy} loadingText="Signing in…">
        Sign in
      </Button>
    </form>
  );
}
