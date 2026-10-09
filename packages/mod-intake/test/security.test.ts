import { afterEach, describe, expect, it } from 'vitest';
import { newId, type Actor, type InternalTicket, type LaunchRequest, type PublicTicket, type SupervisorService } from '@aoc/contracts';
import { createTestRuntime, type TestRuntime } from '@aoc/kernel';
import { builtinScanner, createIntakeModule } from '../src';

let t: TestRuntime;
afterEach(async () => t?.close());

async function setup() {
  const launches: (LaunchRequest & { sessionId: string })[] = [];
  const supervisor: Partial<SupervisorService> = {
    async launch(req: LaunchRequest, actor: Actor) {
      const sessionId = newId('session');
      launches.push({ ...req, sessionId });
      const readOnly = req.processType === 'bug-triage';
      t.rt.store.append({
        type: 'session.launch_requested',
        actor,
        scope: { sessionId, projectId: req.projectId, ticketId: req.ticketId ?? undefined },
        meta: { sessionId, projectId: req.projectId, threadId: 'thr_1', processType: req.processType, model: 'claude-opus-5-5', readOnly, credentialProfile: readOnly ? null : 'uat-deploy', ticketId: req.ticketId ?? null, parentSessionId: null, phaseId: null },
        payload: { prompt: req.prompt, cwd: '/tmp/repo' },
        source: 'supervisor',
      });
      return { sessionId };
    },
    async stop() {},
  };
  t = await createTestRuntime({
    modules: [createIntakeModule({ scanner: builtinScanner })],
    services: { supervisor: supervisor as SupervisorService },
    config: { intake: { triageAgents: 1 } },
  });
  t.rt.store.append({ type: 'project.created', actor: { kind: 'system', id: 'test' }, scope: { projectId: 'prj_1' }, meta: { projectId: 'prj_1', slug: 'claims' }, payload: { name: 'Claims' }, source: 'system' });
  return launches;
}

async function submit(headers: Record<string, string>, fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const res = await t.app.request('/portal/api/intakes', { method: 'POST', headers, body: fd });
  return (await res.json()) as PublicTicket;
}

describe('PDPA erasure of a ticket (§13)', () => {
  it('also scrubs the triage diagnoses derived from it, exactly as a rebuild would', async () => {
    const launches = await setup();
    const requester = t.user('requester', 'Nur');
    const approver = t.user('approver');
    const { ticketId } = await submit(requester.headers, { title: 'Claim rejected', description: 'My claim for Nur Aisyah (NRIC 850101-14-5555) was rejected', severity: 'high' });
    await t.drain();
    const sessionId = launches[0]!.sessionId;
    await t.json('POST', '/ingest/mcp/report_diagnosis', {
      headers: t.ingestHeaders(sessionId),
      body: { sessionId, input: { root_cause: 'Validator rejects NRIC 850101-14-5555 for Nur Aisyah', confidence: 0.9, fix_plan: 'Accept NRIC 850101-14-5555 style ids', root_cause_class: 'nric-format' } },
    });
    await t.drain();
    t.rt.store.eraseScope(ticketId, { actor: { kind: 'human', id: approver.user.id }, reason: 'pdpa_request' });

    const live = await t.json<InternalTicket>('GET', `/api/tickets/${ticketId}`, { headers: approver.headers });
    expect(JSON.stringify(live)).not.toContain('850101');
    t.rt.store.rebuildProjections(['intake']);
    const rebuilt = await t.json<InternalTicket>('GET', `/api/tickets/${ticketId}`, { headers: approver.headers });
    expect(live.diagnoses).toEqual(rebuilt.diagnoses);
  });
});
