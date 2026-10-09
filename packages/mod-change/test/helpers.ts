import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ChangeScope,
  LearningService,
  LedgerService,
  SelfModificationService,
  SupervisorService,
  User,
} from '@aoc/contracts';
import {
  createTestRuntime,
  initRepo,
  type AocModule,
  type BroadcastMessage,
  type TestRuntime,
  type TestUser,
} from '@aoc/kernel';
import { createChangeModule, type ChangeModule, type ChangeModuleOptions } from '../src';

export interface IsolatedCall {
  cwd: string;
  command: string[];
  credentialProfile: string | null;
  timeoutMs: number;
  env?: Record<string, string>;
  sandbox?: { handOver?: string[] };
}

/** Git env isolated from the host's config so tests are deterministic. */
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

/**
 * SupervisorService fake: runIsolated really runs the command (argv, no shell) as the supervisor does — PATH, then
 * the caller's env, then the credential profile's env — as the current user (no session user is configured).
 */
export class FakeSupervisor implements SupervisorService {
  readonly calls: IsolatedCall[] = [];
  readonly profiles: Record<string, Record<string, string>> = {
    'prod-promote': { TEST_PROMOTION_TOKEN: 'prod-promote' },
  };

  runIsolated(input: IsolatedCall): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.calls.push(input);
    if (input.sandbox && input.credentialProfile)
      return Promise.reject(new Error('runIsolated: a sandboxed run never gets a credential profile'));
    return new Promise((resolve) => {
      const env = {
        PATH: process.env.PATH ?? '',
        ...input.env,
        ...(input.credentialProfile ? this.profiles[input.credentialProfile] : {}),
      };
      const child = spawn(input.command[0]!, input.command.slice(1), {
        cwd: input.cwd,
        env,
        timeout: input.timeoutMs,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', (err) => resolve({ exitCode: 127, stdout, stderr: `${stderr}${String(err)}` }));
      child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    });
  }
  async launch(): Promise<{ sessionId: string }> {
    throw new Error('not used in mod-change tests');
  }
  async resume(): Promise<void> {}
  async nudge(): Promise<void> {}
  async restart(): Promise<void> {}
  async stop(): Promise<void> {}
  async rollover(): Promise<{ refused: string[] }> {
    return { refused: ['not used'] };
  }
  isRunning(): boolean {
    return false;
  }
  stopRequested(): boolean {
    return false;
  }
  /** git commands run through runIsolated: the subcommand and its arguments, after git's global options. */
  gitCalls(): { profile: string | null; cwd: string; sandboxed: boolean; args: string[] }[] {
    return this.calls.flatMap((c) => {
      if (c.command[0] !== 'git') return [];
      let i = 1;
      while (i < c.command.length) {
        const a = c.command[i]!;
        if (a === '-c' || a === '--work-tree') i += 2;
        else if (a.startsWith('--git-dir=')) i += 1;
        else break;
      }
      return [{ profile: c.credentialProfile, cwd: c.cwd, sandboxed: !!c.sandbox, args: c.command.slice(i) }];
    });
  }
}

/** Plain git, as a developer or an agent runs it (the kernel's service refuses every transport). */
const git = {
  run(dir: string, args: string[], opts: { env?: Record<string, string> } = {}) {
    const r = spawnSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', ...opts.env },
    });
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? String(r.error ?? '') };
  },
};
const temps: string[] = [];

export function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

export function cleanupTemps(): void {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
}

export interface TestRepo {
  dir: string;
  git(...args: string[]): string;
  commit(message: string, files: Record<string, string>): string;
  head(ref?: string): string;
}

export function makeRepo(files: Record<string, string> = { 'README.md': '# app\n' }): TestRepo {
  const dir = tempDir('aoc-chg-repo-');
  initRepo(dir, { files });
  const run = (...args: string[]) => {
    const r = git.run(dir, args, { env: GIT_ENV });
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  return {
    dir,
    git: run,
    commit(message, changes) {
      for (const [p, content] of Object.entries(changes)) {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), content);
      }
      run('add', '-A');
      run('commit', '-q', '-m', message);
      return run('rev-parse', 'HEAD');
    },
    head: (ref = 'HEAD') => run('rev-parse', ref),
  };
}

/**
 * A bare remote wired as the project repository's `origin` (the developers' view), plus the developers' pre-push
 * speed bump there: it refuses pushes unless AOC_SUPERVISOR_PUSH=1. AOC itself never runs that hook any more.
 */
export function addGuardedRemote(repo: TestRepo): string {
  const remote = tempDir('aoc-chg-remote-');
  const r = git.run(remote, ['init', '-q', '--bare', '-b', 'main'], { env: GIT_ENV });
  if (r.code !== 0) throw new Error(r.stderr);
  repo.git('remote', 'add', 'origin', remote);
  repo.git('push', '-q', 'origin', 'main');
  const hook = join(repo.dir, '.git', 'hooks', 'pre-push');
  writeFileSync(
    hook,
    '#!/bin/sh\n[ "$AOC_SUPERVISOR_PUSH" = "1" ] || { echo "pre-push: only the AOC supervisor may push" >&2; exit 1; }\n',
  );
  chmodSync(hook, 0o755);
  return remote;
}

/** What an operator does once per project (as the aocd user): name the protected remote in the service clone. */
export function setPromotionRemote(h: Harness, projectId: string, remote: string): string {
  const clone = h.mod.engine.serviceClonePath(projectId);
  if (!existsSync(clone)) {
    mkdirSync(dirname(clone), { recursive: true });
    const init = git.run(dirname(clone), ['init', '-q', '--bare', clone], { env: GIT_ENV });
    if (init.code !== 0) throw new Error(init.stderr);
  }
  const added = git.run(clone, [`--git-dir=${clone}`, 'remote', 'add', 'origin', remote], { env: GIT_ENV });
  if (added.code !== 0) throw new Error(added.stderr);
  return clone;
}

export function remoteHead(remote: string, branch = 'main'): string {
  return git.run(remote, [`--git-dir=${remote}`, 'rev-parse', `refs/heads/${branch}`], { env: GIT_ENV }).stdout.trim();
}

/** A ref in the project's service clone (null when absent). */
export function cloneRef(h: Harness, projectId: string, ref: string): string | null {
  const r = cloneGit(h, projectId, 'rev-parse', '--verify', '--quiet', ref);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** git in the project's service clone (inspection by the test). */
export function cloneGit(h: Harness, projectId: string, ...args: string[]) {
  const clone = h.mod.engine.serviceClonePath(projectId);
  return git.run(clone, [`--git-dir=${clone}`, ...args], { env: GIT_ENV });
}

/** Acceptance test used by the rollback scenarios: fails when state.txt says "broken". */
export const ACCEPTANCE_SCRIPT = `const fs = require('fs');
const broken = fs.readFileSync('state.txt', 'utf8').includes('broken');
console.log('# pass ' + (broken ? 2 : 3));
console.log('# fail ' + (broken ? 1 : 0));
process.exit(broken ? 1 : 0);
`;

export interface Harness {
  t: TestRuntime;
  mod: ChangeModule;
  sup: FakeSupervisor;
  builder: TestUser;
  approver: TestUser;
  notifications: Extract<BroadcastMessage, { event: 'notification' }>['data'][];
  /** Drain reactors and background verifications until everything is quiet. */
  settle(): Promise<void>;
  addProject(projectId: string, repo: string, extra?: Record<string, string>): void;
  types(prefix: string): string[];
  close(): Promise<void>;
}

export async function harness(
  opts: {
    change?: ChangeModuleOptions;
    supervisor?: boolean;
    ledger?: Partial<LedgerService>;
    learning?: Partial<LearningService>;
    selfmod?: SelfModificationService;
    /** More modules, e.g. the real supervisor (with `supervisor: false`). */
    modules?: AocModule[];
    config?: Parameters<typeof createTestRuntime>[0]['config'];
  } = {},
): Promise<Harness> {
  const sup = new FakeSupervisor();
  const mod = createChangeModule({ serviceClonesDir: tempDir('aoc-chg-clones-'), ...opts.change });
  const services: Record<string, unknown> = {};
  if (opts.supervisor !== false) services.supervisor = sup;
  if (opts.ledger) services.ledger = opts.ledger;
  if (opts.learning) services.learning = opts.learning;
  if (opts.selfmod) services.selfmod = opts.selfmod;
  const t = await createTestRuntime({
    modules: [mod, ...(opts.modules ?? [])],
    services,
    config: opts.config,
  });
  const notifications: Harness['notifications'] = [];
  t.rt.broadcaster.subscribe({
    role: 'approver',
    send: (m) => m.event === 'notification' && notifications.push(m.data),
  });
  return {
    t,
    mod,
    sup,
    builder: t.user('builder', 'Bea Builder'),
    approver: t.user('approver', 'Ada Approver'),
    notifications,
    async settle() {
      for (let i = 0; i < 50; i++) {
        await t.drain();
        await new Promise((resolve) => setImmediate(resolve));
        await t.drain();
        if (!mod.engine.busy) return;
        await mod.whenIdle();
      }
      throw new Error('change module did not settle');
    },
    addProject(projectId, repo, extra = {}) {
      t.rt.store.append({
        type: 'project.created',
        actor: { kind: 'system', id: 'test' },
        scope: { projectId },
        meta: { projectId, slug: projectId },
        payload: { name: projectId, repoPath: repo, defaultBranch: 'main', ...extra },
        source: 'system',
      });
    },
    types: (prefix) => t.rt.store.list({ typePrefix: prefix }).map((e) => e.type),
    async close() {
      await t.close();
      cleanupTemps();
    },
  };
}

export const PASSKEY = { passkeyAssertion: { id: 'test-passkey' } };

/** Draft → affirm all four fields (with real edits) → submit. Returns the change id. */
export async function draftAndAffirm(
  h: Harness,
  input: {
    projectId: string;
    scope: ChangeScope;
    owner: TestUser;
    rollbackRef: string;
    acceptanceTest?: string;
    title?: string;
  },
): Promise<string> {
  const created = await h.t.json<{ changeId: string }>('POST', '/api/changes', {
    headers: input.owner.headers,
    body: { projectId: input.projectId, scope: input.scope, title: input.title ?? 'Ship the thing' },
    expect: 201,
  });
  const values: Record<string, Record<string, unknown>> = {
    impact: { value: 'Touches the login flow for every user.', dwellMs: 9000 },
    mitigation: { value: 'Feature flag, staged rollout, alerting on 5xx.', dwellMs: 9000 },
    rollbackPlan: {
      value: 'Roll back to the pinned ref and redeploy.',
      dwellMs: 9000,
      rollbackRef: input.rollbackRef,
    },
    acceptanceTest: { value: input.acceptanceTest ?? 'node test.js', dwellMs: 9000 },
  };
  for (const [field, body] of Object.entries(values)) {
    await h.t.json('POST', `/api/changes/${created.changeId}/fields/${field}`, {
      headers: input.owner.headers,
      body,
    });
  }
  return created.changeId;
}

/** Drive a change record to `approved` (self-approved when allowed, else via the approver's decision). */
export async function approveChange(h: Harness, changeId: string, owner: TestUser): Promise<void> {
  const submitted = await h.t.json<{ status: string; decisionId: string | null }>(
    'POST',
    `/api/changes/${changeId}/submit`,
    { headers: owner.headers },
  );
  if (submitted.status !== 'approved') {
    await h.t.decisions!.resolve(submitted.decisionId!, { optionId: 'approve' }, h.approver.user as User);
    await h.settle();
  }
}
