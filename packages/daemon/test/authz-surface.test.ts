/**
 * Authorization rules that need more than a route table (spec §3, §6, §7): who may close a ticket, what the push
 * gateway lets through, how the shared observer token is held to its budget, where an observed session may not go,
 * and what one person's evidence packs may cost everybody else. Each rule is checked against an independent oracle
 * (a few lines that restate the rule) over the production composition, and the failing seed is printed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { hasPermission, type Role } from '@aoc/contracts';
import { forSeeds, type AocModule, type Rng } from '@aoc/kernel';
import { createEvidenceModule } from '@aoc/mod-evidence';
import { createSessionsModule } from '@aoc/mod-sessions';
import { bootProd, seedSession, type Prod } from './support/prod';

let p: Prod | null = null;
afterEach(async () => {
  await p?.close();
  p = null;
});

const without = (name: string) => (list: AocModule[]) => list.filter((m) => m.name !== name);

// ── the role model ────────────────────────────────────────────────────────────────────────────────────────

describe('closing tickets (ticket.close_own, ticket.close_any)', () => {
  it('Builders may close the tickets of their own work, Approvers any ticket, Requesters none', () => {
    const has = (role: Role, perm: 'ticket.close_own' | 'ticket.close_any') => hasPermission(role, perm);
    expect(['approver', 'builder', 'requester'].map((r) => [r, has(r as Role, 'ticket.close_own'), has(r as Role, 'ticket.close_any')])).toEqual([
      ['approver', true, true],
      ['builder', true, false],
      ['requester', false, false],
    ]);
  });

  /** The rule, restated: any ticket for close_any; otherwise close_own on a ticket one of whose sessions the person owns, never as "withdrawn". */
  const mayClose = (role: Role, resolution: string, ownsLinkedSession: boolean): boolean => {
    if (!hasPermission(role, 'ticket.view_internal')) return false;
    if (hasPermission(role, 'ticket.close_any')) return true;
    return resolution !== 'withdrawn' && hasPermission(role, 'ticket.close_own') && ownsLinkedSession;
  };

  const RESOLUTIONS = ['wont_fix', 'duplicate', 'cannot_reproduce', 'withdrawn'] as const;

  it('every attempt is allowed or refused exactly as the rule says, and a refused one writes nothing', async () => {
    await forSeeds(
      'ticket close',
      async (rng: Rng, seed) => {
        // No supervisor: a submitted ticket would otherwise start triage sessions. Tickets here are only rows to close.
        p = await bootProd({ modules: without('supervisor'), captureErrors: true });
        const people = {
          requester: p.user('requester', 'Requester'),
          ownerA: p.user('builder', 'Builder A'),
          ownerB: p.user('builder', 'Builder B'),
          bystander: p.user('builder', 'Builder C'),
          approver: p.user('approver', 'Approver'),
        };
        const tickets = ['tkt_one', 'tkt_two', 'tkt_three', 'tkt_four'];
        // tkt_one: A works on it; tkt_two: B; tkt_three: both; tkt_four: nobody (only an Approver can close it)
        const owners: Record<string, (keyof typeof people)[]> = { tkt_one: ['ownerA'], tkt_two: ['ownerB'], tkt_three: ['ownerA', 'ownerB'], tkt_four: [] };
        for (const id of tickets) {
          p.store.append({
            type: 'intake.submitted',
            actor: { kind: 'human', id: people.requester.user.id },
            scope: { ticketId: id },
            meta: { ticketId: id, requesterId: people.requester.user.id, severity: 'high', attachmentCount: 0, attachmentHashes: [] },
            payload: { title: 'Claim form crashes on upload', description: 'Aminah binti Yusof cannot attach her IC' },
            source: 'api',
          });
          for (const who of owners[id]!)
            seedSession(p, { sessionId: `ses_${id}_${who}`, ownerId: people[who].user.id, ticketId: id, projectId: 'prj_t', threadId: `thr_${id}_${who}` });
        }
        await p.aoc.runtime.drain();
        const row = (id: string) => p!.store.db.prepare('SELECT resolution FROM itk_tickets WHERE ticket_id = ?').get(id) as { resolution: string | null };
        const closedBy = (id: string) => p!.store.list({ types: ['ticket.closed'], ticketId: id });

        const problems: string[] = [];
        const names = Object.keys(people) as (keyof typeof people)[];
        for (let i = 0; i < 40; i++) {
          const who = rng.pick(names);
          const id = rng.pick(tickets);
          const resolution = rng.pick(RESOLUTIONS);
          const person = people[who];
          const already = row(id).resolution;
          const eventsBefore = p.store.head().seq;
          const res = await p.request('POST', `/api/tickets/${id}/close`, { headers: person.headers, body: { resolution } });
          await res.arrayBuffer();
          const allowed = mayClose(person.user.role, resolution, owners[id]!.includes(who));
          const label = `${who} closes ${id} as ${resolution}${already ? ` (already ${already})` : ''}`;
          if (allowed !== (res.status === 200)) problems.push(`${label}: expected ${allowed ? 200 : 'a refusal'}, got HTTP ${res.status}`);
          if (!allowed && res.status !== 403) problems.push(`${label}: a refused close should be 403, got ${res.status}`);
          if (!allowed && (p.store.head().seq !== eventsBefore || row(id).resolution !== already))
            problems.push(`${label}: refused, but the log or the ticket changed`);
          if (allowed && !already && row(id).resolution !== resolution) problems.push(`${label}: allowed, but the ticket is ${row(id).resolution}`);
          if (already && row(id).resolution !== already) problems.push(`${label}: a closed ticket was re-closed as ${row(id).resolution}`);
        }
        for (const id of tickets) {
          const events = closedBy(id);
          if (events.length > 1) problems.push(`${id} was closed ${events.length} times`);
          for (const e of events) {
            const m = e.meta as { resolution: string };
            const actor = Object.entries(people).find(([, v]) => v.user.id === e.actor.id)?.[0];
            if (!actor) problems.push(`${id}: ticket.closed by an unknown actor ${e.actor.id}`);
            else if (!mayClose(people[actor as keyof typeof people].user.role, m.resolution, owners[id]!.includes(actor as keyof typeof people)))
              problems.push(`${id}: closed as ${m.resolution} by ${actor}, who may not`);
          }
        }
        expect(problems.join('\n'), `seed ${seed}`).toBe('');
        await p.close();
        p = null;
      },
      { count: 4 },
    );
  }, 60_000);
});

// ── the push gateway ──────────────────────────────────────────────────────────────────────────────────────

describe('the git push gateway (/ingest/git, R-02)', () => {
  /** The `ERR <message>` git prints as "remote error: …" when the advertisement is a refusal. */
  const refusalOf = async (res: Response): Promise<string | null> => {
    const text = Buffer.from(await res.arrayBuffer()).toString('latin1');
    const at = text.indexOf('ERR ');
    return at < 0 ? null : text.slice(at + 4).split('\n')[0]!;
  };

  it('is the session\'s own token only, and a token alone is not enough: no running turn, no push', async () => {
    p = await bootProd();
    const owner = p.user('builder', 'Pusher');
    const approver = p.user('approver', 'Boss');
    const s = seedSession(p, { sessionId: 'ses_push', ownerId: owner.user.id });
    const triage = seedSession(p, { sessionId: 'ses_triage', ownerId: null, readOnly: true, processType: 'triage' });
    const gone = seedSession(p, { sessionId: 'ses_gone', ownerId: owner.user.id });
    p.store.append({
      type: 'session.ended',
      actor: { kind: 'system', id: 'supervisor' },
      scope: { sessionId: gone.sessionId },
      meta: { sessionId: gone.sessionId, outcome: 'completed' },
      source: 'supervisor',
    });
    const repo = `${s.projectId}.git`;
    const advertise = (headers: Record<string, string>, id = repo, service = 'git-receive-pack') =>
      p!.request('GET', `/ingest/git/${id}/info/refs?service=${service}`, { headers });
    const push = (headers: Record<string, string>, contentType = 'application/x-git-receive-pack-request') =>
      p!.request('POST', `/ingest/git/${repo}/git-receive-pack`, { headers: { ...headers, 'content-type': contentType }, body: '0000' });

    // Nobody who is not a managed session gets near it: not people, not the other ingest principals.
    const cookie = p.ids.cookieHeaders(approver.token);
    const outsiders: [string, Record<string, string>, number][] = [
      ['anonymous', {}, 401],
      ['an approver\'s token', approver.headers, 401],
      ['an approver\'s cookie', cookie, 401],
      ['the observer token', p.ids.ingestHeaders('observer'), 403],
      ['a system token', p.ids.ingestHeaders('system'), 403],
      ['the session\'s sidecar token', p.ids.sidecarHeaders(s.sessionId), 403],
    ];
    for (const [who, headers, status] of outsiders) {
      expect((await advertise(headers)).status, `info/refs as ${who}`).toBe(status);
      expect((await push(headers)).status, `git-receive-pack as ${who}`).toBe(status);
    }

    // The session's own token reaches the gateway, and is turned away with a message the model can read.
    const own = p.ids.ingestHeaders(s.sessionId);
    const refused = await advertise(own);
    expect(refused.status).toBe(200);
    expect(await refusalOf(refused)).toMatch(/only while a turn of the session is running/);
    const pushed = await push(own);
    expect(pushed.status).toBe(403);
    expect(((await pushed.json()) as { error: { code: string } }).error.code).toBe('git_gateway');
    expect((await push(own, 'text/plain')).status, 'the wrong content type').toBe(415);

    // Fetching is not served (the model has its own checkout), and the service parameter is required.
    expect(await refusalOf(await advertise(own, repo, 'git-upload-pack'))).toMatch(/pushes only/);
    expect((await p.request('GET', `/ingest/git/${repo}/info/refs`, { headers: own })).status).toBe(403);

    // A read-only (triage) session never pushes, and an ended session's old token is not a licence.
    expect(await refusalOf(await advertise(p.ids.ingestHeaders(triage.sessionId)))).toMatch(/read-only sessions cannot push/);
    expect(await refusalOf(await advertise(p.ids.ingestHeaders(gone.sessionId)))).toMatch(/not an active managed session/);

    // Nothing above wrote a push to the log.
    expect(p.store.list({ types: ['session.git_pushed'] })).toEqual([]);
  });
});

// ── observer tokens ───────────────────────────────────────────────────────────────────────────────────────

describe('the shared observer token is held to its budget on every ingest route (R-13)', () => {
  const hookFor = (claudeId: string, at: string, key: string) => ({
    mode: 'observed',
    aocSessionId: null,
    hook: { session_id: claudeId, hook_event_name: 'PostToolUse', cwd: '/home/dev/app', transcript_path: '/home/dev/.claude/t.jsonl', tool_name: 'Read', tool_input: { file_path: '/x' }, tool_response: {} },
    sentAt: at,
    idempotencyKey: key,
  });

  it('answers 429 with Retry-After on every /ingest path once spent, writes nothing, and leaves every other principal alone', async () => {
    p = await bootProd({
      modules: (list) => list.map((m) => (m.name === 'sessions' ? createSessionsModule({ observerLimits: { requestBurst: 5, requestsPerMinute: 60, newSessionsPerHour: 3 } }) : m)),
    });
    const observer = p.ids.ingestHeaders('observer');
    const other = p.ids.ingestHeaders('observer');
    const claude = '66666666-6666-4666-8666-666666666666';
    const send = (headers: Record<string, string>, n: number) => p!.request('POST', '/ingest/hook', { headers, body: hookFor(claude, p!.clock.iso(), `observed-key-${n}-xx`) });
    let n = 0;
    for (let i = 0; i < 5; i++) expect((await send(observer, ++n)).status, `request ${i + 1} of the burst`).toBe(200);
    await p.aoc.runtime.drain();
    const before = p.store.head().seq;

    const paths = p.aoc.app.routes.filter((r) => r.method === 'POST' && r.path.startsWith('/ingest/') && !r.path.includes(':')).map((r) => r.path);
    expect(paths.length).toBeGreaterThan(10);
    const unlimited: string[] = [];
    for (const path of paths) {
      const res = await p.request('POST', path, { headers: observer, body: {} });
      await res.arrayBuffer();
      if (res.status !== 429) unlimited.push(`${path}: HTTP ${res.status}`);
      else if (!/^\d+$/.test(res.headers.get('retry-after') ?? '')) unlimited.push(`${path}: 429 without Retry-After`);
    }
    const gateway = await p.request('GET', '/ingest/git/prj_x.git/info/refs?service=git-receive-pack', { headers: observer });
    expect(gateway.status, 'the gateway is behind the same budget').toBe(429);
    expect(unlimited, 'ingest routes an observer token can use without spending its budget').toEqual([]);
    await p.aoc.runtime.drain();
    expect(p.store.head().seq, 'a limited request must not write').toBe(before);

    // Other observer tokens, and the managed sessions' own principals, have budgets of their own.
    expect((await send(other, ++n)).status).toBe(200);
    const owner = p.user('builder', 'Owner');
    const s = seedSession(p, { sessionId: 'ses_budget', ownerId: owner.user.id });
    for (let i = 0; i < 12; i++) {
      const res = await p.request('POST', '/ingest/heartbeat', {
        headers: p.ids.sidecarHeaders(s.sessionId),
        body: { sessionId: s.sessionId, pid: 4242, alive: true, at: p.clock.iso(), transcriptBytes: 1, lastTranscriptWriteAt: null },
      });
      expect(res.status, `sidecar heartbeat ${i + 1}`).toBe(200);
    }
    // The budget refills with time (the sustained rate), not with a new connection.
    p.clock.advance(1000);
    expect((await send(observer, ++n)).status).toBe(200);
    expect((await send(observer, ++n)).status).toBe(429);
  });

  it('a spool flush is charged per item, so splitting a flood into spool entries buys nothing', async () => {
    p = await bootProd({
      modules: (list) => list.map((m) => (m.name === 'sessions' ? createSessionsModule({ observerLimits: { requestBurst: 10, requestsPerMinute: 60, newSessionsPerHour: 100 } }) : m)),
    });
    const observer = p.ids.ingestHeaders('observer');
    const claude = '77777777-7777-4777-8777-777777777777';
    const items = (count: number, from: number) =>
      Array.from({ length: count }, (_, i) => ({ path: '/ingest/hook', body: hookFor(claude, p!.clock.iso(), `spool-key-${from + i}-xx`), queuedAt: p!.clock.iso() }));
    const small = await p.request('POST', '/ingest/spool', { headers: observer, body: { items: items(6, 0) } });
    expect(small.status).toBe(200);
    expect(await small.json()).toMatchObject({ accepted: 6, rejected: 0 });
    const big = await p.request('POST', '/ingest/spool', { headers: observer, body: { items: items(300, 100) } });
    expect(big.status).toBe(429);
    expect(big.headers.get('retry-after')).toMatch(/^\d+$/);
    await p.aoc.runtime.drain();
    expect(p.store.list({ types: ['tool.used'] }).length, 'only the first flush was recorded').toBe(6);
  });
});

// ── observed sessions ─────────────────────────────────────────────────────────────────────────────────────

describe('an observed session is unverified laptop work (T-12, G-25)', () => {
  it('an approved change cannot be started on one, however it is addressed; a managed session can', async () => {
    p = await bootProd({ modules: without('supervisor'), captureErrors: true });
    const builder = p.user('builder', 'Change owner');
    const sys = { kind: 'system', id: 'test' } as const;
    p.store.append({
      type: 'project.created',
      actor: sys,
      scope: { projectId: 'prj_chg' },
      meta: { projectId: 'prj_chg', slug: 'laptop-app' },
      payload: { name: 'Laptop app', repoPath: '/home/dev/app' },
      source: 'system',
    });
    const draft = (changeId: string) => {
      p!.store.append({
        type: 'change.drafted',
        actor: { kind: 'human', id: builder.user.id },
        scope: { projectId: 'prj_chg', changeId },
        meta: { changeId, projectId: 'prj_chg', scope: 'reversible_off_main', draftedBy: 'human', sessionId: null, breakglassId: null, ownerId: builder.user.id },
        payload: { title: 'Ship it', impact: 'low', mitigation: 'flag', rollbackPlan: 'revert', rollbackRef: 'a'.repeat(40), acceptanceTest: 'node test.js' },
        source: 'api',
      });
      p!.store.append({
        type: 'change.approved',
        actor: { kind: 'human', id: builder.user.id },
        scope: { projectId: 'prj_chg', changeId },
        meta: { changeId, decisionId: null, approverId: builder.user.id, selfApproved: true },
        source: 'api',
      });
    };
    draft('chg_one');

    // An observed session is created by the shared observer token from a developer's laptop, in the project's directory.
    const claude = '88888888-8888-4888-8888-888888888888';
    const seen = await p.request('POST', '/ingest/hook', {
      headers: p.ids.ingestHeaders('observer'),
      body: { mode: 'observed', aocSessionId: null, hook: { session_id: claude, hook_event_name: 'SessionStart', cwd: '/home/dev/app', transcript_path: '/home/dev/.claude/t.jsonl' }, sentAt: p.clock.iso(), idempotencyKey: 'observed-start-xx' },
    });
    expect(seen.status).toBe(200);
    const observedId = (p.store.list({ types: ['session.observed'] })[0]!.meta as { sessionId: string }).sessionId;
    const managed = seedSession(p, { sessionId: 'ses_managed', ownerId: builder.user.id, projectId: 'prj_chg' });

    const start = (changeId: string, sessionId: string) => p!.request('POST', `/api/changes/${changeId}/start`, { headers: builder.headers, body: { sessionId } });
    const started = () => p!.store.list({ types: ['change.started'] }).length;

    const refused = await start('chg_one', observedId);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('session_not_managed');
    expect(started()).toBe(0);
    // Not under its claude session id either, nor with an unknown id.
    expect([(await start('chg_one', claude)).status, (await start('chg_one', 'ses_unknown')).status]).toEqual([404, 404]);
    expect(started()).toBe(0);

    const ok = await start('chg_one', managed.sessionId);
    expect(ok.status).toBe(200);
    expect(started()).toBe(1);
    // ... and starting it again on the observed session is still refused after a managed one is linked.
    expect((await start('chg_one', observedId)).status).toBe(422);
    expect(started()).toBe(1);
  });
});

// ── evidence packs ────────────────────────────────────────────────────────────────────────────────────────

describe('evidence packs cost one person only their own budget (R-05)', () => {
  it('the hourly budget is per user, a refusal is a 429 with Retry-After that writes nothing, and the job record is not public', async () => {
    p = await bootProd({
      modules: (list) => list.map((m) => (m.name === 'evidence' ? createEvidenceModule({ packLimits: { perUserPerHour: 2, maxQueued: 0 } }) : m)),
    });
    const [greedy, other] = [p.user('builder', 'Greedy'), p.user('approver', 'Other')];
    const range = { from: '2026-10-09', to: '2026-10-09' };
    const post = (headers: Record<string, string>) => p!.request('POST', '/api/evidence/packs', { headers, body: range });
    const packs = () => p!.store.list({ types: ['evidence_pack.generated'] }).length;

    expect((await post(greedy.headers)).status).toBe(201);
    expect((await post(greedy.headers)).status).toBe(201);
    expect(packs()).toBe(2);
    const limited = await post(greedy.headers);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(Number(limited.headers.get('retry-after'))).toBeLessThanOrEqual(3600);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    expect(packs(), 'a refused request builds nothing').toBe(2);

    // Somebody else is not affected by the greedy user, and the budget returns with time.
    expect((await post(other.headers)).status).toBe(201);
    p.clock.advance(3_600_001);
    expect((await post(greedy.headers)).status).toBe(201);

    // The range is checked before any budget is spent.
    const bad = await p.request('POST', '/api/evidence/packs', { headers: other.headers, body: { from: '2026-10-09', to: '2020-01-01' } });
    expect(bad.status).toBe(422);
    // Job records answer audit.view holders only; an unknown id is a 404, never a guess confirmed.
    const requester = p.user('requester', 'Req');
    expect((await p.request('GET', '/api/evidence/jobs/evj_000000000000000000000000', { headers: requester.headers })).status).toBe(403);
    expect((await p.request('GET', '/api/evidence/jobs/evj_000000000000000000000000', { headers: other.headers })).status).toBe(404);
    expect((await p.request('GET', '/api/evidence/jobs/evj_000000000000000000000000')).status).toBe(401);
  });
});
