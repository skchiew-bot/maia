import { afterEach, describe, expect, it } from 'vitest';
import { createChangeModule, type ChangeEngine } from '@aoc/mod-change';
import { bootTestServer, removeTempDirs, type TestServer } from './helpers';

const servers: TestServer[] = [];
afterEach(async () => {
  for (const t of servers.splice(0)) await t.close();
  removeTempDirs();
});

/** The composition builds the change module with its defaults: the configuration is the only way to tell it more. */
async function changeEngine(config: Record<string, unknown>): Promise<ChangeEngine> {
  const t = await bootTestServer({ modules: [createChangeModule()], config });
  servers.push(t);
  return t.aoc.runtime.services.get('change') as ChangeEngine;
}

describe('the promotion section of aocd’s configuration reaches the change module', () => {
  it('gives each project its credential profile, and the rest the section’s default', async () => {
    const engine = await changeEngine({
      promotion: {
        promoteCredentialProfile: 'release-bot',
        projects: { prj_web: { promotionRemote: '/srv/git/web.git', promoteCredentialProfile: 'web-promote' } },
      },
    });
    expect(engine.promoteProfileOf('prj_web')).toBe('web-promote');
    expect(engine.promoteProfileOf('prj_api')).toBe('release-bot');
  });

  it('keeps prod-promote for everyone when the section is absent', async () => {
    const engine = await changeEngine({});
    expect(engine.promoteProfileOf('prj_web')).toBe('prod-promote');
  });
});
