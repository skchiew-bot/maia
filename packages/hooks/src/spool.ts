import { readdirSync } from 'node:fs';
import type { AocClient } from '@aoc/client';

export interface SpoolTarget {
  spoolDir: string;
  daemonUrl: string | null;
  token: string | null;
}

/** Loaded lazily: @aoc/client imports the contracts barrel, a cost only the rare spool/flush paths should pay. */
async function loadClient(t: SpoolTarget, fetchImpl?: typeof fetch): Promise<AocClient> {
  const { createClient } = await import('@aoc/client');
  return createClient({
    daemonUrl: t.daemonUrl ?? '',
    token: t.token,
    spoolDir: t.spoolDir,
    retries: 1,
    fetchImpl,
  });
}

/** Buffers a request in the shared JSONL spool format (replayed through /ingest/spool). False if the disk write failed. */
export async function spoolRequest(t: SpoolTarget, path: string, body: unknown, now: Date): Promise<boolean> {
  try {
    (await loadClient(t)).spool({ path, body, queuedAt: now.toISOString() });
    return true;
  } catch {
    return false;
  }
}

function hasSpooled(spoolDir: string): boolean {
  try {
    return readdirSync(spoolDir).some((f) => f.endsWith('.jsonl'));
  } catch {
    return false;
  }
}

/**
 * Opportunistic replay after a successful call. All requests share one deadline so the hook still exits within
 * ~budgetMs; anything not delivered in time is re-spooled by the client for the next successful call.
 */
export async function flushSpoolBounded(t: SpoolTarget, budgetMs = 1000): Promise<void> {
  if (!t.daemonUrl || !hasSpooled(t.spoolDir)) return;
  const deadline = AbortSignal.timeout(budgetMs);
  const fetchImpl: typeof fetch = (input, init) =>
    fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
  try {
    await (await loadClient(t, fetchImpl)).flushSpool();
  } catch {
    // best effort: the spool stays on disk
  }
}
