import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveDaemonEntry } from '../src/commands/serve';
import { aoc, tempDir } from './helpers/cli';

class FakeChild extends EventEmitter {
  readonly pid = 4242;
  readonly kills: string[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal ?? 'SIGTERM');
    return true;
  }
}

function bundleDir(): string {
  const dir = tempDir('aoc-bundle-');
  writeFileSync(join(dir, 'aocd.mjs'), '');
  return dir;
}

function devCheckout(): string {
  const root = tempDir('aoc-repo-');
  mkdirSync(join(root, 'packages', 'daemon', 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'cli', 'src'), { recursive: true });
  writeFileSync(join(root, 'packages', 'daemon', 'src', 'main.ts'), '');
  return root;
}

describe('resolveDaemonEntry', () => {
  it('prefers aocd.mjs next to the CLI bundle and keeps the caller cwd', () => {
    const dir = bundleDir();
    expect(resolveDaemonEntry({ argv1: join(dir, 'aoc.mjs'), cwd: '/srv', execPath: '/node' })).toEqual({
      kind: 'bundled',
      command: '/node',
      args: [join(dir, 'aocd.mjs')],
      cwd: '/srv',
    });
  });

  it('falls back to node --import tsx packages/daemon/src/main.ts in a dev checkout', () => {
    const root = devCheckout();
    const viaCli = resolveDaemonEntry({
      argv1: join(root, 'packages', 'cli', 'src', 'main.ts'),
      cwd: '/elsewhere',
      execPath: '/node',
    });
    expect(viaCli).toEqual({
      kind: 'dev',
      command: '/node',
      args: ['--import', 'tsx', join(root, 'packages', 'daemon', 'src', 'main.ts')],
      cwd: root,
    });
    expect(
      resolveDaemonEntry({ argv1: '', cwd: join(root, 'packages', 'cli'), execPath: '/node' })?.cwd,
    ).toBe(root);
  });

  it('returns null when neither exists', () => {
    expect(
      resolveDaemonEntry({ argv1: '/a/b/aoc.mjs', cwd: '/c', execPath: '/node' }, () => false),
    ).toBeNull();
  });
});

describe('aoc serve', () => {
  it('spawns aocd with an absolute --config in its own process group and forwards signals', async () => {
    const dir = bundleDir();
    const child = new FakeChild();
    const signals = new EventEmitter();
    const spawn = vi.fn(() => child);
    const run = aoc(['serve', '--config', 'aoc.json'], {
      argv1: join(dir, 'aoc.mjs'),
      cwd: '/srv',
      execPath: '/node',
      spawn,
      signals,
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    expect(spawn).toHaveBeenCalledWith({
      command: '/node',
      args: [join(dir, 'aocd.mjs'), '--config', '/srv/aoc.json'],
      cwd: '/srv',
      detached: true,
    });

    signals.emit('SIGINT');
    signals.emit('SIGTERM');
    expect(child.kills).toEqual(['SIGINT', 'SIGTERM']);
    child.emit('exit', 0, null);
    const r = await run;
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('Starting aocd (bundled)');
    expect(
      signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM') + signals.listenerCount('SIGHUP'),
    ).toBe(0);
  });

  it('exits with the daemon exit code, or 128+signal when it was killed', async () => {
    const dir = bundleDir();
    for (const [code, signal, expected] of [
      [3, null, 3],
      [null, 'SIGTERM', 143],
    ] as const) {
      const child = new FakeChild();
      const run = aoc(['serve'], { argv1: join(dir, 'aoc.mjs'), spawn: vi.fn(() => child) });
      await vi.waitFor(() => expect(child.listenerCount('exit')).toBe(1));
      child.emit('exit', code, signal);
      expect((await run).code).toBe(expected);
    }
  });

  it('reports a spawn failure (exit 1)', async () => {
    const child = new FakeChild();
    const run = aoc(['serve'], { argv1: join(bundleDir(), 'aoc.mjs'), spawn: vi.fn(() => child) });
    await vi.waitFor(() => expect(child.listenerCount('error')).toBe(1));
    child.emit('error', new Error('spawn EACCES'));
    const r = await run;
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('failed to start aocd: spawn EACCES');
  });

  it('exits 1 when aocd cannot be found, without spawning', async () => {
    const r = await aoc(['serve'], { cwd: tempDir() });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('cannot find aocd');
    expect(r.deps.spawn).not.toHaveBeenCalled();
  });
});
