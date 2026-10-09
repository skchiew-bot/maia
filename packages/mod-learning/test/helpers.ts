import type {
  Actor,
  ErrorOccurrenceDTO,
  LearningService,
  MeteringService,
  SessionInfo,
} from '@aoc/contracts';
import { createTestRuntime, type TestRuntime } from '@aoc/kernel';
import { createLearningModule, type LearningModuleOptions } from '../src';

export const SYS: Actor = { kind: 'system', id: 'test' };
export const MIN = 60_000;
export const DAY = 86_400_000;

/** $1 per 1,000 input tokens — exact numbers in assertions. */
export const meteringStub: MeteringService = {
  notionalCostUsd: (_model, u) => u.inputTokens / 1000,
  fxRate: () => null,
  sessionCostUsd: () => 0,
  activeRateCardVersion: () => 1,
};

export async function learningRuntime(
  o: {
    options?: LearningModuleOptions;
    metering?: boolean;
    config?: Record<string, unknown>;
    now?: string;
  } = {},
): Promise<TestRuntime> {
  return createTestRuntime({
    modules: [createLearningModule(o.options)],
    services: o.metering === false ? {} : { metering: meteringStub },
    config: o.config,
    now: o.now,
  });
}

export const learning = (t: TestRuntime): LearningService => t.rt.services.get('learning');

export function addSession(
  t: TestRuntime,
  sessionId: string,
  processType: string | null,
  model: string,
  extra: Partial<SessionInfo> = {},
): SessionInfo {
  return t.sessions!.add({
    sessionId,
    processType,
    model,
    startedAt: t.clock.iso(),
    cwd: '/work/repo',
    ...extra,
  });
}

export function endSession(t: TestRuntime, sessionId: string): void {
  t.sessions!.add({ ...t.sessions!.get(sessionId)!, lifecycle: 'ended' });
}

let seq = 0;

export function toolFailure(t: TestRuntime, sessionId: string, outputSummary: string, filePath?: string) {
  return t.rt.store.append({
    type: 'tool.used',
    actor: { kind: 'agent', id: sessionId },
    scope: { sessionId },
    meta: { sessionId, toolName: 'Bash', fileChanging: false, ok: false, toolUseId: `tu_${++seq}` },
    payload: {
      inputSummary: '{"command":"pnpm test"}',
      outputSummary,
      ...(filePath ? { filePaths: [filePath] } : {}),
    },
    source: 'hook',
  });
}

export function fileChange(t: TestRuntime, sessionId: string, path: string) {
  return t.rt.store.append({
    type: 'tool.used',
    actor: { kind: 'agent', id: sessionId },
    scope: { sessionId },
    meta: { sessionId, toolName: 'Edit', fileChanging: true, ok: true, toolUseId: `tu_${++seq}` },
    payload: { inputSummary: '{}', outputSummary: '{"success":true}', filePaths: [path] },
    source: 'hook',
  });
}

/** One usage batch for a session at `minutesAfterNow` (default +5 min). */
export function usage(
  t: TestRuntime,
  sessionId: string,
  inputTokens: number,
  minutesAfterNow = 5,
  model = 'claude-opus-5-5',
) {
  const at = new Date(t.clock.now() + minutesAfterNow * MIN).toISOString();
  return t.rt.store.append({
    type: 'usage.recorded',
    actor: { kind: 'agent', id: sessionId },
    scope: { sessionId },
    meta: {
      sessionId,
      model,
      inputTokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      messages: 1,
      contextTokens: inputTokens,
      firstAt: at,
      lastAt: at,
    },
    payload: { messageIds: [`msg_${++seq}`] },
    source: 'sidecar',
  });
}

/** Record an agent-reported error through the LearningService and return its id. */
export function report(
  t: TestRuntime,
  message: string,
  extra: Partial<Parameters<LearningService['recordError']>[0]> = {},
  actor: Actor = SYS,
): string {
  learning(t).recordError({ source: 'agent_report', message, ...extra }, actor);
  return lastErrorId(t);
}

export function lastErrorId(t: TestRuntime): string {
  const e = t.rt.store.list({ types: ['error.observed'], order: 'desc', limit: 1 })[0];
  if (!e) throw new Error('no error.observed yet');
  return e.meta.errorId as string;
}

export async function errors(
  t: TestRuntime,
  headers: Record<string, string>,
  query = '',
): Promise<ErrorOccurrenceDTO[]> {
  return t.json<ErrorOccurrenceDTO[]>('GET', `/api/learning/errors${query}`, { headers });
}

export async function createClass(
  t: TestRuntime,
  headers: Record<string, string>,
  name: string,
  dimension = 'spec',
): Promise<string> {
  const c = await t.json<{ classId: string }>('POST', '/api/learning/classes', {
    headers,
    body: { name, dimension },
    expect: 201,
  });
  return c.classId;
}

export async function assignTo(
  t: TestRuntime,
  headers: Record<string, string>,
  errorId: string,
  classId: string,
): Promise<void> {
  await t.json('POST', `/api/learning/errors/${errorId}/root-cause`, { headers, body: { classId } });
  await t.drain();
}
