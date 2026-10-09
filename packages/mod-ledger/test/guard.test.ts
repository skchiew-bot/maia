import { afterEach, describe, expect, it } from 'vitest';
import type { SessionInfo } from '@aoc/contracts';
import { NO_MANIFEST_REASON } from '../src';
import { createHarness, PLAN, type Harness } from './harness';

let h: Harness;
afterEach(async () => h?.close());

const evaluate = (h: Harness, session: SessionInfo, toolName: string) =>
  h.t.rt.policy.evaluate({ session, mode: session.mode, toolName, toolInput: {}, cwd: '/work' });

describe('no-manifest guard (plan gate, §4)', () => {
  it('blocks every non-read-only tool, Bash included, until the plan is declared', async () => {
    h = await createHarness();
    const projectId = h.project();
    const s = h.session({ sessionId: 'ses_gate', projectId });

    for (const tool of [
      'Edit',
      'Write',
      'Bash',
      'NotebookEdit',
      'Task',
      'mcp__github__create_pull_request',
    ]) {
      const r = evaluate(h, s, tool);
      expect(r, tool).toMatchObject({ decision: 'deny', guard: 'no-manifest', blockReason: 'no_manifest' });
      expect(r.reason).toBe(NO_MANIFEST_REASON);
    }
    expect(NO_MANIFEST_REASON).toBe('Declare your plan with mcp__aoc__declare_plan first (AOC-SPEC-003 §4)');
    for (const tool of [
      'Read',
      'Glob',
      'Grep',
      'WebFetch',
      'WebSearch',
      'ToolSearch',
      'mcp__aoc__declare_plan',
      'mcp__aoc__request_decision',
      'mcp__aoc__get_status',
    ]) {
      expect(evaluate(h, s, tool).decision, tool).toBe('allow');
    }

    await h.mcp('declare_plan', s.sessionId, PLAN);
    expect(evaluate(h, s, 'Edit').decision).toBe('allow');
    expect(evaluate(h, s, 'Bash').decision).toBe('allow');
  });

  it('abstains for process types that do not require a plan and for observed sessions', async () => {
    h = await createHarness();
    const projectId = h.project();
    const verify = h.session({ sessionId: 'ses_verify', projectId, processType: 'rollback-verify' });
    expect(evaluate(h, verify, 'Bash').decision).toBe('allow');
    const observed = h.session({ sessionId: 'ses_obs', projectId, mode: 'observed' });
    expect(evaluate(h, observed, 'Edit').decision).toBe('allow');
  });

  it('requires a plan when the registry is unavailable or the type is unknown', async () => {
    h = await createHarness({ withRegistry: false });
    const projectId = h.project();
    const s = h.session({ sessionId: 'ses_noreg', projectId, processType: 'rollback-verify' });
    expect(evaluate(h, s, 'Edit')).toMatchObject({ decision: 'deny', blockReason: 'no_manifest' });
  });
});
