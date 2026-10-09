import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { groupExited, groupRunning } from '../src/process-group';

async function until(what: string, ok: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('process groups of the demo daemon', () => {
  it('lists what runs in a group, and no process that has ended but is not reaped yet', async () => {
    // A leader and a background child, like aocd and a sidecar: killed together, the child is an orphan that init
    // reaps at its own pace, so the group can stay "alive" with nothing in it running.
    const leader = spawn('sh', ['-c', 'sleep 60 & wait'], { detached: true, stdio: 'ignore' });
    const pgid = leader.pid!;
    await until('the leader and its child', () => groupRunning(pgid).length === 2);
    expect(groupRunning(pgid).map((line) => line.split(/\s+/)[0])).toContain(String(pgid));

    process.kill(-pgid, 'SIGKILL');
    await until('the group to have nothing running', () => groupRunning(pgid).length === 0);
    expect(await groupExited(pgid, 15_000)).toBe(true);
  });
});
