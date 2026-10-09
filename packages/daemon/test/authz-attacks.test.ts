/**
 * Abuse scenarios on top of the route matrix (spec §3, §6): a person acting on someone else's resources, a page
 * on another site riding a signed-in browser, an agent writing as another agent, and credentials that should be dead.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identityServiceOf } from '@aoc/mod-identity';
import { bootProd, seedSession, type Prod, type SeededSession } from './support/prod';

let p: Prod;
const SYSTEM = { kind: 'system', id: 'test' } as const;

beforeAll(async () => {
  p = await bootProd();
});
afterAll(async () => p?.close());

/** Let reactors finish, so the log head only moves because of the request under test. */
const settle = () => p.aoc.runtime.drain();

const json = async (res: Response): Promise<any> => {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
};

describe('own resources', () => {
  it('a person may list and revoke their own tokens, and nobody else may touch anyone\'s', async () => {
    const mallory = p.user('builder', 'Mallory');
    const victim = p.user('builder', 'Victim');
    const approver = p.user('approver', 'Boss');

    expect((await p.request('GET', `/api/users/${mallory.user.id}/tokens`, { headers: mallory.headers })).status).toBe(200);
    expect((await p.request('GET', `/api/users/${victim.user.id}/tokens`, { headers: mallory.headers })).status).toBe(403);
    expect((await p.request('GET', `/api/passkeys?userId=${victim.user.id}`, { headers: mallory.headers })).status).toBe(403);
    expect((await p.request('GET', `/api/passkeys`, { headers: mallory.headers })).status).toBe(200);

    // Revoking somebody else's token is refused, and the token keeps working.
    expect((await p.request('DELETE', `/api/tokens/${victim.tokenId}`, { headers: mallory.headers })).status).toBe(403);
    expect((await p.request('GET', '/api/auth/me', { headers: victim.headers })).status).toBe(200);
    // An unknown token id must not look different from somebody else's to a non-admin.
    expect((await p.request('DELETE', '/api/tokens/tok_does_not_exist', { headers: mallory.headers })).status).toBe(403);
    // Revoking one's own is allowed and takes effect at once.
    expect((await p.request('DELETE', `/api/tokens/${mallory.tokenId}`, { headers: mallory.headers })).status).toBe(200);
    expect((await p.request('GET', '/api/auth/me', { headers: mallory.headers })).status).toBe(401);
    // The Approver can revoke anyone's.
    expect((await p.request('DELETE', `/api/tokens/${victim.tokenId}`, { headers: approver.headers })).status).toBe(200);
    expect((await p.request('GET', '/api/auth/me', { headers: victim.headers })).status).toBe(401);
  });

  it('a Builder cannot make themselves, or anyone, an Approver, nor mint tokens for others', async () => {
    const b = p.user('builder', 'Climber');
    const other = p.user('builder', 'Other');
    const patch = (id: string, body: object) => p.request('PATCH', `/api/users/${id}`, { headers: b.headers, body });
    expect((await patch(b.user.id, { role: 'approver' })).status).toBe(403);
    expect((await patch(other.user.id, { active: false })).status).toBe(403);
    expect((await p.request('POST', `/api/users/${other.user.id}/tokens`, { headers: b.headers, body: {} })).status).toBe(403);
    expect((await p.request('POST', '/api/users', { headers: b.headers, body: { role: 'approver', name: 'Sock' } })).status).toBe(403);
    expect(identityServiceOf(p.aoc.runtime.services).getUser(b.user.id)!.role).toBe('builder');
  });
});

describe('dead credentials authenticate nothing', () => {
  it('revoked tokens, logged-out cookies and deactivated users get 401 everywhere', async () => {
    const svc = identityServiceOf(p.aoc.runtime.services);
    const approver = p.user('approver', 'Admin');
    const backup = p.user('approver', 'Second');
    void backup;
    const leaver = p.user('builder', 'Leaver');
    const cookie = p.ids.cookieHeaders(leaver.token);
    expect((await p.request('GET', '/api/auth/me', { headers: cookie })).status).toBe(200);

    // Logging out kills the cookie session, not the personal token behind it.
    const out = await p.request('POST', '/api/auth/logout', { headers: { ...cookie, origin: 'http://aoc.test' } });
    expect(out.status).toBe(200);
    expect((await p.request('GET', '/api/auth/me', { headers: cookie })).status).toBe(401);
    expect((await p.request('GET', '/api/auth/me', { headers: leaver.headers })).status).toBe(200);

    // Deactivating the person ends every credential of theirs, including cookie sessions opened earlier.
    const cookie2 = p.ids.cookieHeaders(leaver.token);
    expect((await p.request('GET', '/api/auth/me', { headers: cookie2 })).status).toBe(200);
    const res = await p.request('PATCH', `/api/users/${leaver.user.id}`, { headers: approver.headers, body: { active: false } });
    expect(res.status).toBe(200);
    for (const headers of [leaver.headers, cookie2]) expect((await p.request('GET', '/api/auth/me', { headers })).status).toBe(401);
    expect(svc.getUser(leaver.user.id)!.active).toBe(false);
    // ... and reactivating them revives none of the old credentials.
    await p.request('PATCH', `/api/users/${leaver.user.id}`, { headers: approver.headers, body: { active: true } });
    for (const headers of [leaver.headers, cookie2]) expect((await p.request('GET', '/api/auth/me', { headers })).status).toBe(401);
  });

  it('an expired token is dead the moment its time is up', async () => {
    const svc = identityServiceOf(p.aoc.runtime.services);
    const who = p.user('builder', 'Short lived');
    const issued = svc.issueUserToken(who.user.id, { expiresInDays: 1 }, SYSTEM);
    const headers = { authorization: `Bearer ${issued.token}` };
    expect((await p.request('GET', '/api/auth/me', { headers })).status).toBe(200);
    p.clock.advance(24 * 3_600_000 - 1);
    expect((await p.request('GET', '/api/auth/me', { headers })).status).toBe(200);
    p.clock.advance(2);
    expect((await p.request('GET', '/api/auth/me', { headers })).status).toBe(401);
  });

  it('credential kinds do not cross surfaces: ingest tokens never open /api, cookies and user tokens never open /ingest', async () => {
    const approver = p.user('approver', 'Cross');
    const cookie = p.ids.cookieHeaders(approver.token);
    const ingest = [p.ids.ingestHeaders('ses_cross'), p.ids.ingestHeaders('observer'), p.ids.ingestHeaders('system')];
    for (const headers of ingest) {
      for (const path of ['/api/auth/me', '/api/users', '/api/audit/events', '/api/stream', '/portal/api/tickets']) {
        expect((await p.request('GET', path, { headers })).status, `${path} with an ingest token`).toBe(401);
      }
      // ... also when it is smuggled in as a cookie.
      const token = headers.authorization!.slice(7);
      expect((await p.request('GET', '/api/auth/me', { headers: { cookie: `aoc_session=${token}` } })).status).toBe(401);
    }
    for (const headers of [approver.headers, cookie]) {
      for (const path of ['/ingest/heartbeat', '/ingest/usage', '/ingest/mcp/get_status']) {
        expect((await p.request('POST', path, { headers, body: {} })).status, `${path} with a person's credential`).toBe(401);
      }
    }
  });
});

describe('cross-site request forgery (§6)', () => {
  const UNSAFE = (p0: Prod) =>
    p0.aoc.app.routes
      .filter((r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) && !r.path.startsWith('/ingest/'))
      .map((r) => ({ method: r.method, path: r.path.replace(':attachmentId', 'att_x').replace(':date', '2026-10-01').replace(':field', 'impact').replace(':id', 'x_missing') }));

  it('a cookie-authenticated write from another origin is refused on every state-changing route, before it does anything', async () => {
    const approver = p.user('approver', 'Signed in');
    const cookie = p.ids.cookieHeaders(approver.token);
    const routes = UNSAFE(p);
    expect(routes.length).toBeGreaterThan(40);
    const before = p.store.head().seq;
    const hostile: Record<string, string>[] = [
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { origin: 'http://aoc.test.evil.example' },
      { origin: 'http://aoc.test:8443' },
      { 'sec-fetch-site': 'cross-site' },
      { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    ];
    const allowedCodes = new Set(['bad_origin', 'cross_site_request']);
    const leaks: string[] = [];
    for (const r of routes) {
      for (const extra of hostile) {
        const res = await p.request(r.method, r.path, { headers: { ...cookie, ...extra }, body: {} });
        const body = await json(res);
        if (res.status !== 403 || !allowedCodes.has(body?.error?.code)) {
          leaks.push(`${r.method} ${r.path} with ${JSON.stringify(extra)} → ${res.status} ${body?.error?.code ?? ''}`);
        }
      }
    }
    expect(leaks).toEqual([]);
    expect(p.store.head().seq, 'a refused request must not write anything').toBe(before);
  });

  it('the same writes pass from our own origin, and bearer tokens (not ambient credentials) are not origin-checked', async () => {
    const approver = p.user('approver', 'Same origin');
    const cookie = p.ids.cookieHeaders(approver.token);
    for (const origin of ['http://aoc.test', undefined]) {
      const res = await p.request('POST', '/api/users', { headers: { ...cookie, ...(origin ? { origin } : {}) }, body: {} });
      expect(res.status, `origin ${origin}`).toBe(422);
    }
    const bearer = await p.request('POST', '/api/users', { headers: { ...approver.headers, origin: 'https://evil.example' }, body: {} });
    expect(bearer.status).toBe(422);
  });

  it('a login from another origin is refused too (no login CSRF)', async () => {
    const who = p.user('builder', 'Victim');
    for (const origin of ['https://evil.example', 'null']) {
      const res = await p.request('POST', '/api/auth/login', { headers: { origin }, body: { token: who.token } });
      expect(res.status, origin).toBe(403);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    const ok = await p.request('POST', '/api/auth/login', { headers: { origin: 'http://aoc.test' }, body: { token: who.token } });
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/aoc_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
  });
});

describe('an agent can write only as itself (§2, §3)', () => {
  const iso = () => p.clock.iso();
  const bodies = (t: SeededSession, n: number): [string, unknown][] => [
    ['/ingest/hook', { mode: 'managed', aocSessionId: t.sessionId, hook: { session_id: t.claudeSessionId, hook_event_name: 'UserPromptSubmit', cwd: '/tmp/seed', prompt: 'forged prompt' }, sentAt: iso(), idempotencyKey: `forged-hook-${n}` }],
    ['/ingest/heartbeat', { sessionId: t.sessionId, pid: 4242, alive: true, at: iso(), transcriptBytes: 1, lastTranscriptWriteAt: null }],
    ['/ingest/activity', { sessionId: t.sessionId, kind: 'stream', at: iso() }],
    ['/ingest/usage', { sessionId: t.sessionId, idempotencyKey: `forged-usage-${n}`, batches: [{ model: 'claude-opus-5-5', inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, messageIds: [`m_forged_${n}`], firstAt: iso(), lastAt: iso(), contextTokens: 10 }] }],
    ['/ingest/throttle', { sessionId: t.sessionId, resetAt: null, message: 'forged limit', source: 'stream' }],
    ['/ingest/process', { sessionId: t.sessionId, event: 'exited', exitCode: 0, signal: null, at: iso(), pid: 4242 }],
    ['/ingest/mcp/declare_plan', { sessionId: t.sessionId, input: { phases: [{ id: 'p1', name: 'Forged', tasks: [{ id: 't1', title: 'forged task', size: 's' }] }] } }],
    ['/ingest/mcp/amend_plan', { sessionId: t.sessionId, input: { reason: 'forged', add: [{ id: 'tx', title: 'x', size: 's', phaseId: 'p1' }] } }],
    ['/ingest/mcp/task_done', { sessionId: t.sessionId, input: { task_id: 't1', evidence: { kind: 'test', ref: 'forged.test.ts > passes' } } }],
    ['/ingest/mcp/playbook_step', { sessionId: t.sessionId, input: { step: 'forged', state: 'done' } }],
    ['/ingest/mcp/get_status', { sessionId: t.sessionId, input: {} }],
    ['/ingest/mcp/request_decision', { sessionId: t.sessionId, input: { test: 'main', question: 'Forged question?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], recommendation: { option_id: 'a', rationale: 'forged' } } }],
    ['/ingest/mcp/report_error', { sessionId: t.sessionId, input: { summary: 'forged error' }, idempotencyKey: `forged-error-${n}` }],
    ['/ingest/mcp/report_diagnosis', { sessionId: t.sessionId, input: { root_cause: 'forged cause', confidence: 0.9, fix_plan: 'forged plan' } }],
  ];

  it('a token for one session, an observer, a person or nobody cannot write to another session: refused, and the log is untouched', async () => {
    const owner = p.user('builder', 'Owner');
    const a = seedSession(p, { sessionId: 'ses_iso_A', ownerId: owner.user.id });
    const b = seedSession(p, { sessionId: 'ses_iso_B', ownerId: owner.user.id });
    const forgers: [string, Record<string, string>][] = [
      ['anonymous', {}],
      ['a builder', owner.headers],
      ['the observer token', p.ids.ingestHeaders('observer')],
      ['the token of session A', p.ids.ingestHeaders(a.sessionId)],
    ];
    const problems: string[] = [];
    let n = 0;
    await settle();
    for (const [path, body] of bodies(b, ++n)) {
      for (const [who, headers] of forgers) {
        const before = p.store.head().seq;
        const res = await p.request('POST', path, { headers, body });
        const text = await res.text();
        await settle();
        if (res.status < 400) problems.push(`${path} as ${who}: accepted (HTTP ${res.status}) ${text.slice(0, 120)}`);
        if (p.store.head().seq !== before) problems.push(`${path} as ${who}: wrote ${p.store.head().seq - before} event(s) for session B`);
      }
    }
    expect(problems).toEqual([]);
    // The spool replays the same writes under one token: every item addressed to B must be rejected, none recorded.
    const items = bodies(b, ++n)
      .filter(([path]) => !path.startsWith('/ingest/mcp/'))
      .map(([path, body]) => ({ path, body, queuedAt: iso() }));
    const tokenA = p.ids.ingestHeaders(a.sessionId);
    await settle();
    const before = p.store.head().seq;
    const res = await p.request('POST', '/ingest/spool', { headers: tokenA, body: { items } });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ accepted: 0, rejected: items.length });
    await settle();
    expect(p.store.list({ fromSeq: before + 1 }).map((e) => `${e.seq} ${e.type}`)).toEqual([]);
  });

  it('the same writes are accepted for the session\'s own token (so the checks above can fail)', async () => {
    const owner = p.user('builder', 'Owner2');
    const c = seedSession(p, { sessionId: 'ses_iso_C', ownerId: owner.user.id });
    const own = p.ids.ingestHeaders(c.sessionId);
    let wrote = 0;
    let n = 100;
    for (const [path, body] of bodies(c, ++n)) {
      if (!['/ingest/hook', '/ingest/usage', '/ingest/throttle', '/ingest/mcp/declare_plan'].includes(path)) continue;
      const before = p.store.head().seq;
      const res = await p.request('POST', path, { headers: own, body });
      expect(res.status, path).toBeLessThan(400);
      wrote += p.store.head().seq - before;
    }
    expect(wrote).toBeGreaterThanOrEqual(4);
  });

  it('a client idempotency key cannot swallow, or be swallowed by, another session\'s event', async () => {
    const owner = p.user('builder', 'KeyOwner');
    const x = seedSession(p, { sessionId: 'ses_key_X', ownerId: owner.user.id });
    const y = seedSession(p, { sessionId: 'ses_key_Y', ownerId: owner.user.id });
    const hook = (t: SeededSession, key: string) => ({
      mode: 'managed',
      aocSessionId: t.sessionId,
      hook: { session_id: t.claudeSessionId, hook_event_name: 'UserPromptSubmit', cwd: '/tmp/seed', prompt: `prompt of ${t.sessionId}` },
      sentAt: iso(),
      idempotencyKey: key,
    });
    const usage = (t: SeededSession, key: string, msg: string) => ({
      sessionId: t.sessionId,
      idempotencyKey: key,
      batches: [{ model: 'claude-opus-5-5', inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, messageIds: [msg], firstAt: iso(), lastAt: iso(), contextTokens: 1 }],
    });
    // X claims the keys first; Y uses the same ones afterwards.
    await p.request('POST', '/ingest/hook', { headers: p.ids.ingestHeaders(x.sessionId), body: hook(x, 'shared-key-0001') });
    await p.request('POST', '/ingest/usage', { headers: p.ids.ingestHeaders(x.sessionId), body: usage(x, 'shared-key-0002', 'm_x') });
    await p.request('POST', '/ingest/mcp/report_error', { headers: p.ids.ingestHeaders(x.sessionId), body: { sessionId: x.sessionId, input: { summary: 'x hit an error' }, idempotencyKey: 'shared-key-0003' } });
    const sawY = () => p.store.list({ sessionId: y.sessionId, types: ['prompt.submitted', 'usage.recorded', 'error.observed'] }).map((e) => e.type).sort();
    expect(sawY()).toEqual([]);
    await p.request('POST', '/ingest/hook', { headers: p.ids.ingestHeaders(y.sessionId), body: hook(y, 'shared-key-0001') });
    await p.request('POST', '/ingest/usage', { headers: p.ids.ingestHeaders(y.sessionId), body: usage(y, 'shared-key-0002', 'm_y') });
    await p.request('POST', '/ingest/mcp/report_error', { headers: p.ids.ingestHeaders(y.sessionId), body: { sessionId: y.sessionId, input: { summary: 'y hit an error' }, idempotencyKey: 'shared-key-0003' } });
    expect(sawY()).toEqual(['error.observed', 'prompt.submitted', 'usage.recorded']);
  });

  it('client-chosen text never reaches the chain in the clear: idempotency keys are hashed, not echoed', async () => {
    const owner = p.user('builder', 'Leaky');
    const s = seedSession(p, { sessionId: 'ses_leak_L', ownerId: owner.user.id });
    const secret = 'Aminah binti Yusof 900101-14-5566';
    await p.request('POST', '/ingest/mcp/report_error', {
      headers: p.ids.ingestHeaders(s.sessionId),
      body: { sessionId: s.sessionId, input: { summary: 'an error class' }, idempotencyKey: secret },
    });
    await p.request('POST', '/ingest/hook', {
      headers: p.ids.ingestHeaders(s.sessionId),
      body: { mode: 'managed', aocSessionId: s.sessionId, hook: { session_id: s.claudeSessionId, hook_event_name: 'UserPromptSubmit', cwd: '/tmp/seed', prompt: 'p' }, sentAt: iso(), idempotencyKey: secret },
    });
    const rows = p.store.db.prepare('SELECT idempotency_key AS k, meta FROM events WHERE session_id = ?').all(s.sessionId) as { k: string | null; meta: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.k ?? '', 'idempotency_key').not.toContain('Aminah');
      expect(r.meta).not.toContain('Aminah');
    }
  });
});

describe('the same route by another spelling', () => {
  it('is never more open than the canonical path', async () => {
    const requester = p.user('requester', 'Req');
    const builder = p.user('builder', 'Bld');
    const variants = (path: string) => [
      path.replace('/api/', '//api/'),
      path.replace('/api/', '/api//'),
      `${path}/`,
      `${path}?x=1`,
      `${path}#frag`,
      path.replace('/api/', '/API/'),
      path.replace('/api/', '/%61pi/'),
      path.replace('/api/', '/api/%2e%2e/api/'),
      path.replace('/api/', '/api/./'),
      `${path};x=y`,
      `${path}%00`,
      `${path}%2f`,
    ];
    const probes: [string, string, 'requester' | 'builder' | 'anon'][] = [
      ['GET', '/api/users', 'builder'],
      ['GET', '/api/audit/events', 'requester'],
      ['POST', '/api/audit/erase', 'builder'],
      ['POST', '/api/credits/allocations', 'builder'],
      ['PUT', '/api/ratecard', 'builder'],
      ['GET', '/api/users', 'anon'],
      ['GET', '/api/decisions', 'anon'],
    ];
    const headers = { requester: requester.headers, builder: builder.headers, anon: {} };
    const bad: string[] = [];
    for (const [method, path, who] of probes) {
      for (const v of variants(path)) {
        const res = await p.request(method, v, { headers: headers[who], body: method === 'GET' ? undefined : {} });
        const text = await res.text();
        // A path the API does not own falls through to the console's static fallback (503 here: no UI build).
        const staticFallback = res.status === 503 && text.includes('console UI is not built');
        if (!staticFallback && (res.status < 400 || res.status >= 500)) bad.push(`${who} ${method} ${v} → ${res.status}`);
      }
    }
    expect(bad).toEqual([]);
    // Ingest by another spelling must not let a person's token in either.
    for (const v of ['/ingest/heartbeat', '//ingest/heartbeat', '/ingest//heartbeat', '/%69ngest/heartbeat', '/ingest/heartbeat/', '/INGEST/heartbeat']) {
      const res = await p.request('POST', v, { headers: builder.headers, body: {} });
      await res.arrayBuffer();
      expect([401, 404], v).toContain(res.status);
    }
  });
});

describe('reads that write', () => {
  it('only the known read-style routes append to the log', async () => {
    const approver = p.user('approver', 'Reader');
    const gets = p.aoc.app.routes.filter((r) => r.method === 'GET' && r.path !== '/*' && r.path !== '/api/stream');
    const writers: string[] = [];
    for (const r of gets) {
      const path = r.path.replace(':attachmentId', 'att_x').replace(':seq', '1').replace(':date', '2026-10-01').replace(':id', 'x_missing');
      const before = p.store.head().seq;
      const res = await p.request('GET', path, { headers: approver.headers });
      await res.arrayBuffer();
      if (p.store.head().seq !== before) writers.push(r.path);
    }
    // Verify records its outcome on the chain (§13); nothing else about a GET may leave a trace.
    expect(writers).toEqual(['/api/audit/verify']);
  });
});
