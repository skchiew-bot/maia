import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ProcessTypeSchema,
  type Actor,
  type BoundaryInstruction,
  type CreditService,
  type LearningService,
  type LedgerService,
  type LessonInfo,
  type PlaybookInfo,
  type ProcessType,
  type RegistryService,
  type SessionInfo,
  type StoredEvent,
  type SupervisorService,
} from '@aoc/contracts';
import { createTestRuntime, initRepo, type TestRuntime, type TestUser } from '@aoc/kernel';
import { createLedgerModule, type LedgerModuleOptions } from '../src';

export class StubRegistry implements RegistryService {
  readonly types = new Map<string, ProcessType>();
  readonly playbooks = new Map<string, PlaybookInfo>();
  constructor() {
    for (const raw of [
      {
        id: 'feature-build',
        name: 'Feature build',
        class: 'execution',
        model: 'opus',
        executionModel: 'sonnet',
      },
      {
        id: 'migration',
        name: 'Migration',
        class: 'discovery',
        model: 'opus',
        risky: true,
        rolloverContextPct: 85,
      },
      {
        id: 'rollback-verify',
        name: 'Rollback verification',
        class: 'maintenance',
        model: 'sonnet',
        requiresPlan: false,
      },
    ]) {
      const t = ProcessTypeSchema.parse(raw);
      this.types.set(t.id, t);
    }
  }
  listTypes() {
    return [...this.types.values()];
  }
  getType(id: string) {
    return this.types.get(id) ?? null;
  }
  activePlaybook(processType: string) {
    return this.playbooks.get(processType) ?? null;
  }
  modelFor(processType: string) {
    return this.types.get(processType)?.model ?? 'opus';
  }
}

export class StubCredits {
  next: BoundaryInstruction = { continue: true };
  readonly calls: { sessionId: string; taskId: string | null; actor: Actor }[] = [];
  checkBoundary(sessionId: string, taskId: string | null, actor: Actor): BoundaryInstruction {
    this.calls.push({ sessionId, taskId, actor });
    return this.next;
  }
}

export class StubSupervisor {
  readonly stops = new Set<string>();
  stopRequested(sessionId: string): boolean {
    return this.stops.has(sessionId);
  }
}

export class StubLearning {
  readonly lessons: LessonInfo[] = [];
  readonly scopes: { processType: string; codeAreas?: string[] }[] = [];
  lessonsForScope(scope: { processType: string; codeAreas?: string[] }): LessonInfo[] {
    this.scopes.push(scope);
    return this.lessons.filter((l) => l.scopeType !== 'process_type' || l.scopeValue === scope.processType);
  }
}

export const PLAN = {
  summary: 'Build the widget store',
  phases: [
    {
      id: 'P1',
      name: 'Foundation',
      tasks: [
        { id: 't1', title: 'Schema', size: 's' },
        { id: 't2', title: 'Store', size: 'm' },
      ],
    },
    {
      id: 'P2',
      name: 'API',
      tasks: [{ id: 't3', title: 'Routes', size: 'l', acceptance: 'GET /widgets returns 200' }],
    },
  ],
} as const;

export interface Harness {
  t: TestRuntime;
  ledger: LedgerService;
  registry: StubRegistry;
  credits: StubCredits;
  supervisor: StubSupervisor;
  learning: StubLearning;
  owner: TestUser;
  /** Create a temp git repo (cleaned up on close). */
  repo(files?: Record<string, string>): string;
  tempDir(): string;
  /** A project (and optionally a thread) via the ledger service. */
  project(name?: string): string;
  thread(projectId: string, title?: string): string;
  session(partial: Partial<SessionInfo> & { sessionId: string; projectId: string }): SessionInfo;
  mcp<T = Record<string, unknown>>(
    tool: string,
    sessionId: string,
    input: unknown,
    expect?: number,
  ): Promise<T>;
  toolUsed(
    sessionId: string,
    opts?: { fileChanging?: boolean; toolName?: string; filePaths?: string[]; ok?: boolean },
  ): StoredEvent;
  events(type: string): StoredEvent[];
  close(): Promise<void>;
}

export async function createHarness(
  opts: { ledger?: LedgerModuleOptions; withRegistry?: boolean; withLearning?: boolean } = {},
): Promise<Harness> {
  const registry = new StubRegistry();
  const credits = new StubCredits();
  const supervisor = new StubSupervisor();
  const learning = new StubLearning();
  const t = await createTestRuntime({
    modules: [createLedgerModule(opts.ledger)],
    services: {
      ...(opts.withRegistry === false ? {} : { registry }),
      ...(opts.withLearning === false ? {} : { learning: learning as unknown as LearningService }),
      credits: credits as unknown as CreditService,
      supervisor: supervisor as unknown as SupervisorService,
    },
  });
  const owner = t.user('builder', 'Dev One');
  const dirs: string[] = [];
  const system: Actor = { kind: 'system', id: 'test' };
  const ledger = t.rt.services.get('ledger');
  const h: Harness = {
    t,
    ledger,
    registry,
    credits,
    supervisor,
    learning,
    owner,
    tempDir() {
      const d = mkdtempSync(join(tmpdir(), 'aoc-ledger-'));
      dirs.push(d);
      return d;
    },
    repo(files) {
      const d = h.tempDir();
      initRepo(d, {
        files: files ?? { 'README.md': '# demo\n', 'test/widget.test.ts': 'it("works", () => {});\n' },
      });
      return d;
    },
    project(name = 'Widget Store') {
      return ledger.ensureThread(
        { projectId: `prj_${name.replace(/\W+/g, '_').toLowerCase()}`, title: 'main' },
        system,
      ).projectId;
    },
    thread(projectId, title = 'line of work') {
      return ledger.ensureThread({ projectId, title }, system).threadId;
    },
    session(partial) {
      return t.sessions!.add({
        ownerId: owner.user.id,
        processType: 'feature-build',
        model: 'claude-opus-5-5',
        ...partial,
      });
    },
    mcp(tool, sessionId, input, expect = 200) {
      return t.json('POST', `/ingest/mcp/${tool}`, {
        headers: t.ingestHeaders(sessionId),
        body: { sessionId, input },
        expect,
      });
    },
    toolUsed(sessionId, o = {}) {
      return t.rt.store.append({
        type: 'tool.used',
        actor: { kind: 'agent', id: sessionId },
        scope: { sessionId },
        meta: {
          sessionId,
          toolName: o.toolName ?? 'Edit',
          fileChanging: o.fileChanging ?? true,
          ok: o.ok ?? true,
          toolUseId: null,
        },
        payload: { inputSummary: 'tool call', ...(o.filePaths ? { filePaths: o.filePaths } : {}) },
        source: 'hook',
      });
    },
    events(type) {
      return t.rt.store.list({ types: [type] });
    },
    async close() {
      await t.close();
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    },
  };
  return h;
}

export function writeFile(dir: string, path: string, content: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

export function git(dir: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

export function commit(dir: string, path: string, content: string, message = 'work'): string {
  writeFile(dir, path, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}
