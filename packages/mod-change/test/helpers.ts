import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChangeScope, LearningService, LedgerService, SupervisorService, User } from '@aoc/contracts';
import {
  createGitService,
  createTestRuntime,
  initRepo,
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
}

/** Git env isolated from the host's config so tests are deterministic. */
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

/** SupervisorService fake: runIsolated really runs the command (argv, no shell) with a minimal env plus the credential profile's env. */
export class FakeSupervisor implements SupervisorService {
  readonly calls: IsolatedCall[] = [];
  readonly profiles: Record<string, Record<string, string>> = {
    'prod-promote': { AOC_TEST_CREDENTIALS: 'prod-promote' },
  };

  runIsolated(input: IsolatedCall): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.calls.push(input);
    return new Promise((resolve) => {
      const env = {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '/tmp',
        ...GIT_ENV,
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
  /** git commands run through runIsolated, as argv after any `env K=V` prefix. */
  gitCalls(): { profile: string | null; env: string[]; args: string[] }[] {
    return this.calls.flatMap((c) => {
      const i = c.command.indexOf('git');
      if (i < 0) return [];
      const env = c.command[0] === 'env' ? c.command.slice(1, i) : [];
      return [{ profile: c.credentialProfile, env, args: c.command.slice(i + 1) }];
    });
  }
}

const git = createGitService();
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

/** A bare remote wired as `origin`, plus a pre-push hook that only lets the supervisor (AOC_SUPERVISOR_PUSH=1) push. */
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

export function remoteHead(remote: string, branch = 'main'): string {
  return git.run(remote, ['rev-parse', `refs/heads/${branch}`], { env: GIT_ENV }).stdout.trim();
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
  } = {},
): Promise<Harness> {
  const sup = new FakeSupervisor();
  const mod = createChangeModule(opts.change);
  const services: Record<string, unknown> = {};
  if (opts.supervisor !== false) services.supervisor = sup;
  if (opts.ledger) services.ledger = opts.ledger;
  if (opts.learning) services.learning = opts.learning;
  const t = await createTestRuntime({ modules: [mod], services });
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
