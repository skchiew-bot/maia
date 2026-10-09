/**
 * Workspaces: where the demo's long-lived sessions edit files so that the checkout a promotion or rollback has to
 * fast-forward (a checked-out `main` with no uncommitted changes) is never dirty.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { initRepo } from '@aoc/kernel';
import { ensureWorkspace } from '../src/workspaces';
import { removeTree } from './helpers';

const root = mkdtempSync(join(tmpdir(), 'aoc-demo-workspaces-'));
afterAll(() => removeTree(root));

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  return { ok: r.status === 0, out: r.stdout.trim() };
};

describe('ensureWorkspace', () => {
  const repo = join(root, 'repo');
  initRepo(repo, { files: { 'src/a.ts': 'export const a = 1;\n' } });
  const dir = join(root, 'workspaces', 'prj_x', 'feature');

  it('makes a linked worktree detached at main, apart from the checkout', () => {
    expect(ensureWorkspace(repo, dir)).toBe(dir);
    expect(git(dir, 'rev-parse', 'HEAD').out).toBe(git(repo, 'rev-parse', 'main').out);
    expect(git(dir, 'symbolic-ref', '--quiet', 'HEAD').ok).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain').out).toContain(`worktree ${dir}`);
    expect(git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir').out).toBe(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir').out);
  });

  it('keeps the checkout clean while a session edits files in its workspace', () => {
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
    writeFileSync(join(dir, 'src/new.ts'), 'export {};\n');
    expect(git(dir, 'status', '--porcelain').out).not.toBe('');
    expect(git(repo, 'status', '--porcelain').out).toBe('');
    expect(git(repo, 'branch', '--show-current').out).toBe('main');
  });

  it('hands the next session a clean workspace at the current tip of main', () => {
    writeFileSync(join(repo, 'src/b.ts'), 'export const b = 1;\n');
    git(repo, 'add', '-A');
    expect(git(repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'main moves on').ok).toBe(true);

    expect(ensureWorkspace(repo, dir)).toBe(dir);
    expect(git(dir, 'status', '--porcelain').out).toBe('');
    expect(existsSync(join(dir, 'src/new.ts'))).toBe(false);
    expect(readFileSync(join(dir, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(git(dir, 'rev-parse', 'HEAD').out).toBe(git(repo, 'rev-parse', 'main').out);
  });

  it('replaces a workspace whose directory was deleted', () => {
    removeTree(dir);
    expect(ensureWorkspace(repo, dir)).toBe(dir);
    expect(git(dir, 'rev-parse', 'HEAD').out).toBe(git(repo, 'rev-parse', 'main').out);
  });
});
