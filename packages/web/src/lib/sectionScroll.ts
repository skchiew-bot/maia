import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import type { ResourceState } from '../api/useResource';

/** The element a URL hash names; null when there is none, no such element, or the escape sequence is malformed. */
function sectionOf(hash: string): HTMLElement | null {
  if (hash.length < 2) return null;
  try {
    return document.getElementById(decodeURIComponent(hash.slice(1)));
  } catch {
    return null;
  }
}

/**
 * Scrolls to the in-page section the URL hash names (KPI tiles and cross-page links such as `/metering#rate-card`;
 * the router does not scroll to hashes). Waits until every resource has settled, so a deep link lands after the
 * data has laid the page out, and runs again on each navigation to the same hash. Instant, never animated (§12).
 */
export function useSectionScroll(...states: readonly Pick<ResourceState<unknown>, 'data' | 'error'>[]): void {
  const { hash, key } = useLocation();
  const ready = states.every((s) => s.data !== undefined || s.error !== undefined);
  useEffect(() => {
    if (ready) sectionOf(hash)?.scrollIntoView?.({ block: 'start' });
  }, [hash, key, ready]);
}
