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

/** The manifest phase a session is working in: the first phase (in plan order) with work left. */
export interface CurrentPhaseDTO {
  phaseId: string;
  name: string;
  /** 1-based position in the plan. */
  index: number;
  /** Phases in the plan. */
  count: number;
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
  /** From the plan manifest; null before a plan is declared or once every phase is done. */
  currentPhase?: CurrentPhaseDTO | null;
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
  /** Today's notional cost at today's stamped USD→MYR rate; null when today has no FX rate. */
  costTodayRm?: number | null;
  openDecision: { decisionId: string; kind: string; createdAt: string } | null;
  throttledUntil: string | null;
  lastActivityAt: string | null;
  startedAt: string;
  /** When session.ended was recorded (a crash alone leaves it unset: the session stays restartable). */
  endedAt?: string | null;
  /** session.ended outcome (completed / failed / killed / retired / abandoned); null while live. */
  outcome?: string | null;
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
  /** The local calendar day (configured timezone) behind every "today" figure, including ended sessions. */
  today?: string;
  kpis: ConsoleKpis;
  /** Live sessions, dead (failed) sessions awaiting a restart, then the sessions that ended today. */
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

/**
 * Whole-session activity behind the session hero (§12): tool calls per minute and plan-limit spans. Minutes
 * with no tool call are omitted, so gaps (decision waits, throttles) stay visible as gaps.
 */
export interface SessionActivityDTO {
  sessionId: string;
  /** Tool calls (completed and denied) per minute, oldest first; `at` is the start of the minute (UTC). */
  minutes: { at: string; count: number }[];
  totalToolCalls: number;
  /** Plan-limit episodes, oldest first. `endAt` and `idleMs` are null while the session is still throttled. */
  throttles: { startAt: string; endAt: string | null; resetAt: string | null; idleMs: number | null }[];
}

/** Operator transcript view (rendered output of the managed session; untrusted text — escape when rendering). */
export interface SessionOutputItem {
  at: string;
  kind: 'assistant_text' | 'tool_use' | 'tool_result' | 'user_prompt' | 'system' | 'result';
  text: string;
  toolName?: string;
}
