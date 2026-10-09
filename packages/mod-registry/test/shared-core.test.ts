/**
 * Playbooks and lessons share one distillation engine (§11): the model call, the deterministic fallback
 * and the Approver gate of a playbook proposal run through the shared core in @aoc/distill.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DistillResponse } from '@aoc/contracts';
import * as core from '@aoc/distill';
import type { TestRuntime } from '@aoc/kernel';
import { PLAYBOOK_GATE } from '../src/distill';
import { LLM_PLAYBOOK, seedRun, start } from './helpers';

vi.mock('@aoc/distill', async (importOriginal) => {
  const real = await importOriginal<typeof import('@aoc/distill')>();
  return {
    ...real,
    distill: vi.fn(real.distill),
    withFallback: vi.fn(real.withFallback),
    proposeForApproval: vi.fn(real.proposeForApproval),
    gateVerdict: vi.fn(real.gateVerdict),
  };
});

let t: TestRuntime;
afterEach(async () => {
  vi.clearAllMocks();
  await t?.close();
});

const distill = async (sessionId: string, headers: Record<string, string>) =>
  t.json<DistillResponse>('POST', '/api/playbooks/distill', { headers, body: { sessionId }, expect: 201 });

describe('playbook proposals go through the shared distillation core', () => {
  it('the model call, the fallback and the Approver gate are the shared ones', async () => {
    t = await start();
    t.llm.on('registry.distill', LLM_PLAYBOOK);
    await seedRun(t, { sessionId: 'ses_run1' });
    const curator = t.user('builder');
    const out = await distill('ses_run1', curator.headers);

    expect(out.method).toBe('llm');
    expect(core.distill).toHaveBeenCalledTimes(1);
    const [llm, req] = vi.mocked(core.distill).mock.calls[0]!;
    expect(llm).toBe(t.llm);
    expect(req).toMatchObject({ purpose: 'registry.distill', model: 'sonnet', maxTokens: 4000 });
    expect(core.withFallback).toHaveBeenCalledTimes(1);
    expect(core.proposeForApproval).toHaveBeenCalledWith(
      expect.objectContaining({ gate: PLAYBOOK_GATE, actor: { kind: 'human', id: curator.user.id } }),
    );
    expect(t.decisions!.get(out.decisionId)).toMatchObject({
      kind: 'playbook_approval',
      requiredRole: 'approver',
    });
  });

  it('only a person binds a playbook: a policy resolution that picks "approve" rejects it', async () => {
    t = await start();
    await seedRun(t, { sessionId: 'ses_run1' });
    const out = await distill('ses_run1', t.user('builder').headers); // the model fails: deterministic fallback
    expect(out.method).toBe('fallback');
    t.decisions!.resolveByPolicy(out.decisionId, 'approve', { kind: 'system', id: 'some-policy' });
    await t.drain();
    expect(t.rt.store.list({ types: ['playbook.approved'] })).toEqual([]);
    expect(t.rt.store.list({ types: ['playbook.rejected'] })).toHaveLength(1);
    expect(t.rt.services.get('registry').activePlaybook('feature-build')).toBeNull();
    expect(core.gateVerdict).toHaveBeenCalled();
  });
});
