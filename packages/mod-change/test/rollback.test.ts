import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LearningService, RollbackDTO } from '@aoc/contracts';
import { isWithin } from '../src/clone';
import {
  ACCEPTANCE_SCRIPT,
  PASSKEY,
  addGuardedRemote,
  cloneRef,
  draftAndAffirm,
  harness,
  makeRepo,
  remoteHead,
  setPromotionRemote,
  type Harness,
  type TestRepo,
} from './helpers';

const PROJECT = 'prj_shop';

describe('gated rollback (§8): verify on a branch, passkey decision only when clean, execute as a new commit', () => {
  let h: Harness;
  let repo: TestRepo;
  let good: string;
  let bad: string;
  const errors: Parameters<LearningService['recordError']>[0][] = [];
  afterEach(async () => {
    errors.length = 0;
    await h?.close();
  });

  function pinPhase(phaseId: string, sha: string, tag: string | null): void {
    if (tag) repo.git('tag', '-a', tag, '-m', `phase ${phaseId}`, sha);
    h.t.rt.store.append({
      type: 'phase.completed',
      actor: { kind: 'agent', id: 'ses_ledger' },
      scope: { projectId: PROJECT },
      meta: { sessionId: 'ses_ledger', projectId: PROJECT, phaseId, pinnedSha: sha, pinnedTag: tag },
      source: 'mcp',
    });
  }

  async function setup(
    project: Record<string, string> = { acceptanceCommand: 'node test.js' },
    files: Record<string, string> = {},
  ) {
    h = await harness({ learning: { recordError: (input) => void errors.push(input) } });
    repo = makeRepo({ 'state.txt': 'good v1\n', 'test.js': ACCEPTANCE_SCRIPT, ...files });
    good = repo.head();
    pinPhase('p1', good, 'aoc/phase/p1');
    bad = repo.commit('feat: v2', { 'state.txt': 'broken v2\n', 'src/new.ts': 'export const v2 = true;\n' });
    h.addProject(PROJECT, repo.dir, project);
  }

  const request = (body: Record<string, unknown>) =>
    h.t.json<RollbackDTO>('POST', '/api/rollbacks', {
      headers: h.builder.headers,
      body: { projectId: PROJECT, reason: 'v2 broke checkout', ...body },
      expect: 202,
    });
  const get = (id: string) =>
    h.t.json<RollbackDTO>('GET', `/api/rollbacks/${id}`, { headers: h.builder.headers });

  it('verifies the pinned target on aoc/rollback/<id>, raises the passkey decision when clean, then restores it as a new commit on main', async () => {
    await setup();
    const rb = await request({ targetRef: 'aoc/phase/p1' });
    expect(rb).toMatchObject({ status: 'requested', targetSha: good, requestedBy: h.builder.user.id });
    await h.settle();

    const verified = await get(rb.rollbackId);
    const branch = `aoc/rollback/${rb.rollbackId}`;
    expect(verified).toMatchObject({
      status: 'awaiting_approval',
      verification: { branch, clean: true, testsPassed: 3, testsFailed: 0 },
    });
    expect(verified.verification!.report).toContain('Result: CLEAN');
    expect(verified.verification!.report).toContain('node test.js [from project]');
    // The new branch is kept in the service clone, where no agent can move it; the project repository has none.
    expect(cloneRef(h, PROJECT, `refs/heads/${branch}`)).toBe(good);
    expect(() => repo.head(branch)).toThrow();
    expect(repo.head('main')).toBe(bad);
    // The acceptance test ran sandboxed, with no credential, in a fresh checkout outside the project repository.
    expect(h.sup.calls.every((c) => c.credentialProfile === null)).toBe(true);
    const run = h.sup.calls.find((c) => c.command.join(' ') === 'node test.js')!;
    expect(run).toMatchObject({
      env: { CI: '1' },
      sandbox: { handOver: [expect.stringContaining('aoc-rollback-verify-')] },
    });
    expect(isWithin(run.cwd, repo.dir)).toBe(false);
    expect(existsSync(run.cwd)).toBe(false);

    const card = h.t.decisions!.get(verified.decisionId!)!;
    expect(card).toMatchObject({
      kind: 'rollback',
      requiredRole: 'approver',
      requiresPasskey: true,
      subjectType: 'rollback',
      subjectId: rb.rollbackId,
      requesterId: h.builder.user.id,
    });
    // No one-tap rollback: the requester cannot approve, and the approver needs the passkey.
    await expect(h.t.decisions!.resolve(card.id, { optionId: 'approve' }, h.builder.user)).rejects.toThrow();
    await expect(h.t.decisions!.resolve(card.id, { optionId: 'approve' }, h.approver.user)).rejects.toThrow(
      /passkey/,
    );
    await h.t.decisions!.resolve(card.id, { optionId: 'approve', ...PASSKEY }, h.approver.user);
    await h.settle();

    const done = await get(rb.rollbackId);
    expect(done).toMatchObject({
      status: 'executed',
      approval: { approverId: h.approver.user.id, passkeyVerified: true },
      execution: { mainShaBefore: bad },
    });
    const main = repo.head('main');
    expect(done.execution!.mainShaAfter).toBe(main);
    // History preserved: a NEW commit on top of v2 whose tree is exactly the verified target's.
    expect(repo.git('rev-parse', `${main}^`)).toBe(bad);
    expect(repo.git('rev-parse', `${main}^{tree}`)).toBe(repo.git('rev-parse', `${good}^{tree}`));
    expect(repo.git('log', '--format=%H', 'main').split('\n')).toEqual([main, bad, good]);
    expect(repo.git('log', '-1', '--format=%B', 'main')).toContain(
      `Rollback to aoc/phase/p1 (AOC ${rb.rollbackId})`,
    );
    expect(repo.git('log', '-1', '--format=%B', 'main')).toContain(`AOC-Decision: ${card.id}`);
    // The checked-out working tree followed the fast-forward.
    expect(readFileSync(join(repo.dir, 'state.txt'), 'utf8')).toBe('good v1\n');
    expect(existsSync(join(repo.dir, 'src/new.ts'))).toBe(false);

    // No remote anywhere: the project's own branch moved, written as the session user; no credential, no push.
    expect(h.sup.calls.every((c) => c.credentialProfile === null)).toBe(true);
    const inProject = h.sup.gitCalls().filter((c) => isWithin(c.cwd, repo.dir));
    expect(inProject.length).toBeGreaterThan(0);
    expect(inProject.every((c) => c.sandboxed)).toBe(true);
    expect(
      h.sup.gitCalls().some((c) => c.args[0] === 'push' || (c.args[0] === 'reset' && c.args.includes('--hard'))),
    ).toBe(false);
    expect(h.types('rollback.')).toEqual([
      'rollback.requested',
      'rollback.verification_started',
      'rollback.verified',
      'rollback.approved',
      'rollback.executed',
    ]);
    expect(h.t.rt.store.verifyChain().ok).toBe(true);
  });

  it('pushes the restore commit from the service clone: one credentialed push, leased on the verified base, never forced', async () => {
    await setup();
    const remote = addGuardedRemote(repo);
    // The developers' speed bump in the project repository still refuses them, with nothing to unlock it; AOC never
    // runs it.
    expect(() => repo.git('push', 'origin', 'aoc/phase/p1:refs/heads/attempt')).toThrow(
      /only through an AOC promotion/,
    );
    const clone = setPromotionRemote(h, PROJECT, remote);
    const rb = await request({ targetRef: good.slice(0, 10) });
    await h.settle();
    await h.t.decisions!.resolve(
      (await get(rb.rollbackId)).decisionId!,
      { optionId: 'approve', ...PASSKEY },
      h.approver.user,
    );
    await h.settle();
    const done = await get(rb.rollbackId);
    expect(done).toMatchObject({ status: 'executed', execution: { mainShaBefore: bad } });
    const after = done.execution!.mainShaAfter;
    expect(remoteHead(remote)).toBe(after);
    expect(repo.head('main')).toBe(after); // the project repository followed
    expect(cloneRef(h, PROJECT, 'refs/aoc/target/main')).toBe(after);
    expect(h.sup.calls.filter((c) => c.credentialProfile !== null)).toHaveLength(1);
    expect(h.sup.gitCalls().filter((c) => c.args[0] === 'push')).toEqual([
      {
        profile: 'prod-promote',
        cwd: clone,
        sandboxed: false,
        args: [
          'push',
          '--porcelain',
          '--no-verify',
          `--force-with-lease=refs/heads/main:${bad}`,
          '--',
          remote,
          `${after}:refs/heads/main`,
        ],
      },
    ]);
  });

  it('a target whose acceptance tests fail is reported back and never reaches the approver', async () => {
    await setup();
    pinPhase('p2', bad, null);
    const rb = await request({ targetRef: bad });
    await h.settle();
    const v = await get(rb.rollbackId);
    expect(v).toMatchObject({
      status: 'not_clean',
      decisionId: null,
      verification: { clean: false, testsPassed: 2, testsFailed: 1 },
    });
    expect(v.verification!.report).toContain('NOT CLEAN');
    expect(v.verification!.report).toContain('# fail 1');
    expect(h.t.decisions!.list({ kind: ['rollback'] })).toHaveLength(0);
    expect(repo.head('main')).toBe(bad);
    expect(h.notifications.some((n) => n.severity === 'warn' && n.refs?.rollbackId === rb.rollbackId)).toBe(
      true,
    );
    expect(errors).toMatchObject([{ source: 'rollback', projectId: PROJECT }]);
  });

  it('only immutable, pinned targets are accepted', async () => {
    await setup();
    const code = async (body: Record<string, unknown>, headers = h.builder.headers) => {
      const res = await h.t.request('POST', '/api/rollbacks', {
        headers,
        body: { projectId: PROJECT, reason: 'try', ...body },
      });
      return { status: res.status, code: ((await res.json()) as { error?: { code: string } }).error?.code };
    };
    expect(await code({ targetRef: bad })).toEqual({ status: 422, code: 'target_not_pinned' });
    expect(await code({ targetRef: 'main' })).toEqual({ status: 422, code: 'target_not_pinned' });
    expect(await code({ targetRef: 'aoc/phase/p1' }, h.t.user('requester').headers)).toMatchObject({
      status: 403,
    });
    repo.git('tag', '-f', '-a', 'aoc/phase/p1', '-m', 'moved', bad);
    expect(await code({ targetRef: 'aoc/phase/p1' })).toEqual({ status: 409, code: 'pin_moved' });
    expect(await code({ targetRef: good })).toEqual({ status: 202, code: undefined });
  });

  it('a rejected rollback, or an approval without a verified passkey, never touches main', async () => {
    await setup();
    const first = await request({ targetRef: 'aoc/phase/p1' });
    const second = await request({ targetRef: good });
    await h.settle();
    await h.t.decisions!.resolve(
      (await get(first.rollbackId)).decisionId!,
      { optionId: 'reject', comment: 'Fix forward instead', ...PASSKEY },
      h.approver.user,
    );
    h.t.decisions!.resolveByPolicy((await get(second.rollbackId)).decisionId!, 'approve', {
      kind: 'system',
      id: 'policy-test',
    });
    await h.settle();
    expect(await get(first.rollbackId)).toMatchObject({
      status: 'rejected',
      rejection: { approverId: h.approver.user.id, comment: 'Fix forward instead' },
    });
    expect(await get(second.rollbackId)).toMatchObject({
      status: 'rejected',
      rejection: { comment: expect.stringContaining('passkey') },
    });
    expect(repo.head('main')).toBe(bad);
    expect(h.sup.calls.some((c) => c.credentialProfile === 'prod-promote')).toBe(false);
  });

  it('runs the change record’s acceptance test when it is a command, else npm test when there is a package.json', async () => {
    await setup(
      {},
      { 'package.json': JSON.stringify({ name: 'shop', private: true, scripts: { test: 'node test.js' } }) },
    );
    const changeId = await draftAndAffirm(h, {
      projectId: PROJECT,
      scope: 'main',
      owner: h.builder,
      rollbackRef: good,
      acceptanceTest: 'node test.js',
    });
    const viaChange = await request({ targetRef: good, changeId });
    const viaPackage = await request({ targetRef: good });
    await h.settle();
    expect((await get(viaChange.rollbackId)).verification!.report).toContain(
      'Command: node test.js [from change]',
    );
    const pkg = await get(viaPackage.rollbackId);
    expect(pkg.verification!.report).toContain('Command: npm test --silent [from package.json]');
    expect(pkg.verification!.clean).toBe(true);
    // The card's free text sits with the change record the rollback is for, else with the project.
    expect(h.requested.get((await get(viaChange.rollbackId)).decisionId!)).toMatchObject({ bodyScope: changeId });
    expect(h.requested.get(pkg.decisionId!)).toMatchObject({ bodyScope: PROJECT });
  });

  it('never runs a change record’s acceptance test through a shell: a chained command does not run (G-50)', async () => {
    await setup();
    const marker = join(repo.dir, '..', `escaped-${process.pid}`);
    const changeId = await draftAndAffirm(h, {
      projectId: PROJECT,
      scope: 'main',
      owner: h.builder,
      rollbackRef: good,
      acceptanceTest: `node test.js; touch ${marker}`,
    });
    const { rollbackId } = await request({ targetRef: good, changeId });
    await h.settle();
    const v = (await get(rollbackId)).verification!;
    // Not a command without a shell, so it is read as prose: the project's own command runs instead.
    expect(v.report).toContain('Command: node test.js [from project]');
    expect(v.clean).toBe(true);
    expect(existsSync(marker)).toBe(false);
    const run = h.sup.calls.at(-1)!;
    expect(run.command).toEqual(['node', 'test.js']);
  });

  it('reports back when verification cannot run at all', async () => {
    await setup({});
    h.sup.profiles['prod-promote'] = {};
    const noCommand = await request({ targetRef: good });
    await h.settle();
    const v = await get(noCommand.rollbackId);
    expect(v).toMatchObject({ status: 'not_clean', decisionId: null });
    expect(v.verification!.report).toContain('no acceptance command');
  });
});
