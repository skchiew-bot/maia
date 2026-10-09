import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AocConfigSchema, type AocConfig } from '@aoc/contracts';
import { AocRuntime, FakeClock, sha256hex, silentLogger } from '@aoc/kernel';
import { ABSENT_HASH, createAuditModule, governedSources } from '../src';

let dir: string;
let config: AocConfig;
const key = randomBytes(32);
const f = (name: string) => join(dir, name);

/** One daemon start on the same data dir (the restart is the point of these tests). */
async function boot(): Promise<{
  changes: { key: string; versionHash: string; previousHash: string | null }[];
  stop(): Promise<void>;
}> {
  const rt = await AocRuntime.create({
    config,
    modules: [createAuditModule({ mappingFile: f('iso42001-mapping.json') })],
    clock: new FakeClock(),
    log: silentLogger,
    masterKey: key,
    dataDir: config.dataDir,
  });
  const seen = rt.store.list({ types: ['config.changed'] });
  return { changes: seen.map((e) => e.meta as never), stop: () => rt.stop() };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aoc-cfg-'));
  writeFileSync(f('process-types.json'), '{"version":"1","types":[]}');
  writeFileSync(f('rate-card.json'), '{"version":1,"rates":[]}');
  writeFileSync(f('iso42001-mapping.json'), '{"version":"draft"}');
  writeFileSync(f('profiles.json'), '{"profiles":{"deploy":{"env":{"TOKEN":"s3cret"}}}}', { mode: 0o600 });
  chmodSync(f('profiles.json'), 0o600);
  config = AocConfigSchema.parse({
    dataDir: f('data'),
    registryFile: f('process-types.json'),
    metering: { rateCardFile: f('rate-card.json') },
    supervisor: { credentialProfilesFile: f('profiles.json') },
    audit: { anchorRepoPath: f('anchor') },
    selfModification: { externalAuditLog: f('selfmod.log') },
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('governed config change detection', () => {
  it('records a baseline at first start and nothing on an unchanged restart', async () => {
    const first = await boot();
    expect(first.changes.map((c) => c.key).sort()).toEqual([
      'audit_config',
      'credential_profiles',
      'credits_config',
      'decisions_config',
      'iso42001_mapping',
      'liveness_config',
      'rate_card_file',
      'registry_file',
      'selfmod_config',
    ]);
    expect(first.changes.every((c) => c.previousHash === null && /^[0-9a-f]{64}$/.test(c.versionHash))).toBe(
      true,
    );
    expect(first.changes.find((c) => c.key === 'rate_card_file')!.versionHash).toBe(
      sha256hex('{"version":1,"rates":[]}'),
    );
    await first.stop();
    const second = await boot();
    expect(second.changes).toHaveLength(9);
    await second.stop();
  });

  it('appends config.changed with the previous hash when a governed file changes', async () => {
    await (await boot()).stop();
    writeFileSync(f('rate-card.json'), '{"version":2,"rates":[]}');
    writeFileSync(f('process-types.json'), '{"version":"2","types":[]}');
    const run = await boot();
    const latest = run.changes.slice(9);
    expect(latest).toEqual([
      {
        key: 'registry_file',
        versionHash: sha256hex('{"version":"2","types":[]}'),
        previousHash: sha256hex('{"version":"1","types":[]}'),
      },
      {
        key: 'rate_card_file',
        versionHash: sha256hex('{"version":2,"rates":[]}'),
        previousHash: sha256hex('{"version":1,"rates":[]}'),
      },
    ]);
    await run.stop();
  });

  it('tracks the credential profiles file by existence and mode only — never its content', async () => {
    await (await boot()).stop();
    writeFileSync(f('profiles.json'), '{"profiles":{"deploy":{"env":{"TOKEN":"rotated"}}}}');
    let run = await boot();
    expect(run.changes.slice(9)).toEqual([]);
    await run.stop();

    chmodSync(f('profiles.json'), 0o644);
    run = await boot();
    expect(run.changes.slice(9).map((c) => c.key)).toEqual(['credential_profiles']);
    await run.stop();

    rmSync(f('profiles.json'));
    run = await boot();
    expect(run.changes.slice(10)).toEqual([
      {
        key: 'credential_profiles',
        versionHash: expect.any(String),
        previousHash: run.changes[9]!.versionHash,
      },
    ]);
    await run.stop();
  });

  it('notices a removed mapping file, and a weakened self-modification boundary', async () => {
    await (await boot()).stop();
    rmSync(f('iso42001-mapping.json'));
    config = {
      ...config,
      selfModification: { ...config.selfModification, protectedPaths: ['packages/kernel/'] },
    };
    const run = await boot();
    const latest = run.changes.slice(9);
    expect(latest.map((c) => c.key)).toEqual(['iso42001_mapping', 'selfmod_config']);
    expect(latest[0]!.versionHash).toBe(ABSENT_HASH);
    await run.stop();
  });

  it('records turning on the sole-Approver fallback (decision policy is governed config)', async () => {
    await (await boot()).stop();
    config = { ...config, decisions: { ...config.decisions, soleApproverFallback: true } };
    const run = await boot();
    expect(run.changes.slice(9).map((c) => c.key)).toEqual(['decisions_config']);
    await run.stop();
  });

  it('does not track an absent optional mapping file until it appears', async () => {
    rmSync(f('iso42001-mapping.json'));
    const run = await boot();
    expect(run.changes.map((c) => c.key)).not.toContain('iso42001_mapping');
    await run.stop();
  });

  it('governs the mapping file the configuration names (compliance.mappingFile), wherever aocd was installed', () => {
    // A relocated aocd resolves its mapping to the packaged copy; the watch must hash that file, not a default path.
    writeFileSync(f('packaged-mapping.json'), '{"version":"packaged"}');
    const relocated = { ...config, compliance: { mappingFile: f('packaged-mapping.json') } };
    const source = (c: AocConfig, opts = {}) =>
      governedSources(c, opts).find((s) => s.key === 'iso42001_mapping')!;
    expect(source(relocated).current()).toBe(sha256hex('{"version":"packaged"}'));
    // The module option still wins (embedding, tests).
    expect(source(relocated, { mappingFile: f('iso42001-mapping.json') }).current()).toBe(
      sha256hex('{"version":"draft"}'),
    );
  });
});
