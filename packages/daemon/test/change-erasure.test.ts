import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DecisionCardView } from '@aoc/contracts';
import { createGitService, FakeLlm, initRepo } from '@aoc/kernel';
import { createChangeModule } from '@aoc/mod-change';
import { createDecisionsModule } from '@aoc/mod-decisions';
import { bootTestServer, removeTempDirs, tempDir, type TestServer } from './helpers';

const PROJECT = 'prj_shop';
const ERASED = '[erased]';
const git = createGitService();
const servers: TestServer[] = [];
afterEach(async () => {
  for (const t of servers.splice(0)) await t.close();
  removeTempDirs();
});

/** The real decisions and change modules on one log: what a card is kept under decides what an erasure reaches. */
async function boot() {
  const repo = join(tempDir('aoc-repo-'), 'shop');
  initRepo(repo, { files: { 'README.md': '# shop\n' } });
  const base = git.run(repo, ['rev-parse', 'HEAD']).stdout.trim();
  const t = await bootTestServer({
    modules: [createDecisionsModule(), createChangeModule()],
    llm: new FakeLlm(),
  });
  servers.push(t);
  t.aoc.runtime.store.append({
    type: 'project.created',
    actor: { kind: 'system', id: 'test' },
    scope: { projectId: PROJECT },
    meta: { projectId: PROJECT, slug: 'shop' },
    payload: { name: 'Shop', repoPath: repo, defaultBranch: 'main' },
    source: 'system',
  });
  const builder = t.user('builder');
  const approver = t.user('approver');
  const call = async <T>(who: { headers: Record<string, string> }, method: string, path: string, body?: unknown) => {
    const res = await t.request(path, {
      method,
      headers: { ...who.headers, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as T };
  };
  return { t, base, builder, approver, call };
}

const shred = (t: TestServer, scopeId: string) =>
  t.aoc.runtime.store.eraseScope(scopeId, { actor: { kind: 'human', id: 'usr_dpo' }, reason: 'pdpa_request' });

describe('the cards mod-change raises are erasable by the change record they are about (PDPA)', () => {
  it('a change request card, and what the approver typed on it, are shredded with the change; other changes keep theirs', async () => {
    const { t, base, builder, approver, call } = await boot();
    const request = async (title: string, impact: string) => {
      const created = await call<{ changeId: string }>(builder, 'POST', '/api/changes', {
        projectId: PROJECT,
        scope: 'main',
        title,
      });
      const { changeId } = created.json;
      for (const field of ['impact', 'mitigation', 'rollbackPlan', 'acceptanceTest'])
        await call(builder, 'POST', `/api/changes/${changeId}/fields/${field}`, {
          value: field === 'impact' ? impact : `Considered ${field}.`,
          dwellMs: 9000,
          ...(field === 'rollbackPlan' ? { rollbackRef: base } : {}),
        });
      const submitted = await call<{ decisionId: string }>(builder, 'POST', `/api/changes/${changeId}/submit`, {});
      expect(submitted.status).toBe(200);
      return { changeId, cardId: submitted.json.decisionId };
    };
    const jane = await request('Fix Jane Tan’s refund', 'Refunds for Jane Tan (NRIC 900101-14-5555) are re-run.');
    const other = await request('Tidy the footer', 'Footer links only.');

    const store = t.aoc.runtime.store;
    const requestedScope = (cardId: string) =>
      store.list({ types: ['decision.requested'], decisionId: cardId })[0]!.bodyScope;
    expect(requestedScope(jane.cardId)).toBe(jane.changeId);
    expect(requestedScope(other.cardId)).toBe(other.changeId);

    const resolved = await call<DecisionCardView>(approver, 'POST', `/api/decisions/${jane.cardId}/resolve`, {
      optionId: 'reject',
      comment: 'Call Jane Tan on 012-3456789 before anything is re-run.',
    });
    expect(resolved.status).toBe(200);
    const card = (id: string) => call<DecisionCardView>(approver, 'GET', `/api/decisions/${id}`).then((r) => r.json);
    expect(await card(jane.cardId)).toMatchObject({
      erased: false,
      context: expect.stringContaining('NRIC 900101-14-5555'),
      resolution: { comment: expect.stringContaining('012-3456789') },
    });

    shred(t, jane.changeId);
    const erased = {
      erased: true,
      title: ERASED,
      question: ERASED,
      context: ERASED,
      status: 'resolved',
      resolution: { optionId: 'reject', comment: ERASED },
    };
    expect(await card(jane.cardId)).toMatchObject(erased);
    expect(JSON.stringify(await card(jane.cardId))).not.toMatch(/Jane|900101|012-3456789/);
    expect(await card(other.cardId)).toMatchObject({
      erased: false,
      title: 'Change request: Tidy the footer',
      context: expect.stringContaining('Footer links only.'),
    });

    t.aoc.runtime.store.rebuildProjections(['decisions']);
    expect(await card(jane.cardId)).toMatchObject(erased);
    expect(await card(other.cardId)).toMatchObject({ erased: false });
    expect(store.verifyChain().ok).toBe(true);
  });

  it('a break-glass card has no change record yet: it is kept with the project, as its justification is', async () => {
    const { t, builder, approver, call } = await boot();
    const invoked = await call<{ breakglassId: string; decisionId: string }>(builder, 'POST', '/api/breakglass', {
      projectId: PROJECT,
      ref: 'main',
      justification: 'Checkout is down for Jane Tan’s corporate account (NRIC 900101-14-5555).',
    });
    expect(invoked.status).toBe(202);
    const { decisionId } = invoked.json;
    const store = t.aoc.runtime.store;
    expect(store.list({ types: ['decision.requested'], decisionId })[0]!.bodyScope).toBe(PROJECT);

    shred(t, PROJECT);
    const card = await call<DecisionCardView>(approver, 'GET', `/api/decisions/${decisionId}`);
    expect(card.json).toMatchObject({ erased: true, title: ERASED, context: ERASED });
    expect(JSON.stringify(card.json)).not.toMatch(/Jane|900101/);
  });
});
