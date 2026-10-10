import { afterEach, describe, expect, it } from 'vitest';
import type { McpErrorResult, ProjectDetail, SessionTimeline, TaskDoneResult } from '@aoc/contracts';
import { phaseTagName } from '../src';
import { commit, createHarness, git, PLAN, writeFile, type Harness } from './harness';

let h: Harness;
afterEach(async () => h?.close());

async function setup(opts: { repo?: boolean } = {}) {
  h = await createHarness();
  const projectId = h.project();
  const cwd = opts.repo === false ? h.tempDir() : h.repo();
  h.session({ sessionId: 'ses_a', projectId, cwd });
  await h.mcp('declare_plan', 'ses_a', PLAN);
  const slug = (
    await h.t.json<ProjectDetail>('GET', `/api/projects/${projectId}`, { headers: h.owner.headers })
  ).slug;
  return { projectId, cwd, slug };
}

const done = (task_id: string, kind: 'test' | 'commit' | 'diff', ref: string, expect = 200) =>
  h.mcp<TaskDoneResult>('task_done', 'ses_a', { task_id, evidence: { kind, ref } }, expect);

describe('task_done evidence (§4, R9)', () => {
  it('verifies evidence, flags closes without file changes, and pins completed phases with an annotated tag', async () => {
    const { cwd, slug } = await setup();
    const initial = git(cwd, 'rev-parse', 'HEAD');

    // An Edit (hook-reported) backs t1; diff evidence needs the working tree to have changed.
    writeFile(cwd, 'src/schema.ts', 'export const schema = 1;\n');
    h.toolUsed('ses_a', { filePaths: [`${cwd}/src/schema.ts`] });
    const r1 = await done('t1', 'diff', 'src/schema.ts +1');
    expect(r1).toMatchObject({ ok: true, flagged: null, phaseCompleted: null, boundary: { continue: true } });
    expect(r1.progress).toEqual({ doneTasks: 1, totalTasks: 3, doneWeight: 2, totalWeight: 10, pct: 20 });
    expect(h.events('task.done')[0]!.meta).toMatchObject({
      evidenceKind: 'diff',
      evidenceVerified: true,
      flag: null,
      fileChangesSinceLast: 1,
      treeChanged: true,
    });

    // Nothing changed since that close, but the close before it did: running the tests is ordinary, not flagged (G-52).
    const r2 = await done('t2', 'test', 'test/widget.test.ts > works');
    expect(r2.flagged).toBeNull();
    expect(h.events('task.done')[1]!.meta).toMatchObject({
      evidenceVerified: true,
      flag: null,
      fileChangesSinceLast: 0,
      treeChanged: false,
    });

    // P1 is complete → annotated tag aoc/<slug>/P1/<seq of the closing event> at HEAD.
    const closeSeq = h.events('task.done')[1]!.seq;
    const tag = phaseTagName(slug, 'P1', closeSeq);
    expect(tag).toBe(`aoc/${slug}/P1/${closeSeq}`);
    expect(r2.phaseCompleted).toEqual({ phaseId: 'P1', pinnedRef: tag });
    expect(git(cwd, 'tag', '-l', 'aoc/*')).toBe(tag);
    expect(git(cwd, 'cat-file', '-t', tag)).toBe('tag');
    expect(git(cwd, 'rev-parse', `${tag}^{commit}`)).toBe(initial);
    const [pc] = h.events('phase.completed');
    expect(pc!.meta).toEqual({
      sessionId: 'ses_a',
      projectId: expect.any(String),
      phaseId: 'P1',
      pinnedSha: initial,
      pinnedTag: tag,
    });
    expect(pc!.causationId).toBe(h.events('task.done')[1]!.id);

    // A commit made outside Edit/Write (e.g. via Bash) still counts as a change; commit evidence must be new.
    const sha = commit(cwd, 'src/routes.ts', 'export const routes = [];\n', 'routes');
    const r3 = await done('t3', 'commit', sha.slice(0, 10));
    expect(r3.flagged).toBeNull();
    expect(h.events('task.done')[2]!.meta).toMatchObject({
      evidenceKind: 'commit',
      evidenceVerified: true,
      fileChangesSinceLast: 0,
      treeChanged: true,
      headSha: sha,
    });
    expect(r3.phaseCompleted?.phaseId).toBe('P2');
    expect(git(cwd, 'rev-parse', `${r3.phaseCompleted!.pinnedRef!}^{commit}`)).toBe(sha);
    expect(r3.progress.pct).toBe(100);

    const tl = await h.t.json<SessionTimeline>('GET', '/api/sessions/ses_a/timeline', {
      headers: h.owner.headers,
    });
    expect(tl.manifest.map((p) => [p.phaseId, p.pinnedTag, p.completedAt !== null])).toEqual([
      ['P1', tag, true],
      ['P2', r3.phaseCompleted!.pinnedRef, true],
    ]);
    expect(tl.manifest[0]!.tasks.map((t) => [t.taskId, t.status, t.flag, t.evidence?.verified])).toEqual([
      ['t1', 'done', null, true],
      ['t2', 'done', null, true],
    ]);
  });

  it('flags a second close in a row that changed nothing, and an empty first close, but never a read-only session (R9, G-52)', async () => {
    const { cwd } = await setup();
    // The first close of the session changed nothing at all: flagged.
    expect((await done('t1', 'test', 'test/widget.test.ts > a')).flagged).toBe('no_file_change');
    // Still nothing: flagged again.
    expect((await done('t2', 'test', 'test/widget.test.ts > b')).flagged).toBe('no_file_change');
    // Real work, then one empty close after it (push, run the tests): neither is flagged.
    commit(cwd, 'src/routes.ts', 'export const routes = [];\n', 'routes');
    const sha = git(cwd, 'rev-parse', 'HEAD');
    expect((await done('t3', 'commit', sha)).flagged).toBeNull();
    expect(h.events('task.done').map((e) => e.meta.flag)).toEqual(['no_file_change', 'no_file_change', null]);
  });

  it('a read-only session closes with the path of a file it inspected: verified inside its workspace, never flagged (G-52)', async () => {
    h = await createHarness();
    const projectId = h.project();
    const cwd = h.repo({ 'src/parser.ts': 'export const parse = 1;\n' });
    h.session({ sessionId: 'ses_ro', projectId, cwd, readOnly: true, processType: 'bug-triage' });
    await h.mcp('declare_plan', 'ses_ro', PLAN);
    const close = (task_id: string, ref: string) =>
      h.mcp<TaskDoneResult>('task_done', 'ses_ro', { task_id, evidence: { kind: 'diff', ref } });
    expect((await close('t1', 'src/parser.ts')).flagged).toBeNull();
    expect((await close('t2', './src/parser.ts')).flagged).toBeNull();
    // A file that is not there, or a path that leaves the workspace, proves nothing.
    expect((await close('t3', 'src/missing.ts')).flagged).toBe('evidence_unverified');
    h.session({ sessionId: 'ses_ro2', projectId, cwd, readOnly: true, processType: 'bug-triage' });
    await h.mcp('declare_plan', 'ses_ro2', PLAN);
    for (const [task_id, ref] of [
      ['t1', '../../../../etc/passwd'],
      ['t2', '/etc/passwd'],
    ] as const)
      expect(
        (await h.mcp<TaskDoneResult>('task_done', 'ses_ro2', { task_id, evidence: { kind: 'diff', ref } }))
          .flagged,
        ref,
      ).toBe('evidence_unverified');
  });

  it('refuses a test ref that is a command line, not a test id (G-52)', async () => {
    await setup();
    for (const [task_id, ref] of [
      ['t1', 'test/widget.test.ts > npm test (node test.js)'],
      ['t2', 'pytest test/widget.test.ts'],
      ['t3', 'test/widget.test.ts > works (npm run test)'],
    ] as const)
      expect((await done(task_id, 'test', ref)).flagged, ref).toBe('evidence_unverified');
  });

  it('flags unverifiable evidence: unknown or pre-plan commits, prose test ids, missing test files, diffs without changes', async () => {
    const { cwd } = await setup();
    const initial = git(cwd, 'rev-parse', 'HEAD');
    await h.mcp('amend_plan', 'ses_a', {
      reason: 'more checks',
      add: ['t4', 't5', 't6'].map((id) => ({ id, title: id, size: 'xs', phaseId: 'P3' })),
    });
    const cases: [string, 'test' | 'commit' | 'diff', string][] = [
      ['t1', 'commit', 'deadbeefdeadbeef'],
      ['t2', 'commit', initial],
      ['t3', 'test', 'all tests pass'],
      ['t4', 'test', 'test/missing.test.ts > works'],
      ['t5', 'diff', 'n/a'],
      ['t6', 'diff', 'git diff --stat'],
    ];
    for (const [id, kind, ref] of cases) {
      h.toolUsed('ses_a'); // a file change happened, so only the evidence is in question
      const r = await done(id, kind, ref);
      expect(r.flagged, `${id} ${kind} ${ref}`).toBe('evidence_unverified');
    }
    expect(h.events('task.done').every((e) => e.meta.evidenceVerified === false)).toBe(true);
  });

  it('rejects closes that are not allowed: before a plan, unknown, removed or already done tasks', async () => {
    h = await createHarness();
    const projectId = h.project();
    h.session({ sessionId: 'ses_a', projectId });
    const early = await h.mcp<McpErrorResult>(
      'task_done',
      'ses_a',
      { task_id: 't1', evidence: { kind: 'test', ref: 'a.test.ts > b' } },
      409,
    );
    expect(early.error).toMatch(/declare_plan/);
    await h.mcp('declare_plan', 'ses_a', PLAN);
    await h.mcp(
      'task_done',
      'ses_a',
      { task_id: 'nope', evidence: { kind: 'test', ref: 'a.test.ts > b' } },
      422,
    );
    await h.mcp('task_done', 'ses_a', { task_id: 't1' }, 422); // evidence is mandatory
    await h.mcp('amend_plan', 'ses_a', { reason: 'not needed', remove: ['t2'] });
    await h.mcp(
      'task_done',
      'ses_a',
      { task_id: 't2', evidence: { kind: 'test', ref: 'a.test.ts > b' } },
      409,
    );
    h.toolUsed('ses_a');
    await h.mcp('task_done', 'ses_a', { task_id: 't1', evidence: { kind: 'test', ref: 'a.test.ts > b' } });
    const twice = await h.mcp<McpErrorResult>(
      'task_done',
      'ses_a',
      { task_id: 't1', evidence: { kind: 'test', ref: 'a.test.ts > b' } },
      409,
    );
    expect(twice).toMatchObject({ ok: false, error: expect.stringMatching(/already done/) });
    expect(h.events('task.done')).toHaveLength(1);
  });

  it('pins nothing (but still completes the phase) when the session has no git repo', async () => {
    await setup({ repo: false });
    h.toolUsed('ses_a');
    await done('t1', 'test', 'WidgetSuite#savesWidgets');
    h.toolUsed('ses_a');
    const r = await done('t2', 'test', 'pkg/store::saves_widgets');
    expect(r.phaseCompleted).toEqual({ phaseId: 'P1', pinnedRef: null });
    expect(h.events('phase.completed')[0]!.meta).toMatchObject({ pinnedSha: null, pinnedTag: null });
  });
});
