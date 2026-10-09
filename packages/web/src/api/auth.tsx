import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { EmptyState, ErrorState } from '../components/EmptyState';
import { ApiError, apiGet, apiPost, loginPathFor } from './client';

/** The three roles of §6. Approver (CEO) holds the gates; Builder drives the operator surface; Requester files tickets. */
export type Role = 'approver' | 'builder' | 'requester';

export const ROLE_LABEL: Record<Role, string> = {
  approver: 'Approver',
  builder: 'Builder',
  requester: 'Requester',
};

/** Where each role lands after sign-in or on `/`: Approvers watch the Control Tower, Builders the Console. */
export const ROLE_LANDING: Record<Role, string> = {
  approver: '/tower',
  builder: '/console',
  requester: '/portal',
};

/** Roles allowed on the operator surface. Requesters only ever see the portal. */
export const OPERATOR_ROLES: readonly Role[] = ['approver', 'builder'];

export interface AuthUser {
  id: string;
  name: string;
  role: Role;
  /** Feature/permission flags from the daemon (e.g. passkey enrolled). */
  flags: Readonly<Record<string, boolean>>;
}

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'error';

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  /** Why the identity probe failed (status `error`: daemon unreachable, 5xx). */
  error: unknown;
  /** Re-reads `/api/auth/me`. */
  refresh: () => Promise<AuthUser | null>;
  /**
   * Exchanges a pasted bearer token for a cookie session (`POST /api/auth/login {token}`), then loads the user.
   * Throws ApiError (401 = token not recognised).
   */
  login: (token: string) => Promise<AuthUser | null>;
  /** Ends the cookie session. */
  logout: () => Promise<void>;
}

const ROLES: readonly Role[] = ['approver', 'builder', 'requester'];

/** Validates the `/api/auth/me` body. Flags may arrive as a list or a map. */
export function normalizeUser(raw: unknown): AuthUser | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const source = (r.user && typeof r.user === 'object' ? r.user : r) as Record<string, unknown>;
  const { id, name, role } = source;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof role !== 'string') return null;
  if (!(ROLES as readonly string[]).includes(role)) return null;
  const flags: Record<string, boolean> = {};
  if (Array.isArray(source.flags)) {
    for (const f of source.flags) if (typeof f === 'string') flags[f] = true;
  } else if (source.flags && typeof source.flags === 'object') {
    for (const [k, v] of Object.entries(source.flags)) flags[k] = v === true;
  }
  return { id, name, role: role as Role, flags };
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  children: ReactNode;
  /** Start from a known user without probing (tests, gallery). */
  initialUser?: AuthUser | null;
}

/** Loads the signed-in user from `/api/auth/me` once and shares it. */
export function AuthProvider({ children, initialUser }: AuthProviderProps) {
  const [status, setStatus] = useState<AuthStatus>(
    initialUser === undefined ? 'loading' : initialUser ? 'authenticated' : 'anonymous',
  );
  const [user, setUser] = useState<AuthUser | null>(initialUser ?? null);
  const [error, setError] = useState<unknown>(undefined);
  const probe = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++probe.current;
    try {
      const me = normalizeUser(await apiGet<unknown>('/api/auth/me', { redirectOn401: false }));
      if (id !== probe.current) return me;
      setUser(me);
      setError(undefined);
      setStatus(me ? 'authenticated' : 'anonymous');
      return me;
    } catch (err) {
      if (id !== probe.current) return null;
      setUser(null);
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setError(undefined);
        setStatus('anonymous');
      } else {
        setError(err);
        setStatus('error');
      }
      return null;
    }
  }, []);

  useEffect(() => {
    if (initialUser === undefined) void refresh();
  }, [initialUser, refresh]);

  const login = useCallback(
    async (token: string) => {
      await apiPost<unknown>('/api/auth/login', { token }, { redirectOn401: false });
      return refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    try {
      await apiPost<unknown>('/api/auth/logout', undefined, { redirectOn401: false });
    } finally {
      probe.current += 1;
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, error, refresh, login, logout }),
    [status, user, error, refresh, login, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** The auth state. Must be used under AuthProvider. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}

/** True when the signed-in user has `flag`. */
export function hasFlag(user: AuthUser | null | undefined, flag: string): boolean {
  return Boolean(user?.flags[flag]);
}

export interface RequireRoleProps {
  /** Roles allowed to see `children`. */
  roles: readonly Role[];
  children: ReactNode;
}

/**
 * Route guard. Anonymous → the surface's sign-in page (with `next`); a requester on an operator route → the
 * portal; any other role mismatch → a "not available for your role" notice. Server-side checks still apply —
 * this only keeps people out of views they cannot use.
 */
export function RequireRole({ roles, children }: RequireRoleProps) {
  const { status, user, error, refresh } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <p className="aoc-loading" role="status">
        Checking your session…
      </p>
    );
  }
  if (status === 'error') {
    return (
      <ErrorState
        title="Can't reach the AOC daemon"
        error={error}
        body="Your session could not be checked. The console needs the daemon to be running."
        onRetry={() => void refresh()}
      />
    );
  }
  if (!user) return <Navigate to={loginPathFor(location)} replace />;
  if (!roles.includes(user.role)) {
    if (user.role === 'requester' && !location.pathname.startsWith('/portal'))
      return <Navigate to="/portal" replace />;
    return (
      <EmptyState
        icon="compliance"
        title="Not available for your role"
        body={`This area needs the ${roles.map((r) => ROLE_LABEL[r]).join(' or ')} role. You are signed in as ${ROLE_LABEL[user.role]}.`}
      />
    );
  }
  return <>{children}</>;
}
