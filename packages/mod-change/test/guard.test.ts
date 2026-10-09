import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PreToolContext, SessionInfo } from '@aoc/contracts';
import { matchProtectedOperation, splitShell } from '../src';
import { harness, makeRepo, tempDir, type Harness } from './helpers';

const hit = (cmd: string, currentBranch: string | null = null) =>
  matchProtectedOperation(cmd, { currentBranch: () => currentBranch });

describe('protected-op patterns', () => {
  it('splits command lines like a shell would (quotes, operators, heredocs, comments)', () => {
    expect(
      splitShell(`cd app && git commit -m "git push origin main" ; echo 'x|y' | wc -l # git push`),
    ).toEqual([
      ['cd', 'app'],
      ['git', 'commit', '-m', 'git push origin main'],
      ['echo', 'x|y'],
      ['wc', '-l'],
    ]);
    expect(splitShell('cat <<EOF > notes.md\ngit push origin main\nEOF\nls 2>&1')).toEqual([['cat'], ['ls']]);
    expect(splitShell('echo $(git push origin main)')).toEqual([['echo'], ['git', 'push', 'origin', 'main']]);
    expect(splitShell('find . -exec rm {} \\;')).toEqual([['find', '.', '-exec', 'rm', '{}', ';']]);
  });

  it.each([
    ['git push origin main', 'main'],
    ['git push origin HEAD:main', 'main'],
    ['git push origin HEAD:refs/heads/master', 'main'],
    ['git push -u origin main', 'main'],
    ['git push --force origin feature/x', 'main'],
    ['git push -f origin feature/x', 'main'],
    ['git push --force-with-lease origin feature/x', 'main'],
    ['git push origin +feature/x', 'main'],
    ['git push --mirror backup', 'main'],
    ['git push --all origin', 'main'],
    ['git push origin release/2.4', 'main'],
    ['git push origin :production', 'main'],
    ['git push origin --delete main', 'main'],
    ['cd repo && GIT_SSH_COMMAND=ssh git -C ../app push origin master', 'main'],
    ['sudo -E git push heroku main', 'main'],
    ['kubectl apply -f k8s/deploy.yaml', 'production'],
    ['kubectl -n prod delete pod api-1', 'production'],
    ['kubectl rollout restart deployment/api', 'production'],
    ['terraform apply -auto-approve', 'production'],
    ['terraform -chdir=infra destroy', 'production'],
    ['helm upgrade --install api ./chart -f values.yaml', 'production'],
    ['vercel --prod', 'production'],
    ['npx vercel deploy --prod', 'production'],
    ['fly deploy --app api', 'production'],
    ['npm publish --access public', 'production'],
    ['pnpm --filter @acme/sdk publish', 'production'],
    ['gh release create v1.2.0 --notes "x"', 'production'],
    ['gh pr merge 42 --squash', 'production'],
    ['docker push ghcr.io/acme/api:1.2', 'production'],
    ['docker buildx build --push -t ghcr.io/acme/api .', 'production'],
    ['psql "$DATABASE_URL" -c "DROP TABLE users"', 'data'],
    ["echo 'TRUNCATE audit_log;' | psql prod", 'data'],
    ['sqlite3 app.db "DELETE FROM sessions"', 'data'],
    ['mysql -u root -e "drop database shop"', 'data'],
    ['psql <<SQL\nDELETE FROM users;\nSQL', 'data'],
    ['docker exec -it db psql -U app -c "drop table orders"', 'data'],
    ['npx prisma migrate deploy', 'data'],
    ['pnpm prisma migrate reset --force', 'data'],
    ['bin/rails db:migrate', 'data'],
    ['bundle exec rails db:migrate RAILS_ENV=production', 'data'],
    ['npx knex migrate:latest', 'data'],
    ['alembic -c alembic.ini upgrade head', 'data'],
    ['uv run alembic upgrade head', 'data'],
    ['python manage.py migrate', 'data'],
    ['redis-cli -h cache FLUSHALL', 'data'],
  ])('blocks %s (%s)', (cmd, test) => {
    expect(hit(cmd)?.test).toBe(test);
  });

  it.each([
    'git push origin feature/x',
    'git push -u origin feature/login',
    'git push --set-upstream origin fix/123',
    'git push origin feature/release/notes',
    'git push origin v1.2.0',
    'git push --dry-run origin main',
    'git push --tags',
    'git status && git log main..HEAD',
    'git pull origin main',
    'git checkout main && git merge feature/x',
    'git commit -m "fix: git push origin main no longer needed"',
    'echo "git push origin main"',
    'grep -rn "DELETE FROM" src/',
    'cat <<EOF > notes.md\nkubectl apply -f x.yaml\nEOF',
    'npm test',
    'npm run build && npm run publish-docs',
    'pnpm install',
    'kubectl get pods -n prod',
    'kubectl rollout status deployment/api',
    'terraform plan',
    'helm template api ./chart',
    'vercel',
    'vercel deploy',
    'docker build -t api .',
    'psql -c "SELECT * FROM users"',
    'npx prisma migrate dev',
    'npx prisma generate',
    'rails db:migrate:status',
    'knex migrate:status',
    'alembic history',
    'gh pr create --fill',
    'command -v kubectl',
  ])('allows %s', (cmd) => {
    expect(hit(cmd, 'feature/x')).toBeNull();
  });

  it('resolves bare pushes and HEAD against the current branch', () => {
    expect(hit('git push', 'main')?.label).toContain('main');
    expect(hit('git push origin', 'main')?.test).toBe('main');
    expect(hit('git push origin HEAD', 'release/9')?.test).toBe('main');
    expect(hit('git push', 'feature/x')).toBeNull();
    expect(hit('git push origin HEAD', null)).toBeNull();
    expect(hit('git push --tags', 'main')).toBeNull();
  });

  it('honours configured protected branches', () => {
    expect(
      matchProtectedOperation('git push origin prod', { protectedBranches: ['prod', 'main'] })?.test,
    ).toBe('main');
    expect(matchProtectedOperation('git push origin release/1', { protectedBranches: ['main'] })).toBeNull();
  });
});

describe('protected-op patterns: commits on a protected branch', () => {
  it.each([
    ['git commit -m "Fix" -m "AOC-Ticket: tkt_1"', 'main'],
    ['git commit --amend --no-edit', 'main'],
    ['git add -A && git commit -m x', 'main'],
    ['git commit -m x', 'master'],
    ['git commit -m x', 'production'],
    ['git commit -m x', 'release/2.4'],
    ['git cherry-pick 4f2a9c1', 'main'],
    ['git revert HEAD', 'main'],
    ['git am 0001-fix.patch', 'main'],
    ['git pull', 'main'],
    ['git pull --rebase origin main', 'main'],
    ['sudo -E git -c user.name=x commit -m x', 'main'],
    ['cd app && git commit -m x', 'main'],
    ['git commit -m x | cat', 'main'],
    // An option spelled as a value is not an option.
    ['git commit -m --dry-run', 'main'],
  ])('bounces %s on %s', (cmd, branch) => {
    expect(hit(cmd, branch)).toMatchObject({ test: 'main', label: expect.stringContaining(branch) });
  });

  it.each(['feature/x', 'uat/tkt_1', 'fix/main-menu', 'feature/release/notes', null])(
    'lets commits, cherry-picks, reverts, patches and pulls through on %s (a detached HEAD or an unknown branch is null)',
    (branch) => {
      for (const cmd of [
        'git commit -m x',
        'git cherry-pick 4f2a9c1',
        'git revert HEAD',
        'git am fix.patch',
        'git pull',
      ]) {
        expect(hit(cmd, branch), cmd).toBeNull();
      }
    },
  );

  it.each([
    'git status',
    'git diff --cached',
    'git log --oneline -5',
    'git add -A',
    'git switch -c uat/tkt_1',
    'git checkout -b feature/whisper',
    'git branch feature/y',
    'git fetch origin',
    'git rev-parse --short HEAD',
    'git push aoc HEAD:refs/heads/uat/tkt_1',
    'echo "git commit -m x"',
    'git log --grep "git pull"',
  ])('leaves %s alone while main is checked out', (cmd) => {
    expect(hit(cmd, 'main')).toBeNull();
  });

  it('needs a branch it knows to be protected, and honours configured protected branches', () => {
    expect(matchProtectedOperation('git commit -m x')).toBeNull();
    expect(matchProtectedOperation('git commit -m x', { currentBranch: () => null })).toBeNull();
    const trunk = { protectedBranches: ['trunk'] };
    expect(
      matchProtectedOperation('git commit -m x', { ...trunk, currentBranch: () => 'trunk' }),
    ).toMatchObject({
      test: 'main',
    });
    expect(matchProtectedOperation('git commit -m x', { ...trunk, currentBranch: () => 'main' })).toBeNull();
  });

  it('judges a commit in the checkout it lands in: git -C, and a cd before it', () => {
    const at = (cmd: string, checkouts: Record<string, string | null>) =>
      matchProtectedOperation(cmd, { currentBranch: (dir) => checkouts[dir ?? ''] ?? null });
    // The session works on a UAT branch; other checkouts of the project are on main.
    const onUat = { '': 'uat/tkt_1', '../app': 'main', 'repo/sub': 'main', '/srv/app': 'main' };
    expect(at('git commit -m x', onUat)).toBeNull();
    for (const cmd of [
      'git -C ../app commit -m x',
      'cd ../app && git commit -m x',
      'cd repo && git -C sub commit -m x',
      'cd /srv/app; git commit -m x',
    ]) {
      expect(at(cmd, onUat), cmd).toMatchObject({ test: 'main' });
    }
    // The session sits on main; the workspace beside it is a detached worktree.
    const onMain = { '': 'main', wt: null };
    expect(at('git commit -m x', onMain)).toMatchObject({ test: 'main' });
    for (const cmd of ['git -C wt commit -m x', 'cd wt && git commit -m x', 'cd ./wt && git commit -m x']) {
      expect(at(cmd, onMain), cmd).toBeNull();
    }
    // Back in the session's own checkout, or somewhere the line does not spell out: the branch it is on.
    for (const cmd of [
      'cd wt && cd .. && git commit -m x',
      'cd "$(git rev-parse --show-toplevel)" && git commit -m x',
      'cd && git commit -m x',
    ]) {
      expect(at(cmd, onMain), cmd).toMatchObject({ test: 'main' });
    }
  });

  it('follows a branch the same line moves the checkout to before it commits', () => {
    // The guard looks before the line runs: the checkout is still on main when `git switch -c` has not yet run.
    for (const cmd of [
      'git switch -c uat/tkt_1 && git add -A && git commit -m x',
      'git switch -c uat/tkt_1 || git switch uat/tkt_1; git commit -m x',
      'git checkout -b feature/whisper && git commit -m x',
      'git switch uat/tkt_1 && git commit -m x',
      'git switch --detach && git commit -m x',
    ]) {
      expect(hit(cmd, 'main'), cmd).toBeNull();
    }
    expect(hit('git switch -c release/9 && git commit -m x', 'feature/x')?.label).toContain('release/9');
    expect(hit('git switch main && git commit -m x', 'feature/x')).toMatchObject({ test: 'main' });
    // A path restore moves nothing, and another checkout's branch is not this one's.
    for (const cmd of [
      'git checkout -- . && git commit -m x',
      'git checkout main -- src/a.ts && git commit -m x',
      'git -C other switch -c uat/tkt_1 && git commit -m x',
    ]) {
      expect(hit(cmd, 'main'), cmd).toMatchObject({ test: 'main' });
    }
    expect(hit('git switch -c uat/tkt_1 && git checkout -- . && git commit -m x', 'main')).toBeNull();
    // A bare `checkout <x>` may be a branch: the line stops vouching for where it moved to, and the strict answer stands.
    expect(hit('git switch -c uat/tkt_1 && git checkout main && git commit -m x', 'main')).toMatchObject({
      test: 'main',
    });
  });
});

describe('protected-op guard in the policy (order 30)', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  const session = (mode: SessionInfo['mode'], cwd = '/nonexistent'): SessionInfo => ({
    sessionId: 'ses_guard',
    mode,
    claudeSessionId: null,
    ownerId: null,
    projectId: 'prj_guard',
    threadId: null,
    processType: 'feature-build',
    model: 'claude-opus-5-5',
    readOnly: false,
    lifecycle: 'running',
    liveness: 'working',
    cwd,
    ticketId: null,
    startedAt: '2026-10-09T00:00:00.000Z',
  });
  const ctx = (
    command: string,
    mode: SessionInfo['mode'] = 'managed',
    toolName = 'Bash',
    cwd = '/nonexistent',
  ): PreToolContext => ({
    session: session(mode, cwd),
    mode,
    toolName,
    toolInput: { command },
    cwd,
  });

  it('denies with a decision card (protected_operation, test, approve/reject, the command as context)', async () => {
    h = await harness();
    const r = h.t.rt.policy.evaluate(ctx('git push origin HEAD:main'));
    expect(r).toMatchObject({ decision: 'deny', guard: 'protected-op', blockReason: 'protected_operation' });
    expect(r.raiseDecision).toMatchObject({
      kind: 'protected_operation',
      test: 'main',
      options: [{ id: 'approve' }, { id: 'reject' }],
      context: 'git push origin HEAD:main',
      subjectType: 'session',
      subjectId: 'ses_guard',
      sessionId: 'ses_guard',
      projectId: 'prj_guard',
    });
    expect(h.t.rt.policy.evaluate(ctx('terraform apply')).raiseDecision?.test).toBe('production');
    expect(h.t.rt.policy.evaluate(ctx('npx prisma migrate deploy')).raiseDecision?.test).toBe('data');
  });

  it('allows ordinary work, other tools, and is advisory for observed sessions', async () => {
    h = await harness();
    expect(h.t.rt.policy.evaluate(ctx('git push origin feature/x')).decision).toBe('allow');
    expect(h.t.rt.policy.evaluate(ctx('git push origin main', 'managed', 'Read')).decision).toBe('allow');
    expect(h.t.rt.policy.evaluate(ctx('git push origin main', 'observed'))).toMatchObject({
      decision: 'allow',
      guard: 'protected-op',
    });
  });

  it('bounces a commit while main is checked out, and lets one on a UAT branch or a detached HEAD through', async () => {
    h = await harness();
    const repo = makeRepo();
    const evaluate = (cwd: string, command = 'git commit -m x') =>
      h.t.rt.policy.evaluate(ctx(command, 'managed', 'Bash', cwd));

    const bounced = evaluate(repo.dir);
    expect(bounced).toMatchObject({
      decision: 'deny',
      guard: 'protected-op',
      blockReason: 'protected_operation',
    });
    expect(bounced.raiseDecision).toMatchObject({
      kind: 'protected_operation',
      test: 'main',
      title: 'Protected operation: git commit (current branch main)',
      context: 'git commit -m x',
      sessionId: 'ses_guard',
      projectId: 'prj_guard',
    });

    // Branching is not the guard's business, and the commit that follows it in the same line lands on the new branch.
    expect(evaluate(repo.dir, 'git switch -c uat/x').decision).toBe('allow');
    expect(evaluate(repo.dir, 'git checkout -b uat/x').decision).toBe('allow');
    expect(evaluate(repo.dir, 'git switch -c uat/x && git add -A && git commit -m x').decision).toBe('allow');
    repo.git('switch', '-c', 'uat/x');
    expect(evaluate(repo.dir).decision).toBe('allow');
    repo.git('switch', '--detach');
    expect(evaluate(repo.dir).decision).toBe('allow');
    repo.git('switch', 'main');
    expect(evaluate(repo.dir).decision).toBe('deny');

    // The demo's workspaces: linked worktrees detached at main, beside the checkout that is on it.
    const workspace = join(tempDir('aoc-chg-ws-'), 'build');
    repo.git('worktree', 'add', '--quiet', '--detach', workspace, 'main');
    expect(evaluate(workspace).decision).toBe('allow');
    expect(evaluate(workspace, `git -C ${repo.dir} commit -m x`).decision).toBe('deny');
    expect(evaluate(workspace, `cd ${repo.dir} && git commit -m x`).decision).toBe('deny');
    expect(evaluate(repo.dir, `git -C ${workspace} commit -m x`).decision).toBe('allow');
    expect(evaluate(repo.dir, `cd ${workspace} && git commit -m x`).decision).toBe('allow');

    // Reading and staging are untouched on main; observed sessions are only advised.
    expect(evaluate(repo.dir, 'git status && git add -A && git log -1').decision).toBe('allow');
    expect(h.t.rt.policy.evaluate(ctx('git commit -m x', 'observed', 'Bash', repo.dir))).toMatchObject({
      decision: 'allow',
      guard: 'protected-op',
    });
  });
});
