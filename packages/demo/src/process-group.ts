/**
 * Process groups of the daemon a demo starts. aocd is spawned detached, so it leads its own group and the group is
 * aocd plus what aocd started and did not detach again: the per-session sidecars. aocd SIGTERMs those as it shuts
 * down but does not wait for them, so they outlive it for their final flush, which they spool into the data
 * directory (`sessions/<id>/sidecar/spool/`) because the daemon is already gone.
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
