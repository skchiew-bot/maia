import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveTsxImport } from '../src/paths';
import { removeTempDirs, repoRoot, tempDir } from './helpers';

afterEach(() => removeTempDirs());

/** Runs the real aocd entry with `config` until it exits (a production start that is refused must exit 1). */
function runAocd(
  cwd: string,
  config: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  writeFileSync(join(cwd, 'aoc.config.json'), JSON.stringify(config));
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('AOC_')),
  );
  Object.assign(env, { AOC_LOG_LEVEL: 'warn', ...extraEnv });
  const child = spawn(
    process.execPath,
    ['--import', resolveTsxImport(repoRoot), join(repoRoot, 'packages', 'daemon', 'src', 'main.ts')],
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  return new Promise((resolve, reject) => {
    // Generous: tsx compiles the whole daemon on start, which is slow on a loaded machine.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`aocd did not exit:\n${stdout}\n${stderr}`));
    }, 75_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('production mode refuses unsafe secrets handling (R6, O-1, O-13)', () => {
  const production = (cwd: string, kek: string) => ({
    mode: 'production',
    dataDir: 'data',
    port: 0,
    keys: { masterKeyFile: kek },
    registryFile: join(repoRoot, 'config', 'process-types.json'),
    metering: { rateCardFile: join(repoRoot, 'config', 'rate-card.json') },
    fx: { extractor: 'fake' },
    supervisor: { workspacesDir: join(cwd, 'workspaces') },
  });

  it('refuses a KEK from AOC_MASTER_KEY even beside a valid key file, without echoing it', async () => {
    const cwd = tempDir();
    const key = randomBytes(32).toString('hex');
    const kek = join(cwd, 'kek');
    writeFileSync(kek, `${key}\n`, { mode: 0o400 });
    const r = await runAocd(cwd, production(cwd, kek), { AOC_MASTER_KEY: key });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('a KEK from AOC_MASTER_KEY is refused');
    expect(r.stdout + r.stderr).not.toContain(key);
    expect(r.stdout).not.toContain('aocd listening');
  }, 90_000);

  it('refuses to run managed sessions as the aocd OS user', async () => {
    const cwd = tempDir();
    const kek = join(cwd, 'kek');
    writeFileSync(kek, `${randomBytes(32).toString('hex')}\n`, { mode: 0o400 });
    const r = await runAocd(cwd, production(cwd, kek));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('needs supervisor.sessionUser');
  }, 90_000);
});
