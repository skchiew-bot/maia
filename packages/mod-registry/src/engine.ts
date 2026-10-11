import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import {
  modelTierOf,
  newId,
  PLAYBOOK_STEPS_MAX,
  ProcessRegistrySchema,
  routeModel,
  type Actor,
  type DistillResponse,
  type KnowledgeKind,
  type KnowledgeSearchResponse,
  type MetaOf,
  type ModelTier,
  type PayloadOf,
  type PlaybookDTO,
  type PlaybookInfo,
  type PlaybookRetireReason,
  type PlaybookStatus,
  type ProcessRegistry,
  type ProcessType,
  type RegistryEntry,
  type RegistryRunDTO,
  type RegistryPlaybookStatus,
  type RegistryService,
  type RegistryTypesResponse,
  type StoredEvent,
  type User,
} from '@aoc/contracts';
import {
  distill as distillWithModel,
  gateVerdict,
  idList,
  proposeForApproval,
  provenanceIds,
  readsUntrustedInput,
  withFallback,
  type Distilled,
} from '@aoc/distill';
import { HttpError, type ModuleContext, type NewEvent } from '@aoc/kernel';
import { estimateCostUsd, type TokenRate } from './costs';
import {
  candidateSteps,
  digestRun,
  DISTILL_EVENT_TYPES,
  fallbackPlaybook,
  PLAYBOOK_GATE,
  playbookRequest,
  type PlaybookDraft,
  type RunEvent,
} from './distill';
import { computeRegistryEntries, runKind, type CostedRun } from './economics';
import { searchKnowledge } from './knowledge';
import {
  activePlaybookRow,
  approvalIntervals,
  getPlaybookRow,
  listPlaybookRows,
  listRunChains,
  nextPlaybookVersion,
  pendingPlaybookRow,
  playbookByDecision,
  playbookCount,
  runChainOf,
  toPlaybookDTO,
  toPlaybookInfo,
  usageOf,
  type PlaybookRow,
  type RunChain,
} from './projections';
import { diffRegistries, type LoadedRegistry } from './registry-file';

const SYSTEM_ACTOR: Actor = { kind: 'system', id: 'registry' };

export interface EngineOptions {
  rates: Record<ModelTier, TokenRate>;
  trendWeeks: number;
}

/** Thrown inside the module and mapped to HTTP by the routes; carries a machine code and an explanation. */
const refuse = (status: 403 | 404 | 409 | 422 | 503, code: string, message: string, details?: unknown) =>
  new HttpError(status, code, message, details);

export class RegistryEngine {
  /** Process types with a distillation in flight (the LLM call is async; one proposal per type at a time). */
  private readonly distilling = new Set<string>();

  constructor(
    private readonly ctx: ModuleContext,
    private readonly loaded: LoadedRegistry,
    private readonly opts: EngineOptions,
  ) {}

  // ── RegistryService ──────────────────────────────────────────────────────
  /** The narrow service other modules see. modelFor takes the type only: budget/credits cannot reach routing (§10, R8). */
  service(): RegistryService {
    return {
      listTypes: () => [...this.loaded.registry.types],
      getType: (id) => this.getType(id),
      activePlaybook: (t) => this.activePlaybook(t),
      modelFor: (t) => this.modelFor(t),
    };
  }

  getType(id: string): ProcessType | null {
    return this.loaded.types.get(id) ?? null;
  }

  activePlaybook(processType: string): PlaybookInfo | null {
    const row = activePlaybookRow(this.ctx.db, processType);
    return row ? toPlaybookInfo(row) : null;
  }

  modelFor(processType: string): ModelTier {
    const t = this.getType(processType);
    if (!t)
      throw new Error(
        `unknown process type "${processType}": not in the fixed registry (${this.loaded.path})`,
      );
    return routeModel(t, this.activePlaybook(processType) !== null);
  }

  typesResponse(): RegistryTypesResponse {
    return {
      version: this.loaded.registry.version,
      versionHash: this.loaded.hash,
      types: this.loaded.registry.types.map((t) => ({
        ...t,
        currentModel: this.modelFor(t.id),
        activePlaybookId: activePlaybookRow(this.ctx.db, t.id)?.playbook_id ?? null,
      })),
    };
  }

  // ── audited change of the fixed list (§2.2) ──────────────────────────────
  recordRegistryChange(): StoredEvent | null {
    const last = this.ctx.store.list({ types: ['registry.changed'], order: 'desc', limit: 1 })[0] ?? null;
    const previousHash = last ? (last.meta as MetaOf<'registry.changed'>).versionHash : null;
    if (previousHash === this.loaded.hash) return null;
    let prev: ProcessRegistry | null = null;
    if (last) {
      const snap = ProcessRegistrySchema.safeParse(
        (this.ctx.store.readPayload(last) as PayloadOf<'registry.changed'> | null)?.snapshot,
      );
      prev = snap.success ? snap.data : null;
    }
    const { registry } = this.loaded;
    return this.ctx.store.append({
      type: 'registry.changed',
      actor: SYSTEM_ACTOR,
      meta: { versionHash: this.loaded.hash, previousHash, typeCount: registry.types.length },
      payload: {
        diffSummary: diffRegistries(prev, registry, last !== null),
        registryVersion: registry.version,
        snapshot: registry,
      },
      source: 'system',
      bodyScope: 'registry',
    });
  }

  // ── playbooks ────────────────────────────────────────────────────────────
  playbookDTO(row: PlaybookRow): PlaybookDTO {
    return toPlaybookDTO(row, activePlaybookRow(this.ctx.db, row.process_type)?.playbook_id ?? null);
  }

  listPlaybooks(f: { processType?: string; status?: PlaybookStatus }): PlaybookDTO[] {
    return listPlaybookRows(this.ctx.db, f).map((r) => this.playbookDTO(r));
  }

  getPlaybook(id: string): PlaybookDTO | null {
    const row = getPlaybookRow(this.ctx.db, id);
    return row ? this.playbookDTO(row) : null;
  }

  async distill(sessionId: string, user: User): Promise<DistillResponse> {
    const chain = runChainOf(this.ctx.db, sessionId);
    if (!chain)
      throw refuse(
        404,
        'run_not_found',
        `No managed run for session ${sessionId}: only runs launched through AOC (session.launch_requested) can be distilled.`,
      );
    const type = this.getType(chain.processType);
    if (!type)
      throw refuse(
        422,
        'unknown_process_type',
        `Run ${chain.rootSessionId} has process type "${chain.processType}", which is not in the fixed registry.`,
      );
    this.assertSelfModificationBoundary(chain);

    const last = chain.sessions[chain.sessions.length - 1]!;
    if (!chain.finished)
      throw refuse(
        422,
        'run_not_successful',
        `Only a successful run can be distilled: run ${chain.rootSessionId} has not ended.`,
        { reason: 'not_ended' },
      );
    if (chain.outcome !== 'completed') {
      throw refuse(
        422,
        'run_not_successful',
        `Only a successful run can be distilled: run ${chain.rootSessionId} ended ${chain.outcome}.`,
        { reason: 'not_completed', outcome: chain.outcome, sessionId: last.session_id },
      );
    }
    const digest = digestRun(this.runEvents(chain));
    if (!digest.hasPlan)
      throw refuse(
        422,
        'run_not_successful',
        `Run ${chain.rootSessionId} declared no plan manifest, so there are no tasks to distill.`,
        { reason: 'no_plan' },
      );
    if (digest.manifestErased) {
      throw refuse(
        422,
        'run_not_successful',
        `Run ${chain.rootSessionId} has an erased plan manifest: its success cannot be verified.`,
        { reason: 'manifest_erased' },
      );
    }
    if (digest.openTaskIds.length) {
      throw refuse(
        422,
        'run_not_successful',
        `Only a successful run can be distilled: ${digest.openTaskIds.length} declared task(s) of run ${chain.rootSessionId} are not done.`,
        {
          reason: 'tasks_open',
          openTaskIds: digest.openTaskIds,
        },
      );
    }
    if (!digest.tasks.length)
      throw refuse(
        422,
        'run_not_successful',
        `Run ${chain.rootSessionId} completed no tasks, so there is nothing to distill.`,
        { reason: 'no_tasks_done' },
      );
    // O-17: a playbook is injected into every run of its type, so its length is capped; the fallback has one step
    // per completed task.
    if (digest.tasks.length > PLAYBOOK_STEPS_MAX)
      throw refuse(
        422,
        'run_too_large',
        `Run ${chain.rootSessionId} completed ${digest.tasks.length} tasks; a playbook holds at most ${PLAYBOOK_STEPS_MAX} steps.`,
        { tasks: digest.tasks.length },
      );
    const decisions = this.ctx.services.maybe('decisions');
    if (!decisions)
      throw refuse(
        503,
        'decisions_unavailable',
        'Playbooks need the Approver gate, but no decision service is loaded.',
      );
    this.assertNotDuplicate(chain, type);
    if (this.distilling.has(type.id))
      throw refuse(409, 'distill_in_progress', `A playbook for "${type.id}" is already being distilled.`);

    this.distilling.add(type.id);
    try {
      const distilled = await this.refine(type, chain, digest);
      const { method, value: draft } = distilled;
      // Synchronous from here: re-check, raise the gate and record the proposal without yielding.
      this.assertNotDuplicate(chain, type);
      const playbookId = newId('playbook', this.ctx.clock.now());
      const version = nextPlaybookVersion(this.ctx.db, type.id);
      const actor: Actor = { kind: 'human', id: user.id };
      const prov = this.runProvenance(chain, type);
      const { card } = proposeForApproval({
        decisions,
        gate: PLAYBOOK_GATE,
        request: {
          title: `Approve playbook: ${type.name} v${version}`,
          question: `Approve this distilled ${draft.steps.length}-step playbook for "${type.name}"? ${routingNote(type)}`,
          options: [
            {
              id: 'approve',
              label: 'Approve',
              description: 'Bind the playbook: new runs of this type follow it.',
            },
            { id: 'reject', label: 'Reject', description: 'Discard the proposal.' },
          ],
          context: approvalContext(distilled, chain, digest, prov),
          subjectType: 'playbook',
          subjectId: playbookId,
          sessionId: null,
          projectId: chain.projectId,
          requesterId: user.id,
        },
        actor,
        withdrawAs: SYSTEM_ACTOR,
        record: (c) =>
          this.ctx.store.append({
            type: 'playbook.proposed',
            actor,
            scope: { sessionId: last.session_id, projectId: chain.projectId ?? undefined, decisionId: c.id },
            meta: {
              playbookId,
              processType: type.id,
              sourceSessionId: last.session_id,
              version,
              stepCount: draft.steps.length,
              decisionId: c.id,
              method,
              sourceSessionIds: prov.sessionIds,
              ticketId: prov.ticketId,
              untrustedSessionIds: prov.untrustedSessionIds,
            },
            payload: {
              title: draft.title,
              steps: draft.steps,
              ...(draft.rationale ? { rationale: draft.rationale } : {}),
            },
            source: 'api',
            // Own key scope: the playbook outlives (and is erased independently of) the session it came from.
            bodyScope: playbookId,
          }),
      });
      return { playbook: this.getPlaybook(playbookId)!, decisionId: card.id, method };
    } finally {
      this.distilling.delete(type.id);
    }
  }

  /** The model refines the run's ordered tasks; any model failure keeps the deterministic candidate. */
  private async refine(
    type: ProcessType,
    chain: RunChain,
    digest: ReturnType<typeof digestRun>,
  ): Promise<Distilled<PlaybookDraft>> {
    const llm = this.ctx.services.maybe('llm');
    const out = withFallback(
      await distillWithModel(llm, playbookRequest(type, digest, candidateSteps(digest))),
      (reason) => fallbackPlaybook(type, chain.rootSessionId, digest, reason),
    );
    if (out.method === 'fallback' && llm) {
      this.ctx.log.warn('playbook distillation fell back to ordered tasks', {
        processType: type.id,
        sessionId: chain.rootSessionId,
        reason: out.reason,
        detail: out.detail,
      });
    }
    return out;
  }

  /** Every session of the run, its ticket, and which sessions read untrusted input (T-15). */
  private runProvenance(chain: RunChain, type: ProcessType): RunProvenance {
    const sessions = this.ctx.services.maybe('sessions');
    const infos = chain.sessions.map((s) => ({ id: s.session_id, info: sessions?.get(s.session_id) ?? null }));
    return {
      sessionIds: provenanceIds(infos.map((s) => s.id)),
      ticketId: infos.find((s) => s.info?.ticketId)?.info?.ticketId ?? null,
      untrustedSessionIds: provenanceIds(infos.filter((s) => readsUntrustedInput(s.info, type)).map((s) => s.id)),
    };
  }

  private assertNotDuplicate(chain: RunChain, type: ProcessType): void {
    const fromRun = listPlaybookRows(this.ctx.db, { processType: type.id }).find(
      (p) =>
        (p.status === 'proposed' || p.status === 'approved') &&
        chain.sessions.some((s) => s.session_id === p.source_session_id),
    );
    if (fromRun)
      throw refuse(
        409,
        'already_distilled',
        `Run ${chain.rootSessionId} already produced playbook ${fromRun.playbook_id} (${fromRun.status}).`,
        { playbookId: fromRun.playbook_id },
      );
    const pending = pendingPlaybookRow(this.ctx.db, type.id);
    if (pending) {
      throw refuse(
        409,
        'proposal_pending',
        `Playbook ${pending.playbook_id} for "${type.id}" is still waiting for the Approver; resolve or retire it first.`,
        {
          playbookId: pending.playbook_id,
          decisionId: pending.decision_id,
        },
      );
    }
  }

  /**
   * Self-modification boundary (§13): AOC may build its own features, but it must not distill
   * playbooks that steer agents working on the AOC platform itself. A run whose working directory (or
   * project repository) lies inside a configured AOC repo is refused; an unknown cwd fails closed.
   */
  private assertSelfModificationBoundary(chain: RunChain): void {
    const roots = this.ctx.config.selfModification.aocRepoPaths.map(canonicalPath);
    if (!roots.length) return;
    const dirs = chain.sessions.map((s) => ({ sessionId: s.session_id, dir: this.sessionCwd(s.session_id) }));
    const repo = chain.projectId
      ? (this.ctx.services.maybe('ledger')?.projectRepoPath(chain.projectId) ?? null)
      : null;
    if (repo) dirs.push({ sessionId: chain.rootSessionId, dir: repo });
    for (const { sessionId, dir } of dirs) {
      if (!dir) continue;
      const path = canonicalPath(dir);
      const root = roots.find((r) => path === r || path.startsWith(r.endsWith(sep) ? r : `${r}${sep}`));
      if (root) {
        throw refuse(
          403,
          'self_modification_boundary',
          `Refused by the self-modification boundary (§13): session ${sessionId} worked in ${dir}, inside the AOC platform repository ${root}. ` +
            'AOC may build its own features, but it never distills playbooks for work on the platform itself: its governance, audit and credit core ' +
            'stay human-built and human-changed, and AOC self-changes are audited outside AOC — the system must not mark its own homework.',
          { reason: 'aoc_repo', sessionId, aocRepoPath: root },
        );
      }
    }
    if (dirs.every((d) => !d.dir)) {
      throw refuse(
        403,
        'self_modification_boundary',
        `Refused by the self-modification boundary (§13): the working directory of run ${chain.rootSessionId} is unknown, so it cannot be shown to lie outside the AOC platform repositories.`,
        { reason: 'cwd_unknown' },
      );
    }
  }

  private sessionCwd(sessionId: string): string | null {
    for (const e of this.ctx.store.list({
      sessionId,
      types: ['session.launch_requested', 'session.launched'],
      limit: 20,
    })) {
      const cwd = (this.ctx.store.readPayload(e) as { cwd?: unknown } | null)?.cwd;
      if (typeof cwd === 'string' && cwd) return cwd;
    }
    return this.ctx.services.maybe('sessions')?.get(sessionId)?.cwd ?? null;
  }

  private runEvents(chain: RunChain): RunEvent[] {
    const out: RunEvent[] = [];
    for (const s of chain.sessions) {
      const cwd = this.sessionCwd(s.session_id);
      for (const e of this.ctx.store.list({
        sessionId: s.session_id,
        types: [...DISTILL_EVENT_TYPES],
        limit: 100_000,
      })) {
        out.push({ e, payload: this.ctx.store.readPayload(e), cwd });
      }
    }
    return out;
  }

  retire(playbookId: string, reason: PlaybookRetireReason, user: User): PlaybookDTO {
    const row = getPlaybookRow(this.ctx.db, playbookId);
    if (!row) throw refuse(404, 'playbook_not_found', `No playbook ${playbookId}.`);
    if (row.status !== 'proposed' && row.status !== 'approved')
      throw refuse(409, 'not_retirable', `Playbook ${playbookId} is already ${row.status}.`);
    const actor: Actor = { kind: 'human', id: user.id };
    this.ctx.store.append({
      type: 'playbook.retired',
      actor,
      scope: { projectId: row.project_id ?? undefined, decisionId: row.decision_id },
      meta: { playbookId, reason },
      source: 'api',
    });
    if (row.status === 'proposed') {
      try {
        this.ctx.services.maybe('decisions')?.withdraw(row.decision_id, 'playbook_retired', actor);
      } catch (err) {
        this.ctx.log.warn('could not withdraw playbook approval decision', {
          playbookId,
          decisionId: row.decision_id,
          err: String(err),
        });
      }
    }
    return this.getPlaybook(playbookId)!;
  }

  /** Reactor: the Approver's decision binds or discards the proposal. Idempotent (status + causation checks). */
  onDecision(e: StoredEvent): void {
    const verdict = gateVerdict(PLAYBOOK_GATE, e);
    if (!verdict) return;
    const { store, db } = this.ctx;
    const decisionId = (e.meta as { decisionId: string }).decisionId;
    const row = playbookByDecision(db, decisionId);
    if (!row || row.status !== 'proposed') return;
    if (store.findByCausation(e.id).some((x) => x.type.startsWith('playbook.'))) return;
    const scope = { projectId: row.project_id ?? undefined, decisionId };
    // A withdrawn or expired approval card never binds the proposal.
    if (verdict === 'withdrawn') {
      store.append({
        type: 'playbook.retired',
        actor: SYSTEM_ACTOR,
        scope,
        meta: { playbookId: row.playbook_id, reason: 'decision_withdrawn' },
        source: 'system',
        causationId: e.id,
      });
      return;
    }
    const m = e.meta as MetaOf<'decision.resolved'>;
    // The gate is human-only: a reject, and any policy (machine) resolution, discards the proposal.
    if (verdict === 'rejected') {
      store.append({
        type: 'playbook.rejected',
        actor: e.actor,
        scope,
        meta: { playbookId: row.playbook_id, decisionId, approverId: m.resolvedBy },
        source: 'system',
        causationId: e.id,
      });
      return;
    }
    const superseded = listPlaybookRows(db, { processType: row.process_type, status: 'approved' });
    const events: NewEvent[] = [
      {
        type: 'playbook.approved',
        actor: e.actor,
        scope,
        meta: { playbookId: row.playbook_id, decisionId, approverId: m.resolvedBy },
        source: 'system',
        causationId: e.id,
      } satisfies NewEvent<'playbook.approved'>,
      ...superseded.map(
        (p) =>
          ({
            type: 'playbook.retired',
            actor: e.actor,
            scope: { projectId: p.project_id ?? undefined, decisionId },
            meta: { playbookId: p.playbook_id, reason: 'superseded' },
            source: 'system',
            causationId: e.id,
          }) satisfies NewEvent<'playbook.retired'>,
      ),
    ];
    store.appendMany(events);
  }

  // ── economics ────────────────────────────────────────────────────────────
  /** Every run chain with its cost, tokens and duration (shared by the hero economics and the runs list). */
  private costedRuns(): { chain: RunChain; run: CostedRun }[] {
    const db = this.ctx.db;
    const metering = this.ctx.services.maybe('metering');
    const sessionCost = (
      sessionId: string,
      launchModel: string,
    ): { usd: number; basis: 'metered' | 'estimated' } => {
      if (metering) {
        try {
          return { usd: metering.sessionCostUsd(sessionId), basis: 'metered' };
        } catch (err) {
          this.ctx.log.warn('metering.sessionCostUsd failed; using token estimate', {
            sessionId,
            err: String(err),
          });
        }
      }
      const fallbackTier = modelTierOf(launchModel);
      let usd = 0;
      for (const u of usageOf(db, sessionId)) {
        const tier = modelTierOf(u.model);
        const rate =
          this.opts.rates[tier !== 'unknown' ? tier : fallbackTier !== 'unknown' ? fallbackTier : 'opus'];
        usd += estimateCostUsd(
          {
            inputTokens: u.input_tokens,
            outputTokens: u.output_tokens,
            cacheReadTokens: u.cache_read_tokens,
            cacheWrite5mTokens: u.cache_write_5m_tokens,
            cacheWrite1hTokens: u.cache_write_1h_tokens,
          },
          rate,
        );
      }
      return { usd, basis: 'estimated' };
    };
    const tokensOf = (sessionId: string) =>
      usageOf(db, sessionId).reduce(
        (a, u) =>
          a +
          u.input_tokens +
          u.output_tokens +
          u.cache_read_tokens +
          u.cache_write_5m_tokens +
          u.cache_write_1h_tokens,
        0,
      );
    return listRunChains(db).map((chain) => {
      const costs = chain.sessions.map((s) => sessionCost(s.session_id, s.model));
      const endedAt = chain.finished ? chain.sessions[chain.sessions.length - 1]!.ended_at : null;
      const run: CostedRun = {
        rootSessionId: chain.rootSessionId,
        processType: chain.processType,
        launchedAtMs: Date.parse(chain.launchedAt),
        launchSeq: chain.launchSeq,
        finished: chain.finished,
        outcome: chain.outcome,
        costUsd: costs.reduce((a, x) => a + x.usd, 0),
        costBasis: costs.every((x) => x.basis === 'metered') ? 'metered' : 'estimated',
        tokens: chain.sessions.reduce((a, s) => a + tokensOf(s.session_id), 0),
        durationMs: endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(chain.launchedAt)) : null,
      };
      return { chain, run };
    });
  }

  entries(): RegistryEntry[] {
    const db = this.ctx.db;
    const metering = this.ctx.services.maybe('metering');
    const learning = this.ctx.services.maybe('learning');
    const runs = this.costedRuns().map((x) => x.run);
    const fx = this.ctx.services.maybe('fx');
    const fxRate = (date: string): number | null => {
      try {
        return (fx?.rateFor(date) ?? metering?.fxRate(date) ?? null)?.rate ?? null;
      } catch {
        return null;
      }
    };
    return computeRegistryEntries({
      types: this.loaded.registry.types,
      runs,
      approvals: approvalIntervals(db),
      playbookStatus: (t) => this.playbookStatus(t),
      currentModel: (t) => this.modelFor(t.id),
      lessonsInScope: (t) => {
        if (!learning) return null;
        try {
          return learning.lessonsForScope({ processType: t }).length;
        } catch {
          return null;
        }
      },
      rates: this.opts.rates,
      nowMs: this.ctx.clock.now(),
      timezone: this.ctx.config.timezone,
      weeks: this.opts.trendWeeks,
      fxRate,
    });
  }

  /** Runs newest first, with their kind (discovery / execution) and any playbook distilled from them. */
  runs(filter: { processType?: string; outcome?: string; limit: number }): RegistryRunDTO[] {
    const approvals = approvalIntervals(this.ctx.db);
    const distilledFrom = new Map<string, string>();
    for (const p of listPlaybookRows(this.ctx.db, {}))
      if (p.source_session_id && (p.status === 'proposed' || p.status === 'approved'))
        distilledFrom.set(p.source_session_id, p.playbook_id);
    return this.costedRuns()
      .filter(
        ({ chain }) =>
          (!filter.processType || chain.processType === filter.processType) &&
          (!filter.outcome || (chain.finished && chain.outcome === filter.outcome)),
      )
      .sort((a, b) => b.chain.launchSeq - a.chain.launchSeq)
      .slice(0, filter.limit)
      .map(({ chain, run }) => {
        const type = this.getType(chain.processType);
        const last = chain.sessions[chain.sessions.length - 1]!;
        return {
          runId: chain.rootSessionId,
          lastSessionId: last.session_id,
          sessions: chain.sessions.length,
          processType: chain.processType,
          projectId: chain.projectId,
          model: chain.model,
          kind: type ? runKind(type, chain.launchSeq, approvals) : 'discovery',
          launchedAt: chain.launchedAt,
          endedAt: chain.finished ? last.ended_at : null,
          outcome: chain.finished ? chain.outcome : null,
          finished: chain.finished,
          costUsd: Math.round(run.costUsd * 10_000) / 10_000,
          costBasis: run.costBasis,
          tokens: run.tokens,
          durationMs: run.durationMs,
          playbookId: chain.sessions.map((s) => distilledFrom.get(s.session_id)).find(Boolean) ?? null,
        };
      });
  }

  private playbookStatus(processType: string): RegistryPlaybookStatus {
    const active = activePlaybookRow(this.ctx.db, processType);
    const pending = pendingPlaybookRow(this.ctx.db, processType);
    return {
      status: active ? 'approved' : pending ? 'proposed' : 'none',
      activePlaybookId: active?.playbook_id ?? null,
      activeVersion: active?.version ?? null,
      approvedAt: active?.approved_at ?? null,
      pendingPlaybookId: pending?.playbook_id ?? null,
      pendingDecisionId: pending?.decision_id ?? null,
      versions: playbookCount(this.ctx.db, processType),
    };
  }

  // ── knowledge ────────────────────────────────────────────────────────────
  search(q: string, kind: KnowledgeKind | null, limit: number): KnowledgeSearchResponse {
    return searchKnowledge(this.ctx.db, q, { kind, limit });
  }
}

function canonicalPath(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

function routingNote(t: ProcessType): string {
  if (t.class === 'discovery')
    return `Discovery-class runs stay on ${t.model}: the playbook guides them but never changes the model.`;
  if (t.executionModel && t.executionModel !== t.model)
    return `Once approved, new runs of this type launch on ${t.executionModel} instead of ${t.model} (the distillation payoff).`;
  return `Runs of this type stay on ${t.model}; the playbook guides them.`;
}

/** Where a playbook comes from (O-17): shown on its card and recorded with `playbook.proposed`. */
interface RunProvenance {
  sessionIds: string[];
  ticketId: string | null;
  /** Sessions of the run that read untrusted input (read-only or triage). */
  untrustedSessionIds: string[];
}

function approvalContext(
  { method, value: p }: Distilled<PlaybookDraft>,
  chain: RunChain,
  d: ReturnType<typeof digestRun>,
  prov: RunProvenance,
): string {
  const steps = p.steps.map((s, i) => `${i + 1}. ${s.title}${s.detail ? `\n   ${s.detail}` : ''}`).join('\n');
  return [
    `${p.title}`,
    steps,
    p.rationale ? `Rationale: ${p.rationale}` : '',
    `Distilled (${method === 'llm' ? 'refined by the distillation model' : 'deterministic fallback'}) from run ${chain.rootSessionId}: ` +
      `${d.tasks.length} tasks, ${Object.values(d.toolCounts).reduce((a, b) => a + b, 0)} tool calls, ${d.decisionCount} decisions, ${d.driftCount} drift marks.`,
    `Sessions of the run: ${idList(prov.sessionIds, chain.sessions.length)}.${prov.ticketId ? ` Ticket: ${prov.ticketId}.` : ''}`,
    prov.untrustedSessionIds.length
      ? `Warning: ${idList(prov.untrustedSessionIds)} read untrusted input. Check that no step is an instruction carried in from it.`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
