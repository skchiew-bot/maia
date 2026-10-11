import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aoc, loggedInHome } from './helpers/cli';
import { startFakeDaemon, type FakeDaemon } from './helpers/fake-daemon';

let d: FakeDaemon;
let home: string;
beforeEach(async () => {
  d = await startFakeDaemon();
  home = loggedInHome(d.url);
});
afterEach(() => d.stop());

describe('aoc admin (O-26)', () => {
  it('redrive: POSTs the seq and the reason, and prints the outcome and the recording event', async () => {
    d.on('POST', '/api/admin/reactors/intake.triage-on-submit/redrive', { json: { outcome: 'ok', error: null, eventSeq: 900 } });
    const r = await aoc(['admin', 'redrive', 'intake.triage-on-submit', '412', '--reason', 'git repo restored'], { homeDir: home });
    expect(r.code).toBe(0);
    expect(d.calls('POST', '/api/admin/reactors/intake.triage-on-submit/redrive')[0]!.body).toEqual({ seq: 412, reason: 'git repo restored' });
    expect(r.stdout).toMatch(/Outcome\s+re-driven: intake.triage-on-submit ran on seq 412/);
    expect(r.stdout).toMatch(/Recorded\s+event seq 900/);
  });

  it('a failed action exits 1; a missing reason or a bad seq is a usage error; a Builder token gets the Approver hint', async () => {
    d.on('POST', '/api/admin/jobs/fx.daily/run', { json: { outcome: 'failed', error: 'Error: BNM unreachable', eventSeq: 901 } });
    const failed = await aoc(['admin', 'run-job', 'fx.daily', '--reason', 'missed'], { homeDir: home });
    expect(failed.code).toBe(1);
    expect(failed.stdout).toMatch(/Outcome\s+FAILED — Error: BNM unreachable/);

    expect((await aoc(['admin', 'run-job', 'fx.daily'], { homeDir: home })).code).toBe(2);
    expect((await aoc(['admin', 'redrive', 'x.y', 'abc', '--reason', 'r'], { homeDir: home })).code).toBe(2);

    d.on('POST', '/api/admin/projections/rebuild', {
      status: 403,
      json: { error: { code: 'forbidden', message: 'Missing permission ops.admin' } },
    });
    const refused = await aoc(['admin', 'rebuild', 'sessions', '--reason', 'r'], { homeDir: home });
    expect(refused.code).toBe(3);
    expect(refused.stderr).toMatch(/hint: .*Approver token.*ops\.admin/);
  });

  it('rebuild: sends every named projector and exits 1 when one is left degraded', async () => {
    d.on('POST', '/api/admin/projections/rebuild', {
      json: { outcome: 'ok', error: null, eventSeq: 902, projectors: ['sessions', 'decisions'], degraded: ['decisions'] },
    });
    const r = await aoc(['admin', 'rebuild', 'sessions', 'decisions', '--reason', 'counts looked wrong', '--json'], { homeDir: home });
    expect(r.code).toBe(1);
    expect(d.calls('POST', '/api/admin/projections/rebuild')[0]!.body).toEqual({
      projectors: ['sessions', 'decisions'],
      reason: 'counts looked wrong',
    });
    expect(JSON.parse(r.stdout)).toMatchObject({ outcome: 'ok', degraded: ['decisions'] });
  });
});
