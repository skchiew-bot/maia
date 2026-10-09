/** Test harness: a runtime with the supervisor module, the fake claude, and stubs for the services it uses. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ProcessRegistrySchema,
  defaultConfig,
  routeModel,
  type Actor,
  type BoundaryInstruction,
  type CreditBalance,
  type CreditService,
  type HandoffBrief,
  type LaunchRequest,
  type LearningService,
  type LedgerService,
  type LessonInfo,
  type LivenessService,
  type PlaybookInfo,
  type ProcessType,
  type Progress,
  type RegistryService,
  type ServiceMap,
  type StoredEvent,
  type ThreadInfo,
} from '@aoc/contracts';
import { createTestRuntime, type Logger, type TestRuntime } from '@aoc/kernel';
import { createSupervisorModule, type Supervisor, type SupervisorModuleOptions } from '../src';

export const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
export const FAKE_SIDECAR = fileURLToPath(new URL('./fixtures/fake-sidecar.mjs', import.meta.url));
export const REPO_REGISTRY = fileURLToPath(new URL('../../../config/process-types.json', import.meta.url));

export const SECRETS = {
  aocdDeployKey: 'aocd-deploy-key-SECRET-1',
  aocdMasterKey: 'aocd-master-key-SECRET-2',
  gitFeature: 'ghp_feature_SECRET-3',
  uatDeploy: 'uat_deploy_SECRET-4',
};

const TYPES: ProcessType[] = ProcessRegistrySchema.parse({
  version: 'test',
  types: [
    {
      id: 'feature-build',
      name: 'Feature build',
      class: 'execution',
      model: 'opus',
      executionModel: 'sonnet',
      credentialProfile: 'git-feature',
    },
    {
      id: 'discovery',
      name: 'Discovery build',
      class: 'discovery',
      model: 'opus',
      credentialProfile: 'git-feature',
    },
    {
      id: 'bug-triage',
      name: 'Bug triage (read-only)',
      class: 'triage',
      model: 'opus',
      readOnly: true,
      permissionMode: 'dontAsk',
      tools: { deny: ['Bash', 'WebFetch', 'Agent', 'Task'] },
    },
    {
      id: 'migration',
      name: 'Migration',
      class: 'discovery',
      model: 'opus',
      credentialProfile: 'git-feature',
      risky: true,
      rolloverContextPct: 85,
    },
    {
      id: 'docs',
      name: 'Documentation',
      class: 'execution',
      model: 'sonnet',
      executionModel: 'haiku',
      permissionMode: 'default',
    },
    {
      id: 'rollback-verify',
      name: 'Rollback verification',
      class: 'maintenance',
      model: 'sonnet',
      requiresPlan: false,
    },
  ],
}).types.map((t) => (t.id === 'bug-triage' ? { ...t, builtinTools: ['Read', 'Glob', 'Grep'] } : t));

export class StubRegistry implements RegistryService {
  readonly playbooks = new Map<string, PlaybookInfo>();
  private readonly types: ProcessType[];
  constructor(extra: ProcessType[] = []) {
    this.types = [...TYPES, ...extra];
  }
  listTypes(): ProcessType[] {
    return this.types;
  }
  getType(id: string): ProcessType | null {
    return this.types.find((t) => t.id === id) ?? null;
  }
  activePlaybook(processType: string): PlaybookInfo | null {
    return this.playbooks.get(processType) ?? null;
  }
  modelFor(processType: string) {
    return routeModel(this.getType(processType)!, this.playbooks.get(processType)?.status === 'approved');
  }
}

export class StubLedger implements LedgerService {
  readonly threads = new Map<string, ThreadInfo>();
  readonly writerCalls: string[] = [];
  boundary = { atBoundary: true, reason: null as string | null, openTasks: 2 };
  readonly pct = new Map<string, number>();
  defaultPct = 50;
  briefProblems: string[] = [];
  readonly repoPaths = new Map<string, string>();
  private n = 0;

  hasManifest(): boolean {
    return true;
  }
  boundaryState() {
    return this.boundary;
  }
  sessionProgress(sessionId: string): Progress {
    const pct = this.pct.get(sessionId) ?? this.defaultPct;
    const done = Math.round((pct / 100) * 4);
    return {
      doneTasks: done,
      totalTasks: 4,
      doneWeight: done * 2,
      totalWeight: 8,
      pct,
      flaggedTasks: 0,
      phases: [],
      etaMs: null,
      etaHiddenReason: null,
    };
  }
  projectProgress(): Progress | null {
    return null;
  }
  getThread(threadId: string): ThreadInfo | null {
    return this.threads.get(threadId) ?? null;
  }
  ensureThread(input: { projectId: string; threadId?: string | null; title?: string }): ThreadInfo {
    const threadId = input.threadId ?? `thr_test${++this.n}`;
    let t = this.threads.get(threadId);
    if (!t) {
      t = { threadId, projectId: input.projectId, title: input.title ?? '', activeWriterSessionId: null };
      this.threads.set(threadId, t);
    }
    return t;
  }
  acquireWriter(threadId: string, sessionId: string): boolean {
    this.writerCalls.push(`acquire ${sessionId}`);
    const t = this.threads.get(threadId)!;
    if (t.activeWriterSessionId && t.activeWriterSessionId !== sessionId) return false;
    t.activeWriterSessionId = sessionId;
    return true;
  }
  releaseWriter(threadId: string, sessionId: string, reason: string): void {
    this.writerCalls.push(`release ${sessionId} ${reason}`);
    const t = this.threads.get(threadId);
    if (t?.activeWriterSessionId === sessionId) t.activeWriterSessionId = null;
  }
  /** Appended to the brief text: agent-written records (task titles, decision context) feed the real brief. */
  briefSuffix = '';
  buildHandoffBrief(threadId: string, fromSessionId: string): HandoffBrief {
    const t = this.threads.get(threadId)!;
    return {
      threadId,
      projectId: t.projectId,
      fromSessionId,
      text: `HANDOFF ${threadId}: open tasks t3, t4; decision dec_x chose option B; see src/auth.ts${this.briefSuffix}`,
      openTaskIds: ['t3', 't4'],
      openDecisionIds: [],
      filePointers: ['src/auth.ts'],
      hash: 'b'.repeat(64),
    };
  }
  validateBrief(): { ok: boolean; problems: string[] } {
    return { ok: this.briefProblems.length === 0, problems: this.briefProblems };
  }
  projectRepoPath(projectId: string): string | null {
    return this.repoPaths.get(projectId) ?? null;
  }
}

export class StubCredits implements CreditService {
  next: BoundaryInstruction = { continue: true };
  readonly calls: string[] = [];
  checkBoundary(sessionId: string, taskId: string | null): BoundaryInstruction {
    this.calls.push(`${sessionId}:${taskId}`);
    return this.next;
  }
  balance(userId: string): CreditBalance {
    return {
      userId,
      period: '2026-10',
      allocationUsd: 300,
      grantedUsd: 0,
      usedUsd: 0,
      balanceUsd: 300,
      autoGrantUsed: false,
      pendingTopupRequestId: null,
      exempt: false,
    };
  }
}

export class StubLiveness implements LivenessService {
  readonly activity: string[] = [];
  readonly processes: { sessionId: string; alive: boolean; pid: number | null; lifecycle?: string }[] = [];
  /** Set by the harness: the session's lifecycle at the moment a process change is reported. */
  lifecycleOf: (sessionId: string) => string | undefined = () => undefined;
  get() {
    return null;
  }
  refresh(): void {}
  recordActivity(sessionId: string): void {
    this.activity.push(sessionId);
  }
  recordProcess(sessionId: string, alive: boolean, pid: number | null): void {
    this.processes.push({ sessionId, alive, pid, lifecycle: this.lifecycleOf(sessionId) });
  }
}

export class StubLearning implements LearningService {
  lessons: LessonInfo[] = [
    {
      lessonId: 'les_tests',
      scopeType: 'process_type',
      scopeValue: 'feature-build',
      rule: 'Run the package tests before task_done',
      fix: 'pnpm --filter <pkg> test',
    },
  ];
  readonly applied: { lessonIds: string[]; sessionId: string }[] = [];
  lessonsForScope(scope: { processType: string }): LessonInfo[] {
    return this.lessons.filter((l) => l.scopeValue === scope.processType);
  }
  recordLessonsApplied(lessonIds: string[], sessionId: string): void {
    this.applied.push({ lessonIds, sessionId });
  }
  recordError(): void {}
}

export interface FakeCall {
  pid: number;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  uuid: string;
  turn: number;
  mode: string;
  prompt: string;
}

export interface HarnessOptions {
  supervisor?: Record<string, unknown>;
  config?: Record<string, unknown>;
  module?: SupervisorModuleOptions;
  /** Provide the stub registry service (default true; false exercises the registry-file fallback). */
  registry?: boolean;
  /** Provide the stub ledger (default true). */
  ledger?: boolean;
  services?: Partial<ServiceMap>;
  log?: Logger;
  /** Process types added to the stub registry. */
  types?: ProcessType[];
  /** aocd environment entries added to (or, with undefined, removed from) the default one (e.g. FAKE_SIDECAR_LINGER=1). */
  env?: Record<string, string | undefined>;
  /** Keep the event store on disk (its directory is `t.dataDir`). */
  onDisk?: boolean;
}

export async function createHarness(o: HarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aoc-supervisor-'));
  const dir = (name: string) => {
    const p = join(root, name);
    mkdirSync(p, { recursive: true });
    return p;
  };
  const home = dir('home');
  const claudeConfig = dir('claude-config');
  const sessionsDir = dir('sessions');
  const callLog = join(root, 'claude-calls.jsonl');
  const sidecarLog = join(root, 'sidecar-calls.jsonl');
  const profilesFile = join(root, 'credential-profiles.json');
  writeFileSync(
    profilesFile,
    JSON.stringify({
      profiles: {
        'git-feature': { env: { GIT_PUSH_TOKEN: SECRETS.gitFeature } },
        'uat-deploy': { env: { DEPLOY_TOKEN: SECRETS.uatDeploy } },
      },
    }),
  );
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: home,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    CLAUDE_CONFIG_DIR: claudeConfig,
    FAKE_CLAUDE_LOG: callLog,
    DEPLOY_KEY: SECRETS.aocdDeployKey,
    AOC_MASTER_KEY: SECRETS.aocdMasterKey,
    ...o.env,
  };
  const ledger = new StubLedger();
  const registry = new StubRegistry(o.types);
  const credits = new StubCredits();
  const liveness = new StubLiveness();
  const learning = new StubLearning();
  const services: Partial<ServiceMap> = { credits, liveness, learning, ...o.services };
  if (o.registry !== false) services.registry = registry;
  if (o.ledger !== false) services.ledger = ledger;

  const t: TestRuntime = await createTestRuntime({
    modules: [createSupervisorModule({ sessionsDir, env, interruptGraceMs: 400, ...o.module })],
    config: {
      ...o.config,
      supervisor: {
        claudeBin: process.execPath,
        claudeArgsPrefix: [FAKE_CLAUDE],
        mcpCommand: ['node', '/opt/aoc/mcp-server.js'],
        hookCommand: ['node', '/opt/aoc/aoc-hook.js'],
        sidecarCommand: [process.execPath, FAKE_SIDECAR, sidecarLog],
        envAllowlist: [...defaultConfig().supervisor.envAllowlist, 'FAKE_CLAUDE_LOG', 'FAKE_SIDECAR_LINGER'],
        credentialProfilesFile: profilesFile,
        maxConcurrentSessions: 4,
        autoContinueLimit: 0,
        ...o.supervisor,
      },
    },
    services,
    log: o.log,
    onDisk: o.onDisk,
  });
  const sup = t.rt.services.get('supervisor') as Supervisor;
  liveness.lifecycleOf = (sessionId) => sup.session(sessionId)?.lifecycle;
  const owner = t.user('builder', 'Owner');
  const ownerActor: Actor = { kind: 'human', id: owner.user.id };

  const readJsonl = <T>(file: string): T[] =>
    existsSync(file)
      ? readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as T)
      : [];

  const h = {
    t,
    sup,
    ledger,
    registry,
    credits,
    liveness,
    learning,
    root,
    env,
    sessionsDir,
    owner,
    ownerActor,
    sidecarLog,
    async launch(
      prompt: string,
      extra: Partial<LaunchRequest> = {},
      actor: Actor = ownerActor,
    ): Promise<string> {
      const { sessionId } = await sup.launch(
        { processType: 'feature-build', projectId: 'prj_demo', prompt, ...extra },
        actor,
      );
      return sessionId;
    },
    calls: (): FakeCall[] => readJsonl<FakeCall>(callLog),
    callsFor: (sessionId: string): FakeCall[] =>
      readJsonl<FakeCall>(callLog).filter((c) => c.env.AOC_SESSION_ID === sessionId),
    sidecarCalls: () => readJsonl<{ args: string[]; env: Record<string, string> }>(sidecarLog),
    events: (type: string, sessionId?: string): StoredEvent[] =>
      t.rt.store.list({ types: [type], ...(sessionId ? { sessionId } : {}) }),
    payload: (e: StoredEvent) => t.rt.store.readPayload(e) as Record<string, unknown> | null,
    lifecycle: (sessionId: string) => sup.session(sessionId)?.lifecycle,
    file: (sessionId: string, name: string) => readFileSync(join(sessionsDir, sessionId, name), 'utf8'),
    async waitFor(pred: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
      const until = Date.now() + timeoutMs;
      for (;;) {
        await t.drain();
        if (pred()) return;
        if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    async waitLifecycle(sessionId: string, lifecycle: string, timeoutMs?: number): Promise<void> {
      await h.waitFor(
        () => h.lifecycle(sessionId) === lifecycle,
        `${sessionId} → ${lifecycle} (now ${h.lifecycle(sessionId)})`,
        timeoutMs,
      );
    },
    /** Revocation waits for the session's sidecars to finish their final flush. */
    async waitRevoked(token: string): Promise<void> {
      await h.waitFor(() => t.identity!.verifyIngestToken(token) === null, 'the ingest token to be revoked');
    },
    gate() {
      const path = join(root, `gate-${Math.random().toString(36).slice(2)}`);
      return { path, open: () => writeFileSync(path, 'go') };
    },
    async close(): Promise<void> {
      await t.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return h;
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
