import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveWebDir, webDirCandidates } from '../src/static';
import { bootTestServer, removeTempDirs, tempDir, type TestServer } from './helpers';

const INDEX =
  '<!doctype html><title>AOC console</title><script type="module" src="/assets/app-3fA9_x1Q.js"></script>';
const PORTAL = '<!doctype html><title>AOC portal</title>';

function webBuild(opts: { portalEntry?: boolean } = {}): string {
  const dir = tempDir('aocd-web-');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), INDEX);
  writeFileSync(join(dir, 'assets', 'app-3fA9_x1Q.js'), 'console.log("aoc")');
  writeFileSync(join(dir, 'assets', 'app-3fA9_x1Q.css'), 'body{}');
  writeFileSync(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(dir, '.env'), 'SECRET=1');
  if (opts.portalEntry) {
    mkdirSync(join(dir, 'portal'));
    writeFileSync(join(dir, 'portal', 'index.html'), PORTAL);
  }
  return dir;
}

const servers: TestServer[] = [];
async function boot(webDir: string | null): Promise<TestServer> {
  const t = await bootTestServer({ webDir });
  servers.push(t);
  return t;
}
afterEach(async () => {
  for (const t of servers.splice(0)) await t.close();
  removeTempDirs();
});

describe('static UI', () => {
  it('serves index.html for / and SPA deep links, including /portal/*, without caching it', async () => {
    const t = await boot(webBuild());
    for (const path of [
      '/',
      '/sessions/ses_01J9ZX',
      '/decisions?status=open',
      '/portal',
      '/portal/tickets/tkt_1',
    ]) {
      const res = await t.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(await res.text()).toBe(INDEX);
    }
  });

  it('prefers a separate portal entry for /portal/* when the build has one', async () => {
    const t = await boot(webBuild({ portalEntry: true }));
    expect(await (await t.request('/portal/tickets/tkt_1')).text()).toBe(PORTAL);
    expect(await (await t.request('/sessions')).text()).toBe(INDEX);
  });

  it('long-caches hashed assets, revalidates other files, and answers If-None-Match with 304', async () => {
    const t = await boot(webBuild());
    const js = await t.request('/assets/app-3fA9_x1Q.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await js.text()).toBe('console.log("aoc")');
    expect((await t.request('/assets/app-3fA9_x1Q.css')).headers.get('content-type')).toBe(
      'text/css; charset=utf-8',
    );

    const icon = await t.request('/favicon.svg');
    expect(icon.headers.get('content-type')).toBe('image/svg+xml');
    expect(icon.headers.get('cache-control')).toBe('no-cache');

    const etag = (await t.request('/')).headers.get('etag')!;
    const revalidated = await t.request('/', { headers: { 'if-none-match': etag } });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe('');

    const head = await t.request('/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('404s missing files and API paths instead of serving HTML, and never escapes the web root', async () => {
    const t = await boot(webBuild());
    expect((await t.request('/assets/missing-abc.js')).status).toBe(404);
    const api = await t.request('/api/unknown');
    expect(api.status).toBe(404);
    expect(api.headers.get('content-type')).toContain('application/json');
    expect((await t.request('/portal/api/unknown')).status).toBe(404);
    expect((await t.request('/.env')).status).toBe(404);
    expect((await t.request('/..%2f..%2f..%2fetc%2fpasswd')).status).toBe(404);
    expect((await t.request('/assets/..%2f..%2f.env')).status).toBe(404);
    for (const path of [
      '/..%2f..%2f..%2fetc%2fpasswd',
      '/assets/..%2f..%2f.env',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/%2e%2e%5c%2e%2e%5cetc%5cpasswd',
    ]) {
      const res = await t.request(path);
      const text = await res.text();
      expect(text, path).not.toContain('root:');
      expect(text, path).not.toContain('SECRET');
    }
  });

  it('explains that the UI is not built when there is no web build', async () => {
    const t = await boot(null);
    const res = await t.request('/sessions');
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('not built');
  });

  it('finds the UI beside a bundle (<dist>/web) before the checkout build', () => {
    const dist = tempDir('aocd-dist-');
    mkdirSync(join(dist, 'bin'));
    mkdirSync(join(dist, 'web'));
    writeFileSync(join(dist, 'web', 'index.html'), INDEX);
    const checkout = tempDir('aocd-repo-');
    mkdirSync(join(checkout, 'packages', 'web', 'dist'), { recursive: true });
    writeFileSync(join(checkout, 'packages', 'web', 'dist', 'index.html'), INDEX);
    expect(resolveWebDir(webDirCandidates(join(dist, 'bin'), checkout))).toBe(join(dist, 'web'));
    expect(resolveWebDir(webDirCandidates(join(checkout, 'packages', 'daemon', 'src'), checkout))).toBe(
      join(checkout, 'packages', 'web', 'dist'),
    );
    expect(resolveWebDir(webDirCandidates(join(checkout, 'packages', 'daemon', 'src'), null))).toBeNull();
  });
});
