import { afterEach, describe, expect, it } from 'vitest';
import {
  ProcessTypeSchema,
  type AnomalySignal,
  type RegistryService,
  type TowerAnomaly,
} from '@aoc/contracts';
import {
  affirmed,
  ago,
  amend,
  capReached,
  changeApproved,
  changeDrafted,
  DAY,
  decide,
  launch,
  live,
  meteringStub,
  plan,
  playbookApproved,
  reconciled,
  setup,
  taskDone,
  topupRequested,
  usage,
  type Harness,
} from './helpers';

let h: Harness;
afterEach(async () => h?.close());

const CUR = DAY; // inside the last 7 days
const PREV = 10 * DAY; // inside the 7 days before

const registry = {
  getType: (id: string) =>
    id === 'bug-fix'
      ? ProcessTypeSchema.parse({
          id: 'bug-fix',
          name: 'Bug fix',
          class: 'execution',
          model: 'opus',
          executionModel: 'haiku',
        })
      : null,
} as unknown as RegistryService;

async function radar(): Promise<Record<AnomalySignal, TowerAnomaly>> {
  const s = await h.snap();
  return Object.fromEntries(s.anomalies.map((a) => [a.signal, a])) as Record<AnomalySignal, TowerAnomaly>;
}

let n = 0;
/** `total` closes at `at`, the first `hits` of them anomalous per `hit`. */
function closes(
  total: number,
  hits: number,
  at: number,
  hit: { flag?: 'no_file_change'; evidenceVerified?: boolean },
  sessionId = 'ses_docs',
): void {
  for (let i = 0; i < total; i++) {
    taskDone(h, sessionId, `t${++n}`, i < hits ? { at: ago(h, at), ...hit } : { at: ago(h, at) });
  }
}

function manifests(total: number, heavy: number): void {
  for (let i = 0; i < total; i++) {
    const sid = `ses_plan_${++n}`;
    launch(h, sid, { at: ago(h, CUR), processType: 'feature' });
    // > 60% XS is heavy; exactly 60% is not.
    plan(h, sid, i < heavy ? ['xs', 'xs', 'xs', 'xs', 's'] : ['xs', 'xs', 'xs', 's', 's'], {
      at: ago(h, CUR),
    });
  }
}

function amendments(late: number, early: number): void {
  for (let i = 0; i < late + early; i++) {
    const sid = `ses_amend_${++n}`;
    launch(h, sid, { at: ago(h, CUR), processType: 'feature' });
    plan(h, sid, ['s', 's'], { at: ago(h, CUR) });
    if (i < late) taskDone(h, sid, 't1', { at: ago(h, CUR), weight: 2 }); // half the declared weight is done
    amend(h, sid, { prev: 4, next: 6, add: [{ id: 't3', size: 's' }], at: ago(h, CUR) });
  }
}

function affirmations(total: number, blind: number): void {
  changeDrafted(h, 'chg_aff', 'prj_a', ago(h, CUR));
  for (let i = 0; i < total; i++) affirmed(h, 'chg_aff', false, i < blind ? 1200 : 9000, ago(h, CUR));
}

function approvals(total: number, self: number): void {
  for (let i = 0; i < total; i++) {
    const id = `chg_${++n}`;
    changeDrafted(h, id, 'prj_a', ago(h, CUR));
    changeApproved(h, id, i < self, 'usr_dev', ago(h, CUR));
  }
}

/** `judged` reconciled turns, the first `flagged` of them discrepant, plus turns that could not be judged. */
function checks(judged: number, flagged: number, unverified = 0): void {
  const statuses = ['under_reported', 'over_reported', 'regressed'] as const;
  for (let i = 0; i < judged; i++)
    reconciled(h, 'ses_docs', i < flagged ? statuses[i % statuses.length]! : i % 2 ? 'overhead' : 'match', { at: ago(h, CUR) });
  for (let i = 0; i < unverified; i++) reconciled(h, 'ses_docs', 'unverified', { at: ago(h, CUR) });
}

function runs(onDiscoveryModel: number, onExecutionModel: number): void {
  playbookApproved(h, 'pbk_1', 'bug-fix', ago(h, 3 * DAY));
  for (let i = 0; i < onDiscoveryModel + onExecutionModel; i++) {
    launch(h, `ses_run_${++n}`, {
      at: ago(h, CUR),
      processType: 'bug-fix',
      model: i < onDiscoveryModel ? 'claude-opus-5-5' : 'claude-haiku-5-5',
    });
  }
}

type Case = [status: TowerAnomaly['status'], arrange: () => void, value: number];
const CASES: Record<AnomalySignal, Case[]> = {
  // Baseline 10% from the previous week → watch at 15%, alert at 20%.
  no_file_change_closes: [
    [
      'normal',
      () => (closes(20, 2, PREV, { flag: 'no_file_change' }), closes(20, 2, CUR, { flag: 'no_file_change' })),
      10,
    ],
    [
      'watch',
      () => (closes(20, 2, PREV, { flag: 'no_file_change' }), closes(20, 3, CUR, { flag: 'no_file_change' })),
      15,
    ],
    [
      'alert',
      () => (closes(20, 2, PREV, { flag: 'no_file_change' }), closes(20, 4, CUR, { flag: 'no_file_change' })),
      20,
    ],
  ],
  // No baseline → the 5% floor: watch at 7.5%, alert at 10%.
  evidence_unverified: [
    ['normal', () => closes(10, 0, CUR, { evidenceVerified: false }), 0],
    ['watch', () => closes(40, 3, CUR, { evidenceVerified: false }), 7.5],
    ['alert', () => closes(10, 1, CUR, { evidenceVerified: false }), 10],
  ],
  // Floor 10%: watch at 15%, alert at 20%.
  xs_heavy_manifests: [
    ['normal', () => manifests(10, 1), 10],
    ['watch', () => manifests(20, 3), 15],
    ['alert', () => manifests(5, 1), 20],
  ],
  // Count, floor 2: watch at 3, alert at 4. Amendments before half the work was done are not late.
  late_denominator_growth: [
    ['normal', () => amendments(2, 3), 2],
    ['watch', () => amendments(3, 0), 3],
    ['alert', () => amendments(4, 1), 4],
  ],
  // Floor 10%: watch at 15%, alert at 20%. Blind = unedited with under 3s dwell.
  blind_affirm_rate: [
    ['normal', () => affirmations(10, 1), 10],
    ['watch', () => affirmations(20, 3), 15],
    ['alert', () => affirmations(10, 2), 20],
  ],
  // Count, floor 0.6: one run → watch, two → alert.
  discovery_with_playbook: [
    ['normal', () => runs(0, 3), 0],
    ['watch', () => runs(1, 2), 1],
    ['alert', () => runs(2, 0), 2],
  ],
  // Floor 40%: watch at 60%, alert at 80%.
  self_approval_rate: [
    ['normal', () => approvals(10, 5), 50],
    ['watch', () => approvals(10, 6), 60],
    ['alert', () => approvals(10, 8), 80],
  ],
  // Floor 5%: watch at 7.5%, alert at 10%. Unverified turns were not judged: in neither count.
  metering_discrepancy: [
    ['normal', () => checks(20, 1), 5],
    ['watch', () => checks(40, 3), 7.5],
    ['alert', () => checks(10, 1, 30), 10],
  ],
};

describe('anomaly radar (portfolio level, R11)', () => {
  for (const [signal, cases] of Object.entries(CASES) as [AnomalySignal, Case[]][]) {
    for (const [status, arrange, value] of cases) {
      it(`${signal}: ${status}`, async () => {
        h = await setup({ services: { registry } });
        launch(h, 'ses_docs', { at: ago(h, 20 * DAY), processType: 'docs' });
        arrange();
        const a = (await radar())[signal];
        expect(a).toMatchObject({ signal, status, value });
        expect(a.scope === 'portfolio' || /^(process_type|project):/.test(a.scope)).toBe(true);
      });
    }
  }

  it('explains value, baseline and thresholds, and points at a concentrated process type or project — never a person', async () => {
    h = await setup({ services: { registry } });
    launch(h, 'ses_docs', { at: ago(h, 20 * DAY), processType: 'docs' });
    closes(20, 2, PREV, { flag: 'no_file_change' });
    closes(20, 3, CUR, { flag: 'no_file_change' });
    approvals(10, 8);
    runs(2, 0);
    const r = await radar();
    expect(r.no_file_change_closes).toEqual({
      signal: 'no_file_change_closes',
      label: 'No-file-change closes',
      value: 15,
      baseline: 10,
      unit: '%',
      status: 'watch',
      scope: 'process_type:docs',
      explanation:
        '3 of 20 tasks closed in 7d had no file change since the previous close (15%). Previous 7d: 10%. Watch ≥ 15%, alert ≥ 20%. Concentrated in process type docs (3 of 3).',
    });
    expect(r.self_approval_rate).toMatchObject({ status: 'alert', scope: 'project:prj_a', unit: '%' });
    expect(r.discovery_with_playbook).toMatchObject({
      status: 'alert',
      scope: 'process_type:bug-fix',
      unit: 'count',
      baseline: 0,
    });
    expect(r.evidence_unverified).toMatchObject({ status: 'normal', scope: 'portfolio' });
  });

  it('does not judge a thin sample', async () => {
    h = await setup();
    launch(h, 'ses_docs', { at: ago(h, 20 * DAY), processType: 'docs' });
    closes(3, 3, CUR, { flag: 'no_file_change' });
    const a = (await radar()).no_file_change_closes;
    expect(a).toMatchObject({ value: 100, baseline: null, status: 'normal' });
    expect(a.explanation).toContain('Too few samples to judge (need 5).');
  });

  it('without the registry, a run on the type’s strongest observed tier after a playbook approval counts', async () => {
    h = await setup();
    runs(1, 1);
    expect((await radar()).discovery_with_playbook).toMatchObject({
      value: 1,
      status: 'watch',
      scope: 'process_type:bug-fix',
    });
  });

  it('never carries a user id or name: the whole snapshot is portfolio-level in `anomalies`', async () => {
    h = await setup({ services: { registry, metering: meteringStub().stub } });
    const people = ['Aisyah Rahman', 'Tan Wei Jie', 'Priya Nair'].map((name) => h.t.user('builder', name));
    for (const [i, p] of people.entries()) {
      const sid = `ses_person_${i}`;
      launch(h, sid, { at: ago(h, CUR), owner: p.user.id, processType: 'bug-fix' });
      live(h, sid, i === 0 ? 'stalled' : 'working', ago(h, CUR));
      usage(h, sid, 5000, { at: ago(h, CUR) });
      plan(h, sid, ['xs', 'xs', 'xs', 'xs', 's'], { at: ago(h, CUR) });
      for (let k = 1; k <= 5; k++)
        taskDone(h, sid, `t${k}`, {
          at: ago(h, CUR),
          flag: k < 3 ? 'no_file_change' : null,
          evidenceVerified: k !== 5,
        });
      changeDrafted(h, `chg_p${i}`, 'prj_a', ago(h, CUR));
      for (let k = 0; k < 4; k++) affirmed(h, `chg_p${i}`, false, 500, ago(h, CUR), p.user.id);
      changeApproved(h, `chg_p${i}`, true, p.user.id, ago(h, CUR));
      capReached(h, p.user.id, sid, ago(h, CUR));
      topupRequested(h, p.user.id, `tpu_${i}`, `dec_tpu_${i}`, ago(h, CUR));
      decide(h, `dec_${i}`, 'agent_decision', {
        at: ago(h, CUR),
        test: 'data',
        sessionId: sid,
        requesterId: p.user.id,
      });
    }
    runs(2, 0);
    const s = await h.snap();
    expect(s.anomalies).toHaveLength(8);
    expect(s.anomalies.filter((a) => a.status !== 'normal').length).toBeGreaterThan(3);
    const radarJson = JSON.stringify(s.anomalies);
    for (const p of people) {
      expect(radarJson).not.toContain(p.user.id);
      expect(radarJson).not.toContain(p.user.name);
    }
    expect(radarJson).not.toMatch(/usr_/);
    // The rest of the snapshot may name people only where the contract allows it (capacity planning).
    expect(JSON.stringify(s.attention.map((a) => a.title))).not.toMatch(/Aisyah|Wei Jie|Priya|usr_/);
  });
});
