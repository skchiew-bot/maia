/**
 * Read models / DTOs for mod-registry: fixed process-type registry, playbooks (distillation engine),
 * registry economics (the Registry hero, §12) and the team knowledge layer (§14).
 */
import type { ModelTier, ProcessClass } from '../domain';
import type { ProcessType } from '../registry';

// ── fixed registry ─────────────────────────────────────────────────────────
export interface ProcessTypeView extends ProcessType {
  /** Model the supervisor launches this type with right now (`RegistryService.modelFor`). */
  currentModel: ModelTier;
  activePlaybookId: string | null;
}
export interface RegistryTypesResponse {
  /** `version` field of the registry file. */
  version: string;
  /** sha256 of the canonical JSON of the registry file (what `registry.changed` audits). */
  versionHash: string;
  types: ProcessTypeView[];
}

// ── playbooks ──────────────────────────────────────────────────────────────
export const PLAYBOOK_STATUSES = ['proposed', 'approved', 'rejected', 'retired'] as const;
export type PlaybookStatus = (typeof PLAYBOOK_STATUSES)[number];
/** How a playbook was distilled: LLM refinement of the run's candidate steps, or the deterministic fallback. */
export type DistillMethod = 'llm' | 'fallback';

export interface PlaybookStepDTO {
  id: string;
  title: string;
  detail?: string;
}
export interface PlaybookDTO {
  playbookId: string;
  processType: string;
  version: number;
  /** "[erased]" when the body was crypto-shredded. */
  title: string;
  steps: PlaybookStepDTO[];
  rationale: string | null;
  status: PlaybookStatus;
  /** The type's active playbook (latest approved, not retired, not erased): drives model routing. */
  active: boolean;
  method: DistillMethod;
  sourceSessionId: string | null;
  projectId: string | null;
  decisionId: string;
  proposedBy: string;
  proposedAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
  rejectedAt: string | null;
  rejectedBy: string | null;
  retiredAt: string | null;
  retireReason: string | null;
  erased: boolean;
}
export interface DistillResponse {
  playbook: PlaybookDTO;
  /** The `playbook_approval` decision (Approver gate) the proposal waits on. */
  decisionId: string;
  method: DistillMethod;
}
export const PLAYBOOK_RETIRE_REASONS = ['manual', 'obsolete', 'quality'] as const;
export type PlaybookRetireReason = (typeof PLAYBOOK_RETIRE_REASONS)[number];

// ── registry economics (Registry hero: the distillation business case) ─────
export type RunKind = 'discovery' | 'execution';
export interface RunCostSplit {
  /** Finished runs (rollover chains count once; any final outcome). */
  runs: number;
  /** Finished runs whose final outcome was `completed`. */
  completedRuns: number;
  /** Average notional USD per finished run; null when there are none. */
  avgCostUsd: number | null;
  totalCostUsd: number;
}
/** Per-run efficiency of one split (finished runs; rollover chains count once). */
export interface RunEfficiency {
  /** Mean metered tokens per finished run, every token type; null with no runs. */
  avgTokens: number | null;
  /** Mean wall-clock time per finished run, launch to final end (ms); null with no runs. */
  avgDurationMs: number | null;
}
/**
 * Distillation savings beyond USD. Ringgit converts each run's amount at the BNM rate of the local day the run
 * was launched and sums them (the daily-rollup rule) — never a USD total × today's rate.
 */
export interface RegistrySavings {
  /** realizedSavingsUsd in RM; null until both splits have runs, or when a contributing day has no rate. */
  realizedRm: number | null;
  /** opportunity.usd in RM; null without an execution path, or when a contributing day has no rate. */
  opportunityRm: number | null;
  /** execution runs × (discovery − execution) tokens per run; null until both splits have runs. Negative = more. */
  tokensSaved: number | null;
  /** execution runs × (discovery − execution) wall-clock ms per run; null until both splits have runs. */
  timeSavedMs: number | null;
}
export interface RegistryTrendPoint {
  /** Monday of the week (local timezone), YYYY-MM-DD. */
  weekStart: string;
  runs: number;
  discoveryRuns: number;
  executionRuns: number;
  /** Average cost per finished run launched that week; null for an empty week. */
  avgCostUsd: number | null;
  /** Runs that used tokens but cost US$0: no rate card priced their model that day (they pull the average down). */
  unpricedRuns: number;
}
export interface RegistryOpportunity {
  /**
   * Value of having a playbook for this type at its recent volume:
   * max(0, discovery $/run − execution $/run) × finished runs launched in the trend window.
   */
  usd: number;
  /** measured = real execution runs; projected = discovery $/run × rate ratio executionModel/model; none = no execution path. */
  basis: 'measured' | 'projected' | 'none';
  windowRuns: number;
  /** Execution $/run used for the opportunity (measured or projected). */
  executionCostUsd: number | null;
}
export interface RegistryPlaybookStatus {
  /** approved = an active playbook exists; proposed = awaiting the Approver; none otherwise. */
  status: 'none' | 'proposed' | 'approved';
  activePlaybookId: string | null;
  activeVersion: number | null;
  approvedAt: string | null;
  pendingPlaybookId: string | null;
  pendingDecisionId: string | null;
  /** Playbook versions ever proposed for the type. */
  versions: number;
}
export interface RegistryEntry {
  processType: string;
  name: string;
  description: string;
  class: ProcessClass;
  /** Discovery model (runs without an approved playbook; discovery-class always). */
  model: ModelTier;
  executionModel: ModelTier | null;
  /** `modelFor(type)` now — budget and credits never influence it. */
  currentModel: ModelTier;
  readOnly: boolean;
  risky: boolean;
  discovery: RunCostSplit;
  execution: RunCostSplit;
  /** Runs launched but not finished yet (excluded from the averages). */
  activeRuns: number;
  /** (discovery $/run − execution $/run) / discovery $/run × 100; null until both splits have runs. */
  savingsPct: number | null;
  /** execution runs × (discovery $/run − execution $/run); null until both splits have runs. */
  realizedSavingsUsd: number | null;
  opportunity: RegistryOpportunity;
  /** Tokens and wall-clock time per finished run, per split. */
  efficiency: { discovery: RunEfficiency; execution: RunEfficiency };
  savings: RegistrySavings;
  /** 8 weekly points, oldest → newest (the current, partial week last). */
  trend: RegistryTrendPoint[];
  playbook: RegistryPlaybookStatus;
  /** Lessons in scope for the type (learning service); null when unavailable. */
  lessonsInScope: number | null;
  /** Open repeat offences for the type; null until mod-learning exposes it. */
  openRepeatOffences: number | null;
  /** metered = MeteringService.sessionCostUsd; estimated = usage.recorded × default rates. */
  costBasis: 'metered' | 'estimated' | 'mixed' | 'none';
}

/** One managed run (a launch plus its rollover successors), as `GET /api/registry/runs` lists it. */
export interface RegistryRunDTO {
  /** Root session id: the run's identity. */
  runId: string;
  /** Latest session of the chain (open it, or distill from it). */
  lastSessionId: string;
  sessions: number;
  processType: string;
  projectId: string | null;
  /** Model id the run was launched with. */
  model: string;
  kind: RunKind;
  launchedAt: string;
  /** Final end; null while running. */
  endedAt: string | null;
  /** Final outcome (completed, failed, killed, …); null while running. */
  outcome: string | null;
  finished: boolean;
  costUsd: number;
  costBasis: 'metered' | 'estimated';
  tokens: number;
  durationMs: number | null;
  /** Playbook (proposed or approved) already distilled from this run. */
  playbookId: string | null;
}
export interface RegistryRunsResponse {
  runs: RegistryRunDTO[];
}

// ── team knowledge layer ───────────────────────────────────────────────────
export const KNOWLEDGE_KINDS = ['ticket', 'playbook', 'lesson', 'decision'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export interface KnowledgeRefs {
  ticketId?: string;
  playbookId?: string;
  lessonId?: string;
  decisionId?: string;
  sessionId?: string;
  projectId?: string;
  processType?: string;
}
/** A snippet fragment; `hit` marks matched terms. Render as text (never as HTML). */
export interface KnowledgeSnippetPart {
  text: string;
  hit: boolean;
}
export interface KnowledgeResult {
  docId: string;
  kind: KnowledgeKind;
  title: string;
  /** Plain-text snippet around the best match. */
  snippet: string;
  snippetParts: KnowledgeSnippetPart[];
  /** Relevance (higher is better): −bm25 with the title weighted over the body. */
  score: number;
  refs: KnowledgeRefs;
  /** When the knowledge was established (ticket closed, playbook approved, lesson bound, decision resolved). */
  date: string;
}
export interface KnowledgeSearchResponse {
  query: string;
  kind: KnowledgeKind | null;
  /** all = every term matched; any = no document matched all terms, so any-term matches are shown. */
  match: 'all' | 'any';
  results: KnowledgeResult[];
}
