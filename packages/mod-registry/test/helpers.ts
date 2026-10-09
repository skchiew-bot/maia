import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventSource, ServiceMap } from '@aoc/contracts';
import { createTestRuntime, type TestRuntime } from '@aoc/kernel';
import { createRegistryModule, type RegistryModuleOptions } from '../src';

export const REGISTRY = {
  version: '2026.10.1',
  types: [
    {
      id: 'discovery',
      name: 'Discovery build',
      class: 'discovery',
      model: 'opus',
      credentialProfile: 'git-feature',
    },
    {
      id: 'feature-build',
      name: 'Feature build',
      class: 'execution',
      model: 'opus',
      executionModel: 'sonnet',
      credentialProfile: 'git-feature',
    },
    {
      id: 'bug-fix',
      name: 'Bug fix',
      class: 'execution',
      model: 'opus',
      executionModel: 'sonnet',
      credentialProfile: 'uat-deploy',
    },
    { id: 'test-repair', name: 'Test repair', class: 'execution', model: 'sonnet', executionModel: 'haiku' },
    {
      id: 'bug-triage',
      name: 'Bug triage',
      class: 'triage',
      model: 'opus',
      readOnly: true,
      credentialProfile: null,
    },
  ],
};

export function writeRegistry(content: unknown, dir = mkdtempSync(join(tmpdir(), 'aoc-reg-'))): string {
  const file = join(dir, 'process-types.json');
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return file;
}

export interface StartOptions {
  registry?: unknown;
  services?: Partial<ServiceMap>;
  config?: Record<string, unknown>;
  now?: string;
  module?: RegistryModuleOptions;
}

export async function start(o: StartOptions = {}): Promise<TestRuntime> {
  const registryFile = writeRegistry(o.registry ?? REGISTRY);
  return createTestRuntime({
    modules: [createRegistryModule(o.module)],
    config: { registryFile, ...o.config },
    services: o.services,
    now: o.now,
  });
}

const SUPERVISOR = { kind: 'system', id: 'supervisor' } as const;
const SRC: EventSource = 'supervisor';

export function launch(
  t: TestRuntime,
  s: { sessionId: string; processType: string; model?: string; projectId?: string; cwd?: string },
): void {
  const projectId = s.projectId ?? 'prj_shop';
  t.rt.store.append({
    type: 'session.launch_requested',
    actor: SUPERVISOR,
    scope: { sessionId: s.sessionId, projectId, threadId: 'thr_1' },
    meta: {
      sessionId: s.sessionId,
      projectId,
      threadId: 'thr_1',
      processType: s.processType,
      model: s.model ?? 'claude-opus-5-5',
      readOnly: false,
      credentialProfile: null,
      ticketId: null,
      parentSessionId: null,
      phaseId: null,
    },
    payload: { prompt: 'Build the orders feature', cwd: s.cwd ?? '/work/shop' },
    source: SRC,
  });
}

export function ended(
  t: TestRuntime,
  sessionId: string,
  outcome: 'completed' | 'failed' | 'killed' | 'retired' | 'abandoned' = 'completed',
): void {
  t.rt.store.append({
    type: 'session.ended',
    actor: SUPERVISOR,
    scope: { sessionId },
    meta: { sessionId, outcome },
    source: SRC,
  });
}

export function rollover(t: TestRuntime, fromSessionId: string, toSessionId: string): void {
  t.rt.store.append({
    type: 'session.rollover_completed',
    actor: SUPERVISOR,
    scope: { sessionId: toSessionId, threadId: 'thr_1' },
    meta: { threadId: 'thr_1', fromSessionId, toSessionId },
    source: SRC,
  });
}

export interface PlanTask {
  id: string;
  title: string;
  acceptance?: string;
}
export function declarePlan(
  t: TestRuntime,
  sessionId: string,
  phases: { id: string; name: string; tasks: PlanTask[] }[],
  projectId = 'prj_shop',
): void {
  const taskCount = phases.reduce((a, p) => a + p.tasks.length, 0);
  t.rt.store.append({
    type: 'plan.declared',
    actor: { kind: 'agent', id: sessionId },
    scope: { sessionId, projectId },
    meta: {
      sessionId,
      projectId,
      threadId: 'thr_1',
      manifestVersion: 1,
      phaseCount: phases.length,
      taskCount,
      totalWeight: taskCount * 3,
    },
    payload: {
      phases: phases.map((p) => ({ ...p, tasks: p.tasks.map((x) => ({ ...x, size: 'm' as const })) })),
    },
    source: 'mcp',
  });
}

export function taskDone(
  t: TestRuntime,
  sessionId: string,
  taskId: string,
  phaseId: string,
  projectId = 'prj_shop',
): void {
  t.rt.store.append({
    type: 'task.done',
    actor: { kind: 'agent', id: sessionId },
    scope: { sessionId, projectId, taskId },
    meta: {
      sessionId,
      projectId,
      taskId,
      phaseId,
      weight: 3,
      evidenceKind: 'test',
      evidenceVerified: true,
      flag: null,
      fileChangesSinceLast: 1,
    },
    payload: { evidence: { kind: 'test', ref: `test/${taskId}.test.ts` } },
    source: 'mcp',
  });
}

export function toolUsed(
  t: TestRuntime,
  sessionId: string,
  toolName: string,
  filePaths: string[] = [],
  fileChanging = false,
): void {
  t.rt.store.append({
    type: 'tool.used',
    actor: { kind: 'agent', id: sessionId },
    scope: { sessionId },
    meta: { sessionId, toolName, fileChanging, ok: true, toolUseId: null },
    payload: { inputSummary: `${toolName} call`, filePaths },
    source: 'hook',
  });
}

export function drift(t: TestRuntime, sessionId: string, detail: string, projectId = 'prj_shop'): void {
  t.rt.store.append({
    type: 'drift.detected',
    actor: { kind: 'system', id: 'ledger' },
    scope: { sessionId, projectId },
    meta: { sessionId, projectId, kind: 'scope_growth', severity: 'medium' },
    payload: { detail },
    source: 'system',
  });
}

export function usage(
  t: TestRuntime,
  sessionId: string,
  model: string,
  u: { input?: number; output?: number; cacheRead?: number },
): void {
  t.rt.store.append({
    type: 'usage.recorded',
    actor: { kind: 'system', id: 'sidecar' },
    scope: { sessionId },
    meta: {
      sessionId,
      model,
      inputTokens: u.input ?? 0,
      outputTokens: u.output ?? 0,
      cacheReadTokens: u.cacheRead ?? 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      messages: 1,
      contextTokens: 1000,
      firstAt: t.clock.iso(),
      lastAt: t.clock.iso(),
    },
    payload: { messageIds: ['msg_1'] },
    source: 'sidecar',
  });
}

/** Seed a playbook straight into the log (as mod-registry would) — for routing/economics/knowledge tests. */
export function seedPlaybook(
  t: TestRuntime,
  p: {
    playbookId: string;
    processType: string;
    version?: number;
    title?: string;
    steps?: { id: string; title: string; detail?: string }[];
    approve?: boolean;
  },
): void {
  const decisionId = `dec_${p.playbookId}`;
  const steps = p.steps ?? [{ id: 's1', title: 'Do the thing' }];
  t.rt.store.append({
    type: 'playbook.proposed',
    actor: { kind: 'human', id: 'usr_curator' },
    scope: { decisionId },
    meta: {
      playbookId: p.playbookId,
      processType: p.processType,
      sourceSessionId: null,
      version: p.version ?? 1,
      stepCount: steps.length,
      decisionId,
      method: 'fallback',
    },
    payload: { title: p.title ?? `${p.processType} playbook`, steps },
    source: 'api',
    bodyScope: p.playbookId,
  });
  if (p.approve ?? true) approvePlaybook(t, p.playbookId);
}

export function approvePlaybook(t: TestRuntime, playbookId: string): void {
  t.rt.store.append({
    type: 'playbook.approved',
    actor: { kind: 'human', id: 'usr_ceo' },
    scope: {},
    meta: { playbookId, decisionId: `dec_${playbookId}`, approverId: 'usr_ceo' },
    source: 'system',
  });
}

export function retirePlaybook(t: TestRuntime, playbookId: string, reason = 'manual'): void {
  t.rt.store.append({
    type: 'playbook.retired',
    actor: { kind: 'human', id: 'usr_ceo' },
    scope: {},
    meta: { playbookId, reason },
    source: 'api',
  });
}

export const PHASES = [
  {
    id: 'p1',
    name: 'Build API',
    tasks: [
      { id: 't1', title: 'Add the orders endpoint', acceptance: 'POST /orders returns 201' },
      { id: 't2', title: 'Write endpoint tests' },
    ],
  },
  { id: 'p2', name: 'Ship', tasks: [{ id: 't3', title: 'Update the API docs' }] },
];

/**
 * A complete feature-build run: plan, tools (with file areas), an agent decision resolved with a comment,
 * drift, every task done with evidence, ended `completed` (unless told otherwise).
 */
export async function seedRun(
  t: TestRuntime,
  o: {
    sessionId: string;
    processType?: string;
    cwd?: string;
    outcome?: 'completed' | 'failed' | null;
    skipLastTask?: boolean;
  },
): Promise<void> {
  const { sessionId } = o;
  const cwd = o.cwd ?? '/work/shop';
  launch(t, { sessionId, processType: o.processType ?? 'feature-build', cwd });
  declarePlan(t, sessionId, PHASES);
  toolUsed(t, sessionId, 'Read', [`${cwd}/src/api/orders.ts`]);
  toolUsed(t, sessionId, 'Edit', [`${cwd}/src/api/orders.ts`], true);
  const card = t.decisions!.request(
    {
      kind: 'agent_decision',
      test: 'ambiguity',
      title: 'Order id format',
      question: 'Should order ids be UUIDs or sequential numbers?',
      options: [
        { id: 'uuid', label: 'UUIDs' },
        { id: 'seq', label: 'Sequential numbers' },
      ],
      subjectType: 'session',
      subjectId: sessionId,
      sessionId,
      projectId: 'prj_shop',
      requesterId: 'usr_owner',
    },
    { kind: 'agent', id: sessionId },
  );
  const reviewer = t.user('builder', 'Reviewer');
  await t.decisions!.resolve(
    card.id,
    { optionId: 'uuid', comment: 'Ids must not leak order volume' },
    reviewer.user,
  );
  taskDone(t, sessionId, 't1', 'p1');
  toolUsed(t, sessionId, 'Write', [`${cwd}/test/api/orders.test.ts`], true);
  toolUsed(t, sessionId, 'Bash');
  drift(t, sessionId, 'Also touched the shared validation helper');
  taskDone(t, sessionId, 't2', 'p1');
  toolUsed(t, sessionId, 'Edit', [`${cwd}/docs/api.md`, '/etc/passwd'], true);
  if (!o.skipLastTask) taskDone(t, sessionId, 't3', 'p2');
  if (o.outcome !== null) ended(t, sessionId, o.outcome ?? 'completed');
  await t.drain();
}

export const LLM_PLAYBOOK = {
  title: 'Add a REST endpoint with tests and docs',
  steps: [
    {
      id: 'design-endpoint',
      title: 'Design and implement the endpoint',
      detail: 'Edit src/api; decide id format first (UUIDs).',
    },
    {
      id: 'test-endpoint',
      title: 'Cover it with endpoint tests',
      detail: 'Write test/api/*.test.ts and run them.',
    },
    { id: 'document', title: 'Update the API docs', detail: 'docs/api.md' },
  ],
  rationale: 'Mirrors the order that worked: implement, test, document.',
};
