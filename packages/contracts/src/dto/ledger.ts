/** Build-ledger read models (owner: mod-ledger). Session hero = timeline strip; project = master timeline (§9, §12). */
import type { DecisionKind } from '../domain';
import type { DeclarePlanResult, EvidenceKind, TaskSize } from '../mcp';
import type { LessonInfo } from '../services';
import type { ProgressDTO } from './sessions';

export interface ProjectSummary {
  projectId: string;
  name: string;
  slug: string;
  repoPath: string | null;
  progress: ProgressDTO;
  activeSessions: number;
  openDecisions: number;
  lastActivityAt: string | null;
}

export interface ManifestTaskDTO {
  taskId: string;
  phaseId: string;
  title: string;
  acceptance?: string | null;
  size: TaskSize;
  weight: number;
  status: 'open' | 'done' | 'removed';
  declaredBy: string; // user id or session id (attribution)
  sessionId: string;
  doneAt: string | null;
  evidence: { kind: EvidenceKind; ref: string; verified: boolean } | null;
  flag: 'no_file_change' | 'evidence_unverified' | null;
  /** Set on a predecessor's copy (shown as open) when a successor writer in the same thread took the task over (rollover, §5). */
  carriedToSessionId?: string | null;
}
export interface ManifestPhaseDTO {
  phaseId: string;
  name: string;
  order: number;
  completedAt: string | null;
  pinnedSha: string | null;
  pinnedTag: string | null;
  tasks: ManifestTaskDTO[];
}
export interface AmendmentDTO {
  at: string;
  by: string;
  byName: string | null;
  sessionId: string;
  added: number;
  removed: number;
  resized: number;
  prevTotalWeight: number;
  newTotalWeight: number;
  reason: string;
}

export type TimelineMarkKind =
  | 'tool'
  | 'decision'
  | 'drift'
  | 'rollback'
  | 'enhancement'
  | 'phase_complete'
  | 'task_done'
  | 'throttle'
  | 'amendment';
export interface TimelineMark {
  kind: TimelineMarkKind;
  at: string;
  label: string;
  refId: string | null;
  severity: 'low' | 'medium' | 'high' | null;
}
export interface TimelinePhaseBand {
  phaseId: string;
  name: string;
  startAt: string;
  endAt: string | null;
  doneWeight: number;
  totalWeight: number;
}
export interface SessionTimeline {
  sessionId: string;
  startAt: string;
  endAt: string | null;
  now: string;
  phases: TimelinePhaseBand[];
  marks: TimelineMark[];
  progress: ProgressDTO;
  manifest: ManifestPhaseDTO[];
  amendments: AmendmentDTO[];
}

export interface ProjectTimeline {
  projectId: string;
  name: string;
  progress: ProgressDTO;
  /** Stacked per-phase segment bar: one segment per contributor (developer) per phase. */
  phases: {
    phaseId: string;
    name: string;
    order: number;
    doneWeight: number;
    totalWeight: number;
    completedAt: string | null;
    segments: { ownerId: string; ownerName: string | null; doneWeight: number; totalWeight: number }[];
  }[];
  amendments: AmendmentDTO[];
  manifest: ManifestPhaseDTO[];
}

export interface ThreadSummary {
  threadId: string;
  projectId: string;
  title: string;
  activeWriterSessionId: string | null;
  createdAt: string;
}
export interface ThreadWriterDTO {
  sessionId: string;
  acquiredAt: string;
  releasedAt: string | null;
  reason: 'ended' | 'rollover' | 'failed' | 'stopped' | null;
}
/** A durable thread (§5): sequential writer sessions; progress counts each carried-over task once. */
export interface ThreadDetail extends ThreadSummary {
  writers: ThreadWriterDTO[];
  /** The thread's sequential sessions, oldest first (writer history; manifests declared in it when the lock was never used). */
  sessionIds: string[];
  progress: ProgressDTO;
}

export interface ProjectDetail extends ProjectSummary {
  description: string | null;
  defaultBranch: string | null;
  createdAt: string;
  threads: ThreadSummary[];
}

export interface EnhancementDTO {
  eventId: string;
  projectId: string;
  sessionId: string | null;
  changeId: string | null;
  at: string;
  by: string;
  title: string;
  detail: string | null;
}

// ── MCP results the contracts do not define yet (candidates for mcp.ts) ──────
export interface DeclarePlanLedgerResult extends DeclarePlanResult {
  /** Open tasks of the previous writer in this thread taken over by re-declaring their ids. */
  carriedOver: number;
}
export interface AmendPlanResult {
  ok: true;
  manifestVersion: number;
  totalTasks: number;
  totalWeight: number;
  prevTotalWeight: number;
  added: number;
  removed: number;
  resized: number;
  carriedOver: number;
  phasesCompleted: { phaseId: string; pinnedRef: string | null }[];
}
export interface PlaybookStepResult {
  ok: true;
  stepId: string | null;
  /** Why this report deviates from the active playbook (recorded as drift), or null. */
  deviation: string | null;
}
export interface GetStatusResult {
  ok: true;
  sessionId: string;
  projectId: string | null;
  threadId: string | null;
  manifestVersion: number | null;
  manifest: ManifestPhaseDTO[];
  progress: ProgressDTO | null;
  boundary: { atBoundary: boolean; reason: string | null; openTasks: number };
  openDecisions: { decisionId: string; kind: DecisionKind; title: string; question: string; createdAt: string }[];
  lessons: LessonInfo[];
  playbook: { playbookId: string; title: string; steps: { id: string; title: string; state: 'started' | 'done' | 'failed' | 'skipped' | null }[] } | null;
}
