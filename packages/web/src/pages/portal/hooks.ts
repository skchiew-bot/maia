import type { IntakeLimits } from '@aoc/contracts';
import { useEffect, useRef } from 'react';
import { ROLE_LANDING, type AuthUser } from '../../api/auth';
import { isPortalPath, safeNextPath } from '../../api/client';
import { useResource } from '../../api/useResource';
import { useClock } from '../../lib/clock';
import { useLatest } from '../../lib/dom';
import { DEFAULT_LIMITS } from './uploads';

/** Gap that stops focus and visibility events fired together from refetching twice. */
export const RETURN_REFRESH_GAP_MS = 5000;

/**
 * The portal has no event stream (the operator stream refuses requesters), and it never polls: it refetches
 * when the requester comes back to the tab or window, and after their own actions.
 */
export function useRefreshOnReturn(reload: () => void, enabled = true): void {
  const clock = useClock();
  const reloadRef = useLatest(reload);
  const last = useRef(clock.now());
  useEffect(() => {
    if (!enabled) return undefined;
    const onReturn = () => {
      if (document.visibilityState === 'hidden') return;
      const now = clock.now();
      if (now - last.current < RETURN_REFRESH_GAP_MS) return;
      last.current = now;
      reloadRef.current();
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [clock, enabled, reloadRef]);
}

/** Upload rules as configured on the server; the defaults stand in until (or unless) they load. */
export function useIntakeLimits(enabled = true): IntakeLimits {
  return useResource<IntakeLimits>('/portal/api/limits', { enabled }).data ?? DEFAULT_LIMITS;
}

/** Who may use the requester portal: requesters, and Approvers for requests they file themselves. */
export function canUsePortal(user: AuthUser | null): boolean {
  return user?.role === 'requester' || user?.role === 'approver';
}

/**
 * Where portal sign-in continues: requesters stay inside the portal whatever `next` says; Builders, who file
 * nothing here, go to their console unless they were heading somewhere specific outside the portal.
 */
export function portalDestination(user: AuthUser, next: string | null): string {
  const target = safeNextPath(next, '/portal');
  if (user.role === 'requester') return isPortalPath(target.split(/[?#]/)[0]!) ? target : '/portal';
  if (user.role === 'builder') return isPortalPath(target.split(/[?#]/)[0]!) ? ROLE_LANDING.builder : target;
  return target;
}
