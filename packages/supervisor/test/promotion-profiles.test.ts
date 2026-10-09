/**
 * The credential profile of the push to a protected remote (promotion, rollback, break-glass) is aocd's own: it must
 * exist (or production refuses to start: an Approver's passkey must not be spent on a push that cannot run), and no
 * process type may name it (R1; docs/runbooks/credential-isolation.md §4 items 7 and 9).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AocConfigSchema, ProcessRegistrySchema, type AocConfig, type ProcessType } from '@aoc/contracts';
import { createLogger } from '@aoc/kernel';
import {
  PromotionProfileError,
  checkPromotionProfiles,
  promotionProfileProblems,
  type PromotionProfileDeps,
} from '../src/promotion-profiles';
import { createHarness, type Harness } from './harness';

const temps: string[] = [];
let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A credential profiles file defining each of `names` (empty env: nothing here is a credential). */
function profilesFile(...names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'aoc-promo-profiles-'));
  temps.push(dir);
  const file = join(dir, 'credential-profiles.json');
  writeFileSync(file, JSON.stringify({ profiles: Object.fromEntries(names.map((n) => [n, { env: {} }])) }), {
    mode: 0o600,
  });
  return file;
}

const type = (id: string, credentialProfile: string | null): ProcessType =>
  ProcessRegistrySchema.parse({
    version: 'test',
    types: [{ id, name: id, class: 'execution', model: 'sonnet', credentialProfile }],
  }).types[0]!;

const config = (o: Record<string, unknown> = {}): AocConfig => AocConfigSchema.parse(o);
const deps = (defined: string[] | Error, types: ProcessType[] | null = []): PromotionProfileDeps => ({
  definedProfiles: () => {
    if (defined instanceof Error) throw defined;
    return defined;
  },
  types: () => types,
});
const withFile = (o: Record<string, unknown> = {}) =>
  config({ ...o, supervisor: { credentialProfilesFile: '/etc/aoc/credential-profiles.json' } });

describe('promotionProfileProblems', () => {
  it('finds nothing when every promotion profile is defined and no process type names one', () => {
    const c = withFile({ promotion: { projects: { prj_web: { promoteCredentialProfile: 'web-promote' } } } });
    expect(
      promotionProfileProblems(c, deps(['prod-promote', 'web-promote', 'git-feature'], [type('bug-fix', 'git-feature'), type('docs', null)])),
    ).toEqual([]);
  });

  it('names the configuration key of every profile the credential profiles file does not define', () => {
    const c = withFile({
      promotion: {
        promoteCredentialProfile: 'release-bot',
        projects: {
          prj_web: { promoteCredentialProfile: 'web-promote' },
          prj_api: { promoteCredentialProfile: 'web-promote' },
          prj_ops: {},
        },
      },
    });
    const problems = promotionProfileProblems(c, deps(['web-promote']));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"release-bot" (promotion.promoteCredentialProfile)');
    expect(problems[0]).toContain('does not define it');
    expect(problems[0]).toContain('docs/runbooks/credential-isolation.md');

    const web = promotionProfileProblems(c, deps(['release-bot']));
    expect(web).toHaveLength(1);
    expect(web[0]).toContain(
      '"web-promote" (promotion.projects.prj_web.promoteCredentialProfile, promotion.projects.prj_api.promoteCredentialProfile)',
    );
  });

  it('says why when there is no credential profiles file, or it cannot be read', () => {
    expect(promotionProfileProblems(config(), deps([]))).toEqual([
      expect.stringContaining('supervisor.credentialProfilesFile is not configured'),
    ]);
    expect(
      promotionProfileProblems(withFile(), deps(new Error('credential profiles file is unreadable (ENOENT)'))),
    ).toEqual([expect.stringContaining('credential profiles file is unreadable (ENOENT)')]);
  });

  it('finds a process type that names the default or a project’s promotion profile, and ignores the rest', () => {
    const c = withFile({ promotion: { projects: { prj_web: { promoteCredentialProfile: 'web-promote' } } } });
    const problems = promotionProfileProblems(
      c,
      deps(['prod-promote', 'web-promote'], [
        type('deployer', 'prod-promote'),
        type('web-deployer', 'web-promote'),
        type('builder', 'git-feature'),
        type('docs', null),
      ]),
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('process type "deployer" names the promotion credential profile "prod-promote"');
    expect(problems[1]).toContain('process type "web-deployer" names the promotion credential profile "web-promote"');
    expect(promotionProfileProblems(c, deps(['prod-promote', 'web-promote'], null))).toEqual([]);
  });
});

describe('checkPromotionProfiles', () => {
  const logged = () => {
    const lines: string[] = [];
    return { lines, log: createLogger({ level: 'warn', sink: (l) => lines.push(l) }) };
  };

  it('refuses to start in production, saying everything that is wrong', () => {
    const { lines, log } = logged();
    const c = withFile({ mode: 'production' });
    const bad = deps(['git-feature'], [type('deployer', 'prod-promote')]);
    expect(() => checkPromotionProfiles(c, bad, log)).toThrow(PromotionProfileError);
    expect(() => checkPromotionProfiles(c, bad, log)).toThrow(/production mode: promotion credential profile "prod-promote"/);
    expect(() => checkPromotionProfiles(c, bad, log)).toThrow(/process type "deployer"/);
    expect(lines).toEqual([]);
  });

  it('only warns in development, and starts', () => {
    const { lines, log } = logged();
    checkPromotionProfiles(withFile(), deps(['git-feature'], [type('deployer', 'prod-promote')]), log);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('promotion credential profile \\"prod-promote\\"');
    expect(lines[1]).toContain('process type \\"deployer\\"');
  });

  it('is silent when nothing is wrong, in either mode', () => {
    const { lines, log } = logged();
    for (const mode of ['development', 'production'])
      checkPromotionProfiles(withFile({ mode }), deps(['prod-promote']), log);
    expect(lines).toEqual([]);
  });
});

describe('the supervisor and the promotion profiles', () => {
  const DEPLOYER = [type('deployer', 'prod-promote')];
  const logged = () => {
    const lines: string[] = [];
    return { lines, log: createLogger({ level: 'warn', sink: (l) => lines.push(l) }) };
  };

  it('starts in development, saying that the promotion profile is not defined', async () => {
    const { lines, log } = logged();
    h = await createHarness({ log });
    expect(lines.filter((l) => l.includes('promotion credential profile'))).toHaveLength(1);
    expect(lines.join('\n')).toContain('prod-promote');
    const id = await h.launch('still works');
    await h.waitLifecycle(id, 'idle');
  });

  it('stays quiet when the credential profiles file defines it', async () => {
    const { lines, log } = logged();
    h = await createHarness({ log, supervisor: { credentialProfilesFile: profilesFile('prod-promote', 'git-feature') } });
    expect(lines.filter((l) => l.includes('promotion'))).toEqual([]);
  });

  it('never launches a process type that names the promotion profile, even one added to the registry after start', async () => {
    const { lines, log } = logged();
    h = await createHarness({
      log,
      supervisor: { credentialProfilesFile: profilesFile('prod-promote', 'git-feature', 'uat-deploy') },
    });
    expect(lines.filter((l) => l.includes('promotion'))).toEqual([]);
    h.registry.listTypes().push(...DEPLOYER);

    await expect(h.launch('promote everything', { processType: 'deployer' })).rejects.toMatchObject({
      status: 500,
      code: 'promotion_profile_forbidden',
    });
    expect(h.events('session.launch_requested')).toEqual([]);
    expect(h.calls()).toEqual([]);
    // Other types are unaffected.
    const id = await h.launch('a build');
    await h.waitLifecycle(id, 'idle');
  });

  it('applies to a project’s own promotion profile as well, and warns at start about a type that names it', async () => {
    const { lines, log } = logged();
    h = await createHarness({
      log,
      types: [type('web-deployer', 'web-promote')],
      config: { promotion: { projects: { prj_demo: { promoteCredentialProfile: 'web-promote' } } } },
      supervisor: { credentialProfilesFile: profilesFile('prod-promote', 'web-promote', 'git-feature') },
    });
    expect(lines.filter((l) => l.includes('process type \\"web-deployer\\"'))).toHaveLength(1);
    await expect(h.launch('go', { processType: 'web-deployer' })).rejects.toMatchObject({
      code: 'promotion_profile_forbidden',
    });
    expect(h.calls()).toEqual([]);
  });
});
