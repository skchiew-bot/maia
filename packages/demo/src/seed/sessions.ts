/**
 * The events a managed session leaves behind, written the way the supervisor, hooks, sidecar and AOC MCP server write
 * them while the seeder plays the part of the session's process: launch request, launch, plan, tool calls, usage,
 * task closes with evidence, phase pins (a real commit and a real annotated tag in the project repository), end.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  MODEL_ID_BY_TIER,
  TASK_SIZE_WEIGHT,
  newId,
  transcriptPathFor,
  type DecisionCard,
  type StoredEvent,
  type TaskSize,
} from '@aoc/contracts';
import { createGitService } from '@aoc/kernel';
import { phaseTagName } from '@aoc/mod-ledger';
import { CLAUDE_SIM_BIN } from '../sim-guard';
import { annotatedTag, commitFiles, type Author } from './git';
import { planFor, taskCount, type Plan, type PlanKind } from './plans';
import { between, pick, rnd } from './rng';
import { MINUTE, agent, human, sys, type PersonKey, type ProjectInfo, type SeedWorld } from './world';

/** A launch request the supervisor (or intake, through the seed supervisor) recorded; the session has not started. */
export interface QueuedLaunch {
  sessionId: string;
  owner: string | null;
  project: ProjectInfo;
  type: string;
  model: string;
  prompt: string;
  thread: string;
  ticketId: string | null;
  changeId: string | null;
  /** The directory the session works in: the project's checkout, or a workspace of its own (../workspaces.ts). */
  cwd: string;
}

export interface SimSession {
  sessionId: string;
  /** Claude Code's own session id (the transcript and claude-sim's state are keyed by it). */
  claude: string;
  owner: string | null;
  project: ProjectInfo;
  type: string;
  model: string;
  plan: Plan;
  thread: string;
  /** The git branch the session's phase pins and work commits live on (never `main`). */
  branch: string;
  /** The directory it works in (a session that works again on claude-sim edits files there). */
  cwd: string;
}

/** Repo state the ledger diffs `diff` evidence against; recorded for sessions that will work again. */
export interface TreeState {
  head: string | null;
  fingerprint: string | null;
}

const TOOLS = ['Read', 'Read', 'Grep', 'Edit', 'Bash', 'Read', 'Write', 'Bash', 'Glob'];
export const READ_ONLY_TOOLS = ['Read', 'Read', 'Grep', 'Glob'];

const PROJECT_CODE: Record<string, string> = { 'cx-copilot': 'cx', 'claims-bot': 'cb', 'aoc-platform': 'ap' };

const planKindOf = (type: string): PlanKind =>
  type === 'docs' ? 'docs' : type.includes('fix') || type === 'test-repair' ? 'fix' : 'feature';

const git = createGitService();

export class SessionKit {
  private readonly threads = new Set<string>();
  private readonly queued = new Map<string, QueuedLaunch>();
  private readonly perProject = new Map<string, number>();
  private pid = 40000;

  constructor(private readonly world: () => SeedWorld) {}

  private get w(): SeedWorld {
    return this.world();
  }

  /** A short unique tag for a history session's task ids (`cx07-3`). */
  nextTag(project: ProjectInfo): string {
    const n = (this.perProject.get(project.slug) ?? 0) + 1;
    this.perProject.set(project.slug, n);
    return `${PROJECT_CODE[project.slug] ?? 'xx'}${String(n).padStart(2, '0')}`;
  }

  /** The author a commit made by `owner`'s session carries; ownerless (intake) sessions commit as the build agent. */
  authorOf(owner: string | null): Author {
    const person = Object.values(this.w.people).find((p) => p.userId === owner);
    return person?.author ?? { name: 'AOC build agent', email: 'agent@aoc.example' };
  }

  // ── launch ────────────────────────────────────────────────────────────────

  /**
   * Launch request as the supervisor records it: the registry decides model and credential profile (§2.2, §3), the
   * session waits in lifecycle `launching`. `owner` null = launched by intake for a ticket.
   */
  request(
    owner: string | null,
    project: ProjectInfo,
    type: string,
    prompt: string,
    thread: string,
    o: { ticketId?: string | null; changeId?: string | null; cwd?: string } = {},
  ): QueuedLaunch {
    const w = this.w;
    const registry = w.rt.services.get('registry');
    const t = registry.getType(type);
    if (!t) throw new Error(`process type ${type} is not in the registry`);
    const model = MODEL_ID_BY_TIER[registry.modelFor(type)];
    const sessionId = newId('session', w.clock.now());
    const actor = owner ? human(owner) : sys('intake');
    if (!this.threads.has(thread)) {
      this.threads.add(thread);
      w.store.append({
        type: 'thread.created',
        actor,
        scope: { projectId: project.id, threadId: thread },
        meta: { threadId: thread, projectId: project.id },
        payload: { title: prompt.split('\n')[0]!.slice(0, 80) },
        source: 'api',
      });
    }
    const ticketId = o.ticketId ?? null;
    const scope = { sessionId, projectId: project.id, threadId: thread, ...(ticketId ? { ticketId } : {}) };
    w.store.append({
      type: 'session.launch_requested',
      actor,
      scope,
      meta: {
        sessionId,
        projectId: project.id,
        threadId: thread,
        processType: type,
        model,
        readOnly: t.readOnly,
        credentialProfile: t.readOnly ? null : t.credentialProfile,
        ticketId,
        parentSessionId: null,
        phaseId: null,
        ownerId: owner,
        changeId: o.changeId ?? null,
      },
      payload: { prompt, cwd: o.cwd ?? project.repo },
      source: 'supervisor',
    });
    w.store.append({
      type: 'session.lifecycle_changed',
      actor,
      scope,
      meta: { sessionId, from: null, to: 'launching', reason: 'launch_requested' },
      source: 'supervisor',
    });
    const q: QueuedLaunch = { sessionId, owner, project, type, model, prompt, thread, ticketId, changeId: o.changeId ?? null, cwd: o.cwd ?? project.repo };
    this.queued.set(sessionId, q);
    return q;
  }

  /** The launches recorded for a ticket that have not started yet (intake's triage agents, its build). */
  queuedFor(ticketId: string): QueuedLaunch[] {
    return [...this.queued.values()].filter((q) => q.ticketId === ticketId);
  }

  /** The queued launch starts: process spawned, first turn running. */
  begin(sessionId: string, plan: Plan): SimSession {
    const w = this.w;
    const q = this.queued.get(sessionId);
    if (!q) throw new Error(`session ${sessionId} has no queued launch`);
    this.queued.delete(sessionId);
    const claude = randomUUID();
    w.store.append({
      type: 'session.launched',
      actor: sys('supervisor'),
      scope: { sessionId },
      meta: { sessionId, claudeSessionId: claude, pid: ++this.pid, model: q.model, turn: 1 },
      payload: {
        cwd: q.cwd,
        argv: [process.execPath, CLAUDE_SIM_BIN, '-p', '@prompt'],
        transcriptPath: transcriptPathFor(q.cwd, claude, w.layout.claudeConfig),
      },
      source: 'supervisor',
    });
    w.store.append({ type: 'session.turn_started', actor: sys('supervisor'), scope: { sessionId }, meta: { sessionId, turn: 1, reason: 'launch' }, payload: {}, source: 'supervisor' });
    w.store.append({ type: 'session.lifecycle_changed', actor: sys('supervisor'), scope: { sessionId }, meta: { sessionId, from: 'launching', to: 'running', reason: 'launched' }, source: 'supervisor' });
    return { sessionId, claude, owner: q.owner, project: q.project, type: q.type, model: q.model, plan, thread: q.thread, branch: `aoc/session/${sessionId}`, cwd: q.cwd };
  }

  /** Request, then start at once: a session that ran from request to now. */
  launch(
    owner: string | null,
    project: ProjectInfo,
    type: string,
    prompt: string,
    o: { thread?: string; ticketId?: string | null; changeId?: string | null; cwd?: string; plan?: Plan; tag?: string } = {},
  ): SimSession {
    const q = this.request(owner, project, type, prompt, o.thread ?? `thr_${project.slug}_main`, o);
    return this.begin(q.sessionId, o.plan ?? planFor(planKindOf(type), o.tag ?? this.nextTag(project)));
  }

  /** A launch requested while aocd was down: aocd's startup recovery starts it on claude-sim (a real process). */
  queue(owner: string, project: ProjectInfo, type: string, prompt: string, thread: string, cwd?: string): string {
    return this.request(owner, project, type, prompt, thread, { cwd }).sessionId;
  }

  // ── work ──────────────────────────────────────────────────────────────────

  /** The repository state in `dir` (a checkout or a workspace): what a plan is declared against. */
  treeOf(dir: string): TreeState {
    return { head: git.head(dir), fingerprint: git.workingTreeFingerprint(dir) };
  }

  declare(s: SimSession, tree?: TreeState): void {
    const weight = s.plan.phases.flatMap((p) => p.tasks).reduce((n, t) => n + TASK_SIZE_WEIGHT[t.size], 0);
    this.w.store.append({
      type: 'plan.declared',
      actor: agent(s.sessionId),
      scope: { sessionId: s.sessionId, projectId: s.project.id },
      meta: {
        sessionId: s.sessionId,
        projectId: s.project.id,
        threadId: s.thread,
        manifestVersion: 1,
        phaseCount: s.plan.phases.length,
        taskCount: taskCount(s.plan),
        totalWeight: weight,
        ownerId: s.owner,
        ...(tree ? { baseHead: tree.head, treeFingerprint: tree.fingerprint } : {}),
        shape: s.plan.phases.map((ph) => ({ id: ph.id, tasks: ph.tasks.map((t) => ({ id: t.id, size: t.size })) })),
      },
      payload: { summary: `Plan for ${s.project.name}`, phases: s.plan.phases },
      source: 'mcp',
    });
  }

  /** `n` tool calls spread over `spanMs`; the clock ends at the end of the span. */
  tools(s: SimSession, n: number, spanMs: number, palette: readonly string[] = TOOLS): void {
    const w = this.w;
    const start = w.clock.now();
    for (let i = 0; i < n; i++) {
      w.at(start + Math.round((spanMs * i) / Math.max(1, n)));
      const tool = pick(palette);
      const ok = rnd() > 0.06;
      const file = `src/${pick(['service', 'handler', 'ui', 'schema', 'telemetry'])}.ts`;
      w.store.append({
        type: 'tool.used',
        actor: agent(s.sessionId),
        scope: { sessionId: s.sessionId, projectId: s.project.id },
        meta: { sessionId: s.sessionId, toolName: tool, fileChanging: ok && (tool === 'Edit' || tool === 'Write'), ok, toolUseId: `toolu_${randomBytes(8).toString('hex')}` },
        payload: {
          inputSummary: tool === 'Bash' ? '{"command":"pnpm test --filter api"}' : `{"file_path":"${file}"}`,
          outputSummary: ok ? 'ok' : 'Error: Cannot find module "../config"',
          filePaths: tool === 'Edit' || tool === 'Write' ? [file] : [],
        },
        source: 'hook',
      });
    }
    w.at(start + spanMs);
  }

  usage(s: SimSession, messages: number, contextTokens: number): void {
    const w = this.w;
    const tier = s.model.includes('opus') ? 1 : s.model.includes('haiku') ? 0.25 : 0.6;
    const ids = Array.from({ length: messages }, () => `msg_${randomBytes(10).toString('hex')}`);
    w.store.append({
      type: 'usage.recorded',
      actor: agent(s.sessionId),
      scope: { sessionId: s.sessionId, projectId: s.project.id },
      meta: {
        sessionId: s.sessionId,
        model: s.model,
        inputTokens: Math.round(messages * between(2, 40)),
        outputTokens: Math.round(messages * between(400, 2200) * tier),
        cacheReadTokens: Math.round(messages * contextTokens * 0.9),
        cacheWrite5mTokens: Math.round(messages * between(200, 1200)),
        cacheWrite1hTokens: Math.round(messages * between(1000, 6000)),
        messages,
        contextTokens,
        firstAt: new Date(w.clock.now() - 60_000).toISOString(),
        lastAt: w.clock.iso(),
      },
      payload: { messageIds: ids },
      source: 'sidecar',
    });
  }

  /**
   * A session that worked until `activityEnd` and left a diff-evidenced first task behind. It works again on claude-sim,
   * whose next diff evidence is checked against the repository state recorded with its plan. Returns the context it had.
   */
  workedUntil(s: SimSession, activityEnd: number): number {
    const tree = this.treeOf(s.cwd);
    this.tools(s, 5, 2 * MINUTE);
    this.declare(s, tree);
    this.tools(s, between(10, 25), Math.max(MINUTE, activityEnd - this.w.clock.now()));
    const contextTokens = between(60_000, 420_000);
    this.usage(s, between(10, 30), contextTokens);
    const first = s.plan.phases[0]!.tasks[0]!;
    this.done(s, first.id, s.plan.phases[0]!.id, first.size, { kind: 'diff', tree });
    return contextTokens;
  }

  /** A real commit on the session's branch: what a task closed with `commit` evidence points at. */
  commit(s: SimSession, message: string, files: Record<string, string>, trailers: string[] = []): string {
    return commitFiles(s.project.repo, {
      branch: s.branch,
      files,
      message,
      trailers: [`AOC-Session: ${s.sessionId}`, ...trailers],
      author: this.authorOf(s.owner),
      at: this.w.clock.now(),
    });
  }

  /** Task close. A `commit` close is backed by a real commit (`opts.commit` when the caller made one, else a stub). */
  done(
    s: SimSession,
    taskId: string,
    phaseId: string,
    size: TaskSize,
    opts: { flag?: 'no_file_change' | null; kind?: 'commit' | 'test' | 'diff'; tree?: TreeState; commit?: string; ref?: string; detail?: string } = {},
  ): StoredEvent {
    const kind = opts.commit ? 'commit' : (opts.kind ?? pick(['commit', 'test', 'diff'] as const));
    const title = s.plan.phases.flatMap((p) => p.tasks).find((t) => t.id === taskId)?.title ?? taskId;
    let sha = opts.commit ?? null;
    if (kind === 'commit' && !sha) {
      sha = this.commit(s, title, { [`src/work/${taskId}.ts`] : `// ${title}\n// session ${s.sessionId}\nexport {};\n` });
    }
    const digest = createHash('sha1').update(`${s.sessionId}${taskId}`).digest('hex');
    const ref = kind === 'commit' ? sha! : (opts.ref ?? (kind === 'test' ? `api/${taskId}.test.ts > passes` : `diff:${digest.slice(0, 12)}`));
    const head = sha ?? opts.tree?.head ?? null;
    return this.w.store.append({
      type: 'task.done',
      actor: agent(s.sessionId),
      scope: { sessionId: s.sessionId, projectId: s.project.id, taskId },
      meta: {
        sessionId: s.sessionId,
        projectId: s.project.id,
        taskId,
        phaseId,
        weight: TASK_SIZE_WEIGHT[size],
        evidenceKind: kind,
        evidenceVerified: opts.flag ? false : true,
        flag: opts.flag ?? null,
        fileChangesSinceLast: opts.flag ? 0 : between(1, 9),
        ...(head ? { headSha: head } : {}),
        ...(opts.tree?.fingerprint ? { treeFingerprint: opts.tree.fingerprint } : {}),
      },
      payload: { evidence: { kind, ref, ...(opts.detail ? { detail: opts.detail } : {}) } },
      source: 'mcp',
    }) as unknown as StoredEvent;
  }

  /**
   * Phase pin, as the ledger does it (mod-ledger completePhaseIfDone): an annotated tag `aoc/<slug>/<phase>/<seq>`, `seq`
   * being the closing task's event, on the session's HEAD. Here that is a real commit on the session's branch (the
   * phase note) and a real tag, so the pin resolves in the repository like any rollback target. A session that made
   * its own commits (`pinAt`) pins its last one instead of adding a note.
   */
  phaseDone(s: SimSession, phaseId: string, cause: StoredEvent, pinAt?: string): void {
    const w = this.w;
    const phase = s.plan.phases.find((p) => p.id === phaseId)!;
    const tag = phaseTagName(s.project.slug, phaseId, cause.seq);
    const author = this.authorOf(s.owner);
    const note = [
      `# Phase complete: ${phase.name}`,
      '',
      `Project ${s.project.slug} · session ${s.sessionId} · pinned ${w.clock.iso()}`,
      '',
      ...phase.tasks.map((t) => `- ${t.id} ${t.title} (${t.size})`),
      '',
    ].join('\n');
    const sha = pinAt ?? this.commit(s, `Phase complete: ${phase.name}`, { [`docs/phases/${s.sessionId}-${phaseId}.md`]: note });
    annotatedTag(s.project.repo, tag, sha, `AOC phase ${phaseId} complete (project ${s.project.id}, session ${s.sessionId}, event ${cause.id})`, author, w.clock.now());
    w.store.append({
      type: 'phase.completed',
      actor: agent(s.sessionId),
      scope: { sessionId: s.sessionId, projectId: s.project.id },
      meta: { sessionId: s.sessionId, projectId: s.project.id, phaseId, pinnedSha: sha, pinnedTag: tag },
      source: 'mcp',
      causationId: cause.id,
    });
  }

  /** Supervisor's turn end, lifecycle change and session end, in the order Supervisor.endSession writes them. */
  end(s: SimSession, outcome: 'completed' | 'failed' = 'completed'): void {
    const w = this.w;
    w.store.append({
      type: 'session.turn_ended',
      actor: sys('supervisor'),
      scope: { sessionId: s.sessionId },
      meta: { sessionId: s.sessionId, turn: 1, outcome: outcome === 'completed' ? 'end_turn' : 'crashed', exitCode: outcome === 'completed' ? 0 : 1, durationMs: 1000 },
      payload: {},
      source: 'supervisor',
    });
    // The lifecycle change first, so the supervisor's projection sees the session as over (otherwise startup recovery
    // fails every finished history session as process_gone_on_restart).
    w.store.append({ type: 'session.lifecycle_changed', actor: sys('supervisor'), scope: { sessionId: s.sessionId }, meta: { sessionId: s.sessionId, from: 'running', to: 'ended', reason: outcome }, source: 'supervisor' });
    w.store.append({ type: 'session.ended', actor: sys('supervisor'), scope: { sessionId: s.sessionId }, meta: { sessionId: s.sessionId, outcome }, source: 'supervisor' });
  }

  // ── decisions ─────────────────────────────────────────────────────────────

  decision(input: {
    kind: string;
    test?: string | null;
    title: string;
    question: string;
    options: { id: string; label: string }[];
    rec?: string;
    context?: string;
    subjectType: string;
    subjectId: string;
    sessionId?: string | null;
    projectId?: string | null;
    requesterId: string;
    eligible?: string[];
  }): DecisionCard {
    return this.w.rt.services.get('decisions').request(
      {
        kind: input.kind as never,
        test: (input.test ?? null) as never,
        title: input.title,
        question: input.question,
        options: input.options,
        recommendation: input.rec ? { optionId: input.rec, rationale: 'Agent recommendation based on blast radius and reversibility.' } : null,
        context: input.context ?? null,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        sessionId: input.sessionId ?? null,
        projectId: input.projectId ?? null,
        requesterId: input.requesterId,
        eligibleUserIds: input.eligible ?? null,
      },
      input.sessionId ? agent(input.sessionId) : human(input.requesterId),
    );
  }

  /** Resolve as `who`: a button for most cards, a signed assertion for the passkey gates. Reactors settle before it returns. */
  async resolve(id: string, option: string, who: PersonKey, comment?: string): Promise<void> {
    const w = this.w;
    const user = w.rt.services.get('identity').getUser(w.people[who].userId);
    if (!user) return;
    if (w.rt.services.get('decisions').get(id)?.requiresPasskey) {
      await w.signer.resolve(id, option, who, comment);
      return;
    }
    await w.rt.services.get('decisions').resolve(id, { optionId: option, comment: comment ?? null }, user);
    await w.settle();
  }
}
