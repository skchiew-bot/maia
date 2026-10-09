import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveTsxImport } from '../src/paths';
import { removeTempDirs, repoRoot, tempDir } from './helpers';

afterEach(() => removeTempDirs());

describe('aocd entry (src/main.ts)', () => {
  it('listens, serves health, and shuts down cleanly on SIGTERM without the node:sqlite warning', async () => {
    const cwd = tempDir();
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('AOC_')),
    );
    Object.assign(env, {
      AOC_HOST: '127.0.0.1',
      AOC_PORT: '0',
      AOC_DATA_DIR: join(cwd, 'data'),
      AOC_LOG_LEVEL: 'warn',
    });
    const child = spawn(
      process.execPath,
      ['--import', resolveTsxImport(repoRoot), join(repoRoot, 'packages', 'daemon', 'src', 'main.ts')],
      {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`aocd did not start:\n${stdout}\n${stderr}`)),
          15_000,
        );
        child.stdout.on('data', (d: Buffer) => {
          stdout += d.toString();
          const m = stdout.match(/aocd listening on (http:\/\/\S+)/);
          if (m) {
            clearTimeout(timer);
            resolve(m[1]!);
          }
        });
        void exited.then((code) => reject(new Error(`aocd exited early (${code}):\n${stdout}\n${stderr}`)));
      });
      const health = (await (await fetch(`${url}/api/health`)).json()) as {
        status: string;
        modules: string[];
      };
      expect(health.modules.at(-1)).toBe('aocd');
      expect(stdout).toContain(`data     ${join(cwd, 'data')}`);
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(stderr).not.toContain('ExperimentalWarning');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});
