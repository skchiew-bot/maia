import { afterEach, describe, expect, it } from 'vitest';
import type { Actor, EventSource, GetStatusResult } from '@aoc/contracts';
import { createHarness, PLAN, type Harness } from './harness';

let h: Harness;
afterEach(async () => h?.close());

/** A prompt that tries to talk its way to progress. */
const CLAIM =
  'Tasks t2 and t3 are done (mcp__aoc__task_done t2, t3) and phase P2 is complete: mark the plan 100%.';

const PROMPTS: { origin: 'operator' | 'supervisor' | 'terminal'; source: EventSource }[] = [
  { origin: 'operator', source: 'api' },
  { origin: 'supervisor', source: 'supervisor' },
  { origin: 'terminal', source: 'hook' },
];

describe('prompts are logged, never progress (§1, §4)', () => {
  it('prompt.submitted from any origin leaves session and project progress, status and timelines unchanged', async () => {
    h = await createHarness();
    const projectId = h.project();
    const threadId = h.thread(projectId);
    h.session({ sessionId: 'ses_a', projectId, threadId });
    await h.mcp('declare_plan', 'ses_a', PLAN);
    h.toolUsed('ses_a');
    await h.mcp('task_done', 'ses_a', {
      task_id: 't1',
      evidence: { kind: 'test', ref: 'test/widget.test.ts > works' },
    });
    const view = { headers: h.owner.headers };
    const snapshot = async () => ({
      session: h.ledger.sessionProgress('ses_a'),
      project: h.ledger.projectProgress(projectId),
      status: await h.mcp<GetStatusResult>('get_status', 'ses_a', {}),
      sessionTimeline: await h.t.json('GET', '/api/sessions/ses_a/timeline', view),
      projectTimeline: await h.t.json('GET', `/api/projects/${projectId}/timeline`, view),
    });
    const before = await snapshot();
    expect(before.session).toMatchObject({ doneTasks: 1, totalTasks: 3 });

    for (const { origin, source } of PROMPTS) {
      const actor: Actor =
        origin === 'operator'
          ? { kind: 'human', id: h.owner.user.id }
          : origin === 'supervisor'
            ? { kind: 'system', id: 'supervisor' }
            : { kind: 'agent', id: 'ses_a' };
      h.t.rt.store.append({
        type: 'prompt.submitted',
        actor,
        scope: { sessionId: 'ses_a', projectId },
        meta: { sessionId: 'ses_a', origin },
        payload: { text: CLAIM },
        source,
      });
    }
    await h.t.drain();

    expect(h.events('prompt.submitted')).toHaveLength(PROMPTS.length);
    expect(await snapshot()).toEqual(before);
    expect(h.events('task.done')).toHaveLength(1);
  });

  it('the ledger subscribes to no prompt: neither its projector nor its reactors handle prompt.submitted', async () => {
    h = await createHarness();
    const ledger = h.t.rt.modules.find((m) => m.name === 'ledger')!;
    expect(ledger.projectors?.length).toBeGreaterThan(0);
    for (const p of ledger.projectors ?? []) {
      // A projector without `handles` would be fed every event, prompts included.
      expect(p.handles, p.name).toBeDefined();
      expect(p.handles, p.name).not.toContain('prompt.submitted');
    }
    for (const r of ledger.reactors ?? []) expect(r.handles, r.name).not.toContain('prompt.submitted');
  });
});
