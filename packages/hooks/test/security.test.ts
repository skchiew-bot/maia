import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deadUrl, managedEnv, postToolUse, readSpool, runHookBinary, startFakeDaemon, stop, tmp, type FakeDaemon } from './helpers';
import { resolveMode } from '../src/mode';
import { flushSpoolBounded, loadClient } from '../src/spool';

let daemon: FakeDaemon | null = null;
afterEach(async () => {
  await daemon?.close();
  daemon = null;
});

describe('managed spools are per session', () => {
  it("never replays (and so never loses) another session's spooled events", async () => {
    const home = tmp(); // one OS user, two managed sessions, no AOC_SPOOL_DIR from the launcher
    const B = 'ses_01JTESTBBBBBBBBBBBBBBBBBBBB';
    const A = 'ses_01JTESTAAAAAAAAAAAAAAAAAAAA';
    const down = await runHookBinary('PostToolUse', postToolUse(), managedEnv(home, await deadUrl(), { AOC_SESSION_ID: B }));
    expect(down.code).toBe(0);
    const spoolOfB = (resolveMode(managedEnv(home, 'http://x', { AOC_SESSION_ID: B }), home) as { spoolDir: string }).spoolDir;
    expect(readSpool(spoolOfB)).toHaveLength(1);

    // The daemon refuses items that belong to another session's token (as /ingest/spool does) and the client then
    // deletes them, so session A must never pick up B's spool in the first place.
    daemon = await startFakeDaemon((r) =>
      r.path === '/ingest/spool'
        ? { status: 200, json: { accepted: 0, duplicates: 0, rejected: r.body.items.length } }
        : { status: 200, json: { exitCode: 0 } },
    );
    const up = await runHookBinary('Stop', stop('/tmp/none.jsonl'), managedEnv(home, daemon.url, { AOC_SESSION_ID: A }));
    expect(up.code).toBe(0);
    expect(daemon.requests.map((r) => r.path)).toEqual(['/ingest/hook']);
    expect(readSpool(spoolOfB)).toHaveLength(1);
  });

  it('keeps an explicit AOC_SPOOL_DIR as given', () => {
    const home = tmp();
    const dir = join(home, 'custom');
    expect(resolveMode(managedEnv(home, 'http://x', { AOC_SPOOL_DIR: dir }), home)).toMatchObject({ spoolDir: dir });
  });
});

describe('the spool replay budget covers the replay, not the client import', () => {
  it('replays the spool even when a cold start spends the whole budget loading the client', async () => {
    const dir = tmp();
    const target = { spoolDir: dir, daemonUrl: '', token: 't' };
    (await loadClient(target)).spool({ path: '/ingest/hook', body: { n: 1 }, queuedAt: new Date().toISOString() });
    daemon = await startFakeDaemon((r) => ({ status: 200, json: { accepted: r.body.items.length, duplicates: 0, rejected: 0 } }));
    const coldLoad: typeof loadClient = async (t, fetchImpl) => {
      await new Promise((r) => setTimeout(r, 3500)); // the lazy import of @aoc/client on a cold, busy host
      return loadClient(t, fetchImpl);
    };
    await flushSpoolBounded({ ...target, daemonUrl: daemon.url }, 3000, coldLoad);
    expect(daemon.requests.map((r) => r.path)).toEqual(['/ingest/spool']);
    expect(readSpool(dir)).toHaveLength(0);
  });
});
