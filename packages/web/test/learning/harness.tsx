import { render } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AuthProvider, type AuthUser } from '../../src/api';
import { ToastProvider } from '../../src/components';
import { AppRoutes } from '../../src/routes';
import { jsonResponse, mockFetch } from '../helpers';

/** A request the page made: method, path with query, parsed JSON body. */
export interface Call {
  method: string;
  path: string;
  body: unknown;
}

export type Handler = (url: URL, body: unknown) => unknown;

/**
 * Routes fetch by `METHOD /path` (query ignored for matching) to JSON fixtures. Unrouted requests answer 404 so
 * a page hitting an unexpected endpoint shows up as a failure. The shell's inbox summary is always routed.
 */
export function routeFetch(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const all: Record<string, Handler> = {
    'GET /api/decisions/summary': () => ({
      generatedAt: '2026-10-09T05:00:00.000Z',
      open: 0,
      resolvableByMe: 0,
      oldestOpenAt: null,
      oldestResolvableByMeAt: null,
      byKind: {},
    }),
    ...routes,
  };
  const fn = mockFetch((raw, init) => {
    const url = new URL(raw, 'http://localhost');
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });
    const handler = all[`${method} ${url.pathname}`];
    if (!handler)
      return jsonResponse(
        { error: { code: 'not_mocked', message: `${method} ${url.pathname}` } },
        { status: 404 },
      );
    const out = handler(url, body);
    return out instanceof Response ? out : jsonResponse(out);
  });
  return { fn, calls };
}

function Location() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname + l.search}</output>;
}

/** The real app routes (operator shell, lazy pages, event stream) at `path`, signed in as `user`. */
export function renderAt(path: string, user: AuthUser) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider initialUser={user}>
        <ToastProvider>
          <AppRoutes />
          <Location />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

export const APPROVER: AuthUser = { id: 'usr_ceo', name: 'Chiew Sin Kwang', role: 'approver', flags: {} };
export const BUILDER: AuthUser = { id: 'usr_priya', name: 'Priya Nair', role: 'builder', flags: {} };
