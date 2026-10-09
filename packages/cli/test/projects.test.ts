import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aoc, loggedInHome } from './helpers/cli';
import { startFakeDaemon, type FakeDaemon } from './helpers/fake-daemon';
import { project, timeline } from './helpers/fixtures';

let d: FakeDaemon;
let home: string;
beforeEach(async () => {
  d = await startFakeDaemon();
  home = loggedInHome(d.url);
});
afterEach(() => d.stop());

describe('aoc projects', () => {
  it('lists projects with a progress bar and numbers', async () => {
    d.on('GET', '/api/projects', { json: [project()] });
    const r = await aoc(['projects'], { homeDir: home });
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n')[1]).toMatch(
      /^prj_1\s+Alpha\s+\[#####-----\] 45\.0%\s+3\/8\s+2\s+1\s+5m ago\s+\/repos\/alpha$/,
    );
  });

  it('suggests creating one when there are none', async () => {
    d.on('GET', '/api/projects', { json: { projects: [] } });
    expect((await aoc(['projects'], { homeDir: home })).stdout).toContain('aoc project create');
  });
});

describe('aoc project create', () => {
  it('POSTs the name and the absolute repo path', async () => {
    d.on('POST', '/api/projects', { status: 201, json: project({ projectId: 'prj_9', name: 'Beta' }) });
    const r = await aoc(['project', 'create', '--name', 'Beta', '--repo', '../beta'], {
      homeDir: home,
      cwd: '/src/alpha',
    });
    expect(r.code).toBe(0);
    expect(d.calls('POST', '/api/projects')[0]!.body).toEqual({ name: 'Beta', repoPath: '/src/beta' });
    expect(r.stdout).toContain('Created project Beta (prj_9) → /src/beta');
  });

  it('expands ~ in the repo path', async () => {
    d.on('POST', '/api/projects', { json: { projectId: 'prj_9' } });
    await aoc(['project', 'create', '--name', 'B', '--repo', '~/code/b'], { homeDir: home });
    expect((d.calls('POST', '/api/projects')[0]!.body as { repoPath: string }).repoPath).toBe(
      `${home}/code/b`,
    );
  });

  it('requires --name and --repo (exit 2)', async () => {
    expect((await aoc(['project', 'create', '--name', 'B'], { homeDir: home })).code).toBe(2);
    expect(d.requests).toHaveLength(0);
  });
});

describe('aoc timeline', () => {
  it('renders the stacked per-phase bar from GET /api/projects/:id/timeline', async () => {
    d.on('GET', '/api/projects/prj_1/timeline', { json: timeline() });
    const r = await aoc(['timeline', 'prj_1', '--width', '20'], { homeDir: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('[AAAA|BBBB............] 50.0%');
    expect(r.stdout).toMatch(/B Build\s+\[##=\.{7}\]\s+25\.0%\s+4\/16/);
  });

  it('--json passes the timeline through', async () => {
    d.on('GET', '/api/projects/prj_1/timeline', { json: timeline() });
    expect(JSON.parse((await aoc(['timeline', 'prj_1', '--json'], { homeDir: home })).stdout)).toEqual(
      timeline(),
    );
  });
});
