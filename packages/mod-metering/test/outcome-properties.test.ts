/**
 * Cost per outcome (§14) against a model of its rules, over random portfolios.
 *
 * Sessions work for tickets, changes and phases (some for several tickets or changes at once), spend on random days in
 * random models, days close, and the dollar-to-ringgit figures change under them. Whenever the portfolio lens is read:
 *  - every outcome carries the US$ of the sessions linked to it, a session shared between outcomes of a kind counting
 *    by its share, and the RM of each usage day at that day's rate (the stamp frozen when the day closed, else the live
 *    figure), summed and rounded once; a day with spend and no rate is left out and marks the outcome incomplete; no
 *    figure at all when no usage day has a rate; spend of US$0 needs none;
 *  - its process type is the one with the largest share of the spend, none on a tie or when nothing was spent;
 *  - the statistics of a kind are those of its items (US$ over all of them, RM over the complete ones), and the items
 *    come in completion order;
 *  - nothing in the lens names a person.
 * The failing seed is printed; replay it with AOC_SEED=<n>.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { CostPerOutcomeDTO, OutcomeCostClassDTO } from '@aoc/contracts';
import { forSeeds, type Rng, type TestRuntime } from '@aoc/kernel';
import { buildStarted, closeDays, closeTicket, launch, meteringRuntime, myt, phaseCompleted, usage } from './helpers';
import { FxWorld, addDays, costOf, fileCard, localDay, round6, type Rate, type Stamp } from './model';

let t: TestRuntime | undefined;
afterEach(async () => t?.close());

const HOUR = 3_600_000;
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'mystery-model'];
const TYPES = ['feature', 'bug-fix', 'docs'];
const rateOf = (model: string): Rate | undefined => fileCard.rates.find((r) => r.model === model);

interface Sess {
  id: string;
  project: string;
  type: string;
  phase: string | null;
  tickets: Set<string>;
  changes: Set<string>;
}
interface Row {
  session: string;
  date: string;
  usd: number;
  unpriced: boolean;
}
type Kind = 'ticket' | 'change' | 'phase';
interface Done {
  kind: Kind;
  ref: string;
  project: string | null;
  at: string;
}

/** What the rules say one outcome costs. */
interface Expect {
  usd: number;
  rm: number | null;
  complete: boolean;
  /** A usage day that cost US$0 and had no rate: nothing to convert, so nothing is missing. */
  freeDayWithoutRate: boolean;
  /** The two largest shares of the spend are equal to the micro-dollar, so no process type leads. */
  tied: boolean;
  sessions: number;
  unpriced: boolean;
  project: string | null;
  processType: string | null;
}

class Portfolio {
  readonly sessions = new Map<string, Sess>();
  readonly rows: Row[] = [];
  readonly closed = new Map<string, Stamp>();
  readonly done: Done[] = [];
  wm: string | null = null;
  constructor(
    readonly startDay: string,
    readonly fx: FxWorld,
  ) {}

  /** The rate a usage day is converted at: the stamp frozen at its close, else what the FX figures say now. */
  rateOn(date: string): number | null {
    return (this.closed.get(date) ?? this.fx.stamp(date)).rate;
  }

  /** The daily close: every unclosed day before today is frozen with the FX in force right now. */
  close(today: string): void {
    for (let d = this.wm ? addDays(this.wm, 1) : this.startDay; d < today; d = addDays(d, 1)) {
      if (!this.closed.has(d)) this.closed.set(d, this.fx.stamp(d));
      this.wm = d;
    }
  }

  /** The sessions an outcome is made of, each with the part of its spend the outcome carries. */
  private parts(kind: Kind, ref: string): { s: Sess; share: number }[] {
    if (kind === 'phase') {
      const [project, phase] = ref.split('/');
      return [...this.sessions.values()].filter((s) => s.project === project && s.phase === phase && this.rows.some((r) => r.session === s.id)).map((s) => ({ s, share: 1 }));
    }
    const links = (s: Sess) => (kind === 'ticket' ? s.tickets : s.changes);
    return [...this.sessions.values()].filter((s) => links(s).has(ref)).map((s) => ({ s, share: 1 / links(s).size }));
  }

  expected(kind: Kind, ref: string, project: string | null): Expect {
    const parts = this.parts(kind, ref);
    const perDay = new Map<string, number>();
    const perType = new Map<string, number>();
    const usageDays = new Set<string>();
    let unpriced = false;
    const projects = new Set<string>();
    for (const { s, share } of parts) {
      const rows = this.rows.filter((r) => r.session === s.id);
      if (rows.length) projects.add(s.project);
      for (const r of rows) {
        perDay.set(r.date, (perDay.get(r.date) ?? 0) + r.usd * share);
        perType.set(s.type, (perType.get(s.type) ?? 0) + r.usd * share);
        usageDays.add(r.date);
        unpriced ||= r.unpriced;
      }
    }
    let rm = 0;
    let complete = true;
    let freeDayWithoutRate = false;
    for (const [date, usd] of perDay) {
      const rate = this.rateOn(date);
      if (rate !== null) rm += usd * rate;
      else if (usd > 0) complete = false;
      else freeDayWithoutRate = true;
    }
    const anyRate = [...usageDays].some((d) => this.rateOn(d) !== null);
    const ranked = [...perType.entries()].map(([type, usd]) => ({ type, usd: round6(usd) })).sort((a, b) => b.usd - a.usd);
    const tied = ranked.length > 1 && ranked[0]!.usd === ranked[1]!.usd;
    return {
      usd: round6([...perDay.values()].reduce((a, b) => a + b, 0)),
      rm: !complete && !anyRate ? null : round6(rm),
      complete,
      freeDayWithoutRate,
      tied,
      sessions: parts.length,
      unpriced,
      project: kind === 'phase' ? project : projects.size === 1 ? [...projects][0]! : null,
      processType: ranked.length && !tied ? ranked[0]!.type : null,
    };
  }
}

/** Hyndman–Fan type 7, as the lens documents it. */
function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  return s[lo]! + (h - lo) * (s[Math.ceil(h)]! - s[lo]!);
}

const near = (a: number | null, b: number | null, tol = 1e-5): boolean => (a === null || b === null ? a === b : Math.abs(a - b) <= tol);

describe('cost per outcome against a model of its rules (§14)', () => {
  it('US$, ringgit per usage day, completeness, process type and statistics match the rules, in completion order, naming nobody', async () => {
    const reached = { tickets: 0, changes: 0, phases: 0, shared: 0, incomplete: 0, noFigure: 0, unpriced: 0, typed: 0, untyped: 0, frozenDiffers: 0, empty: 0, freeDay: 0, tied: 0, checks: 0 };
    await forSeeds(
      'cost per outcome',
      async (rng: Rng, seed) => {
        const fx = new FxWorld();
        t = await meteringRuntime({ now: myt('2026-10-02', '10:00'), fx });
        const builder = t.user('builder', 'Dev');
        const approver = t.user('approver', 'Approver');
        const world = new Portfolio(localDay(t.clock.now()), fx);
        const problems: string[] = [];
        const log: string[] = [];
        const now = () => t!.clock.now();
        const today = () => localDay(now());
        const tickets = ['tkt_1', 'tkt_2', 'tkt_3', 'tkt_4', 'tkt_5'];
        const changes = ['chg_1', 'chg_2', 'chg_3'];
        const projects = ['prj_a', 'prj_b'];
        const uniform = rng.chance(0.4);

        // The first figure may only exist some days in: the days before it have no rate to carry forward.
        const firstFigure = rng.int(-2, 4);
        for (let d = firstFigure; d <= firstFigure + 5; d++) {
          if (d === firstFigure || rng.chance(0.6)) fx.records.set(addDays(world.startDay, d), { rate: Math.round((3.8 + rng.next()) * 1e4) / 1e4, status: 'live', sourceDate: addDays(world.startDay, d) });
        }

        const newSession = () => {
          const id = `ses_${world.sessions.size + 1}`;
          const kind = rng.weighted<'ticket' | 'phase' | 'plain'>([['ticket', 5], ['phase', 2], ['plain', 3]]);
          const s: Sess = { id, project: rng.pick(projects), type: rng.pick(TYPES), phase: kind === 'phase' ? rng.pick(['ph1', 'ph2']) : null, tickets: new Set(), changes: new Set() };
          if (kind === 'ticket') s.tickets.add(rng.pick(tickets));
          launch(t!, { sessionId: id, ownerId: builder.user.id, projectId: s.project, processType: s.type, ticketId: [...s.tickets][0] ?? null, phaseId: s.phase });
          world.sessions.set(id, s);
          log.push(`launch ${id} ${s.project} ${s.type}${s.phase ? ` phase ${s.phase}` : ''}${s.tickets.size ? ` for ${[...s.tickets]}` : ''}`);
        };
        const spend = () => {
          const s = rng.pick([...world.sessions.values()]);
          const model = uniform ? MODELS[0]! : rng.weighted<string>([[MODELS[0]!, 3], [MODELS[1]!, 3], [MODELS[2]!, 2], [MODELS[3]!, 3]]);
          // Now and then a batch of nothing (a priced model that spent no tokens costs US$0 just as an unpriced one does),
          // and round batches; in a uniform world only those, so that two process types can spend exactly the same.
          const shape = uniform ? rng.weighted<'idle' | 'round'>([['idle', 1], ['round', 3]]) : rng.weighted<'idle' | 'round' | 'any'>([['idle', 15], ['round', 25], ['any', 60]]);
          const k = shape === 'idle' ? { input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 } : shape === 'round' ? { input: 1_000_000, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 } : { input: rng.int(0, 600_000), output: rng.int(0, 400_000), cacheRead: rng.int(0, 2_000_000), cw5m: 0, cw1h: 0 };
          usage(t!, s.id, { model, input: k.input, output: k.output, cacheRead: k.cacheRead });
          const r = rateOf(model);
          world.rows.push({ session: s.id, date: today(), usd: r ? costOf(r, k) : 0, unpriced: !r });
          log.push(`usage ${s.id} ${model} on ${today()}`);
        };
        const link = () => {
          const s = rng.pick([...world.sessions.values()]);
          const how = rng.weighted<'build' | 'change' | 'triage'>([['build', 4], ['change', 3], ['triage', 2]]);
          if (how === 'build') {
            const ticketId = rng.pick(tickets);
            const changeId = rng.chance(0.4) ? rng.pick(changes) : null;
            buildStarted(t!, { ticketId, sessionId: s.id, changeId });
            s.tickets.add(ticketId);
            if (changeId) s.changes.add(changeId);
            log.push(`build_started ${s.id} ${ticketId} ${changeId ?? ''}`);
          } else if (how === 'change') {
            const changeId = rng.pick(changes);
            t!.rt.store.append({ type: 'change.started', actor: { kind: 'system', id: 'test' }, meta: { changeId, sessionId: s.id }, source: 'supervisor' });
            s.changes.add(changeId);
            log.push(`change.started ${s.id} ${changeId}`);
          } else {
            const ticketId = rng.pick(tickets);
            const ids = rng.sample([...world.sessions.keys()], rng.int(1, 3));
            t!.rt.store.append({ type: 'ticket.triage_started', actor: { kind: 'system', id: 'test' }, meta: { ticketId, sessionIds: ids, budgetTokens: 1000, budgetMinutes: 5 }, source: 'api' });
            for (const id of ids) world.sessions.get(id)!.tickets.add(ticketId);
            log.push(`triage_started ${ticketId} ${ids}`);
          }
        };
        const finish = () => {
          const kind = rng.weighted<Kind>([['ticket', 5], ['change', 3], ['phase', 2]]);
          const at = t!.clock.iso();
          if (kind === 'ticket') {
            const ref = rng.pick(tickets);
            const resolution = rng.weighted<'fixed' | 'wont_fix'>([['fixed', 4], ['wont_fix', 1]]);
            closeTicket(t!, ref, resolution);
            if (resolution === 'fixed' && !world.done.some((d) => d.kind === kind && d.ref === ref)) world.done.push({ kind, ref, project: null, at });
            log.push(`ticket.closed ${ref} ${resolution}`);
          } else if (kind === 'change') {
            const ref = rng.pick(changes);
            t!.rt.store.append({ type: 'change.completed', actor: { kind: 'system', id: 'test' }, meta: { changeId: ref, pinnedSha: 'abc1234', pinnedTag: null }, source: 'supervisor' });
            if (!world.done.some((d) => d.kind === kind && d.ref === ref)) world.done.push({ kind, ref, project: null, at });
            log.push(`change.completed ${ref}`);
          } else {
            const project = rng.pick(projects);
            const phaseId = rng.pick(['ph1', 'ph2']);
            const ref = `${project}/${phaseId}`;
            phaseCompleted(t!, { sessionId: [...world.sessions.keys()][0]!, projectId: project, phaseId });
            if (!world.done.some((d) => d.kind === kind && d.ref === ref)) world.done.push({ kind, ref, project, at });
            log.push(`phase.completed ${ref}`);
          }
        };
        const tick = () => {
          t!.clock.advance(rng.pick([3 * HOUR, 9 * HOUR, 15 * HOUR, 26 * HOUR]));
          log.push(`time → ${t!.clock.iso()}`);
        };
        const close = async () => {
          await closeDays(t!);
          world.close(today());
          log.push(`close through ${world.wm}`);
        };
        const changeFx = () => {
          const date = addDays(today(), -rng.int(-1, 5));
          fx.records.set(date, { rate: Math.round((3.8 + rng.next()) * 1e4) / 1e4, status: 'live', sourceDate: date });
          if (world.closed.has(date) && world.closed.get(date)!.rate !== fx.stamp(date).rate) reached.frozenDiffers++;
          log.push(`fx ${date}`);
        };

        const compare = (cls: OutcomeCostClassDTO, kind: Kind, label: string) => {
          const want = world.done.filter((d) => d.kind === kind).sort((a, b) => (a.at === b.at ? (a.ref < b.ref ? -1 : 1) : a.at < b.at ? -1 : 1));
          const got = cls.items.map((i) => i.refId);
          if (JSON.stringify(got) !== JSON.stringify(want.map((d) => d.ref))) problems.push(`${label}: outcomes ${got} (the model completed ${want.map((d) => d.ref)}, in that order)`);
          for (const item of cls.items) {
            const d = want.find((x) => x.ref === item.refId);
            if (!d) continue;
            const e = world.expected(kind, item.refId, d.project);
            const where = `${label} ${item.refId}`;
            if (!near(item.notionalUsd, e.usd)) problems.push(`${where}: US$${item.notionalUsd}, the rules give ${e.usd}`);
            if (!near(item.notionalRm, e.rm)) problems.push(`${where}: RM ${item.notionalRm}, the rules give ${e.rm}`);
            if (item.rmComplete !== e.complete) problems.push(`${where}: rmComplete ${item.rmComplete}, the rules give ${e.complete}`);
            if (item.sessions !== e.sessions) problems.push(`${where}: ${item.sessions} sessions, the rules give ${e.sessions}`);
            if (item.unpriced !== e.unpriced) problems.push(`${where}: unpriced ${item.unpriced}, the rules give ${e.unpriced}`);
            if (item.projectId !== e.project) problems.push(`${where}: project ${item.projectId}, the rules give ${e.project}`);
            if (item.processType !== e.processType) problems.push(`${where}: process type ${item.processType}, the rules give ${e.processType}`);
            if (!e.complete) reached.incomplete++;
            if (e.rm === null) reached.noFigure++;
            if (e.unpriced) reached.unpriced++;
            if (e.processType) reached.typed++;
            else reached.untyped++;
            if (e.usd === 0 && e.sessions === 0) reached.empty++;
            if (e.freeDayWithoutRate && e.complete) reached.freeDay++;
            if (e.tied) reached.tied++;
          }
          // The statistics of the kind are those of its items.
          const usd = cls.items.map((i) => i.notionalUsd);
          const rmValues = cls.items.flatMap((i) => (i.rmComplete && i.notionalRm !== null ? [i.notionalRm] : []));
          const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
          const r6 = (x: number | null) => (x === null ? null : round6(x));
          const s = cls.stats;
          const checks: [string, number | null, number | null][] = [
            ['count', s.count, usd.length],
            ['totalUsd', s.totalUsd, round6(total(usd))],
            ['meanUsd', s.meanUsd, usd.length ? round6(total(usd) / usd.length) : null],
            ['medianUsd', s.medianUsd, r6(percentile(usd, 0.5))],
            ['p90Usd', s.p90Usd, r6(percentile(usd, 0.9))],
            ['minUsd', s.minUsd, usd.length ? round6(Math.min(...usd)) : null],
            ['maxUsd', s.maxUsd, usd.length ? round6(Math.max(...usd)) : null],
            ['totalRm', s.totalRm, rmValues.length ? round6(total(rmValues)) : null],
            ['meanRm', s.meanRm, rmValues.length ? round6(total(rmValues) / rmValues.length) : null],
            ['medianRm', s.medianRm, r6(percentile(rmValues, 0.5))],
            ['p90Rm', s.p90Rm, r6(percentile(rmValues, 0.9))],
            ['minRm', s.minRm, rmValues.length ? round6(Math.min(...rmValues)) : null],
            ['maxRm', s.maxRm, rmValues.length ? round6(Math.max(...rmValues)) : null],
          ];
          for (const [name, g, w] of checks) if (!near(g, w, 1e-5)) problems.push(`${label} stats.${name}: ${g}, the items give ${w}`);
          if (s.rmComplete !== (rmValues.length === cls.items.length)) problems.push(`${label} stats.rmComplete: ${s.rmComplete}, ${rmValues.length} of ${cls.items.length} items have a complete RM`);
          if (kind === 'ticket') reached.tickets += cls.items.length;
          if (kind === 'change') reached.changes += cls.items.length;
          if (kind === 'phase') reached.phases += cls.items.length;
        };
        const check = async (why: string) => {
          reached.checks++;
          const dto = await t!.json<CostPerOutcomeDTO>('GET', `/api/metering/cost-per-outcome?from=${world.startDay}&to=${today()}`, { headers: approver.headers });
          compare(dto.ticketsFixed, 'ticket', `after ${why}: tickets`);
          compare(dto.changesShipped, 'change', `after ${why}: changes`);
          compare(dto.phasesCompleted, 'phase', `after ${why}: phases`);
          const text = JSON.stringify(dto);
          if (text.includes(builder.user.id) || /"(owner|user|actor)(Id)?"/.test(text)) problems.push(`after ${why}: the portfolio lens names a person`);
        };

        for (let i = 0; i < rng.int(3, 5); i++) newSession();
        const ops: [string, () => Promise<void> | void, number][] = [
          ['spend', spend, 10],
          ['tick', tick, 4],
          ['close', close, 3],
          ['fx', changeFx, 2],
          ['link', link, 3],
          ['finish', finish, 4],
          ['launch', newSession, 1],
        ];
        for (let step = 0; step < 45 && !problems.length; step++) {
          const [name, fn] = rng.weighted(ops.map((o) => [o, o[2]] as const));
          await fn();
          await t.drain();
          if (name === 'finish' || name === 'close' || name === 'fx' || step % 9 === 0) await check(name);
        }
        await check('the end');
        // A rebuild reproduces every figure.
        const read = async () => ({ ...(await t!.json<CostPerOutcomeDTO>('GET', `/api/metering/cost-per-outcome?from=${world.startDay}&to=${today()}`, { headers: approver.headers })), generatedAt: null });
        const before = await read();
        t.rt.store.rebuildProjections(['metering']);
        if (JSON.stringify(await read()) !== JSON.stringify(before)) problems.push('rebuilding the metering projection changes the portfolio lens');

        expect(problems.length ? `${problems.slice(0, 12).join('\n')}\n--- steps ---\n${log.join('\n')}` : '', `seed ${seed}`).toBe('');
        await t.close();
        t = undefined;
      },
      { count: 40 },
    );
    expect(reached.tickets, 'ticket outcomes read').toBeGreaterThan(20);
    expect(reached.changes, 'change outcomes read').toBeGreaterThan(10);
    expect(reached.phases, 'phase outcomes read').toBeGreaterThan(5);
    expect(reached.incomplete, 'outcomes with a day left out of the RM').toBeGreaterThan(0);
    expect(reached.noFigure, 'outcomes with no RM figure').toBeGreaterThan(0);
    expect(reached.unpriced, 'outcomes with unpriced usage').toBeGreaterThan(0);
    expect(reached.typed, 'outcomes with a process type').toBeGreaterThan(10);
    expect(reached.untyped, 'outcomes without one').toBeGreaterThan(0);
    expect(reached.frozenDiffers, 'FX restated for a closed day').toBeGreaterThan(0);
    expect(reached.freeDay, 'complete outcomes with a US$0 usage day and no rate').toBeGreaterThan(0);
    expect(reached.tied, 'outcomes whose two largest process-type shares tie').toBeGreaterThan(0);
  }, 180_000);
});
