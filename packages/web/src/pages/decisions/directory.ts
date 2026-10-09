import { useMemo } from 'react';
import type { IdentityUserDto, ProjectSummary, SessionSummary } from '@aoc/contracts';
import { useAuth } from '../../api/auth';
import { useResource } from '../../api/useResource';
import type { PeopleLookup } from './model';

export interface Directory extends PeopleLookup {
  session(id: string | null | undefined): SessionSummary | null;
  projectName(id: string | null | undefined): string | null;
}

/**
 * Names for the ids decision cards and tickets carry. Approvers read the user list; everyone else learns names
 * from session owners (the transparent team console, §6). The user list is never requested by a role that
 * cannot read it, so the page loads without a refused request.
 */
export function useDirectory(): Directory {
  const { user } = useAuth();
  const users = useResource<{ users: IdentityUserDto[] }>(user?.role === 'approver' ? '/api/users' : null);
  const sessions = useResource<SessionSummary[]>('/api/sessions', {
    refreshOn: (m) => m.kind === 'aoc' && m.event.type === 'session.launch_requested',
  });
  const projects = useResource<ProjectSummary[]>('/api/projects');

  return useMemo<Directory>(() => {
    const names = new Map<string, string>();
    for (const s of sessions.data ?? []) if (s.ownerId && s.ownerName) names.set(s.ownerId, s.ownerName);
    for (const u of users.data?.users ?? []) names.set(u.id, u.name);
    if (user) names.set(user.id, user.name);
    const sessionMap = new Map((sessions.data ?? []).map((s) => [s.sessionId, s]));
    const projectMap = new Map((projects.data ?? []).map((p) => [p.projectId, p.name]));
    const approvers = users.data
      ? users.data.users.filter((u) => u.active && u.role === 'approver').length
      : null;
    return {
      nameOf: (id) => names.get(id) ?? null,
      activeApprovers: approvers,
      session: (id) => (id ? (sessionMap.get(id) ?? null) : null),
      projectName: (id) => (id ? (projectMap.get(id) ?? null) : null),
    };
  }, [users.data, sessions.data, projects.data, user]);
}
