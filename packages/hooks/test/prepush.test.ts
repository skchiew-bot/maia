import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluatePrePush, gitHooksDir, installGitHooks, isProtectedRef } from '../src';
import { tmp } from './helpers';

const SHA_A = '1111111111111111111111111111111111111111';
const SHA_B = '2222222222222222222222222222222222222222';
const ZERO = '0000000000000000000000000000000000000000';

const pushLine = (remoteRef: string, localRef = 'refs/heads/work', localSha = SHA_A) =>
  `${localRef} ${localSha} ${remoteRef} ${SHA_B}`;

function prePush(stdin: string, env: Record<string, string> = {}) {
  const r = spawnSync('sh', [join(gitHooksDir(), 'pre-push'), 'origin', 'git@example.com:acme/app.git'], {
    input: stdin,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
  });
  return { code: r.status, stderr: r.stderr };
}

describe('git/pre-push', () => {
  it('refuses a push to main without AOC_SUPERVISOR_PUSH', () => {
    const r = prePush(`${pushLine('refs/heads/main')}\n`);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("AOC: refusing to push to protected ref 'refs/heads/main'");
  });

  it('allows feature branches', () => {
    expect(prePush(`${pushLine('refs/heads/feature/login')}\n`)).toEqual({ code: 0, stderr: '' });
  });

  it('allows protected refs only for the supervisor promotion executor', () => {
    expect(prePush(`${pushLine('refs/heads/main')}\n`, { AOC_SUPERVISOR_PUSH: '1' }).code).toBe(0);
    expect(prePush(`${pushLine('refs/heads/main')}\n`, { AOC_SUPERVISOR_PUSH: 'true' }).code).toBe(1);
  });

  it('refuses deleting a protected branch and any multi-ref push that includes one', () => {
    expect(prePush(`${pushLine('refs/heads/release/2.0', '(delete)', ZERO)}\n`).code).toBe(1);
    const mixed = prePush(`${pushLine('refs/heads/feature/a')}\n${pushLine('refs/heads/production')}\n`);
    expect(mixed.code).toBe(1);
    expect(mixed.stderr).toContain("'refs/heads/production'");
    expect(mixed.stderr).not.toContain('feature/a');
  });

  it('reads a final line without a trailing newline, and an empty push is fine', () => {
    expect(prePush(pushLine('refs/heads/master')).code).toBe(1);
    expect(prePush('').code).toBe(0);
  });

  it('agrees with isProtectedRef / evaluatePrePush on every ref', () => {
    const refs = [
      'refs/heads/main',
      'refs/heads/master',
      'refs/heads/production',
      'refs/heads/release/1.2',
      'refs/heads/release/x/y',
      'refs/heads/feature/main',
      'refs/heads/mainline',
      'refs/heads/main-hotfix',
      'refs/heads/releases/1',
      'refs/heads/production-copy',
      'refs/heads/Main',
      'refs/tags/main',
      'refs/tags/release/1.0',
      'main',
      'release/3',
      'feature',
    ];
    for (const ref of refs) {
      const script = prePush(`${pushLine(ref)}\n`).code === 1;
      expect({ ref, blocked: script }).toEqual({ ref, blocked: isProtectedRef(ref) });
      expect(evaluatePrePush(`${pushLine(ref)}\n`, {}).allowed, ref).toBe(!script);
    }
    expect(refs.filter(isProtectedRef)).toEqual([
      'refs/heads/main',
      'refs/heads/master',
      'refs/heads/production',
      'refs/heads/release/1.2',
      'refs/heads/release/x/y',
      'main',
      'release/3',
    ]);
  });

  it('evaluatePrePush lists the protected refs and honours the supervisor override', () => {
    const stdin = [
      pushLine('refs/heads/main'),
      pushLine('refs/heads/feat'),
      pushLine('refs/heads/main'),
      '',
    ].join('\n');
    expect(evaluatePrePush(stdin, {})).toEqual({ allowed: false, protectedRefs: ['refs/heads/main'] });
    expect(evaluatePrePush(stdin, { AOC_SUPERVISOR_PUSH: '1' })).toEqual({
      allowed: true,
      protectedRefs: ['refs/heads/main'],
    });
  });
});

describe('git/prepare-commit-msg', () => {
  function prepare(message: string, env: Record<string, string>, source = 'message'): string {
    const dir = tmp();
    const file = join(dir, 'COMMIT_EDITMSG');
    writeFileSync(file, message);
    const r = spawnSync('sh', [join(gitHooksDir(), 'prepare-commit-msg'), file, source], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: dir, ...env },
    });
    expect(r.status, r.stderr).toBe(0);
    return readFileSync(file, 'utf8');
  }
  const managed = { AOC_SESSION_ID: 'ses_01JABC', AOC_CHANGE_ID: 'chg_01JDEF', AOC_TICKET_ID: 'tkt_01JGHI' };

  it('appends session, change and ticket trailers in managed workspaces, once', () => {
    const once = prepare('Fix the parser\n\nExplains why.\n', managed);
    expect(once).toBe(
      'Fix the parser\n\nExplains why.\n\nAOC-Session: ses_01JABC\nAOC-Change: chg_01JDEF\nAOC-Ticket: tkt_01JGHI\n',
    );
    expect(prepare(once, managed)).toBe(once);
  });

  it('joins an existing trailer block and only adds the trailers whose env is set', () => {
    const msg = 'Add retry\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n';
    expect(prepare(msg, { AOC_SESSION_ID: 'ses_1' })).toBe(`${msg}AOC-Session: ses_1\n`);
  });

  it('records a second session when amending another session’s commit', () => {
    const amended = prepare('Fix\n\nAOC-Session: ses_OLD\n', { AOC_SESSION_ID: 'ses_NEW' }, 'commit');
    expect(amended).toBe('Fix\n\nAOC-Session: ses_OLD\nAOC-Session: ses_NEW\n');
  });

  it('flattens multi-line values into a single trailer line', () => {
    expect(prepare('Fix\n', { AOC_SESSION_ID: 'ses_1\nInjected: yes' })).toBe(
      'Fix\n\nAOC-Session: ses_1Injected: yes\n',
    );
  });

  it('leaves messages alone outside managed sessions and when the message is still empty', () => {
    expect(prepare('Fix the parser\n', {})).toBe('Fix the parser\n');
    const template = '\n# Please enter the commit message for your changes.\n#\n';
    expect(prepare(template, managed, '')).toBe(template);
  });
});

describe('installGitHooks', () => {
  it('copies both hooks executable', () => {
    const dir = join(tmp(), '.git', 'hooks');
    const installed = installGitHooks(dir);
    expect(installed.map((p) => p.slice(dir.length + 1))).toEqual(['pre-push', 'prepare-commit-msg']);
    for (const p of installed) {
      expect(statSync(p).mode & 0o777).toBe(0o755);
      expect(readFileSync(p, 'utf8')).toBe(
        readFileSync(join(gitHooksDir(), p.slice(dir.length + 1)), 'utf8'),
      );
    }
  });
});
