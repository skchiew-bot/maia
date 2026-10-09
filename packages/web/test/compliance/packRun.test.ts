import { describe, expect, it } from 'vitest';
import type { EvidencePackJobDTO } from '@aoc/contracts';
import { ApiError } from '../../src/api';
import {
  isPending,
  jobPath,
  refusalOf,
  requestedRun,
  retryText,
  runOfAnswer,
  runOfJob,
} from '../../src/pages/compliance/packRun';
import { pack } from '../governance/fixtures';

const JOB: EvidencePackJobDTO = {
  jobId: 'evj_abc',
  status: 'queued',
  from: '2026-10-03',
  to: '2026-10-09',
  requestedBy: 'usr_ceo',
  requestedAt: '2026-10-09T07:00:00.000Z',
  position: 2,
  pack: null,
  error: null,
  statusUrl: '/api/evidence/jobs/evj_abc',
};

describe('what a pack request answers', () => {
  it('reads a job (202) and a pack built within the request (201) as the same kind of run', () => {
    expect(runOfAnswer(JOB)).toMatchObject({ jobId: 'evj_abc', status: 'queued', position: 2, pack: null });
    const built = runOfAnswer({ ...pack(), integrity: 'ok', manifest: null });
    expect(built).toMatchObject({ jobId: null, status: 'done', from: '2026-10-03', to: '2026-10-09' });
    expect(built?.pack?.packId).toBe(pack().packId);
  });

  it('refuses to guess at anything else', () => {
    expect(runOfAnswer(null)).toBeNull();
    expect(runOfAnswer('queued')).toBeNull();
    expect(runOfAnswer({ status: 'queued' })).toBeNull();
  });

  it('keeps following only what is queued or running, and only by the job id it was given', () => {
    expect(isPending(runOfJob(JOB))).toBe(true);
    expect(isPending(runOfJob({ ...JOB, status: 'running', position: null }))).toBe(true);
    expect(isPending(runOfJob({ ...JOB, status: 'done', position: null, pack: pack() }))).toBe(false);
    expect(isPending(runOfJob({ ...JOB, status: 'failed', error: 'boom' }))).toBe(false);
    expect(isPending(requestedRun('2026-10-03', '2026-10-09'))).toBe(true);
    expect(isPending(null)).toBe(false);
    // The daemon's statusUrl is not followed: the path is built from the id.
    expect(jobPath('evj_a/../../x')).toBe('/api/evidence/jobs/evj_a%2F..%2F..%2Fx');
  });
});

describe('a refused request (429)', () => {
  const refused = (code: string, details: unknown) =>
    new ApiError(429, code, 'At most 12 evidence packs per user per hour', details);

  it('keeps the daemon wording, the retry delay and the pack that is already pending', () => {
    const r = refusalOf(refused('pack_pending', { jobId: 'evj_old', retryAfterMs: 10_000 }));
    expect(r).toEqual({
      code: 'pack_pending',
      message: 'At most 12 evidence packs per user per hour',
      retryAfterMs: 10_000,
      jobId: 'evj_old',
    });
    expect(retryText(r!)).toBe('Try again in 10s.');
    expect(retryText(refusalOf(refused('rate_limited', { jobId: null, retryAfterMs: 1_800_000 }))!)).toBe(
      'Try again in 30m.',
    );
  });

  it('says nothing about a delay it was not given, and ignores other failures', () => {
    expect(retryText(refusalOf(refused('queue_full', undefined))!)).toBeNull();
    expect(refusalOf(new ApiError(500, 'internal', 'Internal error'))).toBeNull();
    expect(refusalOf(new Error('network'))).toBeNull();
  });
});
