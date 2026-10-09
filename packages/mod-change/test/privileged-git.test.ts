/**
 * G-04 (threat model O-2, T-2): promotion, pin tagging and rollback never run git or repository code with
 * privilege in a tree an agent can write. They run in the service-owned clone; the promotion credential reaches
 * the push alone; acceptance tests run sandboxed in a fresh checkout.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PromotionDTO, RollbackDTO } from '@aoc/contracts';
import { createSupervisorModule } from '@aoc/supervisor';
import type { ChangeModuleOptions } from '../src';
import { clonePathFor, isWithin } from '../src/clone';
import { displayUrl, pushOutcome, transportOf } from '../src/repo';
import {
  ACCEPTANCE_SCRIPT,
  PASSKEY,
  addGuardedRemote,
  approveChange,
  cloneGit,
  cloneRef,
  draftAndAffirm,
  harness,
  makeRepo,
  remoteHead,
  setPromotionRemote,
  tempDir,
  type Harness,
  type TestRepo,
} from './helpers';

const PROJECT = 'prj_g04';
const HOOKS = [
  'pre-push',
  'reference-transaction',
  'post-checkout',
  'post-merge',
  'pre-commit',
  'post-commit',
  'post-rewrite',
  'pre-auto-gc',
  'push-to-checkout',
  'pre-receive',
  'update',
  'post-receive',
  'post-update',
];

const attempt = (fn: () => unknown) => {
  try {
    fn();
  } catch {
    // control commands may fail; only what they ran matters
  }
};

interface Planted {
  marker: string;
  decoy: string | null;
  read(): string;
}

/**
 * What an agent can plant in its workspace: hooks in .git/hooks and in a core.hooksPath directory, aliases,
 * core.sshCommand, a credential helper, an fsmonitor command and a required filter driver for every file. Each
 * program records its name — and whether it saw the promotion credential — in `marker`, then fails. With a remote,
 * the project's config also redirects that remote (url.*.insteadOf, pushurl) to a decoy repository.
 */
function plant(repo: TestRepo, opts: { remote?: string } = {}): Planted {
  const dir = tempDir('aoc-g04-planted-');
  const marker = join(dir, 'MARK');
  const trip = (name: string, where = join(dir, name)) => {
    writeFileSync(where, `#!/bin/sh\necho "${name} credential=\${TEST_PROMOTION_TOKEN:-none}" >> '${marker}'\nexit 1\n`);
    chmodSync(where, 0o755);
    return where;
  };
  const hooksPath = join(dir, 'hooks');
  mkdirSync(hooksPath);
  for (const hook of HOOKS) {
    trip(`hook:${hook}`, join(repo.dir, '.git', 'hooks', hook));
    trip(`hooksPath:${hook}`, join(hooksPath, hook));
  }
  repo.git('config', 'core.hooksPath', hooksPath);
  repo.git('config', 'alias.push', `!${trip('alias-push')}`);
  repo.git('config', 'alias.promote', `!${trip('alias-promote')}`);
  repo.git('config', 'core.sshCommand', trip('ssh'));
  repo.git('config', 'credential.helper', `!${trip('credential-helper')}`);
  repo.git('config', 'core.fsmonitor', trip('fsmonitor'));
  repo.git('config', 'filter.evil.smudge', trip('filter-smudge'));
  repo.git('config', 'filter.evil.clean', trip('filter-clean'));
  repo.git('config', 'filter.evil.required', 'true');
  writeFileSync(join(repo.dir, '.git', 'info', 'attributes'), '* filter=evil\n');
  let decoy: string | null = null;
  if (opts.remote) {
    decoy = tempDir('aoc-g04-decoy-');
    spawnSync('git', ['init', '-q', '--bare', decoy]);
    repo.git('config', `url.${decoy}.insteadOf`, opts.remote);
    repo.git('config', 'remote.origin.pushurl', decoy);
  }
  return { marker, decoy, read: () => (existsSync(marker) ? readFileSync(marker, 'utf8') : '') };
}

// Each scenario runs dozens of real git processes; give them room on a loaded host.
describe('G-04: privileged git never runs in agent-writable trees', { timeout: 60_000 }, () => {
  let h: Harness;
  let repo: TestRepo;
  let good: string;
  let bad: string;
  let changeId: string;
  afterEach(async () => h?.close());

  /** main has a pinned good state and a broken v2; an approved change is linked to session ses_g04. */
  async function setup(change: (repo: TestRepo) => ChangeModuleOptions = () => ({})) {
    repo = makeRepo({ 'state.txt': 'good v1\n', 'test.js': ACCEPTANCE_SCRIPT });
    h = await harness({ change: change(repo) });
    good = repo.head();
    repo.git('tag', '-a', 'aoc/phase/p1', '-m', 'phase p1', good);
    h.t.rt.store.append({
      type: 'phase.completed',
      actor: { kind: 'agent', id: 'ses_ledger' },
      scope: { projectId: PROJECT },
      meta: { sessionId: 'ses_ledger', projectId: PROJECT, phaseId: 'p1', pinnedSha: good, pinnedTag: 'aoc/phase/p1' },
      source: 'mcp',
    });
    bad = repo.commit(`feat: v2\n\nAOC-Session: ses_g04`, { 'state.txt': 'broken v2\n' });
    h.addProject(PROJECT, repo.dir, { acceptanceCommand: 'node test.js' });
    h.t.sessions!.add({ sessionId: 'ses_g04', projectId: PROJECT });
    changeId = await draftAndAffirm(h, {
      projectId: PROJECT,
      scope: 'reversible_off_main',
      owner: h.builder,
      rollbackRef: good,
    });
    await approveChange(h, changeId, h.builder);
    await h.t.json('POST', `/api/changes/${changeId}/start`, {
      headers: h.builder.headers,
      body: { sessionId: 'ses_g04' },
    });
  }

  /** What mod-ledger appends when a session closes a task: the HEAD it read from the session's repository (G-25). */
  let closes = 0;
  function recordHead(sessionId: string, sha: string) {
    const taskId = `tsk_${++closes}`;
    h.t.rt.store.append({
      type: 'task.done',
      actor: { kind: 'agent', id: sessionId },
      scope: { sessionId, projectId: PROJECT, taskId },
      meta: {
        sessionId,
        projectId: PROJECT,
        taskId,
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
  }

  /** A traced feature branch on top of main, worked by the linked session; the project repository stays on main. */
  function feature(name: string, file: string): string {
    repo.git('checkout', '-q', '-b', name);
    const tip = repo.commit(`feat: ${name}\n\nAOC-Session: ses_g04\nAOC-Change: ${changeId}`, {
      [file]: `${name}\n`,
    });
    repo.git('checkout', '-q', 'main');
    recordHead('ses_g04', tip);
    return tip;
  }

  async function promote(fromRef: string): Promise<PromotionDTO> {
    const requested = await h.t.json<PromotionDTO>('POST', '/api/promotions', {
      headers: h.builder.headers,
      body: { projectId: PROJECT, fromRef, changeId },
      expect: 202,
    });
    await h.t.decisions!.resolve(requested.decisionId!, { optionId: 'approve', ...PASSKEY }, h.approver.user);
    await h.settle();
    return h.t.json<PromotionDTO>('GET', `/api/promotions/${requested.promotionId}`, { headers: h.builder.headers });
  }

  async function rollBack(targetRef: string): Promise<RollbackDTO> {
    const rb = await h.t.json<RollbackDTO>('POST', '/api/rollbacks', {
      headers: h.builder.headers,
      body: { projectId: PROJECT, targetRef, reason: 'v2 broke checkout' },
      expect: 202,
    });
    await h.settle();
    const verified = await h.t.json<RollbackDTO>('GET', `/api/rollbacks/${rb.rollbackId}`, {
      headers: h.builder.headers,
    });
    expect(verified.verification).toMatchObject({ clean: true });
    await h.t.decisions!.resolve(verified.decisionId!, { optionId: 'approve', ...PASSKEY }, h.approver.user);
    await h.settle();
    return h.t.json<RollbackDTO>('GET', `/api/rollbacks/${rb.rollbackId}`, { headers: h.builder.headers });
  }

  const treeOf = (sha: string) => repo.git('rev-parse', `${sha}^{tree}`);

  it('ignores a planted pre-push hook, core.hooksPath, aliases and core.sshCommand (and more): promotion and rollback to a remote still succeed', async () => {
    await setup();
    const remote = addGuardedRemote(repo);
    const clone = setPromotionRemote(h, PROJECT, remote);
    const tip = feature('feature/g04', 'g04.ts');
    const planted = plant(repo, { remote });

    const promoted = await promote('feature/g04');
    expect(promoted).toMatchObject({ status: 'completed', completion: { mainShaBefore: bad, mainShaAfter: tip } });
    expect(remoteHead(remote)).toBe(tip);

    const rolled = await rollBack('aoc/phase/p1');
    expect(rolled).toMatchObject({ status: 'executed', execution: { mainShaBefore: tip } });
    const after = rolled.execution!.mainShaAfter;
    expect(remoteHead(remote)).toBe(after);
    expect(cloneGit(h, PROJECT, 'rev-parse', `${after}^{tree}`).stdout.trim()).toBe(treeOf(good));

    // Nothing planted ran; the decoy the project's config points at received nothing.
    expect(planted.read()).toBe('');
    expect(spawnSync('git', ['--git-dir', planted.decoy!, 'for-each-ref'], { encoding: 'utf8' }).stdout).toBe('');
    // The promotion credential reached exactly the two pushes, both from the service clone.
    const credentialed = h.sup.calls.filter((c) => c.credentialProfile !== null);
    expect(credentialed.map((c) => [c.cwd, c.command.includes('push')])).toEqual([
      [clone, true],
      [clone, true],
    ]);
    expect(h.sup.calls.filter((c) => c.credentialProfile === null).every((c) => !c.command.includes('push'))).toBe(
      true,
    );

    // Control: the same repository makes plain git run every kind of planted program.
    attempt(() => repo.git('status'));
    attempt(() => repo.git('promote'));
    attempt(() => repo.git('push', 'origin', 'HEAD:refs/heads/control'));
    attempt(() => repo.git('ls-remote', 'git@evil.example:org/app.git'));
    for (const name of ['fsmonitor', 'alias-promote', 'hooksPath:pre-push', 'ssh'])
      expect(planted.read(), name).toContain(name);
  });

  it('ignores the same planted config when the project has no remote: its own branch moves, and nothing planted runs', async () => {
    await setup();
    const tip = feature('feature/local', 'local.ts');
    const planted = plant(repo);

    expect(await promote('feature/local')).toMatchObject({ status: 'completed', completion: { mainShaAfter: tip } });
    expect(repo.head('main')).toBe(tip);
    const rolled = await rollBack('aoc/phase/p1');
    expect(rolled.status).toBe('executed');
    expect(repo.head('main')).toBe(rolled.execution!.mainShaAfter);
    expect(treeOf(rolled.execution!.mainShaAfter)).toBe(treeOf(good));
    // The checked-out working tree followed, through the neutralised filter driver.
    expect(readFileSync(join(repo.dir, 'state.txt'), 'utf8')).toBe('good v1\n');
    expect(planted.read()).toBe('');
    expect(h.sup.calls.every((c) => c.credentialProfile === null)).toBe(true);
  });

  it('keeps the service clone outside the project repository, and refuses a clones directory inside it', async () => {
    await setup();
    const tip = feature('feature/where', 'where.ts');
    expect((await promote('feature/where')).status).toBe('completed');
    const clone = h.mod.engine.serviceClonePath(PROJECT);
    expect(existsSync(clone)).toBe(true);
    expect(cloneGit(h, PROJECT, 'rev-parse', '--is-bare-repository').stdout.trim()).toBe('true');
    expect(isWithin(clone, repo.dir)).toBe(false);
    expect(cloneRef(h, PROJECT, tip)).toBe(tip);
    await h.close();

    repo = makeRepo();
    h = await harness({ change: { serviceClonesDir: join(repo.dir, '.aoc', 'git') } });
    h.addProject(PROJECT, repo.dir);
    const res = await h.t.request('POST', '/api/promotions', {
      headers: h.builder.headers,
      body: { projectId: PROJECT, fromRef: 'main' },
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('clone_inside_project');
    expect(existsSync(join(repo.dir, '.aoc'))).toBe(false);
  });

  it('never pushes where the project repository points: with remotes there and none configured, nothing moves', async () => {
    await setup();
    const local = feature('feature/local-first', 'l.ts');
    const requested = await h.t.json<PromotionDTO>('POST', '/api/promotions', {
      headers: h.builder.headers,
      body: { projectId: PROJECT, fromRef: 'feature/local-first', changeId },
      expect: 202,
    });
    // A remote appears in the project repository between request and approval: refused at execution.
    const remote = addGuardedRemote(repo);
    await h.t.decisions!.resolve(requested.decisionId!, { optionId: 'approve', ...PASSKEY }, h.approver.user);
    await h.settle();
    expect(h.t.rt.store.list({ types: ['promotion.failed'] })[0]!.meta).toMatchObject({
      reason: 'promotion_remote_unconfigured',
    });
    expect(repo.head('main')).toBe(bad);
    expect(remoteHead(remote)).toBe(bad);

    // Requested while unconfigured: refused up front, before any gate is raised.
    feature('feature/unconfigured', 'u.ts');
    const res = await h.t.request('POST', '/api/promotions', {
      headers: h.builder.headers,
      body: { projectId: PROJECT, fromRef: 'feature/unconfigured', changeId },
    });
    expect(res.status).toBe(422);
    const err = ((await res.json()) as { error: { code: string; message: string } }).error;
    expect(err.code).toBe('promotion_remote_unconfigured');
    expect(err.message).toContain(`git --git-dir=${h.mod.engine.serviceClonePath(PROJECT)} remote add origin`);
    const rb = await h.t.request('POST', '/api/rollbacks', {
      headers: h.builder.headers,
      body: { projectId: PROJECT, targetRef: 'aoc/phase/p1', reason: 'x' },
    });
    expect(rb.status).toBe(422);
    expect(h.t.decisions!.list({ kind: ['go_live', 'rollback'] })).toHaveLength(1);
    expect(h.sup.calls.some((c) => c.credentialProfile !== null)).toBe(false);
    expect(local).not.toBe(bad);
  });

  it('takes the promotion remote from static settings, over the clone’s origin', async () => {
    const remote = tempDir('aoc-g04-static-');
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    await setup(() => ({ projects: { [PROJECT]: { promotionRemote: remote } } }));
    repo.git('push', '-q', remote, 'main');
    const other = addGuardedRemote(repo);
    setPromotionRemote(h, PROJECT, other);
    const tip = feature('feature/static', 's.ts');
    expect((await promote('feature/static')).status).toBe('completed');
    expect(remoteHead(remote)).toBe(tip);
    expect(remoteHead(other)).toBe(bad);
  });

  it('moves the remote only from the base it verified: a branch moved outside AOC fails the lease', async () => {
    await setup();
    const remote = addGuardedRemote(repo);
    setPromotionRemote(h, PROJECT, remote);
    const first = feature('feature/one', 'one.ts');
    expect((await promote('feature/one')).status).toBe('completed');
    expect(cloneRef(h, PROJECT, 'refs/aoc/target/main')).toBe(first);

    // Someone pushes to main without AOC (an R1 breach), on top of what AOC promoted.
    const outside = tempDir('aoc-g04-outside-');
    spawnSync('git', ['clone', '-q', remote, outside]);
    spawnSync('git', ['-C', outside, '-c', 'user.name=x', '-c', 'user.email=x@y', 'commit', '-q', '--allow-empty', '-m', 'rogue']);
    spawnSync('git', ['-C', outside, 'push', '-q', 'origin', 'HEAD:main']);
    const rogue = remoteHead(remote);
    expect(rogue).not.toBe(first);

    repo.git('fetch', '-q', 'origin');
    repo.git('merge', '-q', '--ff-only', first);
    feature('feature/two', 'two.ts');
    const second = await promote('feature/two');
    expect(second.status).toBe('failed');
    expect(h.t.rt.store.list({ types: ['promotion.failed'] }).at(-1)!.meta).toMatchObject({
      reason: 'default_branch_moved',
    });
    expect(remoteHead(remote)).toBe(rogue);
    // AOC drops its record, so the next request starts from the project's fresh view of the remote.
    expect(cloneRef(h, PROJECT, 'refs/aoc/target/main')).toBeNull();
  });

  it('traces against the branch as AOC moved it: an orphan smuggled into the project’s own view of main is caught', async () => {
    await setup();
    const remote = addGuardedRemote(repo);
    setPromotionRemote(h, PROJECT, remote);
    const first = feature('feature/first', 'first.ts');
    expect((await promote('feature/first')).status).toBe('completed');

    // The agent commits an orphan straight onto its local main and moves origin/main with it.
    repo.git('merge', '-q', '--ff-only', first);
    const orphan = repo.commit('chore: unreviewed', { 'sneaky.ts': '1\n' });
    repo.git('update-ref', 'refs/remotes/origin/main', orphan);
    const traced = feature('feature/after-orphan', 'after.ts');
    const res = await h.t.request('POST', '/api/promotions', {
      headers: h.builder.headers,
      body: { projectId: PROJECT, fromRef: 'feature/after-orphan', changeId },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { details: { promotion: PromotionDTO } } };
    expect(body.error.details.promotion.refusal).toMatchObject({ reason: 'provenance_gap', orphanShas: [orphan] });
    expect(remoteHead(remote)).toBe(first);
    expect(traced).not.toBe(orphan);
  });
});

const SANDBOX_USER = 'nobody';
const sandboxUnavailable =
  process.getuid?.() !== 0
    ? 'aocd must be root to run acceptance tests as another user'
    : spawnSync('getent', ['passwd', SANDBOX_USER]).status !== 0
      ? `there is no "${SANDBOX_USER}" user`
      : null;

describe('G-04 end to end, with the real supervisor', { timeout: 60_000 }, () => {
  let h: Harness | null = null;
  afterEach(async () => {
    await h?.close();
    h = null;
  });

  it.skipIf(sandboxUnavailable !== null)(
    `only the push holds the promotion credential; as the session user, an acceptance test that writes outside its checkout fails${sandboxUnavailable ? ` (skipped: ${sandboxUnavailable})` : ''}`,
    async () => {
      const dir = tempDir('aoc-g04-e2e-');
      const profiles = join(dir, 'credential-profiles.json');
      writeFileSync(
        profiles,
        JSON.stringify({ profiles: { 'prod-promote': { env: { TEST_PROMOTION_TOKEN: 'promotion-secret' } } } }),
        { mode: 0o600 },
      );
      // The protected remote records whether each push it receives carries the credential.
      const remote = join(dir, 'remote.git');
      const pushLog = join(dir, 'pushes.log');
      spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
      writeFileSync(
        join(remote, 'hooks', 'pre-receive'),
        `#!/bin/sh\necho "credential=\${TEST_PROMOTION_TOKEN:-none}" >> '${pushLog}'\n`,
        { mode: 0o755 },
      );
      // The service clones live in a root-only directory; one target's acceptance test tries to plant a file there.
      const clones = tempDir('aoc-g04-clones-');
      const outside = join(clones, 'planted-by-acceptance-test');
      const acceptance = (writeOutside: boolean) =>
        [
          "const fs = require('fs');",
          "console.log('uid ' + process.getuid() + ' credential=' + (process.env.TEST_PROMOTION_TOKEN || 'none'));",
          "fs.writeFileSync('inside.txt', 'ok');",
          writeOutside ? `fs.writeFileSync(${JSON.stringify(outside)}, 'planted');` : '',
          "console.log('# pass 1');",
          "console.log('# fail 0');",
        ].join('\n');
      const repo = makeRepo({ 'state.txt': 'a\n', 'test.js': acceptance(false) });
      const stateA = repo.head();
      repo.git('tag', '-a', 'aoc/phase/a', '-m', 'a', stateA);
      const stateB = repo.commit('feat: b', { 'state.txt': 'b\n', 'test.js': acceptance(true) });
      repo.git('tag', '-a', 'aoc/phase/b', '-m', 'b', stateB);
      const head = repo.commit('feat: c', { 'state.txt': 'c\n' });
      repo.git('push', '-q', remote, 'main');
      writeFileSync(pushLog, '');
      const planted = plant(repo);

      // Session isolation (G-01) with `nobody` as the session user, in directories it can reach.
      const reachable = tempDir('aoc-g04-iso-');
      chmodSync(reachable, 0o755);
      h = await harness({
        supervisor: false,
        modules: [createSupervisorModule({ sessionsDir: join(dir, 'sessions') })],
        config: {
          supervisor: {
            sessionUser: SANDBOX_USER,
            sessionHomesDir: join(reachable, 'homes'),
            workspacesDir: join(reachable, 'work'),
            claudeBin: process.execPath,
            credentialProfilesFile: profiles,
          },
        },
        change: { serviceClonesDir: clones, projects: { [PROJECT]: { promotionRemote: remote } } },
      });
      const t = h.t;
      h.addProject(PROJECT, repo.dir, { acceptanceCommand: 'node test.js' });
      for (const [phaseId, sha] of [
        ['a', stateA],
        ['b', stateB],
      ] as const)
        t.rt.store.append({
          type: 'phase.completed',
          actor: { kind: 'agent', id: 'ses_ledger' },
          scope: { projectId: PROJECT },
          meta: { sessionId: 'ses_ledger', projectId: PROJECT, phaseId, pinnedSha: sha, pinnedTag: `aoc/phase/${phaseId}` },
          source: 'mcp',
        });
      const verify = async (targetRef: string) => {
        const rb = await t.json<RollbackDTO>('POST', '/api/rollbacks', {
          headers: h!.builder.headers,
          body: { projectId: PROJECT, targetRef, reason: 'e2e' },
          expect: 202,
        });
        await h!.settle();
        return t.json<RollbackDTO>('GET', `/api/rollbacks/${rb.rollbackId}`, { headers: h!.builder.headers });
      };
      const sandboxUid = Number(
        spawnSync('getent', ['passwd', SANDBOX_USER], { encoding: 'utf8' }).stdout.split(':')[2],
      );

      // Target A only writes its own checkout: clean, approved, pushed.
      const a = await verify('aoc/phase/a');
      expect(a).toMatchObject({ status: 'awaiting_approval', verification: { clean: true } });
      expect(a.verification!.report).toContain(`uid ${sandboxUid} credential=none`);
      await t.decisions!.resolve(a.decisionId!, { optionId: 'approve', ...PASSKEY }, h.approver.user);
      await h.settle();
      const done = await t.json<RollbackDTO>('GET', `/api/rollbacks/${a.rollbackId}`, { headers: h.builder.headers });
      expect(done).toMatchObject({ status: 'executed', execution: { mainShaBefore: head } });
      expect(remoteHead(remote)).toBe(done.execution!.mainShaAfter);

      // Target B's acceptance test writes outside its checkout: as the session user that fails, and nothing reaches
      // the approver.
      const b = await verify('aoc/phase/b');
      expect(b).toMatchObject({ status: 'not_clean', decisionId: null, verification: { clean: false } });
      expect(b.verification!.report).toContain('EACCES');
      expect(existsSync(outside)).toBe(false);

      // The credential reached the one push, and nothing that runs in or from the project repository.
      expect(readFileSync(pushLog, 'utf8').trim().split('\n')).toEqual(['credential=promotion-secret']);
      expect(planted.read()).toBe('');
    },
  );
});

describe('G-04 helpers', () => {
  it('accepts only ssh, https and absolute local-path promotion remotes', () => {
    expect(transportOf('git@github.com:org/app.git')).toBe('ssh');
    expect(transportOf('ssh://git@github.com/org/app.git')).toBe('ssh');
    expect(transportOf('https://github.com/org/app.git')).toBe('https');
    expect(transportOf('/srv/git/app.git')).toBe('file');
    expect(transportOf('file:///srv/git/app.git')).toBe('file');
    for (const bad of [
      'http://github.com/org/app.git',
      'git://github.com/org/app.git',
      'ext::sh -c touch% /tmp/pwned',
      'fd::17',
      '-oProxyCommand=evil:x',
      'relative/app.git',
      'helper::address',
      '',
    ])
      expect(transportOf(bad), bad).toBeNull();
  });

  it('hides URL user-info in messages', () => {
    expect(displayUrl('https://x-access-token:ghs_secret@github.com/org/app.git')).toBe(
      'https://***@github.com/org/app.git',
    );
    expect(displayUrl('git@github.com:org/app.git')).toBe('git@github.com:org/app.git');
  });

  it('names a clone after a plain project id, hashes anything else, and detects overlap', () => {
    expect(clonePathFor('/data/git', 'prj_web')).toBe('/data/git/prj_web.git');
    expect(clonePathFor('/data/git', '../../etc')).toMatch(/^\/data\/git\/p-[0-9a-f]{32}\.git$/);
    expect(isWithin('/data/git/prj_web.git', '/data')).toBe(true);
    expect(isWithin('/data', '/data')).toBe(true);
    expect(isWithin('/data2/git', '/data')).toBe(false);
    expect(isWithin('/srv/..data/x', '/srv')).toBe(true);
  });

  it('reads a stale lease from the porcelain push result', () => {
    expect(pushOutcome({ code: 0, stdout: 'To /r\n \tabc:refs/heads/main\tx..y\nDone\n', stderr: '' })).toEqual({
      ok: true,
    });
    expect(
      pushOutcome({ code: 1, stdout: '!\tabc:refs/heads/main\t[rejected] (stale info)\n', stderr: 'error: failed' }),
    ).toMatchObject({ ok: false, stale: true });
    expect(
      pushOutcome({ code: 1, stdout: '!\tabc:refs/heads/main\t[remote rejected] (protected branch)', stderr: '' }),
    ).toMatchObject({ ok: false, stale: false });
  });
});
