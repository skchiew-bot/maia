import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Router links such as `/metering#rate-card` or a KPI's `#throttle` change the hash without the browser's own
 * jump. Scroll the target into view once it exists (`ready`), instantly: no animated scrolling (§12).
 */
export function useHashScroll(ready: boolean): void {
  const { hash } = useLocation();
  useEffect(() => {
    if (!ready || !hash) return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    el?.scrollIntoView?.({ block: 'start' });
  }, [hash, ready]);
}
