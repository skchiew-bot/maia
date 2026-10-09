import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BreakglassDTO, JsonValue, PromotionDTO, SelfModificationService } from '@aoc/contracts';
import {
  PASSKEY,
  approveChange,
  draftAndAffirm,
  harness,
  makeRepo,
  type Harness,
  type TestRepo,
} from './helpers';

const PROJECT = 'prj_aoc';

/** Stand-in for mod-audit's service: the repo under test is an AOC repo whose core is packages/kernel/ and config/. */
class FakeSelfmod implements SelfModificationService {
  readonly external: Record<string, JsonValue>[] = [];
  constructor(private readonly aocRepo: string | null) {}
  coreFiles(repoPath: string, files: string[]): string[] | null {
    if (!this.aocRepo || resolve(repoPath) !== resolve(this.aocRepo)) return null;
    return files.filter((f) => f.startsWith('packages/kernel/') || f.startsWith('config/'));
  }
  recordExternal(entry: Record<string, JsonValue>): boolean {
    this.external.push(entry);
    return true;
  }
}

describe('self-modification boundary at the promotion gate (§13, G-41)', () => {
  let h: Harness;
  let repo: TestRepo;
  let base: string;
  let changeId: string;
  let selfmod: FakeSelfmod;
  afterEach(async () => h?.close());

  async function setup(opts: { aocRepo?: boolean; service?: boolean } = {}) {
    repo = makeRepo({ 'packages/kernel/store.ts': 'export const v = 1;\n', 'packages/web/app.ts': 'x\n' });
    base = repo.head();
    selfmod = new FakeSelfmod(opts.aocRepo === false ? null : repo.dir);
    h = await harness({
      ...(opts.service === false ? {} : { selfmod }),
      config: { selfModification: { aocRepoPaths: [repo.dir] } },
    });
    h.addProject(PROJECT, repo.dir);
    h.t.sessions!.add({ sessionId: 'ses_agent', projectId: PROJECT, mode: 'managed' });
    changeId = await draftAndAffirm(h, {
      projectId: PROJECT,
      scope: 'reversible_off_main',
      owner: h.builder,
      rollbackRef: base,
    });
    await approveChange(h, changeId, h.builder);
    await h.t.json('POST', `/api/changes/${changeId}/start`, {
      headers: h.builder.headers,
      body: { sessionId: 'ses_agent' },
    });
  }

  /** A traced commit of the managed session: trailers plus a HEAD the ledger recorded for it. */
  function agentCommit(branch: string, files: Record<string, string>): string {
    repo.git('checkout', '-q', '-b', branch);
    const sha = repo.commit(`feat: work\n\nAOC-Session: ses_agent\nAOC-Change: ${changeId}`, files);
    repo.git('checkout', '-q', 'main');
    h.t.rt.store.append({
      type: 'task.done',
      actor: { kind: 'agent', id: 'ses_agent' },
      scope: { sessionId: 'ses_agent', projectId: PROJECT, taskId: `tsk_${branch.replace(/\W/g, '_')}` },
      meta: {
        sessionId: 'ses_agent',
        projectId: PROJECT,
        taskId: `tsk_${branch.replace(/\W/g, '_')}`,
        phaseId: 'ph_1',
        weight: 1,
        evidenceKind: 'commit',
        evidenceVerified: true,
        flag: null,
        fileChangesSinceLast: 1,
        headSha: sha,
      },
      payload: { evidence: { kind: 'commit', ref: sha } },
      source: 'mcp',
    });
    return sha;
  }

  const promote = (fromRef: string) =>
    h.t.request('POST', '/api/promotions', {
      headers: h.builder.headers,
      body: { projectId: PROJECT, fromRef, changeId },
    });

  it('refuses a promotion whose commits from a managed session change the core of an AOC repo, and records it outside AOC', async () => {
    await setup();
    const sha = agentCommit('feature/kernel', {
      'packages/kernel/store.ts': 'export const v = 2;\n',
      'packages/web/app.ts': 'y\n',
    });
    expect(h.mod.engine.provenance(PROJECT, sha)).toMatchObject({ ok: true }); // the trailers are genuine
    const res = await promote('feature/kernel');
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { details: { promotion: PromotionDTO; reasons: string[] } } };
    expect(body.error.details.promotion.refusal).toMatchObject({
      reason: 'self_modification',
      orphanShas: [sha],
    });
    expect(body.error.details.reasons[0]).toContain('managed session ses_agent changed AOC');
    expect(h.t.rt.store.list({ types: ['promotion.refused'] })[0]!.meta).toMatchObject({
      reason: 'self_modification',
      orphanShas: [sha],
    });
    expect(selfmod.external).toEqual([
      {
        kind: 'selfmod.promotion_refused',
        projectId: PROJECT,
        promotionId: body.error.details.promotion.promotionId,
        fromSha: sha,
        commits: [sha],
        sessionIds: ['ses_agent'],
        files: ['packages/kernel/store.ts'],
      },
    ]);
    expect(h.t.decisions!.list({ kind: ['go_live'] })).toHaveLength(0);
    expect(repo.head('main')).toBe(base);
  });

  it('feature changes in an AOC repo, and any change in another repo, pass the boundary untouched', async () => {
    await setup();
    agentCommit('feature/web', { 'packages/web/app.ts': 'z\n' });
    expect((await promote('feature/web')).status).toBe(202);
    await h.close();

    await setup({ aocRepo: false });
    agentCommit('feature/kernel', { 'packages/kernel/store.ts': 'export const v = 3;\n' });
    expect((await promote('feature/kernel')).status).toBe(202);
    expect(selfmod.external).toEqual([]);
  });

  it('fails closed when a listed AOC repo cannot be checked (no boundary service)', async () => {
    await setup({ service: false });
    agentCommit('feature/web', { 'packages/web/app.ts': 'z\n' });
    const res = await promote('feature/web');
    expect(res.status).toBe(422);
    expect(h.t.rt.store.list({ types: ['promotion.refused'] })[0]!.meta).toMatchObject({
      reason: 'self_modification',
      orphanShas: [],
    });
  });

  it('a break-glass promotion that lands core changes in an AOC repo is recorded outside AOC', async () => {
    await setup();
    repo.git('checkout', '-q', '-b', 'hotfix/kernel');
    const hotfix = repo.commit('hotfix: kernel', { 'packages/kernel/store.ts': 'export const v = 9;\n' });
    repo.git('checkout', '-q', 'main');
    h.t.llm.on('change.draft', () => ({
      impact: 'Post-incident',
      mitigation: 'Alert.',
      rollbackPlan: 'Return to the pre-incident commit.',
      rollbackRef: base,
      acceptanceTest: 'npm test',
    }));
    const bg = await h.t.json<BreakglassDTO>('POST', '/api/breakglass', {
      headers: h.builder.headers,
      body: { projectId: PROJECT, ref: 'hotfix/kernel', justification: 'Production is down' },
      expect: 202,
    });
    await h.t.decisions!.resolve(bg.decisionId, { optionId: 'approve', ...PASSKEY }, h.approver.user);
    await h.settle();
    expect(repo.head('main')).toBe(hotfix);
    const promotionId = h.t.rt.store.list({ types: ['promotion.completed'] })[0]!.meta.promotionId;
    expect(selfmod.external).toEqual([
      {
        kind: 'selfmod.promoted',
        projectId: PROJECT,
        promotionId,
        mainShaBefore: base,
        mainShaAfter: hotfix,
        breakglass: true,
        decisionId: bg.decisionId,
        commits: [hotfix],
        files: ['packages/kernel/store.ts'],
      },
    ]);
  });
});
