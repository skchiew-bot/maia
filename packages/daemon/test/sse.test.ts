import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventHeader } from '@aoc/contracts';
import { bootTestServer, removeTempDirs, SseReader, type TestServer } from './helpers';

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

function nudge(t: TestServer, sessionId: string) {
  return t.aoc.runtime.store.append({
    type: 'session.nudged',
    actor: { kind: 'system', id: 'test' },
    scope: { sessionId },
    meta: { sessionId },
    payload: { text: 'secret operator text' },
    source: 'api',
  });
}

describe('GET /api/stream', () => {
  it('refuses anonymous callers (401) and requesters (403)', async () => {
    const t = await boot();
    const anon = await t.request('/api/stream');
    expect(anon.status).toBe(401);
    const requester = await t.request('/api/stream', { headers: t.user('requester').headers });
    expect(requester.status).toBe(403);
    expect(await requester.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect(t.aoc.runtime.broadcaster.size).toBe(0);
  });

  it('streams appended event headers (id = seq, no payload) and audience-filtered notifications', async () => {
    const t = await boot();
    const builder = t.user('builder');
    const res = await t.request('/api/stream', { headers: builder.headers });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    const sse = new SseReader(res);
    const head = t.aoc.runtime.store.head().seq;
    expect(await sse.next()).toEqual({ retry: '3000' });
    expect(await sse.next()).toEqual({ id: String(head) });

    const e = nudge(t, 'ses_live');
    const frame = await sse.next();
    expect(frame.id).toBe(String(e.seq));
    expect(frame.event).toBe('aoc');
    const header = JSON.parse(frame.data!) as EventHeader;
    expect(header).toMatchObject({
      seq: e.seq,
      id: e.id,
      type: 'session.nudged',
      meta: { sessionId: 'ses_live' },
    });
    expect(frame.data).not.toContain('secret operator text');

    t.aoc.runtime.ctx.notify({
      kind: 'info',
      title: 'approvers only',
      audience: ['approver'],
      severity: 'info',
    });
    t.aoc.runtime.ctx.notify({
      kind: 'decision.new',
      title: 'for builders',
      audience: ['builder', 'approver'],
      severity: 'warn',
      refs: { decisionId: 'dec_1' },
    });
    const note = await sse.next();
    expect(note.event).toBe('notification');
    expect(note.id).toBeUndefined();
    expect(JSON.parse(note.data!)).toMatchObject({
      kind: 'decision.new',
      title: 'for builders',
      refs: { decisionId: 'dec_1' },
    });

    await sse.cancel();
    expect(t.aoc.runtime.broadcaster.size).toBe(0);
  });

  it('replays the headers missed since Last-Event-ID, then continues live without duplicates', async () => {
    const t = await boot();
    const builder = t.user('builder');
    const seen = nudge(t, 'ses_a');
    const missed = [nudge(t, 'ses_b'), nudge(t, 'ses_c')];
    const res = await t.request('/api/stream', {
      headers: { ...builder.headers, 'last-event-id': String(seen.seq) },
    });
    const sse = new SseReader(res);
    expect(await sse.next()).toEqual({ retry: '3000' });
    const replayed = [await sse.next(), await sse.next()];
    expect(replayed.map((f) => f.id)).toEqual(missed.map((e) => String(e.seq)));
    expect(replayed.map((f) => (JSON.parse(f.data!) as EventHeader).scope.sessionId)).toEqual([
      'ses_b',
      'ses_c',
    ]);

    const live = nudge(t, 'ses_d');
    const next = await sse.next();
    expect(next.id).toBe(String(live.seq));
    await sse.cancel();
  });

  it('accepts ?lastEventId= when the header is absent (resume after a page reload)', async () => {
    const t = await boot();
    const builder = t.user('approver');
    const seen = nudge(t, 'ses_a');
    const missed = nudge(t, 'ses_b');
    const sse = new SseReader(
      await t.request(`/api/stream?lastEventId=${seen.seq}`, { headers: builder.headers }),
    );
    const frames = await sse.until((f) => f.event === 'aoc');
    expect(frames.at(-1)!.id).toBe(String(missed.seq));
    await sse.cancel();
  });

  it('sends resync instead of replaying when the gap exceeds the replay limit or the id is ahead of this chain', async () => {
    const t = await boot({ sse: { replayLimit: 2 } });
    const builder = t.user('builder');
    const first = nudge(t, 'ses_0');
    for (let i = 1; i <= 3; i++) nudge(t, `ses_${i}`);
    const head = t.aoc.runtime.store.head().seq;

    const gap = new SseReader(
      await t.request('/api/stream', { headers: { ...builder.headers, 'last-event-id': String(first.seq) } }),
    );
    const [, resync] = [await gap.next(), await gap.next()];
    expect(resync).toEqual({
      id: String(head),
      event: 'resync',
      data: JSON.stringify({ lastEventId: first.seq, headSeq: head }),
    });
    await gap.cancel();

    const ahead = new SseReader(
      await t.request('/api/stream', { headers: { ...builder.headers, 'last-event-id': String(head + 50) } }),
    );
    await ahead.next();
    expect((await ahead.next()).event).toBe('resync');
    await ahead.cancel();
  });

  it('answers HEAD without opening a stream', async () => {
    const t = await boot();
    const res = await t.request('/api/stream', { method: 'HEAD', headers: t.user('builder').headers });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(t.aoc.runtime.broadcaster.size).toBe(0);
  });

  it('sends a comment heartbeat', async () => {
    const t = await boot({ sse: { heartbeatMs: 20 } });
    const sse = new SseReader(await t.request('/api/stream', { headers: t.user('builder').headers }));
    const frames = await sse.until((f) => f.comment !== undefined);
    expect(frames.at(-1)).toEqual({ comment: 'ping' });
    await sse.cancel();
  });

  it('refuses a user one stream more than the per-user cap, leaving other users alone, and frees the slot when a stream closes (O-16, G-47)', async () => {
    const t = await boot({ sse: { maxStreamsPerUser: 2 } });
    const builder = t.user('builder');
    const open = async (headers: Record<string, string>) => {
      const sse = new SseReader(await t.request('/api/stream', { headers }));
      await sse.next();
      return sse;
    };
    const first = await open(builder.headers);
    await open(builder.headers);
    const refused = await t.request('/api/stream', { headers: builder.headers });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('30');
    expect(await refused.json()).toMatchObject({ error: { code: 'too_many_streams' } });
    expect(t.aoc.runtime.broadcaster.size).toBe(2);
    // the cap is per user, not per role
    await open(t.user('builder').headers);
    await first.cancel();
    await vi.waitFor(() => expect(t.aoc.runtime.broadcaster.size).toBe(2));
    await open(builder.headers);
    t.aoc.closeStreams();
    await open(builder.headers);
  });

  it('closeStreams() ends open streams (shutdown)', async () => {
    const t = await boot();
    const sse = new SseReader(await t.request('/api/stream', { headers: t.user('builder').headers }));
    await sse.next();
    expect(t.aoc.runtime.broadcaster.size).toBe(1);
    t.aoc.closeStreams();
    expect(t.aoc.runtime.broadcaster.size).toBe(0);
    await expect(sse.until(() => false)).rejects.toThrow('stream ended');
  });
});
