import { afterEach, describe, expect, it } from 'vitest';
import type { PreToolContext, SessionInfo } from '@aoc/contracts';
import { matchProtectedOperation, splitShell } from '../src';
import { harness, type Harness } from './helpers';

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

describe('protected-op guard in the policy (order 30)', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  const session = (mode: SessionInfo['mode']): SessionInfo => ({
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
    cwd: '/nonexistent',
    ticketId: null,
    startedAt: '2026-10-09T00:00:00.000Z',
  });
  const ctx = (
    command: string,
    mode: SessionInfo['mode'] = 'managed',
    toolName = 'Bash',
  ): PreToolContext => ({
    session: session(mode),
    mode,
    toolName,
    toolInput: { command },
    cwd: '/nonexistent',
  });

  it('denies with a decision card (agent_decision, test, approve/reject, the command as context)', async () => {
    h = await harness();
    const r = h.t.rt.policy.evaluate(ctx('git push origin HEAD:main'));
    expect(r).toMatchObject({ decision: 'deny', guard: 'protected-op', blockReason: 'protected_operation' });
    expect(r.raiseDecision).toMatchObject({
      kind: 'agent_decision',
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
});
