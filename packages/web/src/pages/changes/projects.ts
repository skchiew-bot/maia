import { useMemo } from 'react';
import type { ProjectSummary } from '@aoc/contracts';
import { useResource } from '../../api/useResource';

export interface ProjectIndex {
  projects: readonly ProjectSummary[];
  nameOf(projectId: string | null | undefined): string;
  loaded: boolean;
}

const NONE: readonly ProjectSummary[] = [];

/** Project names for the governance pages (ids are what the change and audit APIs carry). */
export function useProjects(): ProjectIndex {
  const res = useResource<ProjectSummary[]>('/api/projects', {
    refreshOn: (m) => m.kind === 'aoc' && m.event.type.startsWith('project.'),
  });
  const projects = res.data ?? NONE;
  const loaded = res.data !== undefined;
  return useMemo(() => {
    const byId = new Map(projects.map((p) => [p.projectId, p.name]));
    return {
      projects: [...projects].sort((a, b) => a.name.localeCompare(b.name)),
      nameOf: (id) => (id ? (byId.get(id) ?? id) : '—'),
      loaded,
    };
  }, [projects, loaded]);
}
