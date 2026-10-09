/** Helpers for scenarios the real supervisor runs on claude-sim (`Harness.start({ supervisor: 'real' })`). */
import type { SessionDetail, StoredEvent } from '@aoc/contracts';
import { waitFor, type Harness, type TestUser } from './harness';

/**
 * POST /api/sessions; `scenario` is a claude-sim scenario name or the path of a scenario JSON file. The marker is on
 * its own line: the first line becomes the thread title, and a rollover brief (which carries the title into the
 * successor's first turn) would otherwise hand the successor the predecessor's scenario.
 */
export async function launchSim(h: Harness, as: TestUser, projectId: string, scenario: string, processType = 'feature-build'): Promise<string> {
  const r = await h.api<{ sessionId: string }>('POST', '/api/sessions', {
    as,
    body: { processType, projectId, prompt: `Work through your plan.\n[[scenario:${scenario}]]` },
    expect: 201,
  });
  return r.sessionId;
}

export const sessionDetail = (h: Harness, sessionId: string, as: TestUser) =>
  h.api<SessionDetail>('GET', `/api/sessions/${sessionId}`, { as });

export function untilSession(
  h: Harness,
  sessionId: string,
  as: TestUser,
  pred: (d: SessionDetail) => boolean,
  what: string,
  timeout = 60_000,
): Promise<SessionDetail> {
  return waitFor(async () => {
    const d = await sessionDetail(h, sessionId, as);
    return pred(d) && d;
  }, { timeout, interval: 100, what });
}

const payloadOf = (h: Harness, e: StoredEvent) => h.store.readPayload(e) as Record<string, unknown> | null;

export const turnsOf = (h: Harness, sessionId: string) =>
  h.events({ types: ['session.turn_started'], sessionId }).map((e) => ({
    turn: e.meta.turn as number,
    reason: e.meta.reason as string,
    text: (payloadOf(h, e)?.injectedText as string | undefined) ?? '',
  }));

export const outcomesOf = (h: Harness, sessionId: string) =>
  h.events({ types: ['session.turn_ended'], sessionId }).map((e) => e.meta.outcome);
