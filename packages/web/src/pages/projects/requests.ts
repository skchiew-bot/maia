import { ApiError } from '../../api';

/**
 * PATCH for `/api/projects/:id` (the shared client has GET/POST/PUT/DELETE only). Same conventions as the
 * shared client: cookie session, the `X-Requested-With` marker, and the daemon's `{ error }` envelope as ApiError.
 */
export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'PATCH',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Requested-With': 'aoc-web' },
      body: JSON.stringify(body),
      credentials: 'include',
    });
  } catch (err) {
    throw new ApiError(0, 'network_error', 'Network request failed', err);
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    const error = (parsed as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
    throw new ApiError(
      res.status,
      error?.code ?? `http_${res.status}`,
      error?.message ?? (res.statusText || 'Request failed'),
      error?.details,
    );
  }
  return parsed as T;
}
