import { readdirSync } from 'node:fs';
import type { AocClient } from '@aoc/client';

export interface SpoolTarget {
  spoolDir: string;
  daemonUrl: string | null;
  token: string | null;
}

/** Loaded lazily: @aoc/client imports the contracts barrel, a cost only the rare spool/flush paths should pay. */
export async function loadClient(t: SpoolTarget, fetchImpl?: typeof fetch): Promise<AocClient> {
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
 * ~budgetMs; anything not delivered in time is re-spooled by the client for the next successful call. The deadline
 * starts once the client is loaded: a cold import can take the whole budget, and the replay would then never run.
 */
export async function flushSpoolBounded(t: SpoolTarget, budgetMs = 1000, load = loadClient): Promise<void> {
  if (!t.daemonUrl || !hasSpooled(t.spoolDir)) return;
  let deadline: AbortSignal | null = null;
  const fetchImpl: typeof fetch = (input, init) => {
    deadline ??= AbortSignal.timeout(budgetMs);
    return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
  };
  try {
    const client = await load(t, fetchImpl);
    deadline = AbortSignal.timeout(budgetMs);
    await client.flushSpool();
  } catch {
    // best effort: the spool stays on disk
  }
}
