/** Build-ledger read models (owner: mod-ledger). Session hero = timeline strip; project = master timeline (§9, §12). */
import type { TaskSize, EvidenceKind } from '../mcp';
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
  size: TaskSize;
  weight: number;
  status: 'open' | 'done' | 'removed';
  declaredBy: string; // user id or session id (attribution)
  sessionId: string;
  doneAt: string | null;
  evidence: { kind: EvidenceKind; ref: string; verified: boolean } | null;
  flag: 'no_file_change' | 'evidence_unverified' | null;
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
