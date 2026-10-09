import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AocConfigSchema, type MetaOf, type PayloadOf, type RegistryTypesResponse } from '@aoc/contracts';
import { AocRuntime, createTestRuntime, FakeClock, silentLogger } from '@aoc/kernel';
import { createRegistryModule, diffRegistries, loadRegistryFile } from '../src';
import { REGISTRY, start, writeRegistry } from './helpers';

const here = dirname(fileURLToPath(import.meta.url));

describe('fixed registry: load + validate (§2.2)', () => {
  it('accepts the shipped config/process-types.json', () => {
    const loaded = loadRegistryFile(resolve(here, '../../../config/process-types.json'));
    expect(loaded.types.size).toBe(8);
    expect(loaded.types.get('discovery')?.model).toBe('opus');
    expect(loaded.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lets every write-capable type with a credential profile commit and push through the gateway, and nothing wider', () => {
    const loaded = loadRegistryFile(resolve(here, '../../../config/process-types.json'));
    const writers = [...loaded.types.values()].filter((t) => !t.readOnly && t.credentialProfile);
    expect(writers.map((t) => t.id).sort()).toEqual(['bug-fix', 'discovery', 'docs', 'feature-build', 'migration', 'test-repair']);
    for (const t of writers) {
      expect(t.tools.allow, t.id).toEqual(expect.arrayContaining(['Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git push aoc:*)']));
      expect(t.tools.deny, t.id).toEqual(expect.arrayContaining(['Bash(git merge:*)', 'Bash(git rebase:*)', 'Bash(git reset:*)']));
      // a push to any other remote or form would bypass the gateway's ref allow-list
      expect(t.tools.allow?.filter((a) => /git push/.test(a)), t.id).toEqual(['Bash(git push aoc:*)']);
    }
  });

  it('fails startup with a clear error naming the file and every problem', async () => {
    const bad = writeRegistry({
      version: '1',
      types: [
        { id: 'disc', name: 'Disc', class: 'discovery', model: 'sonnet' },
        {
          id: 'tri',
          name: 'Triage',
          class: 'triage',
          model: 'opus',
          readOnly: true,
          credentialProfile: 'prod-deploy',
        },
        { id: 'Bad Id', name: 'x', class: 'execution', model: 'opus' },
      ],
    });
    const err = await createTestRuntime({
      modules: [createRegistryModule()],
      config: { registryFile: bad },
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain(`Invalid process-type registry ${bad}`);
    expect(msg).toMatch(/types\[0\]: disc: discovery-class types must run on opus/);
    expect(msg).toMatch(/types\[1\]: tri: read-only types must not receive credentials/);
    expect(msg).toMatch(/types\[2\]\.id/);
  });

  it('rejects malformed JSON, duplicate ids and a missing file', async () => {
    const boot = (registryFile: string) =>
      createTestRuntime({ modules: [createRegistryModule()], config: { registryFile } });
    await expect(boot(writeRegistry('{ "version": "1", "types": ['))).rejects.toThrow(/is not valid JSON/);
    await expect(
      boot(writeRegistry({ version: '1', types: [REGISTRY.types[1], REGISTRY.types[1]] })),
    ).rejects.toThrow(/duplicate process type id "feature-build"/);
    await expect(boot(join(tmpdir(), 'nope', 'process-types.json'))).rejects.toThrow(
      /cannot be read \(ENOENT\)/,
    );
  });

  it('serves the fixed list with the routed model; requesters are refused', async () => {
    const t = await start();
    const builder = t.user('builder');
    const res = await t.json<RegistryTypesResponse>('GET', '/api/registry/process-types', {
      headers: builder.headers,
    });
    expect(res.version).toBe('2026.10.1');
    expect(res.types.map((x) => x.id)).toEqual(REGISTRY.types.map((x) => x.id));
    expect(res.types.find((x) => x.id === 'feature-build')).toMatchObject({
      currentModel: 'opus',
      activePlaybookId: null,
      executionModel: 'sonnet',
    });
    expect(
      (await t.request('GET', '/api/registry/process-types', { headers: t.user('requester').headers }))
        .status,
    ).toBe(403);
    expect((await t.request('GET', '/api/registry/process-types')).status).toBe(401);
    const svc = t.rt.services.get('registry');
    expect(svc.listTypes()).toHaveLength(REGISTRY.types.length);
    expect(svc.getType('bug-triage')?.readOnly).toBe(true);
    expect(svc.getType('nope')).toBeNull();
    // Fixed for the life of the process: nobody can re-route a type in memory.
    const feature = svc.getType('feature-build')!;
    expect(() => Object.assign(feature, { model: 'haiku' })).toThrow(TypeError);
    expect(svc.modelFor('feature-build')).toBe('opus');
    await t.close();
  });
});

describe('fixed registry: audited change detection', () => {
  it('appends registry.changed on first start and whenever the file content changes between runtimes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'aoc-reg-data-'));
    const regDir = mkdtempSync(join(tmpdir(), 'aoc-reg-file-'));
    const masterKey = randomBytes(32);
    const boot = async () => {
      const config = AocConfigSchema.parse({ dataDir, registryFile: join(regDir, 'process-types.json') });
      return AocRuntime.create({
        config,
        modules: [createRegistryModule()],
        clock: new FakeClock('2026-10-09T02:00:00.000Z'),
        log: silentLogger,
        masterKey,
        dataDir,
      });
    };
    const changes = (rt: AocRuntime) => rt.store.list({ types: ['registry.changed'] });

    writeRegistry(REGISTRY, regDir);
    let rt = await boot();
    const [first] = changes(rt);
    const m1 = first!.meta as MetaOf<'registry.changed'>;
    expect(m1).toMatchObject({ previousHash: null, typeCount: 5 });
    expect((rt.store.readPayload(first!) as PayloadOf<'registry.changed'>).diffSummary).toMatch(
      /^initial registry 2026\.10\.1: 5 process types/,
    );
    await rt.stop();

    // Same content, different formatting: no audited change.
    writeRegistry(JSON.stringify(REGISTRY), regDir);
    rt = await boot();
    expect(changes(rt)).toHaveLength(1);
    await rt.stop();

    // Edit the fixed list: one new audited change, linked to the previous hash, with a readable diff.
    const edited = {
      version: '2026.10.2',
      types: [
        ...REGISTRY.types
          .filter((x) => x.id !== 'bug-fix')
          .map((x) =>
            x.id === 'test-repair' ? { ...x, executionModel: 'sonnet', description: 'changed text' } : x,
          ),
        { id: 'docs', name: 'Documentation', class: 'execution', model: 'sonnet', executionModel: 'haiku' },
      ],
    };
    writeRegistry(edited, regDir);
    rt = await boot();
    const all = changes(rt);
    expect(all).toHaveLength(2);
    const m2 = all[1]!.meta as MetaOf<'registry.changed'>;
    expect(m2.previousHash).toBe(m1.versionHash);
    expect(m2.versionHash).not.toBe(m1.versionHash);
    const diff = (rt.store.readPayload(all[1]!) as PayloadOf<'registry.changed'>).diffSummary;
    expect(diff).toContain('version 2026.10.1 → 2026.10.2');
    expect(diff).toContain('added: docs');
    expect(diff).toContain('removed: bug-fix');
    expect(diff).toContain('test-repair: description changed, executionModel haiku→sonnet');
    expect(rt.store.verifyChain().ok).toBe(true);
    await rt.stop();

    // Reverting is a change too (back to the original hash).
    writeRegistry(REGISTRY, regDir);
    rt = await boot();
    expect(changes(rt).map((e) => (e.meta as MetaOf<'registry.changed'>).versionHash)).toEqual([
      m1.versionHash,
      m2.versionHash,
      m1.versionHash,
    ]);
    await rt.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(regDir, { recursive: true, force: true });
  });

  it('summarises formatting-only / default-only edits honestly', () => {
    const a = loadRegistryFile(writeRegistry(REGISTRY)).registry;
    const b = loadRegistryFile(
      writeRegistry({ ...REGISTRY, types: REGISTRY.types.map((x) => ({ ...x, requiresPlan: true })) }),
    ).registry;
    expect(diffRegistries(a, b, true)).toBe('no effective change (formatting or explicit defaults only)');
    expect(diffRegistries(null, b, true)).toMatch(/^previous registry snapshot unavailable/);
  });
});
