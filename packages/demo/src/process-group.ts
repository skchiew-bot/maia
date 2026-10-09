/**
 * Process groups of the daemon a demo starts. aocd is spawned detached, so it leads its own group and the group is
 * aocd plus what aocd started and did not detach again: the per-session sidecars. A clean stop waits for those itself
 * (their last report goes through its API, and a stuck one is killed after a few seconds). They can outlive aocd only
 * when it is killed, and then they spool their final flush into the data directory (`sessions/<id>/sidecar/spool/`)
 * because the daemon is gone.
 */

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
