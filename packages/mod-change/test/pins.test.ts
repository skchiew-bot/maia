import { afterEach, describe, expect, it } from 'vitest';
import type { ChangeRequestDTO, PinListDTO } from '@aoc/contracts';
import { draftAndAffirm, harness, makeRepo, type Harness, type TestRepo } from './helpers';

const PROJECT = 'prj_shop';

describe('pinned states (GET /api/pins): rollback targets checked against the repository', () => {
  let h: Harness;
  let repo: TestRepo;
  afterEach(async () => {
    await h?.close();
  });

  function pinPhase(phaseId: string, sha: string, tag: string | null): void {
    h.t.rt.store.append({
      type: 'phase.completed',
      actor: { kind: 'agent', id: 'ses_ledger' },
      scope: { projectId: PROJECT },
      meta: { sessionId: 'ses_ledger', projectId: PROJECT, phaseId, pinnedSha: sha, pinnedTag: tag },
      source: 'mcp',
    });
  }

  const pins = (query = `projectId=${PROJECT}`) =>
    h.t.json<PinListDTO>('GET', `/api/pins?${query}`, { headers: h.builder.headers });

  it('lists every pinned state newest first, merging records of the same state, with what still resolves', async () => {
    h = await harness();
    repo = makeRepo({ 'state.txt': 'v1\n' });
    const v1 = repo.head();
    repo.git('tag', '-a', 'aoc/phase/p1', '-m', 'phase p1', v1);
    h.addProject(PROJECT, repo.dir);
    pinPhase('p1', v1, 'aoc/phase/p1');
    pinPhase('p0', 'a'.repeat(40), 'aoc/phase/p0'); // the tag was never created
    const v2 = repo.commit('feat: v2', { 'state.txt': 'v2\n' });
    repo.git('tag', '-a', 'aoc/phase/p2', '-m', 'phase p2', v2);
    pinPhase('p2', v1, 'aoc/phase/p2'); // recorded v1, but the tag points at v2: moved

    // A self-approved change pins its rollback point (v2) at submission and its own tag on completion.
    const changeId = await draftAndAffirm(h, {
      projectId: PROJECT,
      scope: 'reversible_off_main',
      owner: h.builder,
      rollbackRef: v2,
    });
    await h.t.json('POST', `/api/changes/${changeId}/submit`, { headers: h.builder.headers });
    const v3 = repo.commit('feat: v3', { 'state.txt': 'v3\n' });
    const done = await h.t.json<ChangeRequestDTO>('POST', `/api/changes/${changeId}/complete`, {
      headers: h.builder.headers,
      body: {},
    });
    expect(done.pinnedSha).toBe(v3);

    const list = await pins();
    expect(list).toMatchObject({ projectId: PROJECT, defaultBranch: 'main', head: v3 });
    expect(list.pins.map((p) => [p.tag, p.sha, p.resolvedSha, p.problem])).toEqual([
      [`aoc/change/${changeId}`, v3, v3, null],
      [null, v2, v2, null],
      ['aoc/phase/p2', v1, null, 'tag_moved'],
      ['aoc/phase/p0', 'a'.repeat(40), null, 'tag_missing'],
      ['aoc/phase/p1', v1, v1, null],
    ]);
    // change.completed and git.ref_pinned record the same state: one pin, both records, oldest first.
    expect(list.pins[0]!.pinnedBy.map((b) => [b.source, b.sourceId])).toEqual([
      ['change.completed', changeId],
      ['git.ref_pinned', 'change.completed'],
    ]);
    expect(list.pins[1]!.pinnedBy).toMatchObject([{ source: 'change.submitted', sourceId: changeId }]);

    expect((await pins(`projectId=${PROJECT}&limit=2`)).pins).toHaveLength(2);
  });

  it('reports a SHA pin whose commit is gone and a project without a known repository', async () => {
    h = await harness();
    repo = makeRepo();
    h.addProject(PROJECT, repo.dir);
    h.t.rt.store.append({
      type: 'git.ref_pinned',
      actor: { kind: 'system', id: 'test' },
      scope: { projectId: PROJECT },
      meta: { projectId: PROJECT, tag: '', sha: 'b'.repeat(40), reason: 'manual' },
      source: 'system',
    });
    const list = await pins();
    expect(list.pins).toMatchObject([{ sha: 'b'.repeat(40), resolvedSha: null, problem: 'commit_missing' }]);

    h.t.rt.store.append({
      type: 'phase.completed',
      actor: { kind: 'agent', id: 'ses_x' },
      scope: { projectId: 'prj_gone' },
      meta: {
        sessionId: 'ses_x',
        projectId: 'prj_gone',
        phaseId: 'p1',
        pinnedSha: 'c'.repeat(40),
        pinnedTag: 'aoc/x',
      },
      source: 'mcp',
    });
    expect(await pins('projectId=prj_gone')).toMatchObject({
      head: null,
      defaultBranch: null,
      pins: [{ tag: 'aoc/x', problem: 'repo_unknown', resolvedSha: null }],
    });
  });

  it('needs audit.view and a project id', async () => {
    h = await harness();
    const requester = h.t.user('requester', 'Rae Requester');
    expect(
      (await h.t.request('GET', `/api/pins?projectId=${PROJECT}`, { headers: requester.headers })).status,
    ).toBe(403);
    expect((await h.t.request('GET', '/api/pins', { headers: h.builder.headers })).status).toBe(422);
  });
});
