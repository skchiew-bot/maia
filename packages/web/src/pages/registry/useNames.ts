import { useMemo } from 'react';
import type { IdentityUserDto, SessionSummary } from '@aoc/contracts';
import { useAuth } from '../../api/auth';
import { useResource } from '../../api/useResource';

/**
 * Display names for the user ids FinOps DTOs carry (proposers, approvers, grant approvers). Approvers read the
 * user list; other roles learn names from session owners, and the user list is never requested by a role that
 * cannot read it (no refused requests on load).
 */
export function useNames(): (userId: string | null | undefined) => string | null {
  const { user } = useAuth();
  const users = useResource<{ users: IdentityUserDto[] }>(user?.role === 'approver' ? '/api/users' : null, {
    refreshOn: (m) => m.kind === 'aoc' && m.event.type.startsWith('user.'),
  });
  const sessions = useResource<SessionSummary[]>('/api/sessions', {
    refreshOn: (m) => m.kind === 'aoc' && m.event.type === 'session.launch_requested',
  });
  return useMemo(() => {
    const names = new Map<string, string>();
    for (const s of sessions.data ?? []) if (s.ownerId && s.ownerName) names.set(s.ownerId, s.ownerName);
    for (const u of users.data?.users ?? []) names.set(u.id, u.name);
    if (user) names.set(user.id, user.name);
    return (id) => (id ? (names.get(id) ?? null) : null);
  }, [users.data, sessions.data, user]);
}
