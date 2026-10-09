import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import type { ResourceState } from '../../api';

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

/**
 * Scrolls to the in-page section the URL hash names (KPI tiles link to sections; the router does not scroll to
 * hashes). Waits until every resource has settled so a deep link lands after the data has laid the page out.
 */
export function useSectionScroll(...states: readonly Pick<ResourceState<unknown>, 'data' | 'error'>[]): void {
  const { hash, key } = useLocation();
  const ready = states.every((s) => s.data !== undefined || s.error !== undefined);
  useEffect(() => {
    if (!hash || !ready) return;
    document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: 'start' });
  }, [hash, key, ready]);
}
