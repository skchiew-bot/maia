/** Isolated runs for code AOC does not trust (G-04): no credential, and the session user when one is configured. */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IsolatedRunInput, SupervisorService } from '@aoc/contracts';
import { lookupOsUser } from '../src/isolation';
import { handOver, isolatedRunEnv } from '../src/sandbox';
import { FAKE_CLAUDE, createHarness, type Harness } from './harness';

const SANDBOX = 'nobody';
const sandboxUnavailable = ((): string | null => {
  if (process.getuid?.() !== 0) return 'aocd must be root to run commands as another user';
  try {
    lookupOsUser(SANDBOX);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
})();

/** Session isolation (G-01) with `nobody` as the session user, in directories it can reach. */
function isolatedSupervisor(dir: string) {
  return {
    sessionUser: SANDBOX,
    sessionHomesDir: join(dir, 'homes'),
    workspacesDir: join(dir, 'work'),
    hookCommand: [process.execPath, FAKE_CLAUDE],
    mcpCommand: [process.execPath, FAKE_CLAUDE],
  };
}

let h: Harness | null = null;
const temps: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
afterEach(async () => {
  await h?.close();
  h = null;
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A stand-in for an acceptance test: reports who it runs as and which writes and reads it gets away with. */
const probe = (attempts: Record<string, string>) => `
const fs = require('fs');
const r = { uid: process.getuid(), home: process.env.HOME ?? null, credential: process.env.DEPLOY_TOKEN ?? null };
const tryIt = (k, fn) => { try { fn(); r[k] = 'ok'; } catch (e) { r[k] = e.code; } };
tryIt('inside', () => fs.writeFileSync('inside.txt', 'ok'));
${Object.entries(attempts)
  .map(([k, path]) =>
    k.startsWith('read')
      ? `tryIt(${JSON.stringify(k)}, () => fs.readFileSync(${JSON.stringify(path)}));`
      : `tryIt(${JSON.stringify(k)}, () => fs.writeFileSync(${JSON.stringify(path)}, 'x'));`,
  )
  .join('\n')}
console.log(JSON.stringify(r));
`;

describe('isolated runs: environment and sandbox (G-04)', () => {
  it('builds the environment from scratch: caller variables over inherited ones, the credential profile over both', () => {
    expect(
      isolatedRunEnv({
        source: { PATH: '/bin', HOME: '/home/aoc', ANTHROPIC_API_KEY: 'k', HTTPS_PROXY: 'http://proxy:3128' },
        timezone: 'Asia/Kuala_Lumpur',
        extra: { HOME: '/nonexistent', PATH: '/usr/bin:/bin' },
        credentials: { GIT_SSH_COMMAND: 'ssh -i /etc/aoc/keys/promotion', AOC_INGEST_TOKEN: 'never' },
      }),
    ).toEqual({
      PATH: '/usr/bin:/bin',
      HTTPS_PROXY: 'http://proxy:3128',
      TZ: 'Asia/Kuala_Lumpur',
      HOME: '/nonexistent',
      GIT_SSH_COMMAND: 'ssh -i /etc/aoc/keys/promotion',
    });
  });

  it('redacts the credential profile’s values from what a credentialed run prints', async () => {
    h = await createHarness();
    const r = await h.sup.runIsolated({
      cwd: h.root,
      command: [process.execPath, '-e', 'console.log("token " + process.env.DEPLOY_TOKEN); console.error(process.env.DEPLOY_TOKEN)'],
      credentialProfile: 'uat-deploy',
      timeoutMs: 5000,
    });
    expect(r).toMatchObject({ exitCode: 0, stdout: 'token [redacted]\n', stderr: '[redacted]\n' });
  });

  it('never gives a sandboxed run a credential profile', async () => {
    h = await createHarness();
    await expect(
      h.sup.runIsolated({
        cwd: h.root,
        command: [process.execPath, '-e', '1'],
        credentialProfile: 'uat-deploy',
        timeoutMs: 5000,
        sandbox: {},
      }),
    ).rejects.toThrow(/never gets a credential profile/);
  });

  it('takes the sandbox option through the SupervisorService contract, which is what mod-change calls', async () => {
    h = await createHarness();
    const service: SupervisorService = h.sup;
    const input: IsolatedRunInput = {
      cwd: h.root,
      command: [process.execPath, '-e', probe({})],
      credentialProfile: null,
      timeoutMs: 5000,
      env: { HOME: '/nonexistent' },
      sandbox: { handOver: [h.root] },
    };
    expect(JSON.parse((await service.runIsolated(input)).stdout)).toMatchObject({ credential: null });
    await expect(service.runIsolated({ ...input, credentialProfile: 'uat-deploy', sandbox: {} })).rejects.toThrow(
      /never gets a credential profile/,
    );
  });

  it('without session isolation, a sandboxed run stays with aocd’s user and holds no credential', async () => {
    h = await createHarness();
    const r = await h.sup.runIsolated({
      cwd: h.root,
      command: [process.execPath, '-e', probe({})],
      credentialProfile: null,
      timeoutMs: 5000,
      env: { HOME: '/nonexistent' },
      sandbox: { handOver: [h.root] },
    });
    expect(JSON.parse(r.stdout)).toMatchObject({ uid: process.getuid?.(), credential: null, home: '/nonexistent' });
    expect(statSync(h.root).uid).toBe(process.getuid?.());
  });

  it.skipIf(sandboxUnavailable !== null)(
    `as the session user, an acceptance test writes only what was handed over${sandboxUnavailable ? ` (skipped: ${sandboxUnavailable})` : ''}`,
    async () => {
      const reachable = temp('aoc-iso-');
      chmodSync(reachable, 0o755);
      h = await createHarness({ supervisor: isolatedSupervisor(reachable) });
      const user = lookupOsUser(SANDBOX);
      const root = temp('aoc-verify-');
      const checkout = join(root, 'checkout');
      mkdirSync(checkout);
      mkdirSync(join(root, 'home'));
      writeFileSync(join(checkout, 'state.txt'), 'good\n');
      const outside = temp('aoc-outside-');
      chmodSync(outside, 0o755);
      const secret = join(outside, 'secret.txt');
      writeFileSync(secret, 'root only\n');
      chmodSync(secret, 0o600);
      symlinkSync(secret, join(checkout, 'link'));

      const r = await h.sup.runIsolated({
        cwd: checkout,
        command: [
          process.execPath,
          '-e',
          probe({
            outside: join(outside, 'written.txt'),
            project: join(h.root, 'planted.txt'),
            readProfiles: h.t.config.supervisor.credentialProfilesFile!,
            readThroughLink: 'link',
          }),
        ],
        credentialProfile: null,
        timeoutMs: 10_000,
        env: { HOME: join(root, 'home') },
        sandbox: { handOver: [root] },
      });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({
        uid: user.uid,
        home: join(root, 'home'),
        credential: null,
        inside: 'ok',
        outside: 'EACCES',
        project: 'EACCES',
        readProfiles: 'EACCES',
        readThroughLink: 'EACCES',
      });
      // The hand-over re-owned the link itself, never its target.
      expect(statSync(secret).uid).toBe(0);
      expect(statSync(join(checkout, 'state.txt')).uid).toBe(user.uid);
    },
  );

  it('refuses to hand over a link or a relative path', () => {
    const dir = temp('aoc-handover-');
    symlinkSync('/etc', join(dir, 'etc-link'));
    const someone = { name: SANDBOX, uid: 65534, gid: 65534 };
    expect(() => handOver([join(dir, 'etc-link')], someone)).toThrow(/not a link/);
    expect(() => handOver(['relative/dir'], someone)).toThrow(/absolute/);
  });
});
