import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AocConfig } from '@aoc/contracts';
import { CHILD_ENV_ALLOWLIST, createTestRuntime, type AocModule, type TestRuntime } from '@aoc/kernel';
import {
  builtinScanner,
  clamavScanner,
  createIntakeModule,
  resolveScanner,
  type IntakeModuleOptions,
} from '../src';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-body'),
]);
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('');

const none = () => null;
type Intake = Pick<AocConfig['intake'], 'scanner' | 'requireScan'>;
const status = (intake: Intake, mode: AocConfig['mode'], find: (b: string) => string | null = none) =>
  resolveScanner(intake, mode, { find }).status;

describe('scanner resolution (§7, R4)', () => {
  it('auto prefers ClamAV when a client is installed, else falls back to the builtin heuristic', () => {
    const clamd = (b: string) => (b === 'clamdscan' ? '/opt/clamav/bin/clamdscan' : null);
    expect(status({ scanner: 'auto', requireScan: true }, 'production', clamd)).toEqual({
      configured: 'auto',
      active: 'clamdscan',
      avEngine: true,
      attachments: 'accepted',
      reason: null,
    });
    const clamscanOnly = (b: string) => (b === 'clamscan' ? '/usr/bin/clamscan' : null);
    expect(status({ scanner: 'auto', requireScan: true }, 'production', clamscanOnly).active).toBe(
      'clamscan',
    );
    expect(status({ scanner: 'auto', requireScan: true }, 'development')).toEqual({
      configured: 'auto',
      active: 'builtin',
      avEngine: false,
      attachments: 'accepted',
      reason: null,
    });
  });

  it('production with requireScan never accepts attachments on the heuristic alone', () => {
    for (const scanner of ['auto', 'builtin'] as const)
      expect(status({ scanner, requireScan: true }, 'production')).toMatchObject({
        active: 'builtin',
        avEngine: false,
        attachments: 'refused',
        reason: 'no_av_engine',
      });
    // An explicit opt-out of required scanning is honoured (and reported unhealthy by the module).
    expect(status({ scanner: 'builtin', requireScan: false }, 'production').attachments).toBe('accepted');
  });

  it('a configured ClamAV that is not installed, or no scanner at all, refuses attachments when a scan is required', () => {
    for (const mode of ['development', 'production'] as const)
      expect(status({ scanner: 'clamav', requireScan: true }, mode)).toEqual({
        configured: 'clamav',
        active: 'clamav',
        avEngine: false,
        attachments: 'refused',
        reason: 'clamav_missing',
      });
    expect(status({ scanner: 'none', requireScan: true }, 'development')).toMatchObject({
      attachments: 'refused',
      reason: 'scanning_disabled',
    });
    expect(status({ scanner: 'clamav', requireScan: false }, 'development').attachments).toBe('accepted');
  });

  it('an injected scanner is an AV engine unless it is the builtin heuristic or none', () => {
    const custom = (name: string, mode: AocConfig['mode']) =>
      resolveScanner({ scanner: 'auto', requireScan: true }, mode, {
        custom: { name, scan: () => ({ verdict: 'clean', scanner: name }) },
      }).status;
    expect(custom('vendor-av', 'production')).toMatchObject({
      configured: 'custom',
      avEngine: true,
      attachments: 'accepted',
    });
    expect(custom('builtin', 'development')).toMatchObject({ avEngine: false, attachments: 'accepted' });
    expect(custom('builtin', 'production')).toMatchObject({ attachments: 'refused', reason: 'no_av_engine' });
    expect(custom('none', 'development')).toMatchObject({
      attachments: 'refused',
      reason: 'scanning_disabled',
    });
  });
});

describe('intake uploads against the resolved scanner', () => {
  let t: TestRuntime;
  let mod: AocModule;
  const temps: string[] = [];
  afterEach(async () => {
    await t?.close();
    for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function setup(config: Record<string, unknown>, opts: IntakeModuleOptions) {
    mod = createIntakeModule(opts);
    t = await createTestRuntime({ modules: [mod], config });
    t.rt.store.append({
      type: 'project.created',
      actor: { kind: 'system', id: 'test' },
      scope: { projectId: 'prj_1' },
      meta: { projectId: 'prj_1', slug: 'claims-bot' },
      payload: { name: 'Claims Bot' },
      source: 'system',
    });
  }

  async function submit(files: Buffer[] = []) {
    const fd = new FormData();
    fd.set('title', 'Claim form crashes on upload');
    fd.set('description', 'When I upload a picture the page goes blank.');
    for (const [i, buf] of files.entries())
      fd.append('files', new File([buf], `shot-${i}.png`, { type: 'image/png' }));
    return t.app.request('/portal/api/intakes', {
      method: 'POST',
      headers: t.user('requester').headers,
      body: fd,
    });
  }

  /** A stand-in ClamAV client on a temp PATH: reports EICAR as infected (exit 1), anything else clean. */
  function fakeClamdscan(): string {
    const dir = mkdtempSync(join(tmpdir(), 'aoc-clamav-'));
    temps.push(dir);
    const bin = join(dir, 'clamdscan');
    writeFileSync(
      bin,
      '#!/bin/sh\nif grep -q EICAR-STANDARD-ANTIVIRUS-TEST-FILE; then echo "stdin: Eicar-Signature FOUND"; exit 1; fi\nexit 0\n',
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  it("scanner 'clamav' without the binary: attachments are refused 503, text-only intakes still work, health reports it", async () => {
    await setup({ intake: { scanner: 'clamav' } }, { findBinary: none });
    const refused = await submit([PNG]);
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('scanner_unavailable');
    expect(t.rt.store.list({ typePrefix: 'intake.' })).toHaveLength(0);
    expect((await submit()).status).toBe(201);
    expect(mod.health!()).toEqual({
      ok: false,
      detail: {
        mode: 'development',
        scanner: 'clamav',
        configured: 'clamav',
        avEngine: false,
        attachments: 'refused',
        reason: 'clamav_missing',
      },
    });
  });

  it('production mode refuses attachments when only the heuristic is available', async () => {
    await setup({ mode: 'production' }, { findBinary: none });
    expect((await submit([PNG])).status).toBe(503);
    expect(mod.health!()).toMatchObject({
      ok: false,
      detail: { scanner: 'builtin', reason: 'no_av_engine' },
    });
  });

  it('development keeps the heuristic, reported as healthy but not an AV engine', async () => {
    await setup({}, { findBinary: none });
    expect((await submit([PNG])).status).toBe(201);
    expect(mod.health!()).toMatchObject({
      ok: true,
      detail: { scanner: 'builtin', avEngine: false, attachments: 'accepted' },
    });
  });

  it('auto runs an installed ClamAV client on every attachment and records which one scanned it', async () => {
    const bin = fakeClamdscan();
    await setup({ mode: 'production' }, { findBinary: (b) => (b === 'clamdscan' ? bin : null) });
    expect(mod.health!()).toMatchObject({ ok: true, detail: { scanner: 'clamdscan', avEngine: true } });
    expect((await submit([Buffer.concat([PNG, Buffer.from(EICAR)])])).status).toBe(422);
    expect((await submit([PNG])).status).toBe(201);
    expect(t.rt.store.list({ types: ['intake.attachment_stored'] }).map((e) => e.meta)).toEqual([
      expect.objectContaining({ scan: 'clean', scanner: 'clamdscan' }),
    ]);
  });

  it('an injected builtin scanner follows the same production rule', async () => {
    await setup({ mode: 'production', intake: { requireScan: true } }, { scanner: builtinScanner });
    expect((await submit([PNG])).status).toBe(503);
  });
});

describe('the ClamAV client is an aocd child (G-46, O-13)', () => {
  it('starts with the kernel allowlist, never with aocd’s AOC_* secrets, API keys or tokens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aoc-clamav-env-'));
    const dump = join(dir, 'env.dump');
    const bin = join(dir, 'clamscan');
    writeFileSync(bin, `#!/bin/sh\nenv > '${dump}'\ncat > /dev/null\nexit 0\n`);
    chmodSync(bin, 0o755);
    const planted = {
      AOC_MASTER_KEY: 'kek-SECRET-1',
      AOC_BOOTSTRAP_TOKEN: 'bootstrap-SECRET-2',
      ANTHROPIC_API_KEY: 'sk-ant-SECRET-3',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-SECRET-4',
      GITHUB_TOKEN: 'ghp_SECRET-5',
      AWS_SECRET_ACCESS_KEY: 'aws-SECRET-6',
      DEPLOY_KEY: 'deploy-SECRET-7',
    };
    const saved = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
    Object.assign(process.env, planted);
    try {
      expect(clamavScanner(bin).scan(PNG)).toEqual({ verdict: 'clean', scanner: 'clamscan' });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const seen = readFileSync(dump, 'utf8');
    rmSync(dir, { recursive: true, force: true });
    const fromTheShell = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']); // what sh itself adds to its environment
    const names = seen
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => l.slice(0, l.indexOf('=')))
      .filter((k) => !fromTheShell.has(k));
    expect(names.filter((k) => !CHILD_ENV_ALLOWLIST.includes(k))).toEqual([]);
    expect(seen).not.toContain('SECRET');
    expect(names).toContain('PATH');
  });
});
