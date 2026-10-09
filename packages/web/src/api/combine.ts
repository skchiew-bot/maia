import type { ResourceState } from './useResource';

/**
 * One resource state over several (a widget built from more than one endpoint): data once every part has
 * loaded, the first error, busy while any part is refetching, and a reload that refetches them all.
 */
export function combine<T extends unknown[]>(
  ...states: { [K in keyof T]: ResourceState<T[K]> }
): ResourceState<T> {
  const parts = states as readonly ResourceState<unknown>[];
  return {
    data: parts.every((s) => s.data !== undefined) ? (parts.map((s) => s.data) as T) : undefined,
    error: parts.find((s) => s.error !== undefined)?.error,
    loading: parts.some((s) => s.loading),
    reload: () => parts.forEach((s) => s.reload()),
  };
}
