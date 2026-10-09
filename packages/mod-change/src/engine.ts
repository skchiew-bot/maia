/**
 * Change control engine (§8, §14): change records with AI-drafted fields the developer must edit or affirm,
 * gated rollback, break-glass and the provenance-guaranteed promotion path. Every state change is an event.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  BLIND_AFFIRM_DWELL_MS,
  CHANGE_FIELDS,
  hasPermission,
  newId,
  type Actor,
  type AffirmRateDTO,
  type BreakglassDTO,
  type ChangeField,
  type ChangeRequestDTO,
  type ChangeScope,
  type ChangeService,
  type DecisionOption,
  type JsonValue,
  type MetaOf,
  type PromotionDTO,
  type ProvenanceDTO,
  type RollbackDTO,
  type Scope,
  type StoredEvent,
  type SupervisorService,
  type User,
} from '@aoc/contracts';
import {
  GIT_SAFETY_ARGS,
  GIT_SERVICE_ENV,
  HttpError,
  filterDriverOverrides,
  type ModuleContext,
} from '@aoc/kernel';
import {
  acceptanceCommandOf,
  isClean,
  parseTestCounts,
  verificationReport,
  type VerificationOutcome,
} from './acceptance';
import {
  DRAFT_SCHEMA,
  DRAFT_SYSTEM,
  DraftResult,
  EMPTY_DRAFT,
  draftPrompt,
  type DraftContext,
  type DraftFields,
} from './draft';
import { affirmRateRow, assessAffirmation, type AffirmationAssessment } from './governance';
import {
  APPROVED_STATUSES,
  ChangeReadModel,
  OWN_DECISIONS,
  type ChangeRow,
  type PromotionRow,
  type RollbackRow,
} from './projection';
import { ServiceClone, clonePathFor } from './clone';
import { LOG_FORMAT, classifyCommit, parseLog, type ProvenanceLookups } from './provenance';
import {
  AOC_GIT_IDENTITY,
  RepoOpError,
  pushOutcome,
  transportOf,
  updateProjectBranch,
  type CommitSpec,
  type GitRunner,
  type PublishResult,
} from './repo';

export interface ProjectSettings {
  repoPath?: string;
  defaultBranch?: string;
  /** Shell command that runs the project's acceptance tests (rollback verification fallback). */
  acceptanceCommand?: string;
  /**
   * The protected remote promotions and rollbacks are pushed to (ssh, https or an absolute local path). Wins over
   * the `origin` an operator set in the project's service clone. Never read from the project repository: agents
   * can write its config.
   */
  promotionRemote?: string;
}

export interface ChangeModuleOptions {
  /** Static per-project settings; they win over mod-ledger and project.created/updated records. */
  projects?: Record<string, ProjectSettings>;
  /** Branch patterns the protected-op guard treats as protected (default main, master, production, release/*). */
  protectedBranches?: string[];
  /** Credential profile of the push to the protected remote (promotion, rollback, break-glass): its only holder. */
  promoteCredentialProfile?: string;
  /** Where the per-project service clones live (default `<dataDir>/git`; a temp dir when the store is in memory). */
  serviceClonesDir?: string;
  verifyTimeoutMs?: number;
  gitTimeoutMs?: number;
  /** Deadline for the post-incident change record after a break-glass approval. */
  postIncidentDueMs?: number;
  blindAffirmMs?: number;
}

const SYSTEM: Actor = { kind: 'system', id: 'change' };
const SCHEDULER: Actor = { kind: 'system', id: 'scheduler:change' };
const APPROVE_REJECT: DecisionOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject' },
];
const PASSKEY_REQUIRED = 'Approval without a verified passkey is not accepted for this gate.';
const MAX_PROVENANCE_COMMITS = 2000;

const human = (u: User): Actor => ({ kind: 'human', id: u.id });
const short = (sha: string) => sha.slice(0, 12);
const iso = (ms: number) => new Date(ms).toISOString();
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function scopeOf(
  projectId: string,
  ids: { changeId?: string | null; ticketId?: string | null; sessionId?: string | null } = {},
): Scope {
  return {
    projectId,
    ...(ids.changeId ? { changeId: ids.changeId } : {}),
    ...(ids.ticketId ? { ticketId: ids.ticketId } : {}),
    ...(ids.sessionId ? { sessionId: ids.sessionId } : {}),
  };
}

/** SupervisorService.runIsolated as the supervisor package implements it, with its `sandbox` option (G-04). */
type IsolatedRun = Parameters<SupervisorService['runIsolated']>[0] & { sandbox?: { handOver?: string[] } };

/** Where a promotion lands: the protected remote, the project's own branch (no remote anywhere), or nowhere yet. */
type PromotionTarget =
  | { kind: 'remote'; url: string }
  | { kind: 'local' }
  | { kind: 'unconfigured'; remotes: string[] };

/** The commit a candidate is compared with, and where it was read. */
interface Base {
  sha: string;
  ref: string;
  /** AOC's own record in the service clone of where it last moved the branch, not the project repository's view. */
  recorded: boolean;
}

/** The service clone's record of where AOC last moved a branch of the protected remote. */
const targetRef = (branch: string) => `refs/aoc/target/${branch}`;

interface DraftInput {
  projectId: string;
  scope: ChangeScope;
  title: string;
  sessionId: string | null;
  breakglassId: string | null;
  changeId?: string;
  causationId?: string;
  incident?: string | null;
}

export class ChangeEngine implements ChangeService {
  readonly read: ChangeReadModel;
  private ctxRef: ModuleContext | null = null;
  private readonly inflight = new Map<string, Promise<void>>();
  private clonesRootRef: string | null = null;
  private ownsClonesRoot = false;
  private readonly o: {
    projects: Record<string, ProjectSettings>;
    promoteCredentialProfile: string;
    serviceClonesDir: string | null;
    verifyTimeoutMs: number;
    gitTimeoutMs: number;
    postIncidentDueMs: number;
    blindAffirmMs: number;
  };

  constructor(opts: ChangeModuleOptions = {}) {
    this.o = {
      projects: opts.projects ?? {},
      promoteCredentialProfile: opts.promoteCredentialProfile ?? 'prod-promote',
      serviceClonesDir: opts.serviceClonesDir ?? null,
      verifyTimeoutMs: opts.verifyTimeoutMs ?? 15 * 60_000,
      gitTimeoutMs: opts.gitTimeoutMs ?? 2 * 60_000,
      postIncidentDueMs: opts.postIncidentDueMs ?? 24 * 3_600_000,
      blindAffirmMs: opts.blindAffirmMs ?? BLIND_AFFIRM_DWELL_MS,
    };
    this.read = new ChangeReadModel(
      () => this.ctx.db,
      () => this.ctx.clock.now(),
    );
  }

  bind(ctx: ModuleContext): void {
    this.ctxRef = ctx;
  }

  private get ctx(): ModuleContext {
    if (!this.ctxRef) throw new Error('change module is not initialised');
    return this.ctxRef;
  }

  // ── background work (rollback verification can run for minutes) ──────────
  /** Run long work outside the reactor queue (one task per key); it starts on a fresh macrotask, never inside an append. */
  private background(key: string, task: () => Promise<void>): void {
    if (this.inflight.has(key)) return;
    const p = new Promise<void>((resolve) => setImmediate(resolve))
      .then(task)
      .catch((err) => this.ctx.log.error('change: background task failed', { key, err: errText(err) }))
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
  }

  get busy(): boolean {
    return this.inflight.size > 0;
  }

  async whenIdle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight.values()]);
  }

  /** After a restart, verifications that were in flight are run again (they never touch the default branch). */
  resumePending(): void {
    for (const r of this.read.rollbacksIn(['requested', 'verifying']))
      this.scheduleVerification(r.rollback_id, null);
  }

  // ── project settings ─────────────────────────────────────────────────────
  repoPath(projectId: string): string | null {
    return (
      this.o.projects[projectId]?.repoPath ??
      this.ctx.services.maybe('ledger')?.projectRepoPath(projectId) ??
      this.read.project(projectId)?.repo_path ??
      null
    );
  }

  private requireRepo(projectId: string): string {
    const repo = this.repoPath(projectId);
    if (!repo || !this.ctx.services.get('git').isRepo(repo))
      throw new HttpError(422, 'project_repo_unknown', `No git repository is known for project ${projectId}`);
    return repo;
  }

  // ── the service-owned clone (G-04) ───────────────────────────────────────
  /** Directory of the service clones: in aocd's data directory, never in a project. */
  private get clonesRoot(): string {
    if (!this.clonesRootRef) {
      if (this.o.serviceClonesDir) this.clonesRootRef = resolve(this.o.serviceClonesDir);
      else if (this.ctx.dataDir === ':memory:') {
        this.clonesRootRef = mkdtempSync(join(tmpdir(), 'aoc-clones-'));
        this.ownsClonesRoot = true;
      } else this.clonesRootRef = join(resolve(this.ctx.dataDir), 'git');
    }
    return this.clonesRootRef;
  }

  /** Where the project's service clone lives (operators set its `origin` there). */
  serviceClonePath(projectId: string): string {
    return clonePathFor(this.clonesRoot, projectId);
  }

  /** Removes a temporary clones directory (in-memory store). */
  dispose(): void {
    if (this.ownsClonesRoot && this.clonesRootRef) rmSync(this.clonesRootRef, { recursive: true, force: true });
  }

  private serviceClone(projectId: string, repo: string): ServiceClone {
    const r = this.ctx.services
      .get('git')
      .run(repo, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--show-object-format']);
    const [top, gitDir, objectFormat] = r.stdout.trim().split('\n');
    if (r.code !== 0 || !top || !gitDir)
      throw new RepoOpError('project_repo_unknown', `${repo} is not a git working tree`);
    return ServiceClone.open(
      this.clonesRoot,
      projectId,
      { top, gitDir, objectFormat: objectFormat || 'sha1' },
      this.o.gitTimeoutMs,
    );
  }

  /** The service clone, holding commit `sha` copied in from the project repository by id. */
  private withCommit(projectId: string, repo: string, sha: string): ServiceClone {
    const clone = this.serviceClone(projectId, repo);
    clone.fetchCommit(repo, sha);
    return clone;
  }

  /** Request paths: a service-clone problem becomes an HTTP error. */
  private cloneOrFail<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof RepoOpError)
        throw new HttpError(err.reason === 'commit_unavailable' ? 422 : 500, err.reason, err.message);
      throw err;
    }
  }

  /**
   * Where promotions of the project land. The remote comes from AOC's configuration (ProjectSettings, or the service
   * clone's `origin`), never from the project repository, whose config agents can write: pushing where it points
   * would let an agent redirect the credentialed push. With remotes there and none configured, nothing is pushed.
   */
  private target(projectId: string, repo: string, clone: ServiceClone): PromotionTarget {
    const url = this.o.projects[projectId]?.promotionRemote ?? clone.remoteUrl();
    if (url) return { kind: 'remote', url };
    const remotes = this.ctx.services
      .get('git')
      .run(repo, ['remote'])
      .stdout.split('\n')
      .map((r) => r.trim())
      .filter(Boolean);
    return remotes.length ? { kind: 'unconfigured', remotes } : { kind: 'local' };
  }

  private unconfiguredDetail(target: { remotes: string[] }, clone: ServiceClone): string {
    return (
      `the project repository has the remote(s) ${target.remotes.join(', ')} but AOC has no promotion remote for it, ` +
      `and never pushes where the project's own config points. As the aocd user: ` +
      `git --git-dir=${clone.path} remote add origin <protected remote url>`
    );
  }

  /**
   * The commit a candidate is compared with. Remote target: where AOC last moved the branch (the service clone's
   * record), else — first use, or after the remote moved without AOC — the project's view of it; the push's lease
   * then proves the remote is really there. Local target: the project's own branch.
   */
  private base(repo: string, clone: ServiceClone, branch: string, target: PromotionTarget): Base | null {
    if (target.kind === 'remote') {
      const recorded = clone.revParse(targetRef(branch));
      if (recorded) return { sha: recorded, ref: `refs/heads/${branch}`, recorded: true };
    }
    const refs =
      target.kind === 'remote'
        ? [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]
        : [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`];
    const git = this.ctx.services.get('git');
    for (const ref of refs) {
      const sha = git.revParse(repo, ref);
      if (sha) {
        clone.fetchCommit(repo, sha);
        return { sha, ref, recorded: false };
      }
    }
    return null;
  }

  /** Every commit in `<base>..<sha>`, read in the service clone, must trace through a gate (§14). */
  private trace(projectId: string, clone: ServiceClone, base: Base, sha: string): ProvenanceDTO {
    const fail = (reason: string): ProvenanceDTO => ({
      projectId,
      sha,
      baseRef: base.ref,
      ok: false,
      commits: [],
      orphanShas: [],
      reasons: [reason],
    });
    const log = clone.run(['log', LOG_FORMAT, `-n${MAX_PROVENANCE_COMMITS + 1}`, `${base.sha}..${sha}`]);
    if (log.code !== 0) return fail(`git log failed: ${log.stderr.trim().slice(0, 300)}`);
    const logged = parseLog(log.stdout);
    if (logged.length > MAX_PROVENANCE_COMMITS) return fail(`more than ${MAX_PROVENANCE_COMMITS} commits to trace`);
    const commits = logged.map((c) => classifyCommit(c, projectId, this.lookups));
    const orphans = commits.filter((c) => !c.traced);
    return {
      projectId,
      sha,
      baseRef: base.ref,
      ok: orphans.length === 0,
      commits,
      orphanShas: orphans.map((c) => c.sha),
      reasons: orphans.map((c) => `${short(c.sha)}: ${c.reason}`),
    };
  }

  /** The supervisor's runIsolated, with its sandbox option (requested for the SupervisorService contract, G-04). */
  private isolated(input: IsolatedRun) {
    return this.ctx.services.get('supervisor').runIsolated(input);
  }

  /**
   * git in the project repository — the agents' workspace — as the session user, never with a credential, and with
   * every filter driver the repository defines switched off (a checkout would run its smudge command).
   */
  private sandboxedGit(repo: string): GitRunner {
    const noFilters = filterDriverOverrides(repo);
    return async (cwd, args, env = {}) => {
      const r = await this.isolated({
        cwd,
        command: ['git', ...GIT_SAFETY_ARGS, ...args],
        credentialProfile: null,
        timeoutMs: this.o.gitTimeoutMs,
        env: { ...GIT_SERVICE_ENV, ...noFilters, ...env },
        sandbox: {},
      });
      return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    };
  }

  /**
   * One credentialed process: `git push` from the service clone to the configured remote, leased on the verified
   * base, so the branch only moves from exactly the state whose delta was checked (a compare-and-swap of a
   * fast-forward, never a rewrite). The clone then records where the branch is.
   */
  private async pushToRemote(
    clone: ServiceClone,
    url: string,
    branch: string,
    base: Base,
    next: string,
  ): Promise<PublishResult> {
    const transport = transportOf(url);
    if (!transport)
      return {
        ok: false,
        failed: 'promotion_remote_invalid',
        detail: `${url} is not an ssh, https or absolute local-path remote`,
      };
    const push = async (expected: string) =>
      pushOutcome(
        await this.isolated({
          cwd: clone.path,
          command: [
            'git',
            ...GIT_SAFETY_ARGS,
            '-c',
            `protocol.${transport}.allow=user`,
            `--git-dir=${clone.path}`,
            'push',
            '--porcelain',
            '--no-verify',
            `--force-with-lease=refs/heads/${branch}:${expected}`,
            '--',
            url,
            `${next}:refs/heads/${branch}`,
          ],
          credentialProfile: this.o.promoteCredentialProfile,
          timeoutMs: this.o.gitTimeoutMs,
          env: { ...GIT_SERVICE_ENV },
        }).then((r) => ({ code: r.exitCode, stdout: r.stdout, stderr: r.stderr })),
      );
    let out = await push(base.sha);
    // An earlier attempt may have pushed before AOC recorded it (a crash): then the remote already holds `next`.
    if (!out.ok && out.stale && base.sha !== next) {
      const again = await push(next);
      if (again.ok) out = again;
    }
    if (out.ok) {
      clone.setRef(targetRef(branch), next);
      return { ok: true, before: base.sha, after: next, warning: null };
    }
    if (!out.stale) return { ok: false, failed: 'push_failed', detail: out.detail };
    if (base.recorded) clone.deleteRef(targetRef(branch));
    return {
      ok: false,
      failed: 'default_branch_moved',
      detail:
        `the remote's ${branch} is not at ${base.sha}, where AOC ${base.recorded ? 'last moved it' : `read it (${base.ref} in the project repository)`}. ` +
        `A push to ${branch} outside AOC is an R1 breach (docs/runbooks/credential-isolation.md §7); otherwise fetch in the project repository and request again.\n${out.detail}`,
    };
  }

  /**
   * Moves the default branch from `base` to `next` (verified by the caller). Remote target: the push above, then the
   * project repository follows as a courtesy. Local target (no remote anywhere): the project repository's own
   * branch, compare-and-swapped, written as the session user.
   */
  private async publish(i: {
    repo: string;
    clone: ServiceClone;
    target: Exclude<PromotionTarget, { kind: 'unconfigured' }>;
    branch: string;
    base: Base;
    next: string;
    restore?: CommitSpec;
  }): Promise<PublishResult> {
    if (i.target.kind === 'local')
      return updateProjectBranch(this.sandboxedGit(i.repo), i.repo, i.branch, i.base.sha, i.next, i.restore);
    const pushed = await this.pushToRemote(i.clone, i.target.url, i.branch, i.base, i.next);
    if (!pushed.ok) return pushed;
    const local = await updateProjectBranch(this.sandboxedGit(i.repo), i.repo, i.branch, null, i.next, i.restore).catch(
      (err): PublishResult => ({ ok: false, failed: 'local_update_failed', detail: errText(err) }),
    );
    return local.ok
      ? pushed
      : {
          ...pushed,
          warning: `pushed to the protected remote; the project repository's ${i.branch} was not updated: ${local.detail}`,
        };
  }

  defaultBranch(projectId: string): string {
    const configured =
      this.o.projects[projectId]?.defaultBranch ?? this.read.project(projectId)?.default_branch;
    if (configured) return configured;
    const repo = this.repoPath(projectId);
    if (repo) {
      const git = this.ctx.services.get('git');
      const origin = git.run(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
      if (origin.code === 0 && origin.stdout.trim()) return origin.stdout.trim().replace(/^origin\//, '');
      for (const b of ['main', 'master']) if (git.revParse(repo, `refs/heads/${b}`)) return b;
      const current = git.currentBranch(repo);
      if (current) return current;
    }
    return 'main';
  }

  currentBranch(dir: string): string | null {
    return this.ctxRef?.services.maybe('git')?.currentBranch(dir) ?? null;
  }

  // ── change records ───────────────────────────────────────────────────────
  async createDraft(
    input: {
      projectId: string;
      scope: ChangeScope;
      title: string;
      sessionId?: string | null;
      breakglassId?: string | null;
    },
    actor: Actor,
  ): Promise<{ changeId: string }> {
    return this.draft(
      { ...input, sessionId: input.sessionId ?? null, breakglassId: input.breakglassId ?? null },
      actor,
    );
  }

  /** HTTP entry point: validates the session link, drafts, and returns the record. */
  async createChange(
    input: { projectId: string; scope: ChangeScope; title: string; sessionId?: string | null },
    user: User,
  ): Promise<ChangeRequestDTO> {
    if (input.sessionId) {
      const sessions = this.ctx.services.maybe('sessions');
      const info = sessions?.get(input.sessionId);
      if (sessions && !info)
        throw new HttpError(404, 'session_not_found', `Unknown session ${input.sessionId}`);
      if (info?.projectId && info.projectId !== input.projectId)
        throw new HttpError(422, 'session_project_mismatch', 'The session belongs to another project');
    }
    const { changeId } = await this.createDraft(input, human(user));
    return this.read.changeDto(changeId)!;
  }

  private async draft(i: DraftInput, actor: Actor): Promise<{ changeId: string }> {
    const idempotencyKey = i.breakglassId ? `change.drafted:breakglass:${i.breakglassId}` : undefined;
    const prior = idempotencyKey ? this.ctx.store.findByIdempotencyKey(idempotencyKey) : null;
    if (prior) return { changeId: String(prior.meta.changeId) };
    const changeId = i.changeId ?? newId('change', this.ctx.clock.now());
    const ownerId =
      actor.kind === 'human'
        ? actor.id
        : i.breakglassId
          ? (this.read.breakglass(i.breakglassId)?.invoked_by ?? null)
          : actor.kind === 'agent'
            ? (this.ctx.services.maybe('sessions')?.get(actor.id)?.ownerId ?? null)
            : null;
    const { by, fields } = await this.draftFields(i);
    const e = this.ctx.store.append({
      type: 'change.drafted',
      actor,
      scope: scopeOf(i.projectId, { changeId, sessionId: i.sessionId }),
      bodyScope: i.projectId,
      meta: {
        changeId,
        projectId: i.projectId,
        scope: i.scope,
        draftedBy: by,
        sessionId: i.sessionId,
        breakglassId: i.breakglassId,
        ownerId,
      },
      payload: { title: i.title, ...fields },
      source: actor.kind === 'human' ? 'api' : 'system',
      idempotencyKey,
      causationId: i.causationId,
    });
    return { changeId: e.meta.changeId };
  }

  /** AI draft via llm.completeJson (purpose change.draft, sonnet); any failure yields empty fields drafted by 'human'. */
  private async draftFields(i: DraftInput): Promise<{ by: 'ai' | 'human'; fields: DraftFields }> {
    const llm = this.ctx.services.maybe('llm');
    if (!llm) return { by: 'human', fields: EMPTY_DRAFT };
    try {
      const res = await llm.completeJson({
        model: 'sonnet',
        purpose: 'change.draft',
        system: DRAFT_SYSTEM,
        prompt: draftPrompt(this.draftContext(i)),
        schema: DRAFT_SCHEMA,
        maxTokens: 2000,
      });
      const parsed = DraftResult.safeParse(res.data);
      if (parsed.success && Object.values(parsed.data).some((v) => v.trim()))
        return { by: 'ai', fields: parsed.data };
      this.ctx.log.warn('change: unusable draft from the LLM', { projectId: i.projectId });
    } catch (err) {
      this.ctx.log.warn('change: LLM draft failed', { projectId: i.projectId, err: errText(err) });
    }
    return { by: 'human', fields: EMPTY_DRAFT };
  }

  private draftContext(i: DraftInput): DraftContext {
    const repo = this.repoPath(i.projectId);
    const git = this.ctx.services.get('git');
    const usable = !!repo && git.isRepo(repo);
    const branch = usable ? this.defaultBranch(i.projectId) : null;
    const head = usable && branch ? git.revParse(repo!, `refs/heads/${branch}`) : null;
    return {
      title: i.title,
      scope: i.scope,
      projectId: i.projectId,
      defaultBranch: branch,
      head,
      recentCommits: head ? git.log(repo!, head, 8).map((c) => `${short(c.sha)} ${c.subject}`) : [],
      rollbackCandidates: this.read
        .pins(i.projectId)
        .flatMap((p) => (p.tag ? [`${p.tag}${p.sha ? ` (${p.sha})` : ''}`] : p.sha ? [p.sha] : [])),
      session: i.sessionId ? this.sessionContext(i.sessionId) : null,
      incident: i.incident ?? null,
    };
  }

  private sessionContext(sessionId: string): string | null {
    const parts: string[] = [];
    const info = this.ctx.services.maybe('sessions')?.get(sessionId) ?? null;
    const ledger = this.ctx.services.maybe('ledger');
    if (info)
      parts.push(
        `Session ${sessionId}: ${info.processType ?? 'unknown'} session on ${info.model ?? 'an unknown model'} (${info.lifecycle})${info.ticketId ? `, ticket ${info.ticketId}` : ''}`,
      );
    try {
      const progress = ledger?.sessionProgress(sessionId);
      if (progress) parts.push(`Plan progress: ${progress.doneTasks}/${progress.totalTasks} tasks done`);
      if (info?.threadId && ledger)
        parts.push(
          `Handoff brief:\n${ledger.buildHandoffBrief(info.threadId, sessionId).text.slice(0, 6000)}`,
        );
    } catch (err) {
      this.ctx.log.warn('change: session context unavailable', { sessionId, err: errText(err) });
    }
    return parts.length ? parts.join('\n') : null;
  }

  private change(id: string): ChangeRow {
    const c = this.read.change(id);
    if (!c) throw new HttpError(404, 'change_not_found', `Unknown change ${id}`);
    return c;
  }

  private assertCanAct(c: ChangeRow, user: User): void {
    if (user.role !== 'approver' && c.owner_id !== user.id)
      throw new HttpError(403, 'not_owner', 'Only the owner of the change record or an approver may do this');
  }

  /**
   * A rollback plan must name an exact, immutable ref: a tag or a commit SHA. Change pins live in the service clone;
   * phase pins (mod-ledger) and older change pins in the project repository.
   */
  resolveRollbackRef(projectId: string, ref: string): string {
    const repo = this.requireRepo(projectId);
    const git = this.ctx.services.get('git');
    const clone = this.cloneOrFail(() => this.serviceClone(projectId, repo));
    const tag = `refs/tags/${ref.replace(/^refs\/tags\//, '')}`;
    const viaTag = clone.revParse(tag) ?? git.revParse(repo, tag);
    if (viaTag) return viaTag;
    if (/^[0-9a-f]{7,64}$/i.test(ref)) {
      const sha = (git.commitExists(repo, ref) ? git.revParse(repo, ref) : null) ?? clone.revParse(ref);
      if (sha) return sha;
    }
    if (git.revParse(repo, ref))
      throw new HttpError(
        422,
        'rollback_ref_not_immutable',
        `${ref} is a moving ref; name an exact tag or commit SHA`,
      );
    throw new HttpError(
      422,
      'rollback_ref_unresolvable',
      `${ref} does not resolve to a commit in the project repository`,
    );
  }

  affirmField(
    changeId: string,
    field: ChangeField,
    input: { value: string; dwellMs: number; rollbackRef?: string },
    user: User,
  ): ChangeRequestDTO & { affirmation: AffirmationAssessment } {
    const c = this.change(changeId);
    this.assertCanAct(c, user);
    if (c.status !== 'draft')
      throw new HttpError(
        409,
        'not_editable',
        `The change record is ${c.status}; fields can only be edited or affirmed while drafting`,
      );
    const value = input.value.trim();
    if (!value) throw new HttpError(422, 'empty_value', 'A field cannot be affirmed empty');
    let ref: string | undefined;
    if (field === 'rollbackPlan') {
      ref = (input.rollbackRef ?? c.rollback_ref ?? '').trim();
      if (!ref)
        throw new HttpError(
          422,
          'rollback_ref_required',
          'The rollback plan must name the exact commit or tag to return to',
        );
      this.resolveRollbackRef(c.project_id, ref);
    }
    const draft = this.read.fields(changeId).find((f) => f.field === field)?.draft ?? '';
    const a = assessAffirmation({
      draft,
      value,
      draftRef: c.draft_rollback_ref ?? '',
      ref,
      dwellMs: input.dwellMs,
      blindDwellMs: this.o.blindAffirmMs,
    });
    this.ctx.store.append({
      type: 'change.field_affirmed',
      actor: human(user),
      scope: scopeOf(c.project_id, { changeId }),
      bodyScope: c.project_id,
      meta: {
        changeId,
        field,
        edited: a.edited,
        editRatio: a.editRatio,
        dwellMs: input.dwellMs,
        blind: a.blind,
      },
      payload: { value, ...(ref !== undefined ? { rollbackRef: ref } : {}) },
      source: 'api',
    });
    return { ...this.read.changeDto(changeId)!, affirmation: a };
  }

  submit(changeId: string, user: User): ChangeRequestDTO {
    const c = this.change(changeId);
    this.assertCanAct(c, user);
    if (c.status !== 'draft')
      throw new HttpError(409, 'not_draft', `The change record is already ${c.status}`);
    const fields = this.read.fields(changeId);
    const missing = CHANGE_FIELDS.filter((f) => {
      const row = fields.find((x) => x.field === f);
      return !row || row.affirmed !== 1 || !(row.value ?? '').trim();
    });
    if (missing.length)
      throw new HttpError(
        422,
        'fields_not_affirmed',
        `All four fields must be supplied and affirmed; missing: ${missing.join(', ')}`,
        { missing },
      );
    if (!c.rollback_ref)
      throw new HttpError(
        422,
        'rollback_ref_required',
        'The rollback plan must name the exact commit or tag to return to',
      );
    const rollbackSha = this.resolveRollbackRef(c.project_id, c.rollback_ref);
    const actor = human(user);
    const scope = scopeOf(c.project_id, { changeId });
    // Builders self-approve reversible off-main work; the record is still complete (submitted + approved, §6/§8).
    if (
      c.scope === 'reversible_off_main' &&
      user.role === 'builder' &&
      hasPermission(user.role, 'change.self_approve_reversible', user.flags)
    ) {
      this.ctx.store.appendMany([
        {
          type: 'change.submitted',
          actor,
          scope,
          meta: { changeId, scope: c.scope, selfApprovable: true, decisionId: null, rollbackSha },
          source: 'api',
        },
        {
          type: 'change.approved',
          actor,
          scope,
          meta: { changeId, decisionId: null, approverId: user.id, selfApproved: true },
          source: 'api',
        },
      ]);
      return this.read.changeDto(changeId)!;
    }
    const decisions = this.ctx.services.maybe('decisions');
    if (!decisions)
      throw new HttpError(503, 'decisions_unavailable', 'The decision service is not available');
    const values = Object.fromEntries(fields.map((f) => [f.field, f.value ?? '']));
    const card = decisions.request(
      {
        kind: 'change_request',
        changeScope: c.scope,
        requiredRole: 'approver',
        title: `Change request: ${c.title ?? changeId}`,
        question: `Approve change ${changeId} (${c.scope.replace(/_/g, ' ')}) in ${c.project_id}?`,
        options: APPROVE_REJECT,
        context: [
          `Impact analysis:\n${values.impact}`,
          `Mitigation plan:\n${values.mitigation}`,
          `Rollback plan (returns to ${c.rollback_ref} = ${rollbackSha}):\n${values.rollbackPlan}`,
          `Acceptance test:\n${values.acceptanceTest}`,
        ].join('\n\n'),
        subjectType: 'change',
        subjectId: changeId,
        projectId: c.project_id,
        requesterId: user.id,
      },
      actor,
    );
    this.ctx.store.append({
      type: 'change.submitted',
      actor,
      scope,
      meta: { changeId, scope: c.scope, selfApprovable: false, decisionId: card.id, rollbackSha },
      source: 'api',
    });
    return this.read.changeDto(changeId)!;
  }

  start(changeId: string, sessionId: string, user: User): ChangeRequestDTO {
    const c = this.change(changeId);
    this.assertCanAct(c, user);
    if (c.status !== 'approved' && c.status !== 'in_progress')
      throw new HttpError(409, 'not_approved', `A change can only start once approved (it is ${c.status})`);
    const sessions = this.ctx.services.maybe('sessions');
    const info = sessions?.get(sessionId);
    if (sessions && !info) throw new HttpError(404, 'session_not_found', `Unknown session ${sessionId}`);
    if (info?.projectId && info.projectId !== c.project_id)
      throw new HttpError(422, 'session_project_mismatch', 'The session belongs to another project');
    if (!this.read.changeDto(changeId)!.sessions.some((s) => s.sessionId === sessionId)) {
      this.ctx.store.append({
        type: 'change.started',
        actor: human(user),
        scope: scopeOf(c.project_id, { changeId, sessionId }),
        meta: { changeId, sessionId },
        source: 'api',
      });
    }
    return this.read.changeDto(changeId)!;
  }

  /** Complete and pin: annotated tag aoc/change/<id> at the project HEAD (or `ref`). */
  complete(changeId: string, user: User, ref?: string): ChangeRequestDTO {
    const c = this.change(changeId);
    this.assertCanAct(c, user);
    if (c.status !== 'approved' && c.status !== 'in_progress')
      throw new HttpError(409, 'not_started', `Only approved work can be completed (it is ${c.status})`);
    const repo = this.requireRepo(c.project_id);
    const git = this.ctx.services.get('git');
    const sha = ref ? git.revParse(repo, ref) : git.head(repo);
    if (!sha) throw new HttpError(422, 'unknown_ref', `${ref ?? 'HEAD'} does not resolve to a commit`);
    const tag = `aoc/change/${changeId}`;
    // The pin is made in the service clone, where no agent can move or delete it (G-04).
    this.cloneOrFail(() => {
      const clone = this.withCommit(c.project_id, repo, sha);
      const existing = clone.revParse(`refs/tags/${tag}`);
      if (existing && existing !== sha)
        throw new HttpError(409, 'pin_conflict', `${tag} already pins ${existing}`);
      if (!existing)
        clone.tag(tag, sha, `AOC change record ${changeId} completed`, AOC_GIT_IDENTITY, this.ctx.clock.now() / 1000);
    });
    const actor = human(user);
    this.ctx.store.appendMany([
      {
        type: 'change.completed',
        actor,
        scope: scopeOf(c.project_id, { changeId }),
        meta: { changeId, pinnedSha: sha, pinnedTag: tag },
        source: 'api',
      },
      {
        type: 'git.ref_pinned',
        actor,
        scope: scopeOf(c.project_id, { changeId }),
        meta: { projectId: c.project_id, tag, sha, reason: 'change.completed' },
        source: 'api',
      },
    ]);
    return this.read.changeDto(changeId)!;
  }

  /** Portfolio governance lens for approvers: per-developer affirm-without-edit rate and blind confirms, ordered by name. */
  affirmRate(projectId?: string): AffirmRateDTO {
    const identity = this.ctx.services.maybe('identity');
    const counts = this.read.affirmationCounts(projectId).map((r) => ({
      userId: r.user_id,
      name: identity?.getUser(r.user_id)?.name ?? null,
      affirmations: r.n,
      affirmedWithoutEdit: r.unedited,
      flagged: r.flagged,
      editRatioSum: r.ratio_sum,
    }));
    const rows = counts
      .map(affirmRateRow)
      .sort((a, b) => (a.name ?? a.userId).localeCompare(b.name ?? b.userId));
    const sum = (k: 'affirmations' | 'affirmedWithoutEdit' | 'flagged' | 'editRatioSum') =>
      counts.reduce((s, c) => s + c[k], 0);
    const {
      userId: _u,
      name: _n,
      ...totals
    } = affirmRateRow({
      userId: '',
      name: null,
      affirmations: sum('affirmations'),
      affirmedWithoutEdit: sum('affirmedWithoutEdit'),
      flagged: sum('flagged'),
      editRatioSum: sum('editRatioSum'),
    });
    return { rows, totals, blindDwellMs: this.o.blindAffirmMs };
  }

  // ── rollback ─────────────────────────────────────────────────────────────
  /**
   * Rollback targets are immutable: a pinned tag (still pointing at its pinned SHA) or a SHA recorded in the chain.
   * The target is copied into the service clone, which verification and execution read from.
   */
  resolvePinnedTarget(projectId: string, ref: string): string {
    const repo = this.requireRepo(projectId);
    const git = this.ctx.services.get('git');
    const clone = this.cloneOrFail(() => this.serviceClone(projectId, repo));
    const tag = ref.replace(/^refs\/tags\//, '');
    const pins = this.read.pinsByTag(projectId, tag);
    let sha: string | null = null;
    if (pins.length) {
      sha = clone.revParse(`refs/tags/${tag}`) ?? git.revParse(repo, `refs/tags/${tag}`);
      if (!sha)
        throw new HttpError(422, 'pin_missing', `Pinned tag ${tag} no longer exists in the repository`);
      const pinned = sha;
      const recorded = pins.map((p) => p.sha).filter((s): s is string => !!s);
      if (recorded.length && !recorded.some((r) => pinned.startsWith(r)))
        throw new HttpError(409, 'pin_moved', `Tag ${tag} was moved away from its pinned SHA`);
    } else if (/^[0-9a-f]{7,64}$/i.test(ref)) {
      const found = (git.commitExists(repo, ref) ? git.revParse(repo, ref) : null) ?? clone.revParse(ref);
      if (found && this.read.isPinnedSha(projectId, found)) sha = found;
    }
    if (!sha)
      throw new HttpError(
        422,
        'target_not_pinned',
        'A rollback target must be a pinned tag or a SHA recorded by a phase completion or change record',
      );
    const target = sha;
    this.cloneOrFail(() => clone.fetchCommit(repo, target));
    return target;
  }

  requestRollback(
    input: { projectId: string; targetRef: string; changeId?: string | null; reason: string },
    user: User,
  ): RollbackDTO {
    const changeId = input.changeId ?? null;
    if (changeId && this.change(changeId).project_id !== input.projectId)
      throw new HttpError(422, 'change_project_mismatch', 'The change record belongs to another project');
    const targetSha = this.resolvePinnedTarget(input.projectId, input.targetRef);
    const rollbackId = newId('rollback', this.ctx.clock.now());
    this.ctx.store.append({
      type: 'rollback.requested',
      actor: human(user),
      scope: scopeOf(input.projectId, { changeId }),
      bodyScope: input.projectId,
      meta: { rollbackId, projectId: input.projectId, targetRef: input.targetRef, targetSha, changeId },
      payload: { reason: input.reason },
      source: 'api',
    });
    return this.read.rollbackDto(rollbackId)!;
  }

  scheduleVerification(rollbackId: string, causationId: string | null): void {
    this.background(`verify:${rollbackId}`, () => this.verifyRollback(rollbackId, causationId));
  }

  /** Check the target out on a new branch, run that state's acceptance tests, report back; only clean raises the passkey decision. */
  private async verifyRollback(rollbackId: string, causationId: string | null): Promise<void> {
    const r = this.read.rollback(rollbackId);
    if (!r || (r.status !== 'requested' && r.status !== 'verifying')) return;
    const branch = `aoc/rollback/${rollbackId}`;
    const scope = scopeOf(r.project_id, { changeId: r.change_id });
    const cause = causationId ?? undefined;
    this.ctx.store.append({
      type: 'rollback.verification_started',
      actor: SYSTEM,
      scope,
      meta: { rollbackId, branch },
      source: 'supervisor',
      idempotencyKey: `rollback.verification_started:${rollbackId}`,
      causationId: cause,
    });
    const outcome = await this.runVerification(r, branch);
    const clean = isClean(outcome);
    const report = verificationReport(outcome);
    let decisionId: string | null = null;
    let decisionProblem: string | null = null;
    if (clean) {
      try {
        const decisions = this.ctx.services.maybe('decisions');
        if (!decisions) throw new Error('decision service unavailable');
        const branchName = this.defaultBranch(r.project_id);
        decisionId = decisions.request(
          {
            kind: 'rollback',
            title: `Rollback ${r.project_id} to ${r.target_ref}`,
            question: `Verification on ${branch} is clean (${outcome.counts.passed} passed, 0 failed). Roll ${branchName} back to ${short(r.target_sha)} with a new commit (history preserved)?`,
            options: APPROVE_REJECT,
            context: report,
            subjectType: 'rollback',
            subjectId: rollbackId,
            projectId: r.project_id,
            requesterId: r.requested_by,
          },
          SYSTEM,
        ).id;
      } catch (err) {
        decisionProblem = errText(err);
      }
    }
    this.ctx.store.append({
      type: 'rollback.verified',
      actor: SYSTEM,
      scope,
      bodyScope: r.project_id,
      meta: {
        rollbackId,
        branch,
        testsPassed: outcome.counts.passed,
        testsFailed: outcome.counts.failed,
        clean,
        decisionId,
      },
      payload: { report },
      source: 'supervisor',
      idempotencyKey: `rollback.verified:${rollbackId}`,
      causationId: cause,
    });
    if (decisionProblem) this.rollbackFailed(r, 'decision_unavailable', decisionProblem, cause);
    if (!clean) {
      this.ctx.notify({
        kind: 'info',
        title: 'Rollback verification is not clean — no approval was requested',
        audience: ['approver', 'builder'],
        severity: 'warn',
        refs: { rollbackId, projectId: r.project_id },
      });
      this.ctx.services
        .maybe('learning')
        ?.recordError(
          {
            source: 'rollback',
            projectId: r.project_id,
            message: `Rollback verification of ${r.target_ref} (${short(r.target_sha)}) was not clean`,
            context: report.slice(0, 4000),
            priority: 'normal',
          },
          SYSTEM,
        );
    }
  }

  /**
   * The target is checked out of the service clone — on the new branch, kept there as evidence — into a fresh,
   * standalone checkout, and that state's acceptance tests run there as the session user (sandboxed, never with a
   * credential). Nothing runs in the project repository.
   */
  private async runVerification(r: RollbackRow, branch: string): Promise<VerificationOutcome> {
    const base: VerificationOutcome = {
      rollbackId: r.rollback_id,
      targetRef: r.target_ref,
      targetSha: r.target_sha,
      branch,
      command: null,
      commandSource: null,
      exitCode: null,
      durationMs: 0,
      counts: { passed: 0, failed: 0, parsed: false },
      output: '',
      problem: null,
    };
    if (!this.ctx.services.maybe('supervisor'))
      return { ...base, problem: 'no supervisor is available to run the verification' };
    const repo = this.repoPath(r.project_id);
    if (!repo) return { ...base, problem: 'the project repository is unknown' };
    let root: string | null = null;
    try {
      const clone = this.withCommit(r.project_id, repo, r.target_sha);
      clone.setRef(`refs/heads/${branch}`, r.target_sha);
      root = mkdtempSync(join(tmpdir(), 'aoc-rollback-verify-'));
      const dir = join(root, 'checkout');
      for (const d of [dir, join(root, 'home'), join(root, 'tmp')]) mkdirSync(d);
      clone.checkoutTo(dir, r.target_sha);
      const cmd = this.acceptanceCommandFor(r, dir);
      if (!cmd)
        return {
          ...base,
          problem:
            'no acceptance command: the change acceptance test is not a command, the project has no acceptanceCommand and there is no package.json',
        };
      const started = this.ctx.clock.now();
      const res = await this.isolated({
        cwd: dir,
        command: ['sh', '-c', cmd.command],
        credentialProfile: null,
        timeoutMs: this.o.verifyTimeoutMs,
        env: { CI: '1', HOME: join(root, 'home'), TMPDIR: join(root, 'tmp') },
        sandbox: { handOver: [root] },
      });
      const output = [res.stdout, res.stderr].filter((s) => s.trim()).join('\n');
      return {
        ...base,
        command: cmd.command,
        commandSource: cmd.source,
        exitCode: res.exitCode,
        durationMs: this.ctx.clock.now() - started,
        counts: parseTestCounts(output),
        output,
      };
    } catch (err) {
      return { ...base, problem: `verification could not run: ${errText(err)}` };
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  }

  private acceptanceCommandFor(
    r: RollbackRow,
    dir: string,
  ): { command: string; source: 'change' | 'project' | 'package.json' } | null {
    if (r.change_id) {
      const fromChange = acceptanceCommandOf(
        this.read.fields(r.change_id).find((f) => f.field === 'acceptanceTest')?.value,
      );
      if (fromChange) return { command: fromChange, source: 'change' };
    }
    const project =
      this.o.projects[r.project_id]?.acceptanceCommand ?? this.read.project(r.project_id)?.acceptance_command;
    if (project) return { command: project, source: 'project' };
    if (existsSync(join(dir, 'package.json')))
      return { command: 'npm test --silent', source: 'package.json' };
    return null;
  }

  private rollbackFailed(r: RollbackRow, reason: string, detail: string, causationId?: string): void {
    this.ctx.store.append({
      type: 'rollback.failed',
      actor: SYSTEM,
      scope: scopeOf(r.project_id, { changeId: r.change_id }),
      bodyScope: r.project_id,
      meta: { rollbackId: r.rollback_id, reason },
      payload: { detail },
      source: 'supervisor',
      idempotencyKey: `rollback.outcome:${r.rollback_id}`,
      causationId,
    });
    this.ctx.notify({
      kind: 'info',
      title: 'Rollback could not be executed',
      audience: ['approver', 'builder'],
      severity: 'danger',
      refs: { rollbackId: r.rollback_id, projectId: r.project_id },
    });
  }

  /**
   * On approval: a NEW commit on the default branch whose tree is the verified target's (history preserved), made in
   * the service clone and published by `publish` — a fast-forward, compare-and-swapped, never a rewrite.
   */
  async executeRollback(rollbackId: string, causationId: string): Promise<void> {
    const r = this.read.rollback(rollbackId);
    if (!r || r.status !== 'approved') return;
    const repo = this.repoPath(r.project_id);
    if (!repo)
      return this.rollbackFailed(
        r,
        'project_repo_unknown',
        'No git repository is known for the project',
        causationId,
      );
    if (!this.ctx.services.maybe('supervisor'))
      return this.rollbackFailed(
        r,
        'supervisor_unavailable',
        'No supervisor is available to execute the rollback',
        causationId,
      );
    const branch = this.defaultBranch(r.project_id);
    const marker = `AOC-Rollback: ${rollbackId}`;
    const executed = (before: string, after: string) => {
      this.ctx.store.append({
        type: 'rollback.executed',
        actor: SYSTEM,
        scope: scopeOf(r.project_id, { changeId: r.change_id }),
        meta: { rollbackId, mainShaBefore: before, mainShaAfter: after },
        source: 'supervisor',
        idempotencyKey: `rollback.outcome:${rollbackId}`,
        causationId,
      });
    };
    try {
      const clone = this.withCommit(r.project_id, repo, r.target_sha);
      const target = this.target(r.project_id, repo, clone);
      if (target.kind === 'unconfigured')
        return this.rollbackFailed(
          r,
          'promotion_remote_unconfigured',
          this.unconfiguredDetail(target, clone),
          causationId,
        );
      const head = this.base(repo, clone, branch, target);
      if (!head) return this.rollbackFailed(r, 'branch_missing', `${branch} does not exist`, causationId);
      if (clone.message(head.sha).includes(marker)) {
        // An earlier attempt already published this rollback (crash before the event was recorded).
        return executed(clone.firstParent(head.sha) ?? head.sha, head.sha);
      }
      const tree = clone.treeOf(r.target_sha);
      if (clone.treeOf(head.sha) === tree)
        return this.rollbackFailed(
          r,
          'already_at_target',
          `${branch} already has the tree of ${r.target_sha}`,
          causationId,
        );
      const restore: CommitSpec = {
        tree,
        parent: head.sha,
        message: [
          `Rollback to ${r.target_ref} (AOC ${rollbackId})`,
          `${marker}\nAOC-Decision: ${r.decision_id ?? 'none'}`,
        ],
        identity: AOC_GIT_IDENTITY,
        // The approval time: a retry after a crash makes the very same commit.
        time: Date.parse(r.approved_at ?? this.ctx.clock.iso()) / 1000,
      };
      const next = clone.commit(restore);
      const res = await this.publish({ repo, clone, target, branch, base: head, next, restore });
      if (!res.ok)
        return this.rollbackFailed(
          r,
          'refused' in res ? 'default_branch_moved' : res.failed,
          res.detail,
          causationId,
        );
      executed(res.before, res.after);
      if (res.warning)
        this.ctx.notify({
          kind: 'info',
          title: 'Rollback pushed, local branch not updated',
          audience: ['approver', 'builder'],
          severity: 'warn',
          refs: { rollbackId },
        });
    } catch (err) {
      this.rollbackFailed(
        r,
        err instanceof RepoOpError ? err.reason : 'execution_error',
        errText(err),
        causationId,
      );
    }
  }

  // ── decisions → state ────────────────────────────────────────────────────
  async onDecisionResolved(e: StoredEvent, payload: JsonValue | null): Promise<void> {
    const m = e.meta as unknown as MetaOf<'decision.resolved'>;
    const d = this.read.decision(m.decisionId);
    if (!d || OWN_DECISIONS[d.subject_type] !== d.kind) return;
    const approve = m.optionId === 'approve';
    const given = (payload as { comment?: unknown } | null)?.comment;
    const comment = typeof given === 'string' && given ? given : undefined;
    const rejectPayload = (c: string | undefined) => (c ? { comment: c } : {});
    const follow = { actor: e.actor, causationId: e.id, source: 'api' as const };
    switch (d.subject_type) {
      case 'change': {
        const c = this.read.change(d.subject_id);
        if (!c || c.status !== 'submitted' || c.decision_id !== m.decisionId) return;
        const scope = scopeOf(c.project_id, { changeId: c.change_id });
        const idempotencyKey = `change.decided:${c.change_id}`;
        if (approve) {
          this.ctx.store.append({
            ...follow,
            type: 'change.approved',
            scope,
            idempotencyKey,
            meta: {
              changeId: c.change_id,
              decisionId: m.decisionId,
              approverId: m.resolvedBy,
              selfApproved: false,
            },
          });
        } else {
          this.ctx.store.append({
            ...follow,
            type: 'change.rejected',
            scope,
            idempotencyKey,
            bodyScope: c.project_id,
            meta: { changeId: c.change_id, decisionId: m.decisionId, approverId: m.resolvedBy },
            payload: rejectPayload(comment),
          });
        }
        return;
      }
      case 'rollback': {
        const r = this.read.rollback(d.subject_id);
        if (!r || r.status !== 'awaiting_approval' || r.decision_id !== m.decisionId) return;
        const scope = scopeOf(r.project_id, { changeId: r.change_id });
        const idempotencyKey = `rollback.decided:${r.rollback_id}`;
        if (approve && m.passkeyVerified) {
          this.ctx.store.append({
            ...follow,
            type: 'rollback.approved',
            scope,
            idempotencyKey,
            meta: {
              rollbackId: r.rollback_id,
              decisionId: m.decisionId,
              approverId: m.resolvedBy,
              passkeyVerified: true,
            },
          });
        } else {
          this.ctx.store.append({
            ...follow,
            type: 'rollback.rejected',
            scope,
            idempotencyKey,
            bodyScope: r.project_id,
            meta: { rollbackId: r.rollback_id, decisionId: m.decisionId, approverId: m.resolvedBy },
            payload: rejectPayload(approve ? PASSKEY_REQUIRED : comment),
          });
        }
        return;
      }
      case 'breakglass': {
        const b = this.read.breakglass(d.subject_id);
        if (!b || b.status !== 'pending' || b.decision_id !== m.decisionId) return;
        const scope = scopeOf(b.project_id);
        const idempotencyKey = `breakglass.decided:${b.breakglass_id}`;
        if (approve && m.passkeyVerified) {
          const now = this.ctx.clock.now();
          this.ctx.store.append({
            ...follow,
            type: 'breakglass.approved',
            scope,
            idempotencyKey,
            meta: {
              breakglassId: b.breakglass_id,
              decisionId: m.decisionId,
              approverId: m.resolvedBy,
              passkeyVerified: true,
              postIncidentChangeId: newId('change', now),
              dueAt: iso(now + this.o.postIncidentDueMs),
            },
          });
        } else {
          this.ctx.store.append({
            ...follow,
            type: 'breakglass.rejected',
            scope,
            idempotencyKey,
            bodyScope: b.project_id,
            meta: { breakglassId: b.breakglass_id, decisionId: m.decisionId, approverId: m.resolvedBy },
            payload: rejectPayload(approve ? PASSKEY_REQUIRED : comment),
          });
        }
        return;
      }
      case 'promotion': {
        const p = this.read.promotion(d.subject_id);
        if (!p || p.status !== 'requested' || p.decision_id !== m.decisionId) return;
        const scope = scopeOf(p.project_id, { ticketId: p.ticket_id, changeId: p.change_id });
        const idempotencyKey = `promotion.outcome:${p.promotion_id}`;
        if (!approve) {
          this.ctx.store.append({
            ...follow,
            type: 'promotion.rejected',
            scope,
            idempotencyKey,
            bodyScope: p.project_id,
            meta: { promotionId: p.promotion_id, decisionId: m.decisionId, approverId: m.resolvedBy },
            payload: rejectPayload(comment),
          });
        } else if (!m.passkeyVerified) {
          this.ctx.store.append({
            ...follow,
            type: 'promotion.refused',
            scope,
            idempotencyKey,
            meta: {
              promotionId: p.promotion_id,
              reason: 'gate_missing',
              orphanShas: [],
              projectId: p.project_id,
              ...(p.from_sha ? { fromSha: p.from_sha } : {}),
            },
          });
        } else {
          await this.executePromotion(p, m.decisionId, e.id);
        }
        return;
      }
    }
  }

  // ── break-glass ──────────────────────────────────────────────────────────
  invokeBreakglass(
    input: { projectId: string; ref: string; justification: string },
    user: User,
  ): BreakglassDTO {
    const repo = this.requireRepo(input.projectId);
    const sha = this.ctx.services.get('git').revParse(repo, input.ref);
    if (!sha) throw new HttpError(422, 'unknown_ref', `${input.ref} does not resolve to a commit`);
    // Copied into the service clone now, so the emergency promotion never depends on the agents' repository.
    this.cloneOrFail(() => this.withCommit(input.projectId, repo, sha));
    const decisions = this.ctx.services.maybe('decisions');
    if (!decisions)
      throw new HttpError(503, 'decisions_unavailable', 'The decision service is not available');
    const breakglassId = newId('breakglass', this.ctx.clock.now());
    const actor = human(user);
    const branch = this.defaultBranch(input.projectId);
    const card = decisions.request(
      {
        kind: 'break_glass',
        requiredRole: 'approver',
        title: `BREAK-GLASS: emergency promotion of ${input.ref} in ${input.projectId}`,
        question: `Production is down. Promote ${short(sha)} (${input.ref}) to ${branch}, bypassing provenance? A post-incident change record becomes due 24h after approval.`,
        options: APPROVE_REJECT,
        context: input.justification,
        subjectType: 'breakglass',
        subjectId: breakglassId,
        projectId: input.projectId,
        requesterId: user.id,
      },
      actor,
    );
    this.ctx.store.append({
      type: 'breakglass.invoked',
      actor,
      scope: scopeOf(input.projectId),
      bodyScope: input.projectId,
      meta: {
        breakglassId,
        projectId: input.projectId,
        invokedBy: user.id,
        ref: input.ref,
        sha,
        decisionId: card.id,
      },
      payload: { justification: input.justification },
      source: 'api',
    });
    this.ctx.notify({
      kind: 'breakglass',
      title: `Break-glass invoked on ${input.projectId}: emergency promotion awaits the approver`,
      audience: ['approver', 'builder'],
      severity: 'danger',
      refs: { breakglassId, decisionId: card.id, projectId: input.projectId },
    });
    return this.read.breakglassDto(breakglassId)!;
  }

  /** Approved break-glass: promote the recorded SHA to the default branch, bypassing provenance (the sole exception, §14). */
  async promoteBreakglass(breakglassId: string, causationId: string): Promise<void> {
    const b = this.read.breakglass(breakglassId);
    if (!b || b.status !== 'approved') return;
    if (b.promotion_id && this.read.promotion(b.promotion_id)?.status !== 'requested') return;
    const e = this.ctx.store.append({
      type: 'promotion.requested',
      actor: SYSTEM,
      scope: scopeOf(b.project_id),
      meta: {
        promotionId: b.promotion_id ?? newId('promotion', this.ctx.clock.now()),
        projectId: b.project_id,
        fromRef: b.ref,
        fromSha: b.sha,
        targetBranch: this.defaultBranch(b.project_id),
        ticketId: null,
        changeId: null,
        breakglassId,
      },
      source: 'supervisor',
      idempotencyKey: `promotion.requested:breakglass:${breakglassId}`,
      causationId,
    });
    const p = this.read.promotion(e.meta.promotionId);
    if (p) await this.executePromotion(p, b.decision_id, causationId);
  }

  /** The mandatory post-incident change record (drafted after the promotion so the emergency fix is never delayed). */
  async draftPostIncident(breakglassId: string, causationId: string): Promise<void> {
    const b = this.read.breakglass(breakglassId);
    if (
      !b ||
      b.status !== 'approved' ||
      !b.post_incident_change_id ||
      this.read.change(b.post_incident_change_id)
    )
      return;
    const before = b.promotion_id ? this.read.promotion(b.promotion_id)?.main_sha_before : null;
    const incident = [
      `Break-glass ${breakglassId}: emergency promotion of ${b.ref} (${b.sha}) approved by ${b.approver_id ?? 'the approver'}.`,
      before ? `The default branch was at ${before} before the emergency promotion.` : null,
      b.justification ? `Justification: ${b.justification}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    await this.draft(
      {
        projectId: b.project_id,
        scope: 'production',
        title: `Post-incident review for break-glass ${breakglassId}`,
        sessionId: null,
        breakglassId,
        changeId: b.post_incident_change_id,
        causationId,
        incident,
      },
      SYSTEM,
    );
  }

  /** Job: flag post-incident change records not completed by their due time. */
  checkOverdue(): void {
    for (const b of this.read.overdueCandidates(this.ctx.clock.iso())) {
      this.ctx.store.append({
        type: 'breakglass.post_incident_overdue',
        actor: SCHEDULER,
        scope: scopeOf(b.project_id, { changeId: b.post_incident_change_id }),
        meta: { breakglassId: b.breakglass_id, changeId: b.post_incident_change_id!, dueAt: b.due_at! },
        source: 'scheduler',
        idempotencyKey: `breakglass.post_incident_overdue:${b.breakglass_id}`,
      });
      this.ctx.notify({
        kind: 'breakglass',
        title: `Post-incident change record for break-glass ${b.breakglass_id} is overdue`,
        audience: ['approver', 'builder'],
        severity: 'danger',
        refs: {
          breakglassId: b.breakglass_id,
          changeId: b.post_incident_change_id!,
          projectId: b.project_id,
        },
      });
    }
  }

  // ── provenance & promotion ───────────────────────────────────────────────
  private get lookups(): ProvenanceLookups {
    return {
      changeApproved: (id, projectId) => {
        const c = this.read.change(id);
        return !!c && c.project_id === projectId && APPROVED_STATUSES.has(c.status);
      },
      sessionChange: (sessionId, projectId) => this.read.approvedChangeForSession(sessionId, projectId),
      sessionTicket: (sessionId) =>
        this.read.sessionTicket(sessionId) ??
        this.ctx.services.maybe('sessions')?.get(sessionId)?.ticketId ??
        null,
      ticketFixPlanApproved: (ticketId) => this.read.ticketFixPlanApproved(ticketId),
    };
  }

  provenance(projectId: string, sha: string): { ok: boolean; orphanShas: string[]; reasons: string[] } {
    const d = this.provenanceDetail(projectId, sha);
    return { ok: d.ok, orphanShas: d.orphanShas, reasons: d.reasons };
  }

  /**
   * Every commit in `<default>..<sha>` must trace through an approved change record or an approved fix plan. The
   * commits are read in the service clone, against the branch as AOC last moved it when it pushes to a remote.
   */
  provenanceDetail(projectId: string, ref: string): ProvenanceDTO {
    const fail = (reason: string, sha = ref, baseRef: string | null = null): ProvenanceDTO => ({
      projectId,
      sha,
      baseRef,
      ok: false,
      commits: [],
      orphanShas: [],
      reasons: [reason],
    });
    const repo = this.repoPath(projectId);
    const git = this.ctx.services.get('git');
    if (!repo || !git.isRepo(repo)) return fail('the project repository is unknown');
    const sha = git.revParse(repo, ref);
    if (!sha) return fail(`${ref} does not resolve to a commit`);
    const branch = this.defaultBranch(projectId);
    try {
      const clone = this.withCommit(projectId, repo, sha);
      const base = this.base(repo, clone, branch, this.target(projectId, repo, clone));
      if (!base) return fail(`default branch ${branch} not found`, sha);
      return this.trace(projectId, clone, base, sha);
    } catch (err) {
      return fail(`the service clone could not check it: ${errText(err)}`, sha);
    }
  }

  async requestPromotion(
    input: { projectId: string; fromRef: string; ticketId?: string | null; changeId?: string | null },
    actor: Actor,
  ): Promise<{ promotionId: string; decisionId: string | null; refused: string[] | null }> {
    const ticketId = input.ticketId ?? null;
    const changeId = input.changeId ?? null;
    const repo = this.requireRepo(input.projectId);
    const fromSha = this.ctx.services.get('git').revParse(repo, input.fromRef);
    if (!fromSha) throw new HttpError(422, 'unknown_ref', `${input.fromRef} does not resolve to a commit`);
    const branch = this.defaultBranch(input.projectId);
    const { clone, base } = this.cloneOrFail(() => {
      const c = this.withCommit(input.projectId, repo, fromSha);
      return { clone: c, base: this.base(repo, c, branch, this.target(input.projectId, repo, c)) };
    });
    if (!base) throw new HttpError(422, 'default_branch_missing', `Default branch ${branch} not found`);
    const head = base.sha;
    const promotionId = newId('promotion', this.ctx.clock.now());
    const scope = scopeOf(input.projectId, { ticketId, changeId });
    const source = actor.kind === 'human' ? ('api' as const) : ('system' as const);
    const refuse = (reason: MetaOf<'promotion.refused'>['reason'], orphanShas: string[], why: string[]) => {
      this.ctx.store.append({
        type: 'promotion.refused',
        actor,
        scope,
        meta: { promotionId, reason, orphanShas, projectId: input.projectId, fromSha },
        source,
      });
      return { promotionId, decisionId: null, refused: why };
    };
    if (changeId) {
      const c = this.read.change(changeId);
      if (!c || c.project_id !== input.projectId || !APPROVED_STATUSES.has(c.status))
        return refuse(
          'gate_missing',
          [],
          [`change ${changeId} is not an approved change record of ${input.projectId}`],
        );
    }
    const prov = this.trace(input.projectId, clone, base, fromSha);
    if (!prov.ok) return refuse('provenance_gap', prov.orphanShas, prov.reasons);
    if (ticketId && this.read.ticketUat(ticketId) !== 'pass')
      return refuse('uat_missing', [], [`ticket ${ticketId} has no passing UAT sign-off`]);
    if (head === fromSha || clone.isAncestor(fromSha, head))
      return refuse(
        'not_fast_forward',
        [],
        [`nothing to promote: ${short(fromSha)} is already on ${branch}`],
      );
    if (!clone.isAncestor(head, fromSha))
      return refuse(
        'not_fast_forward',
        [],
        [`${input.fromRef} does not contain ${branch} (${short(head)}); rebase it first`],
      );
    const decisions = this.ctx.services.maybe('decisions');
    if (!decisions)
      throw new HttpError(503, 'decisions_unavailable', 'The decision service is not available');
    this.ctx.store.append({
      type: 'promotion.requested',
      actor,
      scope,
      meta: {
        promotionId,
        projectId: input.projectId,
        fromRef: input.fromRef,
        fromSha,
        targetBranch: branch,
        ticketId,
        changeId,
        breakglassId: null,
      },
      source,
    });
    const card = decisions.request(
      {
        kind: 'go_live',
        title: `Go live: promote ${input.fromRef} to ${branch} in ${input.projectId}`,
        question: `Promote ${short(fromSha)} (${prov.commits.length} commit${prov.commits.length === 1 ? '' : 's'}, every one traced to a gate) to ${branch}?`,
        options: APPROVE_REJECT,
        context: [
          ...prov.commits.map((c) => `${short(c.sha)} ${c.subject} [${c.via}]`),
          ...(ticketId ? [`Ticket ${ticketId}: UAT passed`] : []),
          ...(changeId ? [`Change record ${changeId}`] : []),
        ].join('\n'),
        subjectType: 'promotion',
        subjectId: promotionId,
        projectId: input.projectId,
        requesterId: actor.id,
      },
      actor,
    );
    return { promotionId, decisionId: card.id, refused: null };
  }

  /**
   * Moves the default branch to the approved SHA. Re-checked in the service clone first: it must fast-forward the
   * branch as AOC knows it now, and (except for break-glass) every commit it adds must still trace through a gate —
   * whatever the project repository's own view of the branch says. Published by `publish`.
   */
  private async executePromotion(
    p: PromotionRow,
    decisionId: string | null,
    causationId: string,
  ): Promise<void> {
    const scope = scopeOf(p.project_id, { ticketId: p.ticket_id, changeId: p.change_id });
    const idempotencyKey = `promotion.outcome:${p.promotion_id}`;
    const base = { actor: SYSTEM, scope, source: 'supervisor' as const, idempotencyKey, causationId };
    const fail = (reason: string, detail: string) => {
      this.ctx.store.append({
        ...base,
        type: 'promotion.failed',
        bodyScope: p.project_id,
        meta: { promotionId: p.promotion_id, reason },
        payload: { detail },
      });
      this.ctx.notify({
        kind: 'info',
        title: 'Promotion could not be executed',
        audience: ['approver', 'builder'],
        severity: 'danger',
        refs: { promotionId: p.promotion_id, projectId: p.project_id },
      });
    };
    const refuse = (reason: 'not_fast_forward' | 'provenance_gap', orphanShas: string[]) => {
      this.ctx.store.append({
        ...base,
        type: 'promotion.refused',
        meta: {
          promotionId: p.promotion_id,
          reason,
          orphanShas,
          projectId: p.project_id,
          ...(p.from_sha ? { fromSha: p.from_sha } : {}),
        },
      });
    };
    const repo = this.repoPath(p.project_id);
    if (!repo || !p.from_sha || !p.target_branch)
      return fail('project_repo_unknown', 'No git repository is known for the project');
    if (!this.ctx.services.maybe('supervisor'))
      return fail('supervisor_unavailable', 'No supervisor is available to execute the promotion');
    try {
      const clone = this.withCommit(p.project_id, repo, p.from_sha);
      const target = this.target(p.project_id, repo, clone);
      if (target.kind === 'unconfigured')
        return fail('promotion_remote_unconfigured', this.unconfiguredDetail(target, clone));
      const head = this.base(repo, clone, p.target_branch, target);
      if (!head) return fail('branch_missing', `${p.target_branch} does not exist`);
      if (head.sha !== p.from_sha) {
        if (!clone.isAncestor(head.sha, p.from_sha)) return refuse('not_fast_forward', []);
        if (!p.breakglass_id) {
          const prov = this.trace(p.project_id, clone, head, p.from_sha);
          if (!prov.ok) return refuse('provenance_gap', prov.orphanShas);
        }
      }
      const res = await this.publish({
        repo,
        clone,
        target,
        branch: p.target_branch,
        base: head,
        next: p.from_sha,
      });
      if (!res.ok) return 'refused' in res ? refuse('not_fast_forward', []) : fail(res.failed, res.detail);
      this.ctx.store.append({
        ...base,
        type: 'promotion.completed',
        meta: {
          promotionId: p.promotion_id,
          mainShaBefore: res.before,
          mainShaAfter: res.after,
          breakglass: !!p.breakglass_id,
          decisionId,
          ticketId: p.ticket_id,
        },
      });
      if (res.warning)
        this.ctx.notify({
          kind: 'info',
          title: 'Promotion pushed, local branch not updated',
          audience: ['approver', 'builder'],
          severity: 'warn',
          refs: { promotionId: p.promotion_id },
        });
    } catch (err) {
      fail(err instanceof RepoOpError ? err.reason : 'execution_error', errText(err));
    }
  }

  promotionDto(id: string): PromotionDTO | null {
    return this.read.promotionDto(id);
  }
}
