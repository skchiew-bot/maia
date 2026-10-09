/**
 * Reads for the Projects area. Every resource refreshes only when a matching event arrives on the stream
 * (no polling); project-scoped events for other projects are ignored.
 */
import { useMemo } from 'react';
import type {
  ChangeRequestDTO,
  DecisionListResponse,
  MeteringSummaryDTO,
  PlaybookDTO,
  ProjectDetail,
  ProjectHistory,
  ProjectRollup,
  ProjectSummary,
  ProjectTimeline,
  RegistryTypesResponse,
  RollbackDTO,
  SessionSummary,
  ThreadDetail,
} from '@aoc/contracts';
import { useResource, type ResourceState, type StreamMessage } from '../../api';
import { useNow } from '../../lib/clock';
import { lastSevenDays } from './model';

/**
 * Stream predicate: aoc events whose type starts with one of `prefixes` (and, with `projectId`, that are not
 * scoped to another project); `liveness` also accepts liveness messages.
 */
export function eventsMatching(
  prefixes: readonly string[],
  opts: { projectId?: string; liveness?: boolean } = {},
): (msg: StreamMessage) => boolean {
  return (msg) => {
    if (msg.kind === 'liveness') return Boolean(opts.liveness);
    const { type, scope } = msg.event;
    if (!prefixes.some((p) => type.startsWith(p))) return false;
    return !opts.projectId || !scope.projectId || scope.projectId === opts.projectId;
  };
}

const PROGRESS_EVENTS = ['plan.', 'task.', 'phase.'];
const SESSION_EVENTS = ['session.', 'throttle.', 'decision.'];

export const refreshProjects = eventsMatching(['project.', 'thread.', ...PROGRESS_EVENTS, ...SESSION_EVENTS], {
  liveness: true,
});
export const refreshRollups = eventsMatching(['project.', 'drift.', ...PROGRESS_EVENTS]);
export const refreshSessions = eventsMatching([...SESSION_EVENTS, ...PROGRESS_EVENTS, 'usage.'], {
  liveness: true,
});
const refreshSpend = eventsMatching(['usage.', 'rollup.', 'ratecard.', 'fx.']);

/** Sessions that can be on a live mix; ended and retired history stays on the project page only. */
const LIVE_MIX_STATES = 'launching,running,idle,waiting_decision,blocked,throttled,failed';

export interface SpendRange {
  from: string;
  to: string;
}

/** Notional spend per project over the trailing seven days (§10: notional API-equivalent, never a bill). */
export function useSpend7d(): { range: SpendRange; resource: ResourceState<MeteringSummaryDTO> } {
  const now = useNow();
  const { from, to } = lastSevenDays(now);
  const range = useMemo(() => ({ from, to }), [from, to]);
  const resource = useResource<MeteringSummaryDTO>('/api/metering/summary', {
    query: { groupBy: 'project', from, to },
    refreshOn: refreshSpend,
  });
  return { range, resource };
}

export function useProjectsList() {
  return {
    summaries: useResource<ProjectSummary[]>('/api/projects', { refreshOn: refreshProjects }),
    rollups: useResource<ProjectRollup[]>('/api/projects/rollup', { refreshOn: refreshRollups }),
    sessions: useResource<SessionSummary[]>('/api/sessions', {
      query: { state: LIVE_MIX_STATES },
      refreshOn: refreshSessions,
    }),
    spend: useSpend7d(),
  };
}

export function useProjectData(projectId: string) {
  const scoped = (prefixes: readonly string[], liveness = false) =>
    eventsMatching(prefixes, { projectId, liveness });
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  return {
    detail: useResource<ProjectDetail>(base, {
      refreshOn: scoped(['project.', 'thread.', ...PROGRESS_EVENTS, ...SESSION_EVENTS], true),
    }),
    timeline: useResource<ProjectTimeline>(`${base}/timeline`, { refreshOn: scoped(PROGRESS_EVENTS) }),
    history: useResource<ProjectHistory>(`${base}/history`, {
      refreshOn: scoped(['plan.', 'phase.', 'drift.', 'enhancement.']),
    }),
    sessions: useResource<SessionSummary[]>('/api/sessions', {
      query: { projectId },
      refreshOn: scoped([...SESSION_EVENTS, ...PROGRESS_EVENTS, 'usage.'], true),
    }),
    decisions: useResource<DecisionListResponse>('/api/decisions', {
      query: { projectId, status: 'open' },
      refreshOn: scoped(['decision.']),
    }),
    changes: useResource<{ items: ChangeRequestDTO[] }>('/api/changes', {
      query: { projectId },
      refreshOn: scoped(['change.', 'breakglass.']),
    }),
    rollbacks: useResource<{ items: RollbackDTO[] }>('/api/rollbacks', {
      query: { projectId },
      refreshOn: scoped(['rollback.']),
    }),
    registry: useResource<RegistryTypesResponse>('/api/registry/process-types', {
      refreshOn: eventsMatching(['registry.', 'playbook.']),
    }),
    playbooks: useResource<PlaybookDTO[]>('/api/playbooks', { refreshOn: eventsMatching(['playbook.']) }),
    spend: useSpend7d(),
  };
}

/** One resource per thread: rendered by a component per thread, so the hook count stays fixed. */
export function useThread(threadId: string, projectId: string): ResourceState<ThreadDetail> {
  return useResource<ThreadDetail>(`/api/threads/${encodeURIComponent(threadId)}`, {
    refreshOn: eventsMatching(['thread.', 'session.rollover', 'plan.', 'task.'], { projectId }),
  });
}
