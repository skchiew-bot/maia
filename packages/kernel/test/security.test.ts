import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestRuntime, EventStore, EventValidationError, FakeClock, MAX_BODY_BYTES, silentLogger, type AocModule } from '../src';

const mk = (dataDir = ':memory:', key = randomBytes(32)) =>
  new EventStore({ dataDir, clock: new FakeClock(), log: silentLogger, masterKey: key });

const nudge = (sessionId: string, text: string) => ({
  type: 'session.nudged' as const,
  actor: { kind: 'human' as const, id: 'usr_1' },
  scope: { sessionId },
  meta: { sessionId },
  payload: { text },
  source: 'api' as const,
});

describe('chained header fields are bounded like meta', () => {
  it('rejects a sourceTs that is not a timestamp (free text would be chained in clear, forever)', () => {
    const s = mk();
    const pii = 'Nur Aisyah binti Ahmad, NRIC 850101-14-5555, +60 12-345 6789';
    expect(() => s.append({ ...nudge('ses_a', 'x'), sourceTs: pii })).toThrow(EventValidationError);
    expect(() => s.append({ ...nudge('ses_a', 'x'), sourceTs: `2026-10-09T02:00:00.000Z${'x'.repeat(1_000_000)}` })).toThrow(EventValidationError);
    expect(s.head().seq).toBe(0);
    expect(s.append({ ...nudge('ses_a', 'x'), sourceTs: '2026-10-09T02:00:00.000Z' }).sourceTs).toBe('2026-10-09T02:00:00.000Z');
  });

  it('rejects oversized or control-character idempotency keys', () => {
    const s = mk();
    expect(() => s.append({ ...nudge('ses_a', 'x'), idempotencyKey: 'k'.repeat(100_000) })).toThrow(EventValidationError);
    expect(() => s.append({ ...nudge('ses_a', 'x'), idempotencyKey: 'key\nwith-newline' })).toThrow(EventValidationError);
    expect(s.head().seq).toBe(0);
    expect(s.append({ ...nudge('ses_a', 'x'), idempotencyKey: 'crd:cap:["2026-10","ses_a",null,0]' }).idempotencyKey).toBe('crd:cap:["2026-10","ses_a",null,0]');
  });
});

describe('blob storage paths', () => {
  const erase = (s: EventStore, scopeId: string) => s.eraseScope(scopeId, { actor: { kind: 'human', id: 'usr_approver' }, reason: 'pdpa_request' });

  it('never lets an erasure scope id escape the blob directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aoc-blobs-'));
    const s = mk(dir);
    s.append(nudge('ses_a', 'kept'));
    s.bodies.putBlob('att_1', 'tkt_1', Buffer.from('media'), '2026-10-09T00:00:00.000Z');
    for (const scope of ['..', '.', '', '../..']) erase(s, scope);
    expect(existsSync(join(dir, 'aoc.db'))).toBe(true);
    expect(existsSync(join(dir, 'bodies.db'))).toBe(true);
    expect(s.bodies.getBlob('att_1')?.toString()).toBe('media');
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps distinct scopes in distinct directories (erasing one never shreds another)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aoc-blobs-'));
    const s = mk(dir);
    s.bodies.putBlob('att_1', 'tkt/1', Buffer.from('slash'), '2026-10-09T00:00:00.000Z');
    s.bodies.putBlob('att_2', 'tkt_1', Buffer.from('underscore'), '2026-10-09T00:00:00.000Z');
    erase(s, 'tkt_1');
    expect(s.bodies.getBlob('att_2')).toBeNull();
    expect(s.bodies.getBlob('att_1')?.toString()).toBe('slash');
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('never writes a blob outside the blob directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aoc-blobs-'));
    const s = mk(dir);
    s.bodies.putBlob('escaped.bin', '..', Buffer.from('media'), '2026-10-09T00:00:00.000Z');
    expect(existsSync(join(dir, 'escaped.bin'))).toBe(false);
    expect(s.bodies.getBlob('escaped.bin')?.toString()).toBe('media');
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('request bodies are capped before any route reads them', () => {
  async function setup() {
    let reads = 0;
    const mod: AocModule = {
      name: 'echo',
      routes(app) {
        for (const path of ['/ingest/echo', '/api/echo', '/portal/api/echo']) {
          app.post(path, async (c) => {
            reads++;
            return c.json({ bytes: (await c.req.text()).length });
          });
        }
      },
    };
    const t = await createTestRuntime({ modules: [mod], config: { intake: { maxAttachments: 2, maxImageBytes: 1024, maxVideoBytes: 4096 } } });
    return { t, reads: () => reads };
  }

  it('rejects oversized unauthenticated bodies with 413, chunked or with a Content-Length', async () => {
    const { t, reads } = await setup();
    const chunked = await t.app.request('/api/echo', { method: 'POST', body: 'x'.repeat(MAX_BODY_BYTES.api + 1) });
    expect(chunked.status).toBe(413);
    const declared = await t.app.request('/api/echo', { method: 'POST', body: 'x', headers: { 'content-length': String(MAX_BODY_BYTES.api + 1) } });
    expect(declared.status).toBe(413);
    const ingest = await t.app.request('/ingest/echo', { method: 'POST', body: 'x'.repeat(MAX_BODY_BYTES.ingest + 1) });
    expect(ingest.status).toBe(413);
    expect(reads()).toBe(0);
    expect((await t.app.request('/api/echo', { method: 'POST', body: 'small' })).status).toBe(200);
    await t.close();
  });

  it('refuses anonymous ingest calls before a route reads the body', async () => {
    const { t, reads } = await setup();
    expect((await t.app.request('/ingest/echo', { method: 'POST', body: '{"partial": ' })).status).toBe(401);
    expect((await t.app.request('/ingest/echo', { method: 'POST', body: '{}', headers: { authorization: 'Bearer not-a-token' } })).status).toBe(401);
    expect(reads()).toBe(0);
    expect((await t.app.request('/ingest/echo', { method: 'POST', body: '{}', headers: t.ingestHeaders('observer') })).status).toBe(200);
    await t.close();
  });

  it('caps the intake portal at the configured attachment limits', async () => {
    const { t, reads } = await setup();
    const over = await t.app.request('/portal/api/echo', { method: 'POST', body: 'x'.repeat(2 * 4096 + MAX_BODY_BYTES.formOverhead + 1) });
    expect(over.status).toBe(413);
    expect(reads()).toBe(0);
    expect((await t.app.request('/portal/api/echo', { method: 'POST', body: 'x'.repeat(4096) })).status).toBe(200);
    await t.close();
  });
});
