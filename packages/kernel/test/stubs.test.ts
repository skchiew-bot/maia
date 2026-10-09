import { describe, expect, it } from 'vitest';
import { createTestRuntime } from '../src';

describe('test kit stubs', () => {
  it('SimpleDecisionService enforces role, SoD and passkey and appends catalog events', async () => {
    const t = await createTestRuntime({ modules: [] });
    const builder = t.user('builder');
    const approver = t.user('approver');
    const d = t.decisions!.request(
      { kind: 'go_live', title: 'Go live', question: 'Promote?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], subjectType: 'ticket', subjectId: 'tkt_1', requesterId: builder.user.id },
      { kind: 'human', id: builder.user.id },
    );
    expect(d.requiredRole).toBe('approver');
    expect(d.requiresPasskey).toBe(true);
    await expect(t.decisions!.resolve(d.id, { optionId: 'yes' }, builder.user)).rejects.toThrow(/separation_of_duties|role/);
    await expect(t.decisions!.resolve(d.id, { optionId: 'yes' }, approver.user)).rejects.toThrow(/passkey/);
    const r = await t.decisions!.resolve(d.id, { optionId: 'yes', passkeyAssertion: { ok: 1 } }, approver.user);
    expect(r.resolution?.passkeyVerified).toBe(true);
    expect(t.rt.store.list({ typePrefix: 'decision.' }).map((e) => e.type)).toEqual(['decision.requested', 'decision.resolved']);
    expect(t.rt.store.verifyChain().ok).toBe(true);
    await t.close();
  });
});
