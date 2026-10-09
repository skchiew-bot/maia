import type { ChildProcess } from 'node:child_process';

/**
 * Signal a child spawned with `detached: true` together with everything it started (its process group), so
 * a hook or command that forked helpers cannot linger and keep our pipes open.
 */
export function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}
