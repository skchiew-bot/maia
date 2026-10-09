import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ALL_EVENTS,
  AOC_ENV,
  EVENT_CATALOG,
  computeProgress,
  deriveLiveness,
  hasPermission,
  ID_PREFIX,
  idKindOf,
  INTAKE_ENVELOPE_BYTES,
  intakeRequestBytes,
  intakeTotalBytes,
  newId,
  requiredRoleFor,
  requiresPasskey,
  resolutionAssurance,
  roleSatisfies,
  RESOLUTION_ASSURANCE_LABEL,
  routeModel,
  ProcessTypeSchema,
  validateEvent,
  AocConfigSchema,
  projectSlug,
  promotionProfilesOf,
  promotionRemoteProblem,
  transcriptPathFor,
  transportOf,
  type LivenessInput,
  type ProcessEventRequest,
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
    // A guard-raised card (tests 1, 2, 5, all tool-boundary) goes to the Approver, whatever the test says.
    for (const test of ['main', 'production', 'data', null] as const)
      expect(requiredRoleFor({ kind: 'protected_operation', test })).toBe('approver');
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

  it('keeps an on-demand backup of the audit state with the Approver (audit.backup), apart from audit.verify', () => {
    expect(hasPermission('approver', 'audit.backup')).toBe(true);
    expect(hasPermission('builder', 'audit.backup')).toBe(false);
    expect(hasPermission('requester', 'audit.backup')).toBe(false);
    expect(hasPermission('builder', 'audit.verify')).toBe(true);
  });

  it('labels a bearer-token button as attribution and only a verified passkey as a signature (G-29)', () => {
    const label = (method: 'button' | 'passkey' | 'policy', passkeyVerified: boolean) =>
      RESOLUTION_ASSURANCE_LABEL[resolutionAssurance({ method, passkeyVerified })];
    expect(label('button', false)).toBe('Attribution (bearer token)');
    expect(label('passkey', true)).toBe('Signed (passkey)');
    expect(label('passkey', false)).toBe('Attribution (bearer token)');
    expect(label('policy', false)).toBe('Platform policy');
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
    expect(ID_PREFIX.backup).toBe('bkp');
    expect(newId('backup')).toMatch(/^bkp_[0-9A-Z]{26}$/);
    expect(idKindOf(newId('backup'))).toBe('backup');
    expect(transcriptPathFor('/home/u/my.repo', 'abc', '/h/.claude')).toBe('/h/.claude/projects/-home-u-my-repo/abc.jsonl');
  });
  // Expected slugs were produced by the slug function embedded in the Claude Code 2.1.295 binary (research C11).
  it('truncates project slugs past 200 characters and appends the cwd hash, like Claude Code', () => {
    const exactly200 = '/' + 'a'.repeat(199);
    expect(projectSlug(exactly200)).toBe('-' + 'a'.repeat(199));
    const nested = '/home/dev/' + 'very-long-directory-name/'.repeat(9) + 'repo';
    expect(projectSlug(nested)).toBe(
      '-home-dev-' + 'very-long-directory-name-'.repeat(7) + 'very-long-direc-gy7dfj',
    );
    // Non-ASCII characters count as one UTF-16 unit each and become '-'.
    expect(projectSlug('/srv/wörk/' + 'x'.repeat(195))).toBe('-srv-w-rk-' + 'x'.repeat(190) + '-q0c2ns');
    expect(projectSlug('/tmp/aoc-capture/work')).toBe('-tmp-aoc-capture-work');
  });
});

describe('intake upload allowance', () => {
  it('has one total, shared by the published limits and every request-body cap: one maximum-size video', () => {
    const defaults = AocConfigSchema.parse({}).intake;
    expect(intakeTotalBytes(defaults)).toBe(200 * 1024 * 1024);
    expect(INTAKE_ENVELOPE_BYTES).toBe(1024 * 1024);
    expect(intakeRequestBytes(defaults)).toBe(200 * 1024 * 1024 + INTAKE_ENVELOPE_BYTES);

    // Not attachments x the largest single allowance: more attachments never raise the total.
    const many = AocConfigSchema.parse({
      intake: { maxVideoBytes: 4096, maxImageBytes: 1024, maxAttachments: 9 },
    }).intake;
    expect(intakeTotalBytes(many)).toBe(4096);
    expect(intakeRequestBytes(many)).toBe(4096 + INTAKE_ENVELOPE_BYTES);
  });
});

describe('ingest wire types', () => {
  it('has no environment variable that lets a push to a protected ref through (AOC pushes from a service-owned clone)', () => {
    expect(Object.keys(AOC_ENV)).not.toContain('supervisorPush');
    expect(Object.values(AOC_ENV)).not.toContain('AOC_SUPERVISOR_PUSH');
  });

  it('a process exit report can name the process it is about, so a stale sidecar is told apart from the current one', () => {
    const named: ProcessEventRequest = { sessionId: 'ses_A', event: 'exited', exitCode: 0, signal: null, at: '2026-10-09T10:00:00.000Z', pid: 4242 };
    const unnamed: ProcessEventRequest = { sessionId: 'ses_A', event: 'exited', exitCode: null, signal: 'SIGKILL', at: '2026-10-09T10:00:00.000Z' };
    expectTypeOf<ProcessEventRequest['pid']>().toEqualTypeOf<number | null | undefined>();
    expect([named.pid, unnamed.pid]).toEqual([4242, undefined]);
  });
});

describe('promotion configuration (per-project remote and credential profile)', () => {
  const parse = (promotion: unknown) => AocConfigSchema.safeParse({ promotion });

  it('defaults to no project entries and the prod-promote profile', () => {
    const config = AocConfigSchema.parse({});
    expect(config.promotion).toEqual({ promoteCredentialProfile: 'prod-promote', projects: {} });
    expect(promotionProfilesOf(config)).toEqual(['prod-promote']);
  });

  it('takes a remote and a credential profile per project, and names every profile in use', () => {
    const config = AocConfigSchema.parse({
      promotion: {
        promoteCredentialProfile: 'release-bot',
        projects: {
          prj_web: { promotionRemote: 'git@github.com:acme/web.git', promoteCredentialProfile: 'web-promote' },
          prj_api: { promotionRemote: 'https://github.com/acme/api.git' },
          prj_ops: { promoteCredentialProfile: 'web-promote' },
          'prj.mirror:1': { promotionRemote: '/srv/git/mirror.git' },
        },
      },
    });
    expect(config.promotion.projects.prj_web).toEqual({
      promotionRemote: 'git@github.com:acme/web.git',
      promoteCredentialProfile: 'web-promote',
    });
    expect(promotionProfilesOf(config)).toEqual(['release-bot', 'web-promote']);
  });

  it('refuses a remote AOC would not push to, one with a credential in it, and a misspelt or malformed entry', () => {
    const remote = (promotionRemote: string) => parse({ projects: { prj_web: { promotionRemote } } });
    expect(remote('ssh://git@github.com/acme/web.git').success).toBe(true);
    for (const bad of [
      'http://github.com/acme/web.git',
      'git://github.com/acme/web.git',
      'ext::sh -c touch% /tmp/pwned',
      '-oProxyCommand=evil:x',
      'relative/web.git',
      '',
    ]) {
      const r = remote(bad);
      expect(r.success, bad).toBe(false);
      expect(r.error?.issues[0]?.path, bad).toEqual(['promotion', 'projects', 'prj_web', 'promotionRemote']);
    }
    const secret = 'https://x-access-token:ghs_SECRET@github.com/acme/web.git';
    const withSecret = remote(secret);
    expect(withSecret.success).toBe(false);
    expect(JSON.stringify(withSecret.error?.issues)).toContain('must not embed credentials');
    expect(JSON.stringify(withSecret.error?.issues)).not.toContain('ghs_SECRET'); // a message never echoes the URL
    expect(remote('https://ghs_SECRET@github.com/acme/web.git').success).toBe(false);
    expect(remote('ssh://git:ghs_SECRET@github.com/acme/web.git').success).toBe(false);

    expect(parse({ projects: { prj_web: { promotionRemotee: '/srv/git/web.git' } } }).success).toBe(false);
    expect(parse({ projects: { 'not a project': { promotionRemote: '/srv/git/web.git' } } }).success).toBe(false);
    expect(parse({ projects: { prj_web: { promoteCredentialProfile: 'has spaces' } } }).success).toBe(false);
    expect(parse({ promoteCredentialProfile: '' }).success).toBe(false);
  });

  it('judges transports and embedded credentials the same way for every consumer', () => {
    expect(transportOf('git@github.com:org/app.git')).toBe('ssh');
    expect(transportOf('ssh://git@github.com/org/app.git')).toBe('ssh');
    expect(transportOf('https://github.com/org/app.git')).toBe('https');
    expect(transportOf('/srv/git/app.git')).toBe('file');
    expect(transportOf('file:///srv/git/app.git')).toBe('file');
    expect(transportOf('helper::address')).toBeNull();
    expect(promotionRemoteProblem('git@github.com:org/app.git')).toBeNull();
    expect(promotionRemoteProblem('ssh://git@github.com/org/app.git')).toBeNull();
    expect(promotionRemoteProblem('https://github.com/org/app.git')).toBeNull();
    expect(promotionRemoteProblem('https://github.com/org/app@v1')).toBeNull();
    expect(promotionRemoteProblem('http://github.com/org/app.git')).toMatch(/ssh, https or absolute/);
  });
});
