/** Session / console read models (owner: mod-sessions). Console hero = small-multiple APM sparklines (§12). */
import type { LivenessState, SessionLifecycle, SessionMode } from '../domain';

export interface LivenessDTO {
  state: LivenessState | null;
  reason: string;
  since: string;
}

export interface ApmSeries {
  windowMinutes: number;
  /** Per-minute action counts, oldest → newest (length = windowMinutes). Actions = tool calls + MCP calls. */
  points: number[];
  current: number;
}

export interface ProgressDTO {
  doneTasks: number;
  totalTasks: number;
  doneWeight: number;
  totalWeight: number;
  pct: number;
  flaggedTasks: number;
  etaMs: number | null;
  etaHiddenReason: 'fewer_than_3_done' | 'complete' | null;
}

export interface SessionSummary {
  sessionId: string;
  mode: SessionMode;
  title: string;
  projectId: string | null;
  projectName: string | null;
  threadId: string | null;
  phaseId: string | null;
  phaseName: string | null;
  processType: string | null;
  model: string | null;
  ownerId: string | null;
  ownerName: string | null;
  lifecycle: SessionLifecycle;
  liveness: LivenessDTO | null;
  apm: ApmSeries;
  progress: ProgressDTO | null;
  contextTokens: number | null;
  contextPct: number | null;
  costTodayUsd: number;
  openDecision: { decisionId: string; kind: string; createdAt: string } | null;
  throttledUntil: string | null;
  lastActivityAt: string | null;
  startedAt: string;
  ticketId: string | null;
}

export interface ConsoleKpis {
  activeSessions: number;
  waitingOnYou: number;
  oldestWaitingSince: string | null;
  throttled: number;
  throttleIdleMsToday: number;
  tasksDoneToday: number;
  tasksDoneWithEvidencePct: number;
  notionalUsdToday: number;
  notionalRmToday: number | null;
}

export interface ConsoleSnapshot {
  generatedAt: string;
  kpis: ConsoleKpis;
  sessions: SessionSummary[];
}

export interface SessionTokenRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  notionalUsd: number;
}

export interface SessionDetail extends SessionSummary {
  claudeSessionId: string | null;
  cwd: string | null;
  readOnly: boolean;
  turns: number;
  tokens: SessionTokenRow[];
  contextWindowTokens: number | null;
  predecessorSessionId: string | null;
  successorSessionId: string | null;
  /** Operator actions currently allowed for the viewer, with reasons when disabled. */
  actions: {
    nudge: { enabled: boolean; reason: string | null };
    restart: { enabled: boolean; reason: string | null };
    stop: { enabled: boolean; reason: string | null };
    rollover: { enabled: boolean; reason: string | null };
    prompt: { enabled: boolean; reason: string | null };
  };
}

/** Operator transcript view (rendered output of the managed session; untrusted text — escape when rendering). */
export interface SessionOutputItem {
  at: string;
  kind: 'assistant_text' | 'tool_use' | 'tool_result' | 'user_prompt' | 'system' | 'result';
  text: string;
  toolName?: string;
}
