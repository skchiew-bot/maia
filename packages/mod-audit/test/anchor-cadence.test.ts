import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TestRuntime } from '@aoc/kernel';
import { auditRuntime, nudge, type AuditTest } from './helpers';

let a: AuditTest | null = null;
afterEach(async () => {
  await a?.t.close();
  a = null;
});

const anchors = (t: TestRuntime) => t.rt.store.list({ types: ['anchor.created'] });
const failures = (t: TestRuntime) => t.rt.store.list({ types: ['anchor.failed'] });

/** Lets queued reactions run, then waits for the anchors they queued on the audit service. */
async function settle(x: AuditTest): Promise<void> {
  await x.t.rt.drain();
  await x.mod.service().idle();
}

function breakglassApproved(t: TestRuntime) {
  return t.rt.store.append({
    type: 'breakglass.approved',
    actor: { kind: 'human', id: 'usr_approver' },
    meta: {
      breakglassId: 'bg_1',
      decisionId: 'dec_1',
      approverId: 'usr_approver',
      passkeyVerified: true,
      postIncidentChangeId: 'chg_1',
      dueAt: '2026-10-10T02:00:00.000Z',
    },
    source: 'api',
  });
}

function decisionResolved(t: TestRuntime, method: 'button' | 'passkey' | 'policy') {
  return t.rt.store.append({
    type: 'decision.resolved',
    actor: method === 'policy' ? { kind: 'system', id: 'credits' } : { kind: 'human', id: 'usr_approver' },
    meta: {
      decisionId: `dec_${method}`,
      kind: 'credit_topup',
      optionId: 'approve',
      resolvedBy: method === 'policy' ? 'policy' : 'usr_approver',
      method,
      passkeyVerified: method === 'passkey',
      selfApproved: false,
      ageMs: 1000,
    },
    payload: {},
    source: method === 'policy' ? 'system' : 'api',
  });
}

describe('anchoring between nightly runs (G-40)', () => {
  it('a break-glass approval is followed by an anchor that covers it', async () => {
    a = await auditRuntime({ config: { audit: { anchorAfterEvents: true } } });
    const { t } = a;
    await settle(a);
    const before = anchors(t).length;
    const e = breakglassApproved(t);
    await settle(a);
    const after = anchors(t);
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)!.meta.seq).toBeGreaterThanOrEqual(e.seq);
    expect(await a.mod.service().verify()).toMatchObject({ ok: true });
  });

  it('a burst of high-value events yields one anchor; routine events and policy resolutions yield none', async () => {
    a = await auditRuntime({ config: { audit: { anchorAfterEvents: true } } });
    const { t } = a;
    await settle(a);
    const before = anchors(t).length;
    nudge(t, 'ses_a', 'routine');
    decisionResolved(t, 'policy');
    await settle(a);
    expect(anchors(t)).toHaveLength(before);

    decisionResolved(t, 'passkey');
    decisionResolved(t, 'button');
    breakglassApproved(t);
    await settle(a);
    expect(anchors(t)).toHaveLength(before + 1);
    expect(anchors(t).at(-1)!.meta.seq).toBe(t.rt.store.head().seq - 1);
  });

  it('anchorAfterEvents: false leaves high-value events to the hourly and nightly runs', async () => {
    a = await auditRuntime();
    breakglassApproved(a.t);
    await settle(a);
    expect(anchors(a.t)).toHaveLength(0);
  });

  it('the hourly job anchors only when something new was logged since the last anchor', async () => {
    a = await auditRuntime({ config: { audit: { anchorIntervalMinutes: 60 } }, now: '2026-10-09T04:00:00.000Z' });
    const { t } = a;
    nudge(t, 'ses_a', 'one');
    // The first tick also runs the nightly job (never run today): its anchor leaves the interval run nothing to do.
    expect(await t.rt.tickJobs()).toEqual(['audit.anchor', 'audit.anchor_interval']);
    const first = anchors(t);
    expect(first).toHaveLength(1);
    expect(first[0]!.source).toBe('scheduler');

    t.clock.advance(30 * 60_000);
    expect(await t.rt.tickJobs()).toEqual([]);
    t.clock.advance(30 * 60_000);
    // Only the anchor's own record is newer than the anchor: nothing to do.
    expect(await t.rt.tickJobs()).toEqual(['audit.anchor_interval']);
    expect(anchors(t)).toHaveLength(1);

    nudge(t, 'ses_a', 'two');
    t.clock.advance(60 * 60_000);
    await t.rt.tickJobs();
    expect(anchors(t)).toHaveLength(2);
    expect(anchors(t)[1]!.meta.seq).toBe(t.rt.store.head().seq - 1);
  });

  it('an anchor store outage is recorded and alerted once, not every hour, and again after it recovers', async () => {
    a = await auditRuntime({ config: { audit: { anchorIntervalMinutes: 60 } }, now: '2026-10-09T04:00:00.000Z' });
    const { t } = a;
    const repo = t.config.audit.anchorRepoPath;
    const hour = async () => {
      nudge(t, 'ses_a', 'work');
      t.clock.advance(60 * 60_000);
      await t.rt.tickJobs();
    };
    nudge(t, 'ses_a', 'work');
    await t.rt.tickJobs();
    expect(anchors(t)).toHaveLength(1);

    rmSync(repo, { recursive: true, force: true });
    writeFileSync(repo, 'blocked');
    await hour();
    await hour();
    await hour();
    expect(failures(t)).toHaveLength(1);
    expect(a.notes.filter((n) => n.kind === 'anchor.missed')).toHaveLength(1);

    rmSync(repo, { force: true });
    await hour();
    expect(anchors(t)).toHaveLength(2);
    rmSync(repo, { recursive: true, force: true });
    writeFileSync(repo, 'blocked');
    await hour();
    expect(failures(t)).toHaveLength(2);
  });

  it('an anchor whose push failed is retried on the next hour even when nothing new was logged', async () => {
    const remote = join(mkdtempSync(join(tmpdir(), 'aoc-anchor-remote-')), 'anchors.git');
    a = await auditRuntime({
      config: { audit: { anchorIntervalMinutes: 60, anchorRemote: remote } },
      now: '2026-10-09T04:00:00.000Z',
    });
    const { t } = a;
    nudge(t, 'ses_a', 'work');
    await t.rt.tickJobs();
    expect(anchors(t).at(-1)!.meta.pushed).toBe(false);

    expect(spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]).status).toBe(0);
    t.clock.advance(60 * 60_000);
    expect(await t.rt.tickJobs()).toEqual(['audit.anchor_interval']);
    expect(anchors(t).at(-1)!.meta.pushed).toBe(true);
    const pushed = anchors(t).length;
    t.clock.advance(60 * 60_000);
    await t.rt.tickJobs();
    expect(anchors(t)).toHaveLength(pushed);
  });
});
