import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

let h: Harness | null = null;
afterEach(async () => {
  h?.releaseSidecars();
  await h?.close();
  h = null;
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('the supervisor lets its sidecars send their last report before aocd stops', () => {
  it('waits for the sidecar of a session that has just ended, and keeps its token valid until then', async () => {
    h = await createHarness({ sidecarHold: true });
    const id = await h.launch('Build');
    await h.waitLifecycle(id, 'idle');
    await h.waitFor(() => h!.sidecarSignals().length === 1, 'the sidecar to be told to report its last usage');
    const token = h.sidecarCalls()[0]!.env.AOC_INGEST_TOKEN!;
    await h.sup.stop(id, true, h.ownerActor); // the session ends while its sidecar is still flushing
    expect(h.lifecycle(id)).toBe('ended');
    expect(h.t.identity!.verifyIngestToken(token)).not.toBeNull();

    // aocd's first phase of a stop, while it still serves requests: the module's quiesce hook.
    let settled = false;
    const quiesced = h.t.rt.quiesce().then(() => (settled = true));
    await sleep(400);
    expect(settled).toBe(false);
    expect(h.sidecarSignals().length).toBeGreaterThanOrEqual(2); // told again, and still running
    expect(h.t.identity!.verifyIngestToken(token)).not.toBeNull(); // its last report is still welcome

    h.releaseSidecars();
    await quiesced;
    expect(h.t.identity!.verifyIngestToken(token)).toBeNull(); // no token survives the stop
  });

  it('interrupts a running turn and waits for that turn’s sidecar too, appending nothing', async () => {
    h = await createHarness({ sidecarHold: true });
    const id = await h.launch('[[fake:hang]] Build');
    await h.waitFor(() => h!.callsFor(id).length === 1 && h!.sidecarCalls().length === 1, 'the turn and its sidecar to start');
    let settled = false;
    const done = h.sup.shutdown().then(() => (settled = true));
    await h.waitFor(() => h!.sidecarSignals().length >= 1, 'the sidecar to be told to report what is left');
    await sleep(300);
    expect(settled).toBe(false);
    h.releaseSidecars();
    await done;
    expect(h.events('session.turn_ended', id)).toEqual([]); // the next start marks the turn Dead
  });

  it('gives a sidecar that never finishes only the flush time, then kills it', async () => {
    h = await createHarness({ sidecarStubborn: true, module: { sidecarFlushMs: 300 } });
    const id = await h.launch('Build');
    await h.waitLifecycle(id, 'idle');
    await h.waitFor(() => h!.sidecarSignals().length === 1, 'the sidecar to be told to stop');
    const { pid } = h.sidecarSignals()[0]!;
    expect(alive(pid)).toBe(true);
    const started = Date.now();
    await h.sup.shutdown();
    expect(Date.now() - started).toBeLessThan(3000);
    await h.waitFor(() => !alive(pid), 'the stuck sidecar to be killed', 3000);
  });

  it('starts nothing new once it winds down, although aocd still answers requests', async () => {
    h = await createHarness({ sidecarHold: true });
    const id = await h.launch('Build');
    await h.waitLifecycle(id, 'idle');
    await h.waitFor(() => h!.sidecarSignals().length === 1, 'the sidecar to be told to stop');
    const done = h.sup.shutdown(); // waits on the held sidecar
    await expect(h.launch('Another build')).rejects.toMatchObject({ status: 503, code: 'shutting_down' });
    await expect(h.sup.nudge(id, 'carry on', h.ownerActor)).rejects.toMatchObject({ status: 503, code: 'shutting_down' });
    expect(h.events('session.launch_requested')).toHaveLength(1);
    expect(h.calls()).toHaveLength(1);
    h.releaseSidecars();
    await done;
  });
});
