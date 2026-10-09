/**
 * Cross-module service interfaces (lead-owned). Modules depend on these interfaces, never on each
 * other's implementations. Each module registers its implementation with the kernel service registry.
 */
import type { DecisionCard, DecisionRequestInput, DecisionResolveInput } from './decisions';
import type { ChangeScope, LivenessState, ModelTier, Role, SessionLifecycle, SessionMode } from './domain';
import type { AnchorDTO, AuditHealthDTO, BackupDTO, VerifyReportDTO } from './dto/audit';
import type { Actor, EventSource, JsonValue } from './envelope';
import type { BoundaryInstruction } from './mcp';
import type { Progress } from './progress';
import type { ProcessType } from './registry';
import type { Permission, UserFlags } from './roles';

// ── identity ────────────────────────────────────────────────────────────────
export interface User {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  flags: UserFlags;
  active: boolean;
}
export interface AuthContext {
  user: User;
  tokenId: string;
  method: 'bearer' | 'cookie';
}
export type IngestPrincipal =
  | { kind: 'session'; sessionId: string; tokenId: string }
  | { kind: 'observer'; tokenId: string }
  | { kind: 'system'; tokenId: string };

export interface IdentityService {
  /** Resolve a bearer token or cookie session to a user (null if invalid/revoked/expired). */
  authenticate(token: string): AuthContext | null;
  getUser(id: string): User | null;
  listUsers(): User[];
  can(user: User, perm: Permission): boolean;
  /** Per-session ingest token (supervisor issues at launch; revoked when the session ends). */
  issueIngestToken(sessionId: string, actor: Actor): string;
  revokeIngestTokensFor(sessionId: string, actor: Actor): void;
  verifyIngestToken(token: string): IngestPrincipal | null;
  /**
   * Verify a WebAuthn assertion for a specific decision. The challenge was bound to
   * (decisionId, optionId, user) by `passkeyChallenge`; returns false on any mismatch.
   */
  verifyDecisionPasskey(input: { userId: string; decisionId: string; optionId: string; assertion: unknown }): Promise<boolean>;
}

// ── sessions directory (mod-sessions) ──────────────────────────────────────
export interface SessionInfo {
  sessionId: string;
  mode: SessionMode;
  claudeSessionId: string | null;
  ownerId: string | null; // user who launched (managed) — null for observed sessions without a mapped user
  projectId: string | null;
  threadId: string | null;
  processType: string | null;
  model: string | null;
  readOnly: boolean;
  lifecycle: SessionLifecycle;
  liveness: LivenessState | null;
  cwd: string | null;
  ticketId: string | null;
  startedAt: string;
}
export interface SessionDirectory {
  get(sessionId: string): SessionInfo | null;
  byClaudeSessionId(claudeSessionId: string): SessionInfo | null;
  list(filter?: { projectId?: string; lifecycle?: SessionLifecycle[]; mode?: SessionMode }): SessionInfo[];
  /** Latest context size (tokens) reported for the session. */
  contextTokens(sessionId: string): number;
}

// ── liveness (mod-sessions) ────────────────────────────────────────────────
export interface LivenessService {
  get(sessionId: string): { state: LivenessState | null; reason: string; since: string } | null;
  /** Recompute now (e.g. after a lifecycle change); appends session.liveness_changed on change. */
  refresh(sessionId: string): void;
  /** In-process signals from the supervisor (stream-json deltas, process start/exit). Not chained. */
  recordActivity(sessionId: string, kind: 'stream' | 'transcript' | 'tool', atMs: number): void;
  recordProcess(sessionId: string, alive: boolean, pid: number | null): void;
}

// ── policy guards (PreToolUse) ─────────────────────────────────────────────
export interface PreToolContext {
  session: SessionInfo;
  mode: SessionMode;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
}
export interface GuardResult {
  decision: 'allow' | 'deny' | 'ask';
  /** Machine label of the guard ("no-manifest", "protected-op", "read-only", "self-modification"). */
  guard: string;
  /** Shown to the agent (stderr / permissionDecisionReason). */
  reason: string;
  /** When set, the denial is turned into a decision card (§2.4: the hook's job is to turn an attempt into a decision card). */
  raiseDecision?: Omit<DecisionRequestInput, 'requesterId'>;
  blockReason?: 'no_manifest' | 'read_only' | 'self_modification' | 'protected_operation';
}
export interface PreToolGuard {
  name: string;
  /** Lower runs first. */
  order: number;
  /** Return null to abstain. Guards are advisory for observed sessions (never block). */
  evaluate(ctx: PreToolContext): GuardResult | null;
}
export interface PolicyService {
  register(guard: PreToolGuard): void;
  /** First deny wins; otherwise allow. */
  evaluate(ctx: PreToolContext): GuardResult;
}

// ── decisions (mod-decisions) ──────────────────────────────────────────────
export interface DecisionListFilter {
  status?: DecisionCard['status'][];
  kind?: DecisionCard['kind'][];
  sessionId?: string;
  projectId?: string;
  subjectId?: string;
  /** Only decisions this user may resolve. */
  resolvableBy?: User;
  limit?: number;
}
export interface DecisionService {
  request(input: DecisionRequestInput, actor: Actor): DecisionCard;
  /** Validates role, separation of duties, eligibility and passkey; appends decision.resolved. */
  resolve(id: string, input: DecisionResolveInput, user: User): Promise<DecisionCard>;
  /** System/policy resolution (e.g. 25%-once credit auto-grant) — recorded with method 'policy'. */
  resolveByPolicy(id: string, optionId: string, actor: Actor, comment?: string): DecisionCard;
  withdraw(id: string, reason: string, actor: Actor): DecisionCard;
  get(id: string): DecisionCard | null;
  list(filter?: DecisionListFilter): DecisionCard[];
  canResolve(card: DecisionCard, user: User): { ok: boolean; reason: string | null };
  /** Raise a Builder-level card to the Approver — never back to the requester (§6). */
  escalate(id: string, input: { toRole?: Role; reason?: string }, actor: Actor): DecisionCard;
  /** Counts for the inbox/tab badge for this viewer. */
  summary(user: User): { open: number; resolvableByMe: number; oldestOpenAt: string | null; oldestResolvableByMeAt: string | null };
}

// ── ledger (mod-ledger) ────────────────────────────────────────────────────
export interface ThreadInfo {
  threadId: string;
  projectId: string;
  title: string;
  activeWriterSessionId: string | null;
}
export interface HandoffBrief {
  threadId: string;
  projectId: string;
  fromSessionId: string;
  text: string;
  openTaskIds: string[];
  openDecisionIds: string[];
  filePointers: string[];
  hash: string;
}
export interface LedgerService {
  hasManifest(sessionId: string): boolean;
  /** Is the session at a clean task boundary (no task half-done, no risky playbook step in progress)? */
  boundaryState(sessionId: string): { atBoundary: boolean; reason: string | null; openTasks: number };
  sessionProgress(sessionId: string): Progress | null;
  projectProgress(projectId: string): Progress | null;
  getThread(threadId: string): ThreadInfo | null;
  /** Create a project/thread if missing (used by the supervisor at launch). */
  ensureThread(input: { projectId: string; threadId?: string | null; title?: string }, actor: Actor): ThreadInfo;
  /** Single active writer per thread (§5). Returns false if another live writer holds it. */
  acquireWriter(threadId: string, sessionId: string, actor: Actor): boolean;
  releaseWriter(threadId: string, sessionId: string, reason: 'ended' | 'rollover' | 'failed' | 'stopped', actor: Actor): void;
  buildHandoffBrief(threadId: string, fromSessionId: string): HandoffBrief;
  validateBrief(brief: HandoffBrief): { ok: boolean; problems: string[] };
  projectRepoPath(projectId: string): string | null;
}

// ── credits (mod-credits) ──────────────────────────────────────────────────
export interface CreditBalance {
  userId: string;
  period: string; // YYYY-MM
  allocationUsd: number;
  grantedUsd: number;
  usedUsd: number;
  balanceUsd: number;
  autoGrantUsed: boolean;
  pendingTopupRequestId: string | null;
  exempt: boolean;
}
export interface CreditService {
  /** Called ONLY at task boundaries (task_done, launch). Never interrupts mid-task (R7). */
  checkBoundary(sessionId: string, taskId: string | null, actor: Actor): BoundaryInstruction;
  balance(userId: string, period?: string): CreditBalance;
}

// ── metering (mod-metering) ────────────────────────────────────────────────
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}
export interface MeteringService {
  /** Notional API-equivalent cost in USD using the rate card effective on `date` (YYYY-MM-DD). */
  notionalCostUsd(model: string, usage: UsageTotals, date: string): number;
  /** USD→MYR for a date (carried forward if needed); null when no rate exists yet. */
  fxRate(date: string): { rate: number; status: 'live' | 'inherited'; sourceDate: string } | null;
  sessionCostUsd(sessionId: string): number;
  activeRateCardVersion(date: string): number;
}

// ── FX (mod-fx) ────────────────────────────────────────────────────────────
export interface FxService {
  rateFor(date: string): { rate: number; status: 'live' | 'inherited'; sourceDate: string } | null;
}

// ── supervisor ─────────────────────────────────────────────────────────────
export interface LaunchRequest {
  processType: string;
  projectId: string;
  threadId?: string | null;
  phaseId?: string | null;
  prompt: string;
  cwd?: string | null;
  ticketId?: string | null;
  parentSessionId?: string | null;
  /** For rollover: brief injected as the opening context. */
  brief?: string | null;
}
export interface SupervisorService {
  launch(req: LaunchRequest, actor: Actor): Promise<{ sessionId: string }>;
  /** Resume a session that ended its turn, injecting text (decision answer, top-up, operator prompt). */
  resume(sessionId: string, injectedText: string, reason: 'decision_answered' | 'topup' | 'throttle_reset' | 'operator_prompt' | 'continue', actor: Actor): Promise<void>;
  /** Nudge = end the current turn and resume with operator text. */
  nudge(sessionId: string, text: string, actor: Actor): Promise<void>;
  restart(sessionId: string, actor: Actor): Promise<void>;
  stop(sessionId: string, immediate: boolean, actor: Actor, reason?: string): Promise<void>;
  rollover(threadId: string, actor: Actor): Promise<{ newSessionId: string } | { refused: string[] }>;
  isRunning(sessionId: string): boolean;
  /** Operator asked for a stop at the next task boundary (task_done returns stop_requested). */
  stopRequested(sessionId: string): boolean;
  /** Run a command in a supervisor-controlled environment (rollback verification, promotion). Never exposed to agents. */
  runIsolated(input: { cwd: string; command: string[]; credentialProfile: string | null; timeoutMs: number; env?: Record<string, string> }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

// ── registry (mod-registry) ────────────────────────────────────────────────
export interface PlaybookInfo {
  playbookId: string;
  processType: string;
  version: number;
  title: string;
  steps: { id: string; title: string; detail?: string }[];
  status: 'proposed' | 'approved' | 'rejected' | 'retired';
}
export interface RegistryService {
  listTypes(): ProcessType[];
  getType(id: string): ProcessType | null;
  activePlaybook(processType: string): PlaybookInfo | null;
  /** Model the supervisor must launch with (discovery-on-Opus rule, §10/R8). */
  modelFor(processType: string): ModelTier;
}

// ── learning (mod-learning) ────────────────────────────────────────────────
export interface LessonInfo {
  lessonId: string;
  scopeType: 'process_type' | 'code_area';
  scopeValue: string;
  rule: string;
  fix: string;
}
export interface LearningService {
  lessonsForScope(scope: { processType: string; codeAreas?: string[] }): LessonInfo[];
  recordLessonsApplied(lessonIds: string[], sessionId: string, actor: Actor): void;
  recordError(input: {
    source: 'tool' | 'test' | 'uat' | 'rollback' | 'hook' | 'agent_report' | 'ci';
    sessionId?: string | null;
    projectId?: string | null;
    message: string;
    context?: string;
    fix?: string;
    rootCauseClass?: string | null;
    codeArea?: string | null;
    priority?: 'normal' | 'high';
  }, actor: Actor): void;
}

// ── change control (mod-change) ────────────────────────────────────────────
export interface ChangeService {
  /** Provenance check: every commit between main and `sha` traces to an approved change + UAT + gate. */
  provenance(projectId: string, sha: string): { ok: boolean; orphanShas: string[]; reasons: string[] };
  createDraft(input: { projectId: string; scope: ChangeScope; title: string; sessionId?: string | null; breakglassId?: string | null }, actor: Actor): Promise<{ changeId: string }>;
  /** Provenance check then a passkey go-live decision; promotion.completed follows approval (meta carries ticketId). */
  requestPromotion(
    input: { projectId: string; fromRef: string; ticketId?: string | null; changeId?: string | null },
    actor: Actor,
  ): Promise<{ promotionId: string; decisionId: string | null; refused: string[] | null }>;
}

// ── audit (mod-audit) ──────────────────────────────────────────────────────
export interface AuditService {
  /**
   * Verify-against-anchor (§13, R2): recompute the whole chain in chunks (the event loop keeps serving) and test it
   * against every off-host anchor record and its proof. Serialised with anchoring. With `record`, the run is appended
   * as chain.verified and a failure raises an `audit.integrity` notification; without it nothing is written.
   */
  verify(record?: { actor: Actor; source: EventSource }): Promise<VerifyReportDTO>;
  /** Newest anchor recorded in the chain (null = never anchored). */
  lastAnchor(): AnchorDTO | null;
  /** Newest completed encrypted backup (null = never; G-21). */
  lastBackup(): BackupDTO | null;
  /** Integrity summary from the read models; never recomputes the chain, so it is cheap enough for dashboards. */
  health(): AuditHealthDTO;
}

// ── git (kernel) ───────────────────────────────────────────────────────────
export interface GitCommit {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  date: string;
  subject: string;
}
export interface GitService {
  isRepo(dir: string): boolean;
  revParse(dir: string, ref: string): string | null;
  commitExists(dir: string, sha: string): boolean;
  head(dir: string): string | null;
  currentBranch(dir: string): string | null;
  /** Hash of `git status --porcelain` + `git diff HEAD` — changes when the working tree changes. */
  workingTreeFingerprint(dir: string): string | null;
  tag(dir: string, name: string, sha: string, message: string): void;
  createBranch(dir: string, branch: string, ref: string): void;
  isAncestor(dir: string, ancestor: string, descendant: string): boolean;
  log(dir: string, range: string, limit?: number): GitCommit[];
  run(dir: string, args: string[], opts?: { env?: Record<string, string>; timeoutMs?: number }): { code: number; stdout: string; stderr: string };
}

// ── LLM (packages/llm) ─────────────────────────────────────────────────────
export interface LlmJsonRequest {
  model: ModelTier;
  purpose: string; // machine label for metering, e.g. "fx.extract"
  system?: string;
  prompt: string;
  /** JSON Schema (draft 2020-12 subset) the output must satisfy. */
  schema: Record<string, unknown>;
  maxTokens?: number;
}
export interface LlmJsonResult<T = JsonValue> {
  data: T;
  model: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  raw: string;
}
export interface LlmService {
  completeJson<T = JsonValue>(req: LlmJsonRequest): Promise<LlmJsonResult<T>>;
}

// ── notifications ──────────────────────────────────────────────────────────
export interface Notification {
  /**
   * `audit.integrity`: Verify failed — the chain or an off-host anchor disagrees (Sev-1, docs/runbooks/anchoring.md §7).
   * `backup.missed`: a backup step failed or the backup did not reach off-host storage (docs/runbooks/backup-restore.md).
   */
  kind: 'decision.new' | 'decision.aging' | 'decision.escalated' | 'evidence.integrity' | 'audit.integrity' | 'session.attention' | 'fx.alert' | 'breakglass' | 'anchor.missed' | 'backup.missed' | 'credit.topup' | 'info';
  title: string;
  /** Roles that should see it (requesters never see internal notifications). */
  audience: Role[];
  link?: string;
  severity: 'info' | 'warn' | 'danger';
  /** Ids only — rendered by the UI. */
  refs?: Record<string, string>;
}
export interface Notifier {
  notify(n: Notification): void;
}

/** Name → interface map for the kernel service registry. */
export interface ServiceMap {
  identity: IdentityService;
  sessions: SessionDirectory;
  liveness: LivenessService;
  policy: PolicyService;
  decisions: DecisionService;
  ledger: LedgerService;
  credits: CreditService;
  metering: MeteringService;
  fx: FxService;
  supervisor: SupervisorService;
  registry: RegistryService;
  learning: LearningService;
  change: ChangeService;
  audit: AuditService;
  git: GitService;
  llm: LlmService;
  notifier: Notifier;
}
export type ServiceName = keyof ServiceMap;
