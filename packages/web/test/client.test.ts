import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  loginPathFor,
  safeNextPath,
  setUnauthorizedHandler,
} from '../src/api/client';
import { jsonResponse, mockFetch } from './helpers';

describe('api client', () => {
  let restoreHandler: () => void;
  const onUnauthorized = vi.fn();

  beforeEach(() => {
    onUnauthorized.mockReset();
    restoreHandler = setUnauthorizedHandler(onUnauthorized);
    window.history.replaceState(null, '', '/console');
  });
  afterEach(() => {
    restoreHandler();
    vi.unstubAllGlobals();
  });

  it('GETs JSON with cookie credentials and a CSRF-friendly header', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ ok: true }));
    await expect(
      apiGet<{ ok: boolean }>('/api/projects', { query: { limit: 20, cursor: undefined, open: true } }),
    ).resolves.toEqual({
      ok: true,
    });
    const [url, init = {}] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/projects?limit=20&open=true');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('include');
    expect(init.body).toBeUndefined();
    expect(init.headers).toMatchObject({ Accept: 'application/json', 'X-Requested-With': 'aoc-web' });
  });

  it('sends JSON bodies for POST and PUT, and handles 204', async () => {
    const fetchMock = mockFetch((_url, init) =>
      init.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : jsonResponse({ echoed: JSON.parse(String(init.body)) }),
    );
    await expect(apiPost('/api/decisions/1/approve', { note: 'ok' })).resolves.toEqual({
      echoed: { note: 'ok' },
    });
    expect(fetchMock.mock.calls[0]![1]?.headers).toMatchObject({ 'Content-Type': 'application/json' });
    await expect(apiPut('/api/x', { a: 1 })).resolves.toEqual({ echoed: { a: 1 } });
    await expect(apiDelete('/api/x')).resolves.toBeUndefined();
  });

  it('turns error bodies into ApiError with status, code and message', async () => {
    mockFetch(() =>
      jsonResponse({ error: { code: 'gate_closed', message: 'Fix plan not approved' } }, { status: 409 }),
    );
    const err = await apiGet('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'gate_closed', message: 'Fix plan not approved' });

    mockFetch(() => jsonResponse({ code: 'flat', message: 'Flat shape' }, { status: 422 }));
    await expect(apiGet('/api/x')).rejects.toMatchObject({
      status: 422,
      code: 'flat',
      message: 'Flat shape',
    });

    mockFetch(() => new Response('<html>oops</html>', { status: 502, statusText: 'Bad Gateway' }));
    await expect(apiGet('/api/x')).rejects.toMatchObject({
      status: 502,
      code: 'http_502',
      message: 'Bad Gateway',
    });
  });

  it('reports network failures and non-JSON success bodies as ApiError', async () => {
    mockFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(apiGet('/api/x')).rejects.toMatchObject({ status: 0, code: 'network_error' });
    mockFetch(() => new Response('<!doctype html>', { status: 200 }));
    await expect(apiGet('/api/x')).rejects.toMatchObject({ status: 200, code: 'invalid_json' });
  });

  it('passes aborts through untouched', async () => {
    mockFetch(() => {
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(apiGet('/api/x')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('on 401 sends operators to /login with a way back', async () => {
    mockFetch(() =>
      jsonResponse({ error: { code: 'unauthenticated', message: 'Sign in' } }, { status: 401 }),
    );
    window.history.replaceState(null, '', '/sessions/ses_1?tab=tasks');
    await expect(apiGet('/api/sessions/ses_1')).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledWith('/login?next=%2Fsessions%2Fses_1%3Ftab%3Dtasks');
  });

  it('on 401 inside the portal sends requesters to /portal/login', async () => {
    mockFetch(() => jsonResponse({}, { status: 401 }));
    window.history.replaceState(null, '', '/portal/tickets/7');
    await expect(apiGet('/api/portal/tickets/7')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledWith('/portal/login?next=%2Fportal%2Ftickets%2F7');
  });

  it('lets callers handle 401 themselves (auth probe, login form)', async () => {
    mockFetch(() => jsonResponse({}, { status: 401 }));
    await expect(apiGet('/api/auth/me', { redirectOn401: false })).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('builds login paths without loops and only accepts same-origin next paths', () => {
    expect(loginPathFor({ pathname: '/login', search: '' })).toBe('/login');
    expect(loginPathFor({ pathname: '/portal/login', search: '' })).toBe('/portal/login');
    expect(loginPathFor({ pathname: '/portal', search: '' })).toBe('/portal/login?next=%2Fportal');
    expect(loginPathFor({ pathname: '/portalish', search: '' })).toBe('/login?next=%2Fportalish');
    expect(safeNextPath('/tower', '/console')).toBe('/tower');
    for (const bad of [
      '//evil.example',
      'https://evil.example',
      '/\\evil',
      'javascript:alert(1)',
      '',
      null,
      undefined,
    ]) {
      expect(safeNextPath(bad, '/console')).toBe('/console');
    }
  });
});
