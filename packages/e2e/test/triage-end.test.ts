/**
 * Where a read-only triage session ends (supervisor + real mod-intake on claude-sim): at its diagnosis, whatever else
 * it left open, and nowhere before it. The ticket text reaches claude-sim as fenced untrusted data, where a scenario
 * marker is data and not a directive, so each scenario here is the harness's CLAUDE_SIM_SCENARIO and each describe
 * starts its own daemon.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InternalTicket, PublicTicket } from '@aoc/contracts';
import { Harness, waitFor, type TestUser } from './harness';
import { sessionDetail, untilSession } from './sim';

const scenarioDir = mkdtempSync(join(tmpdir(), 'aoc-e2e-triage-'));
afterAll(() => rmSync(scenarioDir, { recursive: true, force: true }));

/** A daemon whose every launch (here only the triage session) runs this scenario. */
function daemonRunning(name: string, steps: unknown[]): () => Harness {
  const file = join(scenarioDir, `${name}.json`);
  writeFileSync(file, JSON.stringify({ name, steps }));
  let h: Harness;
  beforeAll(async () => {
    h = await Harness.start({ supervisor: 'real', simEnv: { CLAUDE_SIM_SCENARIO: file } });
  });
  afterAll(async () => {
    await h?.close();
  });
  return () => h;
}

const DIAGNOSE = {
  kind: 'mcp',
  server: 'aoc',
  tool: 'report_diagnosis',
  args: {
    root_cause: 'The session-expiry check compares seconds with milliseconds.',
    confidence: 0.9,
    fix_plan: 'Normalise both values to milliseconds and add a regression test.',
    root_cause_class: 'unit-mismatch',
  },
};

async function submit(h: Harness, requester: TestUser, projectId: string, title: string): Promise<string> {
  const form = new FormData();
  form.set('title', title);
  form.set('description', 'I get kicked out at once after logging in.');
  form.set('severity', 'medium');
  form.set('projectId', projectId);
  const res = await fetch(`${h.url}/portal/api/intakes`, {
    method: 'POST',
    headers: requester.headers,
    body: form,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as PublicTicket).ticketId;
}

describe('(i) a triage session that declared a plan and reported a diagnosis', () => {
  // What the platform's triage prompt asks for: declare a diagnosis plan, inspect, report, end the turn.
  const daemon = daemonRunning('plan-then-diagnose', [
    { kind: 'think', ms: 300, outputTokens: 100 },
    {
      kind: 'mcp',
      server: 'aoc',
      tool: 'declare_plan',
      args: {
        phases: [
          {
            id: 'd',
            name: 'Diagnose',
            tasks: [
              { id: 'd1', title: 'Find the root cause', size: 's' },
              { id: 'd2', title: 'Confirm it', size: 's' },
            ],
          },
        ],
      },
    },
    { kind: 'tool', name: 'Grep', input: { pattern: 'session' } },
    DIAGNOSE,
    { kind: 'text', text: 'Diagnosis reported; ending my turn.' },
    { kind: 'endTurn', final: true },
  ]);

  it('is not kept alive by the plan it never closed: it completes, and the ticket moves on', async () => {
    const h = daemon();
    const requester = await h.user('requester', 'Aziz');
    const dev = await h.user('builder', 'Dev');
    const { projectId } = await h.project(dev, 'Plan Portal');
    const ticketId = await submit(h, requester, projectId, 'Kicked out after login (plan)');

    const gated = await waitFor(
      async () => {
        const t = await h.api<InternalTicket>('GET', `/api/tickets/${ticketId}`, { as: dev });
        return t.stage === 'fix_plan_gate' && t;
      },
      { timeout: 60_000, interval: 100, what: 'the fix-plan gate' },
    );
    const sessionId = gated.diagnoses[0]!.sessionId;
    const ended = await waitFor(() => h.events({ types: ['session.ended'], sessionId })[0], {
      what: 'the triage session to end',
    });
    expect(ended.meta).toEqual({ sessionId, outcome: 'completed' });
    // The plan was declared and left open, and nothing asked the session to continue it.
    expect(h.events({ types: ['plan.declared'], sessionId })).toHaveLength(1);
    expect(h.events({ types: ['task.done'], sessionId })).toEqual([]);
    expect(h.events({ types: ['session.turn_started'], sessionId }).map((e) => e.meta.reason)).toEqual([
      'launch',
    ]);
    expect(h.events({ types: ['session.turn_ended'], sessionId }).map((e) => e.meta.outcome)).toEqual([
      'end_turn',
    ]);
    const detail = await sessionDetail(h, sessionId, dev);
    expect(detail.lifecycle).toBe('ended');
    expect(detail.liveness?.state ?? null).toBeNull(); // no badge: not Waiting on you
    expect(h.store.verifyChain().ok).toBe(true);
  });
});

describe('(i) a triage session whose turn ends without a diagnosis', () => {
  const daemon = daemonRunning('no-diagnosis', [
    { kind: 'text', text: 'I read the code but I am not ready to say what is wrong.' },
    { kind: 'endTurn' },
    { kind: 'text', text: 'Still looking.' },
    { kind: 'endTurn', final: true },
  ]);

  it('is unfinished: auto-continued once, then waiting on the operator, and the ticket stays in triage', async () => {
    const h = daemon();
    const requester = await h.user('requester', 'Bao');
    const dev = await h.user('builder', 'Dev 2');
    const { projectId } = await h.project(dev, 'Silent Portal');
    const ticketId = await submit(h, requester, projectId, 'Kicked out after login (silent)');

    const launch = await waitFor(() => h.events({ types: ['session.launch_requested'], ticketId })[0], {
      what: 'the triage session',
    });
    const sessionId = String(launch.meta.sessionId);
    await untilSession(
      h,
      sessionId,
      dev,
      (d) => d.lifecycle === 'idle',
      'the session to wait on the operator',
    );
    expect(h.events({ types: ['session.turn_started'], sessionId }).map((e) => e.meta.reason)).toEqual([
      'launch',
      'continue',
    ]);
    expect(h.events({ types: ['session.ended'], sessionId })).toEqual([]);
    expect(h.events({ types: ['ticket.diagnosis_reported'], ticketId })).toEqual([]);
    expect((await h.api<InternalTicket>('GET', `/api/tickets/${ticketId}`, { as: dev })).stage).toBe(
      'triage',
    );
    expect(h.store.verifyChain().ok).toBe(true);
  });
});
