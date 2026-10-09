import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitService, FakeLlm, initRepo } from '@aoc/kernel';
import { createAuditModule, verifyExternalAuditLog } from '@aoc/mod-audit';
import { createChangeModule } from '@aoc/mod-change';
import { bootTestServer, removeTempDirs, tempDir, type TestServer } from './helpers';

const PROJECT = 'prj_aoc';
const git = createGitService();
const servers: TestServer[] = [];
afterEach(async () => {
  for (const t of servers.splice(0)) await t.close();
  removeTempDirs();
});

function run(dir: string, ...args: string[]): string {
  const r = git.run(dir, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

describe('self-modification boundary end to end: real mod-audit and mod-change (G-41)', () => {
  it('a promotion whose commits touch packages/kernel/ from a managed session is refused and logged outside AOC', async () => {
    const repo = join(tempDir('aoc-repo-'), 'maia');
    initRepo(repo, {
      files: { 'packages/kernel/src/store.ts': 'export const v = 1;\n', 'README.md': '# AOC\n' },
    });
    const base = run(repo, 'rev-parse', 'HEAD');
    const externalLog = join(tempDir('aoc-extlog-'), 'selfmod-audit.log');
    const t = await bootTestServer({
      modules: [createAuditModule(), createChangeModule()],
      llm: new FakeLlm(),
      config: { selfModification: { aocRepoPaths: [repo], externalAuditLog: externalLog } },
    });
    servers.push(t);
    const store = t.aoc.runtime.store;
    store.append({
      type: 'project.created',
      actor: { kind: 'system', id: 'test' },
      scope: { projectId: PROJECT },
      meta: { projectId: PROJECT, slug: 'aoc' },
      payload: { name: 'AOC', repoPath: repo, defaultBranch: 'main' },
      source: 'system',
    });
    const builder = t.user('builder');
    const call = async (method: string, path: string, body: unknown) => {
      const res = await t.request(path, {
        method,
        headers: { ...builder.headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };

    // An approved change record (self-approved: reversible, off main) worked by managed session ses_agent.
    const created = await call('POST', '/api/changes', {
      projectId: PROJECT,
      scope: 'reversible_off_main',
      title: 'Tune the store',
    });
    const changeId = created.json.changeId as string;
    for (const field of ['impact', 'mitigation', 'rollbackPlan', 'acceptanceTest'])
      await call('POST', `/api/changes/${changeId}/fields/${field}`, {
        value: `Considered ${field} for the store change.`,
        dwellMs: 9000,
        ...(field === 'rollbackPlan' ? { rollbackRef: base } : {}),
      });
    expect((await call('POST', `/api/changes/${changeId}/submit`, {})).json.status).toBe('approved');
    await call('POST', `/api/changes/${changeId}/start`, { sessionId: 'ses_agent' });

    // The session's genuine work: trailers, plus the HEAD the ledger recorded at its task close.
    run(repo, 'checkout', '-q', '-b', 'feature/store');
    const file = join(repo, 'packages/kernel/src/store.ts');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'export const v = 2;\n');
    run(repo, 'add', '-A');
    run(repo, 'commit', '-q', '-m', `perf: tune store\n\nAOC-Session: ses_agent\nAOC-Change: ${changeId}`);
    const sha = run(repo, 'rev-parse', 'HEAD');
    run(repo, 'checkout', '-q', 'main');
    store.append({
      type: 'task.done',
      actor: { kind: 'agent', id: 'ses_agent' },
      scope: { sessionId: 'ses_agent', projectId: PROJECT, taskId: 'tsk_1' },
      meta: {
        sessionId: 'ses_agent',
        projectId: PROJECT,
        taskId: 'tsk_1',
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

    const res = await call('POST', '/api/promotions', {
      projectId: PROJECT,
      fromRef: 'feature/store',
      changeId,
    });
    expect(res.status).toBe(422);
    expect(store.list({ types: ['promotion.refused'] }).map((e) => e.meta)).toEqual([
      expect.objectContaining({ reason: 'self_modification', orphanShas: [sha], projectId: PROJECT }),
    ]);
    expect(run(repo, 'rev-parse', 'main')).toBe(base);

    const text = readFileSync(externalLog, 'utf8');
    expect(verifyExternalAuditLog(text)).toBeNull();
    const lines = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toEqual([
      expect.objectContaining({
        kind: 'selfmod.promotion_refused',
        projectId: PROJECT,
        fromSha: sha,
        commits: [sha],
        sessionIds: ['ses_agent'],
        files: ['packages/kernel/src/store.ts'],
        chainId: store.chainId,
      }),
    ]);
  });
});
