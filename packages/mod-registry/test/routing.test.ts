import { describe, expect, expectTypeOf, it } from 'vitest';
import type { CreditService, RegistryService } from '@aoc/contracts';
import { approvePlaybook, retirePlaybook, seedPlaybook, start } from './helpers';

/** A credit service that says everyone is broke: routing must not care (§10, R8). */
const brokeCredits: CreditService = {
  checkBoundary: () => ({ continue: false, reason: 'credit_cap', instruction: 'Credit cap reached' }),
  balance: (userId) => ({
    userId,
    period: '2026-10',
    allocationUsd: 300,
    grantedUsd: 75,
    usedUsd: 400,
    balanceUsd: -25,
    autoGrantUsed: true,
    pendingTopupRequestId: 'tpu_1',
    exempt: false,
  }),
};

describe('model routing (§2.2, §10)', () => {
  it('discovery-class always runs on its model; execution switches only while an approved playbook is active', async () => {
    const t = await start();
    const reg = t.rt.services.get('registry');
    expect(reg.modelFor('discovery')).toBe('opus');
    expect(reg.modelFor('feature-build')).toBe('opus');
    expect(reg.modelFor('test-repair')).toBe('sonnet');
    expect(reg.modelFor('bug-triage')).toBe('opus');

    seedPlaybook(t, { playbookId: 'pbk_fb1', processType: 'feature-build', approve: false });
    expect(reg.activePlaybook('feature-build')).toBeNull();
    expect(reg.modelFor('feature-build')).toBe('opus'); // a proposal is not a playbook

    approvePlaybook(t, 'pbk_fb1');
    expect(reg.activePlaybook('feature-build')).toMatchObject({
      playbookId: 'pbk_fb1',
      status: 'approved',
      steps: [{ id: 's1', title: 'Do the thing' }],
    });
    expect(reg.modelFor('feature-build')).toBe('sonnet');

    retirePlaybook(t, 'pbk_fb1');
    expect(reg.activePlaybook('feature-build')).toBeNull();
    expect(reg.modelFor('feature-build')).toBe('opus');

    // An approved playbook guides discovery-class runs but never moves them off their model.
    seedPlaybook(t, { playbookId: 'pbk_disc', processType: 'discovery' });
    expect(reg.activePlaybook('discovery')?.playbookId).toBe('pbk_disc');
    expect(reg.modelFor('discovery')).toBe('opus');

    // Without an executionModel there is nothing to switch to.
    seedPlaybook(t, { playbookId: 'pbk_tri', processType: 'bug-triage' });
    expect(reg.modelFor('bug-triage')).toBe('opus');

    expect(() => reg.modelFor('made-up-type')).toThrow(/not in the fixed registry/);
    await t.close();
  });

  it('a crypto-shredded playbook cannot be followed, so routing falls back to the discovery model', async () => {
    const t = await start();
    const reg = t.rt.services.get('registry');
    seedPlaybook(t, { playbookId: 'pbk_fb1', processType: 'feature-build' });
    expect(reg.modelFor('feature-build')).toBe('sonnet');
    t.rt.store.eraseScope('pbk_fb1', { actor: { kind: 'human', id: 'usr_ceo' }, reason: 'secret_leak' });
    expect(reg.activePlaybook('feature-build')).toBeNull();
    expect(reg.modelFor('feature-build')).toBe('opus');
    await t.close();
  });

  it('has no budget or credit input: modelFor takes the process type only, and an exhausted budget changes nothing', async () => {
    expectTypeOf<Parameters<RegistryService['modelFor']>>().toEqualTypeOf<[processType: string]>();
    const t = await start({ services: { credits: brokeCredits } });
    const reg = t.rt.services.get('registry');
    expect(reg.modelFor.length).toBe(1);
    expect(t.rt.services.get('credits').balance('usr_dev').balanceUsd).toBeLessThan(0);
    expect(reg.modelFor('discovery')).toBe('opus');
    expect(reg.modelFor('feature-build')).toBe('opus');
    seedPlaybook(t, { playbookId: 'pbk_fb1', processType: 'feature-build' });
    expect(reg.modelFor('feature-build')).toBe('sonnet');
    await t.close();
  });
});
