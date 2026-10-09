/**
 * What a managed build may do with git, as the shipped process types grant it (config/process-types.json), judged by
 * claude-sim's permission engine (which models Claude Code's) and by mod-change's protected-operation guard. Builds
 * branch, stage and commit for real. They push only through the supervisor's gateway (remote `aoc`, R-02: the
 * credential never enters the session and the credential profile's push.refs decide the branch); they never merge,
 * rewrite history or touch main.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtInScenario, decidePermission, parseRules, type PermissionPolicy } from '@aoc/claude-sim';
import { FILE_CHANGING_TOOLS, ProcessRegistrySchema, type ProcessType } from '@aoc/contracts';
import { matchProtectedOperation } from '@aoc/mod-change';
import { defaultScenario } from '../src/default-scenario';
import { REPO } from './helpers';

const registry = ProcessRegistrySchema.parse(JSON.parse(readFileSync(join(REPO, 'config/process-types.json'), 'utf8')));
const type = (id: string): ProcessType => {
  const t = registry.types.find((x) => x.id === id);
  if (!t) throw new Error(`no process type ${id}`);
  return t;
};

/** The flags the supervisor starts a session with (packages/supervisor/src/launch-config.ts, toolPolicy): the AOC MCP server is always allowed, read-only types also deny every file-changing tool. */
function policyOf(id: string): PermissionPolicy {
  const t = type(id);
  return {
    mode: t.permissionMode,
    allow: parseRules(['mcp__aoc', ...(t.tools.allow ?? [])]),
    deny: parseRules([...(t.tools.deny ?? []), ...(t.readOnly ? FILE_CHANGING_TOOLS : [])]),
    cwd: '/work/repo',
    workingDirs: ['/work/repo'],
    homeDir: '/home/session',
  };
}

const bash = (policy: PermissionPolicy, command: string) => decidePermission(policy, 'Bash', { command }).behavior;
const WRITERS = ['bug-fix', 'feature-build'] as const;

describe.each(WRITERS)('%s: scoped git', (id) => {
  const policy = policyOf(id);

  it('branches, stages and commits, and reads the history', () => {
    for (const command of [
      'git status',
      'git diff HEAD',
      'git log --oneline -5',
      'git show HEAD',
      'git rev-parse --short HEAD',
      'git add src/claims/idempotency.ts test/claims/dedupe.test.ts',
      'git commit -m "Fix" -m "AOC-Ticket: tkt_1" -m "AOC-Session: ses_1"',
      'git checkout -b feature/whisper',
      'git switch -c uat/tkt_1',
      'git switch uat/tkt_1',
      'git switch -',
      // A compound command needs a grant for every part of it.
      'git switch -c uat/tkt_1 || git switch uat/tkt_1',
      'git add -A && git commit -m "Fix"',
      // What the intake build prompt tells a builder to run when the fix is committed.
      'git push aoc HEAD:refs/heads/uat/tkt_1',
    ]) {
      expect(bash(policy, command), command).toBe('allow');
    }
  });

  it('pushes nowhere but the gateway remote, merges nothing, rewrites no history and does not move onto the default branch', () => {
    for (const command of [
      'git push origin uat/tkt_1',
      'git push origin main',
      'git push --force origin HEAD:main',
      'git push https://example.invalid/repo.git HEAD:refs/heads/uat/tkt_1',
      'git merge uat/tkt_1',
      'git rebase main',
      'git reset --hard HEAD~1',
      'git switch main',
      'git checkout main',
      'git switch -C main',
      'git branch -D main',
      'git tag -d aoc/change/chg_1',
      'git update-ref -d refs/heads/main',
      'git remote add origin https://example.invalid/repo.git',
      // One allowed part does not carry a denied one.
      'git commit -m "Fix" && git push origin HEAD',
      'git add -A; git reset --hard',
    ]) {
      expect(bash(policy, command), command).toBe('deny');
    }
  });

  it('keeps the deploy credential profile its type had', () => {
    expect(type(id).credentialProfile).toBe(id === 'bug-fix' ? 'uat-deploy' : 'git-feature');
  });
});

describe('everything else stays as it was', () => {
  it('lets read-only triage run no git at all and change no file', () => {
    const triage = type('bug-triage');
    expect(triage.readOnly).toBe(true);
    expect(triage.credentialProfile ?? null).toBeNull();
    expect(triage.tools.allow ?? []).toEqual([]);
    const policy = policyOf('bug-triage');
    for (const command of ['git commit -m x', 'git add -A', 'git switch -c x', 'git status']) {
      expect(bash(policy, command), command).toBe('deny');
    }
    expect(decidePermission(policy, 'Write', { file_path: '/work/repo/src/a.ts', content: 'x' }).behavior).toBe('deny');
    expect(decidePermission(policy, 'Read', { file_path: '/work/repo/src/a.ts' }).behavior).toBe('allow');
  });

  it('grants no git to the other write types (they commit nothing in the demo)', () => {
    for (const id of ['discovery', 'migration', 'test-repair', 'docs']) {
      expect(bash(policyOf(id), 'git commit -m x'), id).toBe('deny');
    }
  });

  it('is still bounced by the protected-operation guard before the permission rules are consulted', () => {
    for (const command of [
      'git push origin main',
      'git push --force origin HEAD:main',
      'git push origin HEAD:refs/heads/main',
      // The gateway would refuse it too; the permission rules allow the remote, so this one is the guard's catch.
      'git push aoc HEAD:refs/heads/main',
    ]) {
      expect(matchProtectedOperation(command), command).toMatchObject({ test: 'main' });
    }
    // A UAT branch push through the gateway, a commit and a branch switch are not the guard's business.
    for (const command of ['git push aoc HEAD:refs/heads/uat/tkt_1', 'git commit -m x', 'git switch -c uat/tkt_1']) {
      expect(matchProtectedOperation(command), command).toBeNull();
    }
  });
});

describe('the git steps the demo scenarios run', () => {
  const execSteps = (steps: readonly { kind: string; command?: string; exec?: boolean }[]) =>
    steps.flatMap((s) => (s.kind === 'bash' && s.exec ? [s.command!] : []));

  it("are all granted to the process type that runs them (the demo's intake builds and the dedupe continuation)", () => {
    const intake = execSteps(defaultScenario({ receipts: 'tkt_1', transferBlank: 'tkt_2' }).steps as never);
    const dedupe = execSteps(builtInScenario('demo-dedupe-resume')!.steps as never);
    expect(intake.length).toBeGreaterThan(0);
    expect(dedupe.length).toBeGreaterThan(0);
    for (const command of [...intake, ...dedupe]) expect(bash(policyOf('bug-fix'), command), command).toBe('allow');
  });

  it('never include a push, a merge or a move onto main', () => {
    const all = [...execSteps(defaultScenario({ receipts: 'tkt_1', transferBlank: 'tkt_2' }).steps as never), ...execSteps(builtInScenario('demo-dedupe-resume')!.steps as never)];
    for (const command of all) expect(command, command).not.toMatch(/\bgit (push|merge|rebase|reset)\b|\b(switch|checkout) main\b/);
  });
});
