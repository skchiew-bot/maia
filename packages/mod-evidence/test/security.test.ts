import { afterEach, describe, expect, it } from 'vitest';
import type { EvidencePackDetailDTO, EvidencePackJobDTO } from '@aoc/contracts';
import { createTestRuntime, type NewEvent, type TestRuntime } from '@aoc/kernel';
import { createEvidenceModule, type PackJobLimits } from '../src';
import { NOW, RANGE } from './helpers';

let t: TestRuntime | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function boot(packLimits: Partial<PackJobLimits> = {}): Promise<TestRuntime> {
  t = await createTestRuntime({ modules: [createEvidenceModule({ mappingFile: null, packLimits })], onDisk: true, now: NOW });
  return t;
}

/** Enough history inside RANGE that building a pack takes a noticeable while. */
function bulk(rt: TestRuntime, n: number): void {
  rt.clock.set('2026-10-04T04:00:00.000Z');
  for (let i = 0; i < n; i += 1000) {
    const page: NewEvent<'session.nudged'>[] = [];
    for (let j = i; j < Math.min(n, i + 1000); j++)
      page.push({ type: 'session.nudged', actor: { kind: 'human', id: 'usr_operator' }, scope: { sessionId: `ses_${j % 50}` }, meta: { sessionId: `ses_${j % 50}` }, payload: { text: `nudge ${j}` }, source: 'api' });
    rt.rt.store.appendMany(page);
  }
  rt.clock.set(NOW);
}

/** Longest stretch the event loop could not run a timer while `work` was in flight. */
async function longestStall<T>(work: Promise<T>): Promise<{ result: T; stallMs: number; totalMs: number }> {
  const started = performance.now();
  let last = started;
  let stallMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    stallMs = Math.max(stallMs, now - last);
    last = now;
  }, 2);
  try {
    const result = await work;
    const end = performance.now();
    return { result, stallMs: Math.max(stallMs, end - last), totalMs: end - started };
  } finally {
    clearInterval(timer);
  }
}

describe('evidence packs never hold the daemon thread (R-05)', () => {
  it('builds a pack in slices, so hooks and the API keep being served meanwhile', async () => {
    const rt = await boot();
    bulk(rt, 20_000);
    const builder = rt.user('builder');
    const { result, stallMs, totalMs } = await longestStall(rt.request('POST', '/api/evidence/packs', { headers: builder.headers, body: RANGE }));
    expect(result.status).toBe(201);
    const pack = (await result.json()) as EvidencePackDetailDTO;
    expect(pack.eventCount).toBeGreaterThanOrEqual(20_000);
    expect(pack.chainOk).toBe(true);
    // A synchronous build stalls the loop for (nearly) its whole duration.
    expect(stallMs, `longest stall ${Math.round(stallMs)} ms of ${Math.round(totalMs)} ms`).toBeLessThan(totalMs / 2);
  }, 60_000);

  it('builds one pack at a time: later requests queue (202) and a caller with a pack pending gets 429', async () => {
    const rt = await boot();
    bulk(rt, 20_000);
    const builder = rt.user('builder');
    const approver = rt.user('approver');
    const first = rt.request('POST', '/api/evidence/packs', { headers: builder.headers, body: RANGE });
    await new Promise((r) => setTimeout(r, 50));

    const queued = await rt.request('POST', '/api/evidence/packs', { headers: approver.headers, body: RANGE });
    expect(queued.status).toBe(202);
    const job = (await queued.json()) as EvidencePackJobDTO;
    expect(job).toMatchObject({ status: 'queued', position: 1, requestedBy: approver.user.id, pack: null, from: RANGE.from, to: RANGE.to });

    const again = await rt.request('POST', '/api/evidence/packs', { headers: builder.headers, body: RANGE });
    expect(again.status).toBe(429);
    expect(again.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('pack_pending');

    expect((await first).status).toBe(201);
    let status = job;
    for (let i = 0; i < 600 && status.status !== 'done'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      status = await rt.json<EvidencePackJobDTO>('GET', job.statusUrl, { headers: approver.headers });
    }
    expect(status).toMatchObject({ status: 'done', position: null, error: null });
    expect(status.pack!.generatedBy).toEqual({ kind: 'human', id: approver.user.id });
    expect((await rt.request('GET', status.pack!.downloadUrl, { headers: approver.headers })).status).toBe(200);
    expect(rt.rt.store.list({ types: ['evidence_pack.generated'] })).toHaveLength(2);
    expect((await rt.request('GET', job.statusUrl, { headers: rt.user('requester').headers })).status).toBe(403);
  }, 60_000);

  it('caps packs per user per hour and the length of the queue', async () => {
    const rt = await boot({ perUserPerHour: 2, maxQueued: 0 });
    const builder = rt.user('builder');
    const post = (headers: Record<string, string>) => rt.request('POST', '/api/evidence/packs', { headers, body: { from: '2026-10-09', to: '2026-10-09' } });
    expect((await post(builder.headers)).status).toBe(201);
    expect((await post(builder.headers)).status).toBe(201);
    const limited = await post(builder.headers);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    rt.clock.advance(3_600_001);
    expect((await post(builder.headers)).status).toBe(201);

    bulk(rt, 10_000);
    const running = post(rt.user('builder').headers);
    await new Promise((r) => setTimeout(r, 50));
    const full = await post(rt.user('approver').headers);
    expect(full.status).toBe(429);
    expect(((await full.json()) as { error: { code: string } }).error.code).toBe('queue_full');
    expect((await running).status).toBe(201);
  }, 60_000);
});
