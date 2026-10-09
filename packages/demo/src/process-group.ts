/**
 * Process groups of the daemon a demo starts. aocd is spawned detached, so it leads its own group and the group is
 * aocd plus what aocd started and did not detach again: the per-session sidecars. A clean stop waits for those itself
 * (their last report goes through its API, and a stuck one is killed after a few seconds). They can outlive aocd only
 * when it is killed, and then they spool their final flush into the data directory (`sessions/<id>/sidecar/spool/`)
 * because the daemon is gone.
 */
import { spawnSync } from 'node:child_process';

/**
 * The processes in the group that have not ended, one `ps` line each (pid, parent, group, state, age in seconds,
 * command). A zombie is not one: it ended and waits to be reaped, which for an orphan (its parent is gone) is up to
 * init's pace, a couple of seconds on some hosts.
 */
export function groupRunning(pgid: number): string[] {
  const ps = spawnSync('ps', ['-eo', 'pid,ppid,pgid,stat,etimes,args'], { encoding: 'utf8' });
  return ps.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      const [, , group, state] = line.split(/\s+/);
      return Number(group) === pgid && !state!.startsWith('Z');
    })
    .map((line) => line.slice(0, 240));
}

/** True while any process is left in the group (a zombie counts until it is reaped). */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false; // ESRCH: the group is empty (EPERM would be somebody else's group, not ours)
  }
}

/** Resolves true once the group is empty, false when `ms` ran out first. */
export async function groupExited(pgid: number, ms: number, pollMs = 100): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return true;
}
