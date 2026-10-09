import { useEffect, useRef } from 'react';
import type { EvidencePackJobDTO, EvidencePackSummaryDTO } from '@aoc/contracts';
import { ApiError, apiGet } from '../../api';
import { formatAge } from '../../lib/format';

/**
 * Evidence packs are built one at a time. POST /api/evidence/packs answers 201 with the pack when nothing else was
 * building, 202 with a job (poll it) when the request had to wait, and 429 when the caller already has a pack
 * pending, is over the hourly budget or the queue is full. A pack request is therefore a run that is followed from
 * the answer to the finished pack, never a download that is assumed to be ready.
 */
export type PackRunStatus = EvidencePackJobDTO['status'];

export interface PackRun {
  /** The job to poll; null while the request is in flight and for a pack built within the request itself. */
  jobId: string | null;
  status: PackRunStatus;
  from: string;
  to: string;
  /** 1 builds next; null once started. */
  position: number | null;
  pack: EvidencePackSummaryDTO | null;
  error: string | null;
}

export const RUN_WORD: Record<PackRunStatus, string> = {
  queued: 'Queued',
  running: 'Building',
  done: 'Ready',
  failed: 'Failed',
};

export const POLL_MS = 2000;

export const isPending = (run: PackRun | null): boolean =>
  run?.status === 'queued' || run?.status === 'running';

/** The request is out and nothing is known yet: the common case is that it starts building at once. */
export const requestedRun = (from: string, to: string): PackRun => ({
  jobId: null,
  status: 'running',
  from,
  to,
  position: null,
  pack: null,
  error: null,
});

export const runOfJob = (job: EvidencePackJobDTO): PackRun => ({
  jobId: job.jobId,
  status: job.status,
  from: job.from,
  to: job.to,
  position: job.position,
  pack: job.pack,
  error: job.error,
});

export const runOfPack = (pack: EvidencePackSummaryDTO): PackRun => ({
  jobId: null,
  status: 'done',
  from: pack.from,
  to: pack.to,
  position: null,
  pack,
  error: null,
});

/** What the daemon answered to a pack request (a pack or a job), or null for anything else. */
export function runOfAnswer(body: unknown): PackRun | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  if (typeof o.jobId === 'string' && typeof o.status === 'string')
    return runOfJob(body as EvidencePackJobDTO);
  if (typeof o.packId === 'string') return runOfPack(body as EvidencePackSummaryDTO);
  return null;
}

/** Where a queued or running job is read. Built from the id, never from a URL the daemon sent. */
export const jobPath = (jobId: string): string => `/api/evidence/jobs/${encodeURIComponent(jobId)}`;

/** Why the daemon would not take the request (HTTP 429), in its own words. */
export interface Refusal {
  code: string;
  message: string;
  retryAfterMs: number | null;
  /** The caller's own pack that is still pending (code `pack_pending`). */
  jobId: string | null;
}

export function refusalOf(err: unknown): Refusal | null {
  if (!(err instanceof ApiError) || err.status !== 429) return null;
  const d = (err.details && typeof err.details === 'object' ? err.details : {}) as Record<string, unknown>;
  return {
    code: err.code,
    message: err.message,
    retryAfterMs:
      typeof d.retryAfterMs === 'number' && Number.isFinite(d.retryAfterMs) ? d.retryAfterMs : null,
    jobId: typeof d.jobId === 'string' ? d.jobId : null,
  };
}

export const retryText = (r: Refusal): string | null =>
  r.retryAfterMs === null ? null : `Try again in ${formatAge(r.retryAfterMs)}.`;

/** The job is gone (aocd restarted: the queue is operational state, not in the chain). */
const forgotten = (run: PackRun): PackRun => ({
  ...run,
  status: 'failed',
  position: null,
  error:
    'The daemon no longer has this job (it may have restarted). Check the list of packs: it is there if it finished.',
});

/**
 * Follows a queued or running job until it is done or failed, reading its status every `pollMs`. `onChange` gets
 * every status read (it is called from a timer, never during render).
 */
export function useFollowRun(run: PackRun | null, onChange: (next: PackRun) => void, pollMs = POLL_MS): void {
  const latest = useRef({ run, onChange });
  useEffect(() => {
    latest.current = { run, onChange };
  });
  const jobId = run && isPending(run) ? run.jobId : null;

  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let next: PackRun | null = null;
      try {
        next = runOfJob(await apiGet<EvidencePackJobDTO>(jobPath(jobId)));
      } catch (err) {
        const known = latest.current.run;
        // A blip (network, 5xx) keeps the last status and tries again; only "no such job" ends the wait.
        if (err instanceof ApiError && err.status === 404 && known) next = forgotten(known);
      }
      if (stopped) return;
      if (next) latest.current.onChange(next);
      if (!next || isPending(next)) timer = setTimeout(poll, pollMs);
    };
    timer = setTimeout(poll, pollMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [jobId, pollMs]);
}
