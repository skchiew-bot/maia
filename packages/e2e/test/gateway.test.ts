/**
 * R-02 end to end on claude-sim, the way the real CLI was observed to behave (packages/e2e/real-cli/guard-push.test.ts):
 * a credentialed writer holds no push credential — the supervisor's git gateway is a remote called `aoc` in its
 * environment. `git push aoc <commit>:refs/heads/feature/push` arrives upstream through real git smart HTTP to aocd;
 * the same commit to main is stopped by the PreToolUse hook before git runs (and would be refused by the gateway);
 * the credential's secret is never in the session's environment.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serviceRepoPathFor } from '@aoc/supervisor';
import { Harness } from './harness';
import { REPO_ROOT } from './paths';
import { launchSim, untilSession } from './sim';

const CANARY = 'canary-3f9a61c07be2';
/** Git with no global or system configuration of the machine running the test (signing, push negotiation, ...). */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();

const SCENARIO = {
  name: 'e2e-gateway',
  steps: [
    { kind: 'think', ms: 200, outputTokens: 50 },
    {
      kind: 'mcp',
      server: 'aoc',
      tool: 'declare_plan',
      args: {
        phases: [
          {
            id: 'p1',
            name: 'Publish',
            tasks: [{ id: 't1', title: 'Commit and publish push.txt', size: 'xs' }],
          },
        ],
      },
    },
    { kind: 'tool', name: 'Write', input: { file_path: 'push.txt', content: 'x\n' } },
    {
      kind: 'bash',
      command: 'git add push.txt && git commit -q -m "Add push.txt" && git rev-parse HEAD',
      stdout: '',
      saveAs: 'sha',
      exec: true,
    },
    {
      kind: 'bash',
      command: 'printenv AOC_CANARY_TOKEN; echo "canary-exit=$?"',
      stdout: '',
      saveAs: 'canary',
      exec: true,
    },
    { kind: 'bash', command: 'git remote -v', stdout: '', saveAs: 'remotes', exec: true },
    {
      kind: 'bash',
      command: 'git push aoc {{sha.stdout}}:refs/heads/feature/push 2>&1',
      stdout: '',
      saveAs: 'feature',
      exec: true,
    },
    { kind: 'bash', command: 'git push aoc {{sha.stdout}}:refs/heads/main 2>&1', stdout: '', saveAs: 'main' },
    { kind: 'text', text: 'Published the feature branch; main needs a decision.' },
    { kind: 'endTurn', final: true },
  ],
};

let dir: string;
let h: Harness;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aoc-e2e-gateway-'));
  const profiles = join(dir, 'credential-profiles.json');
  // The default registry's builder type holds the git-feature profile; its secret is a canary only aocd may know.
  writeFileSync(
    profiles,
    JSON.stringify({
      profiles: {
        'git-feature': { env: { AOC_CANARY_TOKEN: CANARY }, push: { refs: ['refs/heads/feature/**'] } },
      },
    }),
    { mode: 0o600 },
  );
  // The shipped builder type scopes Bash to a few git verbs (`git push aoc` among them); this scenario also runs
  // `printenv` and `git remote -v`, so it uses the shipped registry with the builder's Bash rules left out.
  const registry = JSON.parse(readFileSync(join(REPO_ROOT, 'config', 'process-types.json'), 'utf8')) as {
    types: { id: string; tools?: { allow?: string[]; deny?: string[] } }[];
  };
  const builder = registry.types.find((t) => t.id === 'feature-build')!;
  builder.tools = {};
  const registryFile = join(dir, 'process-types.json');
  writeFileSync(registryFile, JSON.stringify(registry));
  h = await Harness.start({
    supervisor: 'real',
    config: { registryFile, supervisor: { credentialProfilesFile: profiles } },
  });
});
afterAll(async () => {
  await h?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('push gateway with claude-sim (R-02)', () => {
  it('a feature branch reaches the upstream through `git push aoc`, main is denied by the hook, the credential stays with aocd', async () => {
    const dev = await h.user('builder', 'Publisher');
    const { projectId, repo } = await h.project(dev, 'Publish');
    // The upstream, and the supervisor's repository for the project with it as origin (what an operator sets up).
    const upstream = join(dir, 'upstream.git');
    git(dir, 'init', '--quiet', '--bare', '-b', 'main', upstream);
    git(repo, 'remote', 'add', 'origin', upstream);
    git(repo, 'push', '--quiet', 'origin', 'main');
    git(repo, 'remote', 'remove', 'origin');
    const service = serviceRepoPathFor(join(h.dataDir, 'git'), projectId);
    mkdirSync(dirname(service), { recursive: true });
    git(dir, 'init', '--quiet', '--bare', '--template=', '--initial-branch=aoc-service-clone', service);
    git(dir, `--git-dir=${service}`, 'remote', 'add', 'origin', upstream);
    const mainBefore = git(upstream, 'rev-parse', 'main');

    const scenario = join(dir, 'gateway.json');
    writeFileSync(scenario, JSON.stringify(SCENARIO));
    const sessionId = await launchSim(h, dev, projectId, scenario);
    await untilSession(
      h,
      sessionId,
      dev,
      (d) => d.lifecycle === 'waiting_decision',
      'the denied push to main to raise its card',
    );

    // The system prompt tells the model how to publish; it holds no credential.
    const launched = h.events({ types: ['session.launched'], sessionId })[0]!;
    const prompt = readFileSync(join(h.root, 'sessions', sessionId, 'system-prompt.md'), 'utf8');
    expect(prompt).toContain('git push aoc <commit>:refs/heads/<branch>');
    expect(prompt).toContain('`refs/heads/feature/**`');

    // Upstream: the feature branch carries the session's commit; main did not move; nothing else appeared.
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(git(upstream, 'rev-parse', 'refs/heads/feature/push')).toBe(head);
    expect(git(upstream, 'rev-parse', 'main')).toBe(mainBefore);
    expect(git(upstream, 'for-each-ref', '--format=%(refname)').split('\n').sort()).toEqual([
      'refs/heads/feature/push',
      'refs/heads/main',
    ]);

    // The gateway recorded the one push it served; the push to main never got that far.
    const pushed = h.events({ types: ['session.git_pushed'], sessionId });
    expect(pushed.map((e) => [e.meta.refs, e.meta.forwarded, e.meta.refused, e.meta.failed])).toEqual([
      [1, 1, 0, 0],
    ]);
    expect((h.store.readPayload(pushed[0]!) as { results: unknown[] }).results).toEqual([
      {
        ref: 'refs/heads/feature/push',
        oldSha: '0'.repeat(40),
        newSha: head,
        result: 'forwarded',
        reason: null,
      },
    ]);
    expect(
      h.events({ types: ['tool.denied'], sessionId }).map((e) => [e.meta.toolName, e.meta.guard]),
    ).toEqual([['Bash', 'protected-op']]);

    // What the session saw: the `aoc` remote and no credential — nowhere in its environment, nowhere in its transcript.
    const transcript = readFileSync(
      (h.store.readPayload(launched) as { transcriptPath: string }).transcriptPath,
      'utf8',
    );
    expect(transcript).toContain('canary-exit=1');
    expect(transcript).toMatch(/aoc\\thttp:\/\/127\.0\.0\.1:\d+\/ingest\/git\/[^ ]+\.git \(push\)/);
    expect(transcript).toContain('AOC blocked a protected operation');
    for (const text of [
      transcript,
      JSON.stringify(h.events({ sessionId }).map((e) => [e.meta, h.store.readPayload(e)])),
    ]) {
      expect(text).not.toContain(CANARY);
    }
  });
});
