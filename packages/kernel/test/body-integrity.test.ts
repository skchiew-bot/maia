/**
 * The encrypted body store next to the chain (§13): a tampered body is reported, never trusted; an erasure never
 * destroys data it cannot record; a second process on the same files can never fork the chain.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EventStore, FakeClock, forSeeds, silentLogger, type NewEvent, type Projector } from '../src';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const mk = (dir = ':memory:', key = randomBytes(32)) =>
  new EventStore({ dataDir: dir, clock: new FakeClock(), log: silentLogger, masterKey: key });

const nudge = (sessionId: string, text: string, extra: Partial<NewEvent> = {}): NewEvent => ({
  type: 'session.nudged',
  actor: { kind: 'human', id: 'usr_1' },
  scope: { sessionId },
  meta: { sessionId },
  payload: { text },
  source: 'api',
  ...extra,
});

describe('body integrity (§13)', () => {
  it('verifyBody reports a tampered or transplanted ciphertext as false, as documented, and never throws', () => {
    const s = mk();
    const a = s.append(nudge('ses_a', 'first body'));
    const b = s.append(nudge('ses_a', 'second body'));
    expect(s.verifyBody(a)).toBe(true);

    // One flipped bit of ciphertext.
    const row = s.bodies.db.prepare('SELECT ct FROM bodies WHERE event_id = ?').get(a.id) as { ct: Uint8Array };
    const ct = Buffer.from(row.ct);
    ct[0] = ct[0]! ^ 1;
    s.bodies.db.prepare('UPDATE bodies SET ct = ? WHERE event_id = ?').run(ct, a.id);
    expect(s.verifyBody(a)).toBe(false);
    expect(s.verifyBody(b)).toBe(true);

    // B's valid sealed box moved under A's event id: the AAD binds a body to its event.
    const other = s.bodies.db.prepare('SELECT nonce, ct, tag FROM bodies WHERE event_id = ?').get(b.id) as { nonce: Uint8Array; ct: Uint8Array; tag: Uint8Array };
    s.bodies.db.prepare('UPDATE bodies SET nonce = ?, ct = ?, tag = ? WHERE event_id = ?').run(other.nonce, other.ct, other.tag, a.id);
    expect(s.verifyBody(a)).toBe(false);
  });

  it('eraseScope refuses, before destroying anything, an erasure it could not record on the chain', () => {
    const s = mk();
    const scope = 'z'.repeat(70); // longer than a body.erased scopeId may be
    const e = s.append(nudge('ses_a', 'quarterly report draft', { bodyScope: scope }));
    expect(s.readPayload(e)).toEqual({ text: 'quarterly report draft' });
    expect(() => s.eraseScope(scope, { actor: { kind: 'human', id: 'usr_1' }, reason: 'pdpa_request' })).toThrow();
    // Nothing was recorded, so nothing may have been shredded.
    expect(s.list({ types: ['body.erased'] })).toHaveLength(0);
    expect(s.readPayload(e)).toEqual({ text: 'quarterly report draft' });
    expect(s.bodies.isErased(scope)).toBe(false);
  });

  it('a projector that fails to scrub aborts the erasure before the bodies are shredded', () => {
    const s = mk();
    const p: Projector = {
      name: 'stubborn',
      tables: [],
      ddl: [],
      apply() {},
      onErase() {
        throw new Error('cannot scrub');
      },
    };
    s.registerProjector(p);
    const e = s.append(nudge('ses_a', 'secret'));
    expect(() => s.eraseScope('ses_a', { actor: { kind: 'human', id: 'usr_1' }, reason: 'secret_leak' })).toThrow('cannot scrub');
    expect(s.readPayload(e)).toEqual({ text: 'secret' });
    expect(s.list({ types: ['body.erased'] })).toHaveLength(0);
  });
});

describe('a second process on the same files (sole-writer rule, §15.1)', () => {
  it('can never fork the chain: a stale writer fails cleanly, every success is in the chain, and the chain verifies', async () => {
    await forSeeds('kernel two writers', (rng) => {
      const dir = mkdtempSync(join(tmpdir(), 'aoc-twowriters-'));
      dirs.push(dir);
      const key = randomBytes(32);
      const a = mk(dir, key);
      const b = mk(dir, key);
      const accepted: string[] = [];
      for (let i = 0; i < rng.int(10, 30); i++) {
        const writer = rng.chance(0.5) ? a : b;
        try {
          const e = writer.append(nudge('ses_a', `w${i}`));
          accepted.push(e.id);
        } catch {
          // A cached head that fell behind the other writer: the append is refused, never written onto a stale link.
        }
      }
      const chain = a.list({ limit: 100_000 });
      expect(chain.map((e) => e.id)).toEqual(expect.arrayContaining(accepted));
      expect(chain).toHaveLength(accepted.length);
      expect(a.verifyChain()).toMatchObject({ ok: true, checked: accepted.length });
      expect(b.verifyChain()).toMatchObject({ ok: true, checked: accepted.length });
      a.close();
      b.close();
    });
  });
});
