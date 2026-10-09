import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EventStore, FakeClock, silentLogger, type NewEvent } from '../src';

const restart = (i: number): NewEvent<'session.restarted'> => ({
  type: 'session.restarted',
  actor: { kind: 'human', id: 'usr_1' },
  scope: { sessionId: `ses_${i % 40}` },
  meta: { sessionId: `ses_${i % 40}` },
  source: 'api',
});

function fill(s: EventStore, n: number, offset = 0): void {
  for (let i = 0; i < n; i += 1000) {
    s.appendMany(Array.from({ length: Math.min(1000, n - i) }, (_, j) => restart(offset + i + j)));
  }
}

const dirs: string[] = [];
function open(dir = mkdtempSync(join(tmpdir(), 'aoc-verify-')), key = randomBytes(32)) {
  dirs.push(dir);
  return { dir, key, store: new EventStore({ dataDir: dir, clock: new FakeClock(), log: silentLogger, masterKey: key }) };
}
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('EventStore.verifyChainAsync', () => {
  it('gives the same result as the synchronous pass, for an intact chain and a recomputed forgery', async () => {
    const { dir, key, store } = open();
    fill(store, 2345);
    const atSeqs = [1, 1000, 2345];
    const sync = store.verifyChain({ atSeqs });
    expect(sync).toMatchObject({ ok: true, headSeq: 2345, checked: 2345, firstBadSeq: null });
    expect(await store.verifyChainAsync({ atSeqs, batch: 100 })).toEqual(sync);
    store.close();

    // Rewrite one event behind the store's back (triggers dropped): both passes find the same first bad seq.
    const raw = new DatabaseSync(join(dir, 'aoc.db'));
    raw.exec('DROP TRIGGER events_append_only_u');
    raw.exec(`UPDATE events SET meta = '{"sessionId":"ses_x"}' WHERE seq = 1200`);
    raw.close();
    const reopened = open(dir, key).store;
    const bad = reopened.verifyChain({ atSeqs });
    expect(bad).toMatchObject({ ok: false, firstBadSeq: 1200 });
    expect(await reopened.verifyChainAsync({ atSeqs, batch: 64 })).toEqual(bad);
    reopened.close();
  });

  it('verifies the events present when called; events appended meanwhile wait for the next run', async () => {
    const { store } = open();
    fill(store, 3000);
    const running = store.verifyChainAsync({ batch: 200 });
    let appended = 0;
    await new Promise<void>((resolve) => {
      const tick = () => {
        store.append(restart(10_000 + appended));
        if (++appended < 20) setImmediate(tick);
        else resolve();
      };
      setImmediate(tick);
    });
    const v = await running;
    expect(v).toMatchObject({ ok: true, headSeq: 3000, checked: 3000 });
    expect(store.head().seq).toBe(3020);
    expect(await store.verifyChainAsync()).toMatchObject({ ok: true, headSeq: 3020, headHash: store.head().hash });
    expect(await store.verifyChainAsync({ toSeq: 10 })).toMatchObject({ ok: true, headSeq: 10, checked: 10 });
    store.close();
  });

  it('can be aborted between chunks', async () => {
    const { store } = open();
    fill(store, 1000);
    const ctl = new AbortController();
    const running = store.verifyChainAsync({ batch: 100, signal: ctl.signal });
    ctl.abort();
    await expect(running).rejects.toThrow(/abort/i);
    store.close();
  });

  describe('on a large synthetic chain', () => {
    let store: EventStore;
    let server: Server;
    let url: string;
    let served = 0;
    // Filling the chain is slow when every package's tests run in parallel: give the hook its own budget.
    beforeAll(async () => {
      store = open().store;
      fill(store, 15_000);
      server = createServer((_req, res) => {
        served++;
        res.end('ok');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    }, 120_000);
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    });
    afterEach(() => {
      served = 0;
    });

    it('keeps the event loop serving HTTP while it verifies', async () => {
      await (await fetch(url)).text(); // warm the client and server up
      let done = false;
      let ticks = 0;
      const ticker = setInterval(() => ticks++, 0);
      const verifying = store.verifyChainAsync().then((v) => {
        done = true;
        return v;
      });
      const answer = await (await fetch(url)).text();
      const answeredWhileVerifying = !done;
      const v = await verifying;
      clearInterval(ticker);
      expect(answer).toBe('ok');
      expect(answeredWhileVerifying).toBe(true);
      expect(served).toBe(2);
      expect(ticks).toBeGreaterThan(5);
      expect(v).toMatchObject({ ok: true, headSeq: 15_000, checked: 15_000, headHash: store.head().hash });
    }, 60_000);
  });
});
