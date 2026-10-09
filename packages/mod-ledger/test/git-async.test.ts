/**
 * The ledger's git calls never hold aocd's thread (a hook with ~2.5 s must still be answered while some repository is
 * slow), a check git cannot finish is recorded unverified with its reason, and the one read that may open a working
 * copy another OS user owns trusts exactly that path and nothing the repository says.
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lchownSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpErrorResult, TaskDoneResult } from '@aoc/contracts';
import { commit, createHarness, git, PLAN, writeFile, type Harness } from './harness';

/** The PreToolUse hook's budget (packages/hooks/src/run.ts): it fails closed after this. */
const HOOK_BUDGET_MS = 2_500;
const FOREIGN_UID = 54321;
const isRoot = process.getuid?.() === 0;
const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

let h: Harness | null = null;
let savedPath: string | undefined;
const temps: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'aoc-ledger-git-'));
  temps.push(d);
  return d;
};
beforeEach(() => {
  savedPath = process.env.PATH;
});
afterEach(async () => {
  process.env.PATH = savedPath;
  await h?.close();
  h = null;
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Call {
  args: string;
  env: string[];
}
const SEP = '  ##  ';

/**
 * A `git` first on PATH that logs every call (arguments and GIT_* environment) and, while `slow(seconds)` is on,
 * sleeps first: a repository on a stalled disk or a very large tree.
 */
function installShim() {
  const dir = temp();
  const log = join(dir, 'calls.log');
  const flag = join(dir, 'sleep-seconds');
  const file = join(dir, 'git');
  writeFileSync(
    file,
    // One write per call: git runs in parallel and the records must not interleave.
    `#!/bin/sh
printf '%s\\n' "$*${SEP}$(env | grep '^GIT_' | sort | tr '\\n' ' ')" >> '${log}'
if [ -s '${flag}' ]; then sleep "$(cat '${flag}')"; fi
exec '${realGit}' "$@"
`,
  );
  chmodSync(file, 0o755);
  writeFileSync(log, '');
  process.env.PATH = `${dir}:${savedPath}`;
  // Unique, so a leftover sleep can only be one of ours.
  const sleepFor = `7.${process.pid}`;
  return {
    /** `true`: long enough to hit any timeout; a number: that many seconds; `false`: not slow. */
    slow: (on: boolean | number) =>
      writeFileSync(flag, on === true ? sleepFor : on === false ? '' : String(on)),
    reset: () => writeFileSync(log, ''),
    calls(): Call[] {
      return readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [args, env] = line.split(SEP);
          return { args: args!, env: (env ?? '').split(' ').filter(Boolean) };
        });
    },
    /** Shim sleeps still running (a zombie is not running). */
    strays(): number {
      const ps = spawnSync('ps', ['-eo', 'stat=,args='], { encoding: 'utf8' }).stdout ?? '';
      return ps.split('\n').filter((l) => !l.trim().startsWith('Z') && l.includes(`sleep ${sleepFor}`))
        .length;
    },
  };
}

async function until(pred: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const close = (
  sessionId: string,
  taskId: string,
  kind: 'test' | 'commit' | 'diff',
  ref: string,
  expect = 200,
) =>
  h!.mcp<TaskDoneResult & { evidenceReason?: string }>(
    'task_done',
    sessionId,
    { task_id: taskId, evidence: { kind, ref } },
    expect,
  );

async function twoSessions(opts: Parameters<typeof createHarness>[0] = {}) {
  h = await createHarness({ ledger: { gitTimeoutMs: 800 }, ...opts });
  const projectId = h.project();
  const repo = h.repo();
  h.session({ sessionId: 'ses_a', projectId, cwd: repo });
  h.session({ sessionId: 'ses_b', projectId, cwd: h.tempDir() });
  return { repo, projectId };
}

describe('a slow repository costs only the request that asked about it', () => {
  it('answers another session while a close waits on git, then records the close unverified with git_timeout', async () => {
    const shim = installShim();
    // A timeout longer than the hook budget: a ledger that held the thread would keep the other session waiting past it.
    const { repo } = await twoSessions({ ledger: { gitTimeoutMs: 3_000 } });
    await h!.mcp('declare_plan', 'ses_a', PLAN);
    // New work that would verify as commit evidence if git answered.
    const sha = commit(repo, 'src/store.ts', 'export const store = 1;\n', 'store');
    h!.toolUsed('ses_a');
    shim.slow(true);
    shim.reset();

    const started = Date.now();
    let settled = false;
    const slow = close('ses_a', 't1', 'commit', sha).finally(() => (settled = true));
    await until(() => shim.calls().length > 0, 'the ledger to be inside git');

    // aocd's thread is free: another session's ingest request is answered long inside the hook budget, while the
    // slow close is still waiting on git.
    const t0 = Date.now();
    const status = await h!.mcp<{ ok: boolean; sessionId: string }>('get_status', 'ses_b', {});
    const answeredIn = Date.now() - t0;
    expect(status).toMatchObject({ ok: true, sessionId: 'ses_b' });
    expect(answeredIn).toBeLessThan(HOOK_BUDGET_MS);
    expect(settled).toBe(false);

    const r = await slow;
    // Cut off at the per-call timeout, not left to run for the shim's 7 s.
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
    expect(Date.now() - started).toBeLessThan(6_500);
    expect(r).toMatchObject({ ok: true, flagged: 'evidence_unverified', evidenceReason: 'git_timeout' });
    expect(h!.events('task.done')[0]!.meta).toMatchObject({
      evidenceKind: 'commit',
      evidenceVerified: false,
      evidenceReason: 'git_timeout',
      flag: 'evidence_unverified',
    });
    // The close itself stands (flagged tasks count until reviewed), and git's children did not outlive it.
    expect(r.progress.doneTasks).toBe(1);
    await until(() => shim.strays() === 0, 'the timed-out git to be gone');
    expect(h!.t.rt.store.verifyChain().ok).toBe(true);
  });

  it('the same close verifies when git answers in time (the timeout, not the commit, made it unknown)', async () => {
    installShim();
    const { repo } = await twoSessions();
    await h!.mcp('declare_plan', 'ses_a', PLAN);
    const sha = commit(repo, 'src/store.ts', 'export const store = 1;\n', 'store');
    h!.toolUsed('ses_a');
    const r = await close('ses_a', 't1', 'commit', sha);
    expect(r).toMatchObject({ ok: true, flagged: null });
    expect(r.evidenceReason).toBeUndefined();
    expect(h!.events('task.done')[0]!.meta.evidenceReason).toBeUndefined();
  });

  it('a diff close whose working-tree fingerprint timed out is unverified, not verified by default', async () => {
    const shim = installShim();
    const { repo } = await twoSessions();
    await h!.mcp('declare_plan', 'ses_a', PLAN);
    writeFile(repo, 'src/schema.ts', 'export const schema = 1;\n');
    h!.toolUsed('ses_a');
    shim.slow(true);
    const r = await close('ses_a', 't1', 'diff', 'src/schema.ts +1');
    expect(r).toMatchObject({ flagged: 'evidence_unverified', evidenceReason: 'git_timeout' });
    expect(h!.events('task.done')[0]!.meta).toMatchObject({
      evidenceVerified: false,
      evidenceReason: 'git_timeout',
      treeFingerprint: null,
    });
    // Fast again: the same kind of close verifies (the baseline was kept, nothing was overwritten with null).
    shim.slow(false);
    writeFile(repo, 'src/store.ts', 'export const store = 1;\n');
    h!.toolUsed('ses_a');
    const ok = await close('ses_a', 't2', 'diff', 'src/store.ts +1');
    expect(ok).toMatchObject({ flagged: null });
    expect(h!.events('task.done')[1]!.meta).toMatchObject({ evidenceVerified: true, treeChanged: true });
  });

  it('a test file found only by listing the repository is unknown when the listing times out', async () => {
    const shim = installShim();
    const { repo } = await twoSessions();
    await h!.mcp('declare_plan', 'ses_a', PLAN);
    writeFile(repo, 'packages/store/test/store.test.ts', 'it("saves", () => {});\n');
    h!.toolUsed('ses_a');
    shim.slow(true);
    const r = await close('ses_a', 't1', 'test', 'test/store.test.ts > saves');
    expect(r).toMatchObject({ flagged: 'evidence_unverified', evidenceReason: 'git_timeout' });
    shim.slow(false);
    h!.toolUsed('ses_a');
    expect(await close('ses_a', 't2', 'test', 'test/store.test.ts > saves')).toMatchObject({ flagged: null });
  });

  it('declare_plan still declares on a slow repository, records why its baseline is missing, and later commit evidence is unknown, not verified', async () => {
    const shim = installShim();
    const { repo } = await twoSessions();
    shim.slow(true);
    await h!.mcp('declare_plan', 'ses_a', PLAN);
    expect(h!.events('plan.declared')[0]!.meta).toMatchObject({
      baseHead: null,
      treeFingerprint: null,
      baselineReason: 'git_timeout',
    });
    shim.slow(false);
    // Git answers now, but "already existed when the plan was declared" cannot be told without the baseline.
    const sha = commit(repo, 'src/store.ts', 'export const store = 1;\n', 'store');
    h!.toolUsed('ses_a');
    const r = await close('ses_a', 't1', 'commit', sha);
    expect(r).toMatchObject({ flagged: 'evidence_unverified', evidenceReason: 'git_timeout' });
  });

  it('a session without a repository has no baseline to lose: its plan records no reason', async () => {
    installShim();
    await twoSessions();
    await h!.mcp('declare_plan', 'ses_b', PLAN);
    expect(h!.events('plan.declared')[0]!.meta).toMatchObject({ baseHead: null, treeFingerprint: null });
    expect(h!.events('plan.declared')[0]!.meta.baselineReason).toBeUndefined();
  });

  it('two simultaneous closes of one task record it once (the second is refused, as when they ran in turn)', async () => {
    const shim = installShim();
    const { repo } = await twoSessions({ ledger: { gitTimeoutMs: 5_000 } });
    await h!.mcp('declare_plan', 'ses_a', PLAN);
    const sha = commit(repo, 'src/store.ts', 'export const store = 1;\n', 'store');
    h!.toolUsed('ses_a');
    // Every git call takes a moment, so both closes are certainly in flight before either one is decided.
    shim.slow(0.3);
    const send = () =>
      h!.t.request('POST', '/ingest/mcp/task_done', {
        headers: h!.t.ingestHeaders('ses_a'),
        body: { sessionId: 'ses_a', input: { task_id: 't1', evidence: { kind: 'commit', ref: sha } } },
      });
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const refused = (await (a.status === 409 ? a : b).json()) as McpErrorResult;
    expect(refused.error).toMatch(/already done/);
    expect(h!.events('task.done')).toHaveLength(1);
  });
});

/** Root can prove the ownership check: a working copy owned by another uid is refused by plain git. */
describe.skipIf(!isRoot)('a working copy another OS user owns (session isolation, G-01)', () => {
  function chownTree(path: string, uid: number): void {
    lchownSync(path, uid, uid);
    for (const e of readdirSync(path, { withFileTypes: true })) {
      const p = join(path, e.name);
      if (e.isDirectory()) chownTree(p, uid);
      else lchownSync(p, uid, uid);
    }
  }
  /** Test-only: root reading or committing in the foreign repository, trusting its exact path and nothing else. */
  const asRoot = (repo: string, ...args: string[]) => {
    const r = spawnSync(
      realGit,
      [
        '-c',
        `safe.directory=${repo}`,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        ...args,
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' },
      },
    );
    return { code: r.status, out: r.stdout.trim(), err: r.stderr };
  };
  /** The same read without any of the hardening: what exact-path trust alone would do. */
  const unhardened = (repo: string, ...args: string[]) =>
    spawnSync(realGit, ['-c', `safe.directory=${repo}`, ...args], { cwd: repo, encoding: 'utf8' });

  /** What a hostile session could leave in its own repository: each trap records that it ran. */
  function plantTraps(repo: string) {
    const dir = temp();
    const markers = {
      transport: join(dir, 'ran-transport'),
      fsmonitor: join(dir, 'ran-fsmonitor'),
      hook: join(dir, 'ran-hook'),
    };
    const script = (name: keyof typeof markers) => {
      const file = join(dir, `trap-${name}.sh`);
      writeFileSync(file, `#!/bin/sh\necho ran >> '${markers[name]}'\nexit 1\n`, { mode: 0o755 });
      return file;
    };
    const hooks = join(repo, '.git', 'trap-hooks');
    mkdirSync(hooks);
    writeFileSync(join(hooks, 'reference-transaction'), `#!/bin/sh\necho ran >> '${markers.hook}'\n`, {
      mode: 0o755,
    });
    const config = join(repo, '.git', 'config');
    writeFileSync(
      config,
      readFileSync(config, 'utf8').replace('repositoryformatversion = 0', 'repositoryformatversion = 1'),
    );
    appendFileSync(
      config,
      `[extensions]\n\tpartialClone = origin\n[remote "origin"]\n\turl = ext::${script('transport')}\n\tpromisor = true\n` +
        `[protocol "ext"]\n\tallow = always\n[core]\n\tfsmonitor = ${script('fsmonitor')}\n\thooksPath = ${hooks}\n`,
    );
    return {
      markers,
      ran: () =>
        Object.entries(markers)
          .filter(([, f]) => existsSync(f))
          .map(([k]) => k),
    };
  }

  it('verifies commit evidence there by trusting exactly that path, and runs nothing the repository configures', async () => {
    const shim = installShim();
    h = await createHarness();
    const projectId = h.project();
    const repo = realpathSync(h.repo());
    const traps = plantTraps(repo);
    chownTree(repo, FOREIGN_UID);
    h.session({ sessionId: 'ses_a', projectId, cwd: repo });

    // Premises: root's own git refuses this repository; an unhardened exact-path trust would run the planted
    // promisor transport as root as soon as a cited commit is missing.
    const MISSING = '1'.repeat(40);
    expect(spawnSync(realGit, ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stderr).toMatch(
      /dubious ownership/,
    );
    unhardened(repo, 'rev-list', '-n1', `${MISSING}^{commit}`);
    expect(traps.ran()).toEqual(['transport']);
    rmSync(traps.markers.transport);

    const base = asRoot(repo, 'rev-parse', 'HEAD').out;
    shim.reset();
    await h.mcp('declare_plan', 'ses_a', PLAN);
    // The baseline HEAD is read; the working-tree fingerprint (status, diff) is not: plain git refuses.
    expect(h.events('plan.declared')[0]!.meta).toMatchObject({ baseHead: base, treeFingerprint: null });
    expect(h.events('plan.declared')[0]!.meta.baselineReason).toBeUndefined();

    asRoot(
      repo,
      '-c',
      'user.name=Agent',
      '-c',
      'user.email=agent@localhost',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'work',
    );
    const work = asRoot(repo, 'rev-parse', 'HEAD').out;
    shim.reset();

    h.toolUsed('ses_a');
    expect(await close('ses_a', 't1', 'commit', work)).toMatchObject({ ok: true, flagged: null });
    h.toolUsed('ses_a');
    // Pre-plan commit, and a commit that is not there: refuted (no reason: git answered), nothing executed.
    expect(await close('ses_a', 't2', 'commit', base)).toMatchObject({ flagged: 'evidence_unverified' });
    h.toolUsed('ses_a');
    const missing = await close('ses_a', 't3', 'commit', MISSING);
    expect(missing).toMatchObject({ flagged: 'evidence_unverified' });
    expect(missing.evidenceReason).toBeUndefined();
    expect(h.events('task.done').map((e) => [e.meta.evidenceVerified, e.meta.evidenceReason])).toEqual([
      [true, undefined],
      [false, undefined],
      [false, undefined],
    ]);
    expect(traps.ran()).toEqual([]);

    // Exactly the path, never '*'; hooks and fsmonitor off; no system or user config, no lazy fetch, no transport.
    const calls = shim.calls();
    const trusted = calls.filter((c) => c.args.includes('safe.directory'));
    expect(trusted.length).toBeGreaterThan(0);
    for (const c of trusted) {
      expect(c.args).toContain(`safe.directory=${repo} `);
      expect(c.args).not.toMatch(/safe\.directory=\*/);
      expect(c.args.match(/safe\.directory/g)).toHaveLength(1);
      expect(c.args).toContain('core.hooksPath=/dev/null');
      expect(c.args).toContain('core.fsmonitor=false');
      expect(c.args).toMatch(/ (rev-parse|rev-list) /);
      expect(c.env).toEqual(
        expect.arrayContaining([
          'GIT_CONFIG_GLOBAL=/dev/null',
          'GIT_CONFIG_NOSYSTEM=1',
          'GIT_CONFIG_SYSTEM=/dev/null',
          'GIT_NO_LAZY_FETCH=1',
          'GIT_ALLOW_PROTOCOL=',
          'GIT_OPTIONAL_LOCKS=0',
        ]),
      );
    }
    // The commands that can start filters, textconv and fsmonitor are never trusted.
    const plain = calls.filter((c) => !c.args.includes('safe.directory'));
    expect(plain.length).toBeGreaterThan(0);
    for (const c of plain) expect(c.args).toMatch(/^(status|diff|ls-files|tag) /);

    // Phase P1 closed: HEAD is pinned by sha; the tag (a write) was refused like any plain git call.
    const [pin] = h.events('phase.completed');
    expect(pin!.meta).toMatchObject({ phaseId: 'P1', pinnedSha: work, pinnedTag: null });
    expect(traps.ran()).toEqual([]);
    expect(h.t.rt.store.verifyChain().ok).toBe(true);
  });

  it('a working copy whose path could be read as a pattern is not trusted', async () => {
    installShim();
    h = await createHarness();
    const projectId = h.project();
    const parent = temp();
    const repo = join(parent, 'repo*star');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'f'), 'x\n');
    git(repo, 'add', '-A');
    git(
      repo,
      '-c',
      'user.name=n',
      '-c',
      'user.email=e@l',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'one',
    );
    const sha = git(repo, 'rev-parse', 'HEAD');
    chownTree(repo, FOREIGN_UID);
    h.session({ sessionId: 'ses_a', projectId, cwd: repo });
    await h.mcp('declare_plan', 'ses_a', PLAN);
    expect(h.events('plan.declared')[0]!.meta).toMatchObject({ baseHead: null });
    h.toolUsed('ses_a');
    expect(await close('ses_a', 't1', 'commit', sha)).toMatchObject({ flagged: 'evidence_unverified' });
  });
});
