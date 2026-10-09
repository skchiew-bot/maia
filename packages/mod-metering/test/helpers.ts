import { fileURLToPath } from 'node:url';
import type { Actor, FxService, FxSession } from '@aoc/contracts';
import { createTestRuntime, type TestRuntime } from '@aoc/kernel';
import { createMeteringModule, METERING_CLOSE_JOB } from '../src';

export const RATE_CARD_FILE = fileURLToPath(new URL('../../../config/rate-card.json', import.meta.url));
const SYSTEM: Actor = { kind: 'system', id: 'test' };

/** ISO instant for a Kuala Lumpur wall-clock time (UTC+8, no DST). */
export const myt = (date: string, time = '10:00'): string =>
  new Date(`${date}T${time}:00+08:00`).toISOString();

/** Deterministic FX stub: rates by date (session null unless given); missing dates return null. */
export class StubFx implements FxService {
  readonly calls: string[] = [];
  constructor(
    private readonly rates: Record<
      string,
      { rate: number; status: 'live' | 'inherited'; sourceDate: string; session?: FxSession }
    >,
  ) {}
  rateFor(date: string) {
    this.calls.push(date);
    const r = this.rates[date];
    return r ? { ...r, session: r.session ?? null } : null;
  }
}

export async function meteringRuntime(
  opts: { now?: string; fx?: FxService; rateCardFile?: string } = {},
): Promise<TestRuntime> {
  return createTestRuntime({
    modules: [createMeteringModule()],
    now: opts.now ?? myt('2026-10-09', '10:00'),
    config: { metering: { rateCardFile: opts.rateCardFile ?? RATE_CARD_FILE } },
    services: opts.fx ? { fx: opts.fx } : undefined,
  });
}

export async function closeDays(t: TestRuntime): Promise<void> {
  await t.rt.runJob(METERING_CLOSE_JOB);
}

export function launch(
  t: TestRuntime,
  s: {
    sessionId: string;
    ownerId?: string | null;
    projectId?: string;
    processType?: string;
    model?: string;
    ticketId?: string | null;
    phaseId?: string | null;
    parentSessionId?: string | null;
  },
): void {
  const projectId = s.projectId ?? 'prj_a';
  t.rt.store.append({
    type: 'session.launch_requested',
    actor: s.ownerId ? { kind: 'human', id: s.ownerId } : SYSTEM,
    scope: { sessionId: s.sessionId, projectId },
    meta: {
      sessionId: s.sessionId,
      projectId,
      threadId: 'thr_1',
      processType: s.processType ?? 'feature',
      model: s.model ?? 'claude-opus-5-5',
      readOnly: false,
      credentialProfile: null,
      ticketId: s.ticketId ?? null,
      parentSessionId: s.parentSessionId ?? null,
      phaseId: s.phaseId ?? null,
    },
    payload: { prompt: 'build it', cwd: '/tmp/x' },
    source: 'api',
  });
}

export interface UsageInput {
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cw5m?: number;
  cw1h?: number;
  messages?: number;
  /** Source time of the batch (lastAt); defaults to now. */
  at?: string;
}

export function usage(t: TestRuntime, sessionId: string, u: UsageInput = {}): void {
  const at = u.at ?? t.clock.iso();
  t.rt.store.append({
    type: 'usage.recorded',
    actor: { kind: 'agent', id: sessionId },
    scope: { sessionId },
    meta: {
      sessionId,
      model: u.model ?? 'claude-opus-5-5',
      inputTokens: u.input ?? 0,
      outputTokens: u.output ?? 0,
      cacheReadTokens: u.cacheRead ?? 0,
      cacheWrite5mTokens: u.cw5m ?? 0,
      cacheWrite1hTokens: u.cw1h ?? 0,
      messages: u.messages ?? 1,
      contextTokens: 0,
      firstAt: at,
      lastAt: at,
    },
    payload: { messageIds: ['msg_1'] },
    source: 'sidecar',
  });
}

export function taskDone(
  t: TestRuntime,
  s: { sessionId: string; taskId: string; projectId?: string; phaseId?: string },
): void {
  const projectId = s.projectId ?? 'prj_a';
  t.rt.store.append({
    type: 'task.done',
    actor: { kind: 'agent', id: s.sessionId },
    scope: { sessionId: s.sessionId, projectId, taskId: s.taskId },
    meta: {
      sessionId: s.sessionId,
      projectId,
      taskId: s.taskId,
      phaseId: s.phaseId ?? 'ph1',
      weight: 1,
      evidenceKind: 'commit',
      evidenceVerified: true,
      flag: null,
      fileChangesSinceLast: 1,
    },
    payload: { evidence: { kind: 'commit', ref: 'abc1234' } },
    source: 'mcp',
  });
}

export function throttleHit(t: TestRuntime, sessionId: string): void {
  t.rt.store.append({
    type: 'throttle.hit',
    actor: SYSTEM,
    scope: { sessionId },
    meta: { sessionId, resetAt: null, source: 'stream' },
    payload: { message: 'usage limit reached' },
    source: 'sidecar',
  });
}

export function throttleCleared(t: TestRuntime, sessionId: string, idleMs: number): void {
  t.rt.store.append({
    type: 'throttle.cleared',
    actor: SYSTEM,
    scope: { sessionId },
    meta: { sessionId, idleMs },
    source: 'supervisor',
  });
}

export const HOUR = 3_600_000;
/** Cost of 1M tokens of a kind on claude-opus-5-5 at rate-card v1 (config/rate-card.json). */
export const OPUS_V1 = { input: 4, output: 20, cacheRead: 0.2, cw5m: 5, cw1h: 8 };
export const SONNET_V1 = { input: 2, output: 10 };
