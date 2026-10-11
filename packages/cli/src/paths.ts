/**
 * Every daemon route and console link the CLI uses — kept in one file because the daemon routes are
 * built concurrently; fix names here after integration.
 */
import { UsageError } from './errors';

/** Encode an id as one path segment. "." / ".." (even percent-encoded) would be normalised away by URL parsing. */
function enc(id: string): string {
  if (id === '' || id === '.' || id === '..') throw new UsageError(`invalid id "${id}"`);
  return encodeURIComponent(id);
}

export const API_PATHS = {
  health: '/api/health',
  authMe: '/api/auth/me',
  console: '/api/console',
  sessions: '/api/sessions',
  session: (id: string) => `/api/sessions/${enc(id)}`,
  sessionOutput: (id: string) => `/api/sessions/${enc(id)}/output`,
  sessionPrompt: (id: string) => `/api/sessions/${enc(id)}/prompt`,
  sessionNudge: (id: string) => `/api/sessions/${enc(id)}/nudge`,
  sessionRestart: (id: string) => `/api/sessions/${enc(id)}/restart`,
  sessionStop: (id: string) => `/api/sessions/${enc(id)}/stop`,
  threadRollover: (threadId: string) => `/api/threads/${enc(threadId)}/rollover`,
  decisions: '/api/decisions',
  decisionResolve: (id: string) => `/api/decisions/${enc(id)}/resolve`,
  projects: '/api/projects',
  projectTimeline: (id: string) => `/api/projects/${enc(id)}/timeline`,
  auditVerify: '/api/audit/verify',
  auditAnchor: '/api/audit/anchor',
  auditBackup: '/api/audit/backup',
  auditBackups: '/api/audit/backups',
  evidencePacks: '/api/evidence/packs',
  evidencePackDownload: (packId: string) => `/api/evidence/packs/${enc(packId)}/download`,
  users: '/api/users',
  userTokens: (userId: string) => `/api/users/${enc(userId)}/tokens`,
  adminRedrive: (reactor: string) => `/api/admin/reactors/${enc(reactor)}/redrive`,
  adminRebuild: '/api/admin/projections/rebuild',
  adminRunJob: (job: string) => `/api/admin/jobs/${enc(job)}/run`,
} as const;

/** Query parameter names the CLI sends. */
export const API_QUERY = {
  sessionsProject: 'projectId',
  sessionsState: 'state',
  decisionsStatus: 'status',
} as const;

/** Operator-console routes (served by aocd), relative to the daemon origin. */
export const CONSOLE_PATHS = {
  session: (id: string) => `/sessions/${enc(id)}`,
  decision: (id: string) => `/decisions?id=${enc(id)}`,
} as const;

export function withQuery(path: string, query: Record<string, string | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== null && v !== undefined && v !== '') qs.set(k, v);
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}
