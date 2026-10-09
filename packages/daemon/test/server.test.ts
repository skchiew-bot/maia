import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger, type AocModule } from '@aoc/kernel';
import { createIntakeModule } from '@aoc/mod-intake';
import { CONTENT_SECURITY_POLICY, JSON_BODY_LIMIT } from '../src/http';
import { createDefaultModules, MODULE_ORDER } from '../src/modules';
import { createAocServer } from '../src/server';
import { bootTestServer, removeTempDirs, tempDir, testConfig, type TestServer } from './helpers';

const servers: TestServer[] = [];
async function boot(opts: Parameters<typeof bootTestServer>[0] = {}): Promise<TestServer> {
  const t = await bootTestServer(opts);
  servers.push(t);
  return t;
}
afterEach(async () => {
  for (const t of servers.splice(0)) await t.close();
  removeTempDirs();
});

/** Echo routes that read the body the way module routes do. */
const echoModule: AocModule = {
  name: 'echo',
  routes(app) {
    app.post('/api/echo', async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }));
    app.post('/portal/api/intakes', async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }));
    app.post('/ingest/hook', async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }));
  },
};

function chunked(bytes: number, chunk = 64 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(ctl) {
      if (sent >= bytes) return ctl.close();
      const n = Math.min(chunk, bytes - sent);
      sent += n;
      ctl.enqueue(new Uint8Array(n));
    },
  });
}

describe('aocd HTTP surface', () => {
  it('GET /api/health reports head seq, uptime, modules and projection health', async () => {
    const t = await boot();
    t.user('builder');
    const res = await t.request('/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      status: 'ok',
      headSeq: t.aoc.runtime.store.head().seq,
      uptimeMs: expect.any(Number),
      modules: ['test-identity', 'aocd'],
      projections: { degraded: 0 },
    });
    expect(body.headSeq).toBeGreaterThan(0);
  });

  it('GET /api/health reports a missing malware scanner: degraded for everyone, details for operators only (G-12)', async () => {
    const t = await boot({
      modules: [createIntakeModule({ findBinary: () => null })],
      config: { intake: { scanner: 'clamav' } },
    });
    t.aoc.runtime.store.append({
      type: 'project.created',
      actor: { kind: 'system', id: 'test' },
      scope: { projectId: 'prj_1' },
      meta: { projectId: 'prj_1', slug: 'portal' },
      payload: { name: 'Portal' },
      source: 'system',
    });
    const form = new FormData();
    form.set('title', 'Upload fails');
    form.set('description', 'The page goes blank after the upload.');
    form.append(
      'files',
      new File([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])], 'a.png', {
        type: 'image/png',
      }),
    );
    const upload = await t.request('/portal/api/intakes', {
      method: 'POST',
      headers: t.user('requester').headers,
      body: form,
    });
    expect(upload.status).toBe(503);

    const health = async (headers: Record<string, string> = {}) =>
      (await (await t.request('/api/health', { headers })).json()) as { status: string; checks: unknown };
    expect(await health()).toMatchObject({ status: 'degraded', checks: { intake: { ok: false } } });
    expect(await health(t.user('requester').headers)).toMatchObject({ checks: { intake: { ok: false } } });
    expect((await health(t.user('requester').headers)).checks).toEqual({ intake: { ok: false } });
    expect((await health(t.user('builder').headers)).checks).toEqual({
      intake: {
        ok: false,
        mode: 'development',
        scanner: 'clamav',
        configured: 'clamav',
        avEngine: false,
        attachments: 'refused',
        reason: 'clamav_missing',
      },
    });
  });

  it('puts the security headers on every response and never emits CORS headers', async () => {
    const t = await boot({ modules: [echoModule] });
    const responses = [
      await t.request('/api/health', { headers: { origin: 'https://evil.example' } }),
      await t.request('/api/nope'),
      await t.request('/api/stream'),
      await t.request('/api/echo', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
      }),
      await t.request('/'),
    ];
    for (const res of responses) {
      expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('permissions-policy')).toContain('geolocation=()');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('x-request-id')).toMatch(/^[\w.-]+$/);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.headers.get('access-control-allow-methods')).toBeNull();
    }
    expect(CONTENT_SECURITY_POLICY).toContain(
      "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
    );
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    expect(responses[0]!.headers.get('cache-control')).toBe('no-store');
    expect(responses[0]!.headers.get('strict-transport-security')).toBeNull();
    expect(
      (await t.request('/api/health', { headers: { 'x-request-id': 'req-abc.1' } })).headers.get(
        'x-request-id',
      ),
    ).toBe('req-abc.1');
  });

  it('adds HSTS when the public URL is https', async () => {
    const t = await boot({ config: { publicUrl: 'https://aoc.example.com' } });
    expect((await t.request('/api/health')).headers.get('strict-transport-security')).toBe(
      'max-age=31536000',
    );
  });

  it('answers unknown API paths with the JSON error envelope', async () => {
    const t = await boot();
    const res = await t.request('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
    // Ingest paths authenticate first: an anonymous caller learns nothing about which routes exist.
    expect((await t.request('/ingest/nope', { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('limits JSON bodies to 1 MiB, declared or chunked', async () => {
    const t = await boot({ modules: [echoModule] });
    const sized = (n: number) => ({
      method: 'POST',
      body: new Uint8Array(n),
      headers: { 'content-length': String(n) },
    });
    const ok = await t.request('/api/echo', sized(JSON_BODY_LIMIT));
    expect(await ok.json()).toEqual({ bytes: JSON_BODY_LIMIT });

    const declared = await t.request('/api/echo', sized(JSON_BODY_LIMIT + 1));
    expect(declared.status).toBe(413);
    expect(declared.headers.get('connection')).toBe('close');
    expect(await declared.json()).toMatchObject({ error: { code: 'payload_too_large' } });
    const announced = await t.request('/api/echo', {
      method: 'POST',
      body: '{}',
      headers: { 'content-length': String(10 * 1024 ** 3) },
    });
    expect(announced.status).toBe(413);

    const streamed = await t.request('/ingest/hook', {
      method: 'POST',
      body: chunked(JSON_BODY_LIMIT + 10),
      duplex: 'half',
    } as RequestInit);
    expect(streamed.status).toBe(413);
    expect(streamed.headers.get('connection')).toBe('close');
    expect(await streamed.json()).toMatchObject({ error: { code: 'payload_too_large' } });
    expect(streamed.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);

    const smallStream = await t.request('/api/echo', {
      method: 'POST',
      body: chunked(1000),
      duplex: 'half',
    } as RequestInit);
    expect(await smallStream.json()).toEqual({ bytes: 1000 });
  });

  it('lets intake uploads through up to the video cap', async () => {
    const cap = 3 * 1024 * 1024;
    const t = await boot({ modules: [echoModule], config: { intake: { maxVideoBytes: cap } } });
    const n = 2 * 1024 * 1024;
    const big = await t.request('/portal/api/intakes', {
      method: 'POST',
      body: new Uint8Array(n),
      headers: { 'content-length': String(n) },
    });
    expect(await big.json()).toEqual({ bytes: n });
    const streamed = await t.request('/portal/api/intakes', {
      method: 'POST',
      body: chunked(n),
      duplex: 'half',
    } as RequestInit);
    expect(await streamed.json()).toEqual({ bytes: n });
    const tooBig = await t.request('/portal/api/intakes', {
      method: 'POST',
      body: chunked(cap + JSON_BODY_LIMIT + 1),
      duplex: 'half',
    } as RequestInit);
    expect(tooBig.status).toBe(413);
  });

  it('refuses cross-site writes that ride on the session cookie', async () => {
    const t = await boot({ modules: [echoModule] });
    const { token } = t.user('builder');
    const cookie = `aoc_session=${token}`;
    const evil = await t.request('/api/echo', {
      method: 'POST',
      body: '{}',
      headers: { cookie, origin: 'https://evil.example' },
    });
    expect(evil.status).toBe(403);
    expect(await evil.json()).toMatchObject({ error: { code: 'cross_site_request' } });
    const fetchMeta = await t.request('/api/echo', {
      method: 'POST',
      body: '{}',
      headers: { cookie, 'sec-fetch-site': 'cross-site' },
    });
    expect(fetchMeta.status).toBe(403);

    const sameOrigin = await t.request('/api/echo', {
      method: 'POST',
      body: '{}',
      headers: { cookie, origin: 'http://localhost' },
    });
    expect(sameOrigin.status).toBe(200);
    const publicOrigin = await t.request('/api/echo', {
      method: 'POST',
      body: '{}',
      headers: { cookie, origin: t.aoc.config.publicUrl },
    });
    expect(publicOrigin.status).toBe(200);
    const bearer = await t.request('/api/echo', {
      method: 'POST',
      body: '{}',
      headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' },
    });
    expect(bearer.status).toBe(200);
  });

  it('boots the production composition in module order and provides the llm service', async () => {
    const dir = tempDir();
    const aoc = await createAocServer(testConfig(dir), {
      log: silentLogger,
      masterKey: randomBytes(32),
      webDir: null,
    });
    try {
      const names = aoc.runtime.modules.map((m) => m.name);
      expect(names).toHaveLength(MODULE_ORDER.length + 1);
      MODULE_ORDER.forEach((name, i) => expect(names[i]).toContain(name));
      expect(names.at(-1)).toBe('aocd');
      expect(createDefaultModules()).toHaveLength(MODULE_ORDER.length);
      expect(aoc.runtime.services.has('llm')).toBe(true);
      expect(aoc.config.supervisor.hookCommand.length).toBeGreaterThan(0);
      const health = (await (await aoc.app.request('/api/health')).json()) as {
        status: string;
        modules: string[];
      };
      expect(health.modules).toEqual(names);
    } finally {
      await aoc.close();
      await aoc.close();
    }
  });
});
