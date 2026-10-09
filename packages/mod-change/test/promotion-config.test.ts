import { afterEach, describe, expect, it } from 'vitest';
import type { BreakglassDTO } from '@aoc/contracts';
import type { Logger } from '@aoc/kernel';
import {
  PASSKEY,
  addGuardedRemote,
  harness,
  makeRepo,
  remoteHead,
  setPromotionRemote,
  type Harness,
  type TestRepo,
} from './helpers';

const WEB = 'prj_web';
const API = 'prj_api';

/** A project repository with a hotfix branch ahead of main, and a bare remote nobody configured as yet. */
function project(): { repo: TestRepo; remote: string; hotfix: string } {
  const repo = makeRepo({ 'app.ts': 'export const v = 1;\n' });
  repo.git('checkout', '-q', '-b', 'hotfix/x');
  const hotfix = repo.commit('hotfix: fix it', { 'app.ts': 'export const v = 2;\n' });
  repo.git('checkout', '-q', 'main');
  return { repo, remote: addGuardedRemote(repo), hotfix };
}

describe('promotion settings from aocd’s configuration', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  /** Break-glass is the shortest road to a credentialed push: invoke it and approve it with a passkey. */
  async function promote(projectId: string): Promise<BreakglassDTO> {
    const bg = await h.t.json<BreakglassDTO>('POST', '/api/breakglass', {
      headers: h.builder.headers,
      body: { projectId, ref: 'hotfix/x', justification: 'Checkout is down: needs the hotfix' },
      expect: 202,
    });
    await h.t.decisions!.resolve(bg.decisionId, { optionId: 'approve', ...PASSKEY }, h.approver.user);
    await h.settle();
    return h.t.json<BreakglassDTO>('GET', `/api/breakglass/${bg.breakglassId}`, { headers: h.approver.headers });
  }
  const pushes = () => h.sup.gitCalls().filter((c) => c.args[0] === 'push');

  it('pushes to the remote the configuration names, with the project’s profile, over the service clone’s origin; a project with no entry keeps both defaults', async () => {
    const web = project();
    const api = project();
    const decoy = project(); // what an operator once set as the web clone's origin
    h = await harness({
      config: {
        promotion: {
          promoteCredentialProfile: 'release-bot',
          projects: { [WEB]: { promotionRemote: web.remote, promoteCredentialProfile: 'web-promote' } },
        },
      },
    });
    h.sup.profiles['web-promote'] = { TEST_PROMOTION_TOKEN: 'web' };
    h.sup.profiles['release-bot'] = { TEST_PROMOTION_TOKEN: 'default' };
    h.addProject(WEB, web.repo.dir);
    h.addProject(API, api.repo.dir);
    setPromotionRemote(h, WEB, decoy.remote);
    setPromotionRemote(h, API, api.remote);

    expect(await promote(WEB)).toMatchObject({ status: 'approved', promotion: { status: 'completed' } });
    expect(await promote(API)).toMatchObject({ status: 'approved', promotion: { status: 'completed' } });

    expect(remoteHead(web.remote)).toBe(web.hotfix);
    expect(remoteHead(decoy.remote)).not.toBe(decoy.hotfix); // the clone's origin is only the fallback
    expect(remoteHead(api.remote)).toBe(api.hotfix);
    expect(pushes().map((c) => [c.profile, c.args.at(-2), c.args.at(-1)])).toEqual([
      ['web-promote', web.remote, `${web.hotfix}:refs/heads/main`],
      ['release-bot', api.remote, `${api.hotfix}:refs/heads/main`],
    ]);
    expect(h.mod.engine.promoteProfileOf(WEB)).toBe('web-promote');
    expect(h.mod.engine.promoteProfileOf(API)).toBe('release-bot');
  });

  it('keeps the prod-promote default when the configuration says nothing, and lets the module’s own options win (embedding)', async () => {
    const web = project();
    const other = project();
    h = await harness({
      change: {
        promoteCredentialProfile: 'embedded-default',
        projects: { [WEB]: { promotionRemote: web.remote, promoteCredentialProfile: 'embedded-web' } },
      },
      config: {
        promotion: { projects: { [WEB]: { promotionRemote: other.remote, promoteCredentialProfile: 'configured-web' } } },
      },
    });
    h.sup.profiles['embedded-web'] = { TEST_PROMOTION_TOKEN: 'embedded' };
    h.addProject(WEB, web.repo.dir);
    expect(await promote(WEB)).toMatchObject({ promotion: { status: 'completed' } });
    expect(remoteHead(web.remote)).toBe(web.hotfix);
    expect(remoteHead(other.remote)).not.toBe(other.hotfix);
    expect(pushes().map((c) => c.profile)).toEqual(['embedded-web']);
    expect(h.mod.engine.promoteProfileOf('prj_unlisted')).toBe('embedded-default');

    await h.close();
    h = await harness();
    expect(h.mod.engine.promoteProfileOf(WEB)).toBe('prod-promote');
  });

  it('says so at start when the configuration names a project that does not exist, and not when it does', async () => {
    const warnings: { msg: string; fields?: Record<string, unknown> }[] = [];
    const log: Logger = {
      debug() {},
      info() {},
      warn: (msg, fields) => void warnings.push({ msg, fields }),
      error() {},
      child: () => log,
    };
    h = await harness({
      log,
      config: {
        promotion: {
          projects: { [WEB]: { promotionRemote: '/srv/git/web.git' }, prj_typo: { promotionRemote: '/srv/git/x.git' } },
        },
      },
    });
    // The harness starts before any project is created: both are unknown at that moment.
    expect(warnings.filter((w) => /promotion configuration/.test(w.msg)).map((w) => w.fields?.projectId)).toEqual([
      WEB,
      'prj_typo',
    ]);
    h.addProject(WEB, project().repo.dir);
    expect(h.mod.engine.unknownPromotionProjects()).toEqual(['prj_typo']);
  });
});
