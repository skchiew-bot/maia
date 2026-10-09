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

// ── Projects list roll-up and project history (console read models, §9) ─────
export interface ProjectPhaseRollup {
  phaseId: string;
  name: string;
  order: number;
  doneTasks: number;
  totalTasks: number;
  doneWeight: number;
  totalWeight: number;
  /** Done tasks closed with no file change or unverified evidence: they count until reviewed, shown flagged. */
  flaggedTasks: number;
  flaggedWeight: number;
  completedAt: string | null;
  pinnedTag: string | null;
  pinnedSha: string | null;
}
/** `GET /api/projects/rollup`: the master timeline of every project in one row each (Projects list). */
export interface ProjectRollup {
  projectId: string;
  phases: ProjectPhaseRollup[];
  /** First phase in manifest order with unfinished work; null when nothing is open. */
  currentPhaseId: string | null;
  drift: { total: number; last7d: number; highLast7d: number; lastAt: string | null };
  amendments: { count: number; last7d: number; lastAt: string | null };
}

/** One change to the project's denominator: a plan declared into the master timeline, or an amendment. */
export interface ScopeChangeDTO {
  seq: number;
  at: string;
  kind: 'declared' | 'amended';
  sessionId: string;
  /** Developer the work is attributed to (the session owner), when known. */
  ownerId: string | null;
  ownerName: string | null;
  manifestVersion: number;
  /** Tasks declared (declared) or added (amended). */
  added: number;
  removed: number;
  resized: number;
  /** Open tasks taken over from a previous writer of the thread: already counted, so not new scope (§5). */
  carriedOver: number;
  /** Change to the project's declared weight. */
  weightDelta: number;
  projectWeightBefore: number;
  projectWeightAfter: number;
  /** Amendment reason ("[erased]" once crypto-shredded); null for declarations. */
  reason: string | null;
}
export interface ProjectDriftDTO {
  seq: number;
  at: string;
  sessionId: string;
  kind: 'off_plan_change' | 'playbook_deviation' | 'scope_growth' | 'overrun';
  severity: 'low' | 'medium' | 'high';
  taskId: string | null;
  /** "[erased]" once crypto-shredded. */
  detail: string;
}
/** An immutable rollback point recorded by a phase completion (§8). */
export interface PhasePinDTO {
  phaseId: string;
  sessionId: string;
  tag: string | null;
  sha: string | null;
  at: string;
}
/** An enhancement with its recorder's display name (null when `by` is not a known user). */
export interface ProjectEnhancementDTO extends EnhancementDTO {
  byName: string | null;
}
/** `GET /api/projects/:id/history`: the marks behind the master timeline, oldest first. */
export interface ProjectHistory {
  projectId: string;
  scope: ScopeChangeDTO[];
  drift: ProjectDriftDTO[];
  enhancements: ProjectEnhancementDTO[];
  pins: PhasePinDTO[];
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
