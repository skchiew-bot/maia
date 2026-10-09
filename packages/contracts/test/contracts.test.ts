import { describe, expect, it } from 'vitest';
import {
  ALL_EVENTS,
  EVENT_CATALOG,
  computeProgress,
  deriveLiveness,
  hasPermission,
  newId,
  requiredRoleFor,
  requiresPasskey,
  roleSatisfies,
  routeModel,
  ProcessTypeSchema,
  validateEvent,
  AocConfigSchema,
  transcriptPathFor,
  type LivenessInput,
} from '../src';

const base: LivenessInput = {
  lifecycle: 'running',
  processAlive: true,
  startedAt: 0,
  lastHeartbeatAt: 100_000,
  lastToolActivityAt: null,
  toolInFlightSince: null,
  lastStreamActivityAt: null,
  openDecisions: 0,
  throttledUntil: null,
};

describe('liveness precedence (§4)', () => {
  const now = 110_000;
  it('waiting beats throttled beats dead', () => {
    expect(deriveLiveness({ ...base, openDecisions: 1, throttledUntil: now + 1, processAlive: false }, now).state).toBe('waiting_on_you');
    expect(deriveLiveness({ ...base, throttledUntil: now + 1, processAlive: false }, now).state).toBe('throttled');
    expect(deriveLiveness({ ...base, processAlive: false }, now).state).toBe('dead');
  });
  it('dead on missing heartbeat, stalled on silence, working on tools, thinking otherwise', () => {
    expect(deriveLiveness({ ...base, lastHeartbeatAt: 0 }, 100_000).state).toBe('dead');
    // Stall threshold is 10 minutes of silence (CEO decision, 2026-10-09).
    expect(deriveLiveness({ ...base, lastHeartbeatAt: 540_000 }, 540_000).state).toBe('thinking');
    expect(deriveLiveness({ ...base, lastHeartbeatAt: 660_000 }, 660_000).state).toBe('stalled');
    expect(deriveLiveness({ ...base, lastToolActivityAt: 100_000 }, now).state).toBe('working');
    expect(deriveLiveness({ ...base, toolInFlightSince: 100_000 }, now).state).toBe('working');
    expect(deriveLiveness({ ...base, lastStreamActivityAt: 100_000 }, now).state).toBe('thinking');
  });
  it('ended sessions are not live', () => {
    expect(deriveLiveness({ ...base, lifecycle: 'ended' }, now).state).toBeNull();
  });
});

describe('progress (§4)', () => {
  const phases = [{ id: 'p1', name: 'One', order: 1 }, { id: 'p2', name: 'Two', order: 2 }];
  it('weights by size and hides ETA below 3 done', () => {
    const p = computeProgress(phases, [
      { id: 'a', phaseId: 'p1', size: 'xs', status: 'done' },
      { id: 'b', phaseId: 'p1', size: 'm', status: 'open' },
      { id: 'c', phaseId: 'p2', size: 'xl', status: 'removed' },
    ]);
    expect(p.totalWeight).toBe(4);
    expect(p.doneWeight).toBe(1);
    expect(p.pct).toBe(25);
    expect(p.etaMs).toBeNull();
    expect(p.etaHiddenReason).toBe('fewer_than_3_done');
    expect(p.phases[0]!.complete).toBe(false);
  });
});

describe('roles & decisions (§6)', () => {
  it('routes main/production/data to the approver, others to builders', () => {
    expect(requiredRoleFor({ kind: 'agent_decision', test: 'main' })).toBe('approver');
    expect(requiredRoleFor({ kind: 'agent_decision', test: 'ambiguity' })).toBe('builder');
    expect(requiredRoleFor({ kind: 'change_request', changeScope: 'reversible_off_main' })).toBe('builder');
    expect(requiredRoleFor({ kind: 'go_live' })).toBe('approver');
    expect(requiresPasskey('rollback')).toBe(true);
    expect(roleSatisfies('approver', 'builder')).toBe(true);
    expect(roleSatisfies('builder', 'approver')).toBe(false);
    expect(roleSatisfies('approver', 'requester')).toBe(false);
    expect(hasPermission('requester', 'session.view')).toBe(false);
    expect(hasPermission('builder', 'mapping.stamp', { complianceLead: true })).toBe(true);
    expect(hasPermission('approver', 'mapping.stamp')).toBe(false);
    expect(hasPermission('requester', 'mapping.stamp', { complianceLead: true })).toBe(false);
  });
});

describe('event catalog', () => {
  it('has unique types and strict meta', () => {
    expect(EVENT_CATALOG.size).toBe(ALL_EVENTS.length);
    expect(validateEvent('session.nudged', { sessionId: 'ses_1', text: 'free text!' }, { text: 'x' })[0]).toMatch(/meta/);
    expect(validateEvent('session.nudged', { sessionId: 'ses_1' }, { text: 'x' })).toEqual([]);
    expect(validateEvent('nope.nope', {}, null)[0]).toMatch(/unknown/);
  });
});

describe('registry + config + misc', () => {
  it('rejects discovery types not on opus and read-only types with credentials', () => {
    expect(ProcessTypeSchema.safeParse({ id: 'disc', name: 'D', class: 'discovery', model: 'sonnet' }).success).toBe(false);
    expect(ProcessTypeSchema.safeParse({ id: 'tri', name: 'T', class: 'triage', model: 'opus', readOnly: true, credentialProfile: 'prod' }).success).toBe(false);
    const t = ProcessTypeSchema.parse({ id: 'feat', name: 'F', class: 'execution', model: 'opus', executionModel: 'sonnet' });
    expect(routeModel(t, true)).toBe('sonnet');
    expect(routeModel(t, false)).toBe('opus');
  });
  it('backup events carry sizes, hashes and fingerprints only; backup settings are validated', () => {
    const meta = {
      backupId: 'bkp_01K0000000000000000ABCDEF1',
      file: 'aoc-backup-20261009T183005Z-0ABCDEF1.aocbk',
      bytes: 10,
      sha256: 'a'.repeat(64),
      keyId: '0123456789abcdef',
      kekId: 'fedcba9876543210',
      headSeq: 1,
      headHash: 'b'.repeat(64),
      files: 2,
      aocDbBytes: 1,
      bodiesDbBytes: 1,
      blobs: 0,
      blobBytes: 0,
      skippedBlobs: 0,
      bodiesMissing: 0,
      copied: null,
      pruned: 0,
      retained: 1,
    };
    expect(validateEvent('backup.completed', meta, null)).toEqual([]);
    expect(validateEvent('backup.completed', { ...meta, file: '/var/lib/aoc/backups/x.aocbk' }, null)).not.toEqual([]);
    expect(validateEvent('backup.completed', { ...meta, dir: '/home/someone' }, null)).not.toEqual([]);
    expect(validateEvent('backup.failed', { backupId: null, stage: 'copy', reason: 'copy_failed' }, { detail: 'exit 3' })).toEqual([]);
    expect(validateEvent('backup.failed', { backupId: null, stage: 'copy', reason: 'no such file /home/x' }, {})).not.toEqual([]);
    const audit = AocConfigSchema.parse({}).audit;
    expect(audit).toMatchObject({ backupDir: '.aoc/backups', backupAtLocalTime: '02:30', backupRetentionDays: 35, backupCopyCommand: [] });
    expect(audit.backupKeyFile).toBeUndefined();
    expect(AocConfigSchema.safeParse({ audit: { backupAtLocalTime: '2:30' } }).success).toBe(false);
    expect(AocConfigSchema.safeParse({ audit: { backupRetentionDays: 0 } }).success).toBe(false);
  });
  it('defaults config and builds ids/paths', () => {
    expect(AocConfigSchema.parse({}).port).toBe(7420);
    expect(newId('session')).toMatch(/^ses_[0-9A-Z]{26}$/);
    expect(transcriptPathFor('/home/u/my.repo', 'abc', '/h/.claude')).toBe('/h/.claude/projects/-home-u-my-repo/abc.jsonl');
  });
});
