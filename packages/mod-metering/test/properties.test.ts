/**
 * Notional cost, closed days and the dollar-to-ringgit stamp under random timelines (spec §10, R12).
 *
 * A model of the rules runs beside the real module through random usage (on time, backdated, long overdue), the passage
 * of days, daily closes, rate-card edits (valid and refused) and changes to the FX figures. After every step:
 *  - each usage row sits on the day, with the late flag, rate-card version and cost the rules give it, and a row never
 *    changes once written;
 *  - rate-card edits are forward only: the API refuses a card that takes effect today, on a closed day or before, and
 *    nothing already priced or closed is repriced; what a past day would cost never changes;
 *  - a closed day is frozen: its USD, its ringgit figure and its FX stamp are what they were at the close, however the
 *    FX figures or the rate card change afterwards; an open day follows the live figures;
 *  - an FX figure carried forward is stamped inherited with the date of the rate it came from; with none, missing.
 * The failing seed is printed; replay it with AOC_SEED=<n>.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { MeteringDailyDTO } from '@aoc/contracts';
import { forSeeds, type Rng, type TestRuntime } from '@aoc/kernel';
import { closeDays, launch, meteringRuntime, myt, usage } from './helpers';
import { DAY, FxWorld, MODELS, addDays, costOf, fileCard, localDay, round6, type Card, type Stamp, type Tok } from './model';

let t: TestRuntime | undefined;
afterEach(async () => t?.close());

interface Row {
  date: string;
  late: number;
  version: number;
  cost: number;
  model: string;
}

class World {
  readonly cards: Card[] = [];
  readonly rows: Row[] = [];
  readonly closed = new Map<string, { usd: number; rm: number; stamp: Stamp; version: number }>();
  wm: string | null = null;
  constructor(
    readonly startedDay: string,
    readonly fx: FxWorld,
  ) {
    this.cards.push({ version: 1, effectiveFrom: fileCard.effectiveFrom, rates: new Map(fileCard.rates.map((r) => [r.model, r])) });
  }
  effective(date: string): Card | null {
    let best: Card | null = null;
    for (const c of this.cards) {
      if (c.effectiveFrom > date) continue;
      if (!best || c.effectiveFrom > best.effectiveFrom || (c.effectiveFrom === best.effectiveFrom && c.version > best.version)) best = c;
    }
    return best;
  }
  /** Where a usage batch lands, at `nowMs`, claiming it was used at `lastAtMs`. */
  usage(nowMs: number, lastAtMs: number, model: string, k: Tok): Row {
    const ingestDay = localDay(nowMs);
    const sourceDay = localDay(lastAtMs);
    let date = sourceDay > ingestDay ? ingestDay : sourceDay;
    let late = 0;
    if ((this.wm && date <= this.wm) || date < addDays(ingestDay, -35)) {
      date = ingestDay;
      late = 1;
    }
    if (this.wm && date <= this.wm) date = addDays(this.wm, 1);
    const card = this.effective(date);
    const row = { date, late, version: card?.version ?? 0, cost: card ? costOf(card.rates.get(model)!, k) : 0, model };
    this.rows.push(row);
    return row;
  }
  firstMetered(): string {
    return [this.startedDay, ...this.rows.map((r) => r.date)].reduce((a, b) => (a < b ? a : b));
  }
  /** The daily close: every unclosed day before today is frozen with the FX in force right now. */
  close(today: string): string[] {
    const out: string[] = [];
    for (let d = this.wm ? addDays(this.wm, 1) : this.firstMetered(); d < today; d = addDays(d, 1)) {
      if (this.closed.has(d)) continue;
      const usd = this.rows.filter((r) => r.date === d).reduce((a, r) => a + r.cost, 0);
      const stamp = this.fx.stamp(d);
      this.closed.set(d, { usd, rm: stamp.rate === null ? 0 : round6(usd * stamp.rate), stamp, version: this.effective(d)?.version ?? 0 });
      this.wm = !this.wm || d > this.wm ? d : this.wm;
      out.push(d);
    }
    return out;
  }
}

describe('metering against a model of the rules (R12)', () => {
  it('rows land on the right day at the right price, forward-only edits reprice nothing, closed days stay frozen, FX is carried forward as inherited', async () => {
    const reached = { rows: 0, late: 0, closes: 0, refused: 0, published: 0, fxChanges: 0, inherited: 0, missing: 0, closedAfterFx: 0 };
    await forSeeds(
      'metering',
      async (rng: Rng, seed) => {
        const fx = new FxWorld();
        t = await meteringRuntime({ now: myt('2026-10-09', '10:00'), fx });
        const owner = t.user('builder', 'Dev');
        const approver = t.user('approver', 'Approver');
        launch(t, { sessionId: 'ses_m1', ownerId: owner.user.id });
        launch(t, { sessionId: 'ses_m2', ownerId: owner.user.id });
        const world = new World(localDay(t.clock.now()), fx);
        const problems: string[] = [];
        const log: string[] = [];
        const metering = t.rt.services.get('metering');
        const probe: Tok = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cw5m: 1_000_000, cw1h: 1_000_000 };
        const probeCost = (model: string, date: string) =>
          metering.notionalCostUsd(model, { inputTokens: probe.input, outputTokens: probe.output, cacheReadTokens: probe.cacheRead, cacheWrite5mTokens: probe.cw5m, cacheWrite1hTokens: probe.cw1h }, date);
        const seenProbe = new Map<string, number>();
        const now = () => t!.clock.now();
        const today = () => localDay(now());

        const spend = () => {
          const session = rng.pick(['ses_m1', 'ses_m2']);
          const model = rng.pick(MODELS);
          const k: Tok = { input: rng.int(0, 500_000), output: rng.int(1, 800_000), cacheRead: rng.int(0, 3_000_000), cw5m: rng.int(0, 100_000), cw1h: rng.int(0, 100_000) };
          // Mostly now; sometimes a day or two ago (a late flush), now and then very old (overdue past the backdate limit).
          const at = rng.weighted<number>([
            [now() - rng.int(0, 3_600_000), 6],
            [now() - rng.int(1, 3) * DAY, 3],
            [now() - rng.int(36, 60) * DAY, 1],
          ]);
          usage(t!, session, { model, input: k.input, output: k.output, cacheRead: k.cacheRead, cw5m: k.cw5m, cw1h: k.cw1h, at: new Date(at).toISOString() });
          const row = world.usage(now(), at, model, k);
          reached.rows++;
          if (row.late) reached.late++;
          log.push(`usage ${session} ${model} on ${row.date}${row.late ? ' (late)' : ''} v${row.version}`);
        };
        const tick = () => {
          t!.clock.advance(rng.pick([2 * 3_600_000, 6 * 3_600_000, 14 * 3_600_000, 20 * 3_600_000, 30 * 3_600_000]));
          log.push(`time → ${t!.clock.iso()}`);
        };
        const close = async () => {
          await closeDays(t!);
          const days = world.close(today());
          reached.closes += days.length;
          log.push(`close ${days.join(',') || '(nothing)'}`);
        };
        const publish = async () => {
          const td = today();
          const earliest = addDays(td, 1) > (world.wm ? addDays(world.wm, 1) : '') ? addDays(td, 1) : addDays(world.wm!, 1);
          const asked = rng.weighted<string | undefined>([
            [undefined, 3],
            [addDays(td, rng.int(1, 5)), 3],
            [td, 1],
            [world.wm ?? addDays(td, -3), 2],
            [addDays(td, -rng.int(1, 20)), 1],
            [addDays(td, 800), 1],
          ]);
          const effectiveFrom = asked ?? earliest;
          const ok = effectiveFrom > td && (!world.wm || effectiveFrom > world.wm) && effectiveFrom <= addDays(td, 730);
          const factor = rng.pick([0.5, 0.8, 1.25, 2, 3]);
          const rates = fileCard.rates.filter((r) => MODELS.includes(r.model)).map((r) => ({ ...r, inputPerMTok: r.inputPerMTok * factor, outputPerMTok: r.outputPerMTok * factor }));
          const res = await t!.request('PUT', '/api/ratecard', { headers: approver.headers, body: { rates, ...(asked ? { effectiveFrom: asked } : {}) } });
          const body = (await res.json()) as { version?: number };
          log.push(`publish effectiveFrom=${effectiveFrom} → ${res.status}`);
          if (res.status !== (ok ? 201 : 422)) problems.push(`PUT /api/ratecard effectiveFrom ${effectiveFrom} (today ${td}, last closed ${world.wm}): HTTP ${res.status}, rules say ${ok ? 201 : 422}`);
          if (ok && res.status === 201) {
            world.cards.push({ version: body.version!, effectiveFrom, rates: new Map(rates.map((r) => [r.model, r])) });
            reached.published++;
          } else reached.refused++;
        };
        const changeFx = () => {
          const td = today();
          const date = addDays(td, -rng.int(-1, 12));
          const live = rng.chance(0.6);
          const sourceDate = live ? date : addDays(date, -rng.int(1, 4));
          fx.records.set(date, { rate: Math.round((4 + rng.next()) * 1e4) / 1e4, status: live ? 'live' : 'inherited', sourceDate });
          reached.fxChanges++;
          if (world.closed.has(date)) reached.closedAfterFx++;
          log.push(`fx ${date} ${live ? 'live' : `inherited from ${sourceDate}`}`);
        };

        const rowsSnapshot = () => t!.rt.store.db.prepare('SELECT seq, date, late, rate_card_version AS v, cost_usd AS cost FROM mtr_usage ORDER BY seq').all() as { seq: number; date: string; late: number; v: number; cost: number }[];
        let before: ReturnType<typeof rowsSnapshot> = [];
        const check = async (why: string) => {
          // Rows: as many as the model's, each exactly as the rules place and price it, and none ever rewritten.
          const rows = rowsSnapshot();
          if (rows.length !== world.rows.length) problems.push(`after ${why}: ${rows.length} usage rows, the model has ${world.rows.length}`);
          rows.forEach((r, i) => {
            const w = world.rows[i];
            if (!w) return;
            if (r.date !== w.date || r.late !== w.late || r.v !== w.version || Math.abs(r.cost - w.cost) > 1e-6) problems.push(`after ${why}: row ${i} is ${r.date} late=${r.late} v${r.v} $${r.cost}, the rules give ${w.date} late=${w.late} v${w.version} $${w.cost}`);
            const was = before[i];
            if (was && (was.date !== r.date || was.late !== r.late || was.v !== r.v || was.cost !== r.cost)) problems.push(`after ${why}: row ${i} was rewritten (${was.date} v${was.v} $${was.cost} → ${r.date} v${r.v} $${r.cost})`);
          });
          before = rows;

          // The daily view: frozen days equal their close, open days follow the live figures.
          const from = addDays(world.startedDay, -45);
          const daily = await t!.json<MeteringDailyDTO>('GET', `/api/metering/daily?from=${from}&to=${today()}`, { headers: approver.headers });
          for (const day of daily.days) {
            const c = world.closed.get(day.date);
            if (c) {
              if (day.status !== 'closed') problems.push(`after ${why}: ${day.date} is ${day.status}, the model closed it`);
              if (Math.abs(day.notionalUsd - c.usd) > 1e-5) problems.push(`after ${why}: closed ${day.date} shows $${day.notionalUsd}, frozen at $${c.usd}`);
              if (day.fx.status !== c.stamp.status || day.fx.rate !== c.stamp.rate || day.fx.sourceDate !== c.stamp.sourceDate) problems.push(`after ${why}: closed ${day.date} FX ${JSON.stringify(day.fx)} ≠ frozen ${JSON.stringify(c.stamp)}`);
              if (day.rateCardVersion !== c.version) problems.push(`after ${why}: closed ${day.date} rate card v${day.rateCardVersion}, frozen v${c.version}`);
              if (day.notionalRm !== null && Math.abs(day.notionalRm - c.rm) > 1e-4) problems.push(`after ${why}: closed ${day.date} RM ${day.notionalRm}, frozen ${c.rm}`);
              if (c.stamp.status === 'inherited') reached.inherited++;
              if (c.stamp.status === 'missing') reached.missing++;
            } else if (day.status === 'open') {
              const usd = world.rows.filter((r) => r.date === day.date).reduce((a, r) => a + r.cost, 0);
              if (Math.abs(day.notionalUsd - usd) > 1e-5) problems.push(`after ${why}: open ${day.date} shows $${day.notionalUsd}, the rows add up to $${usd}`);
              const live = fx.stamp(day.date);
              if (day.fx.status !== live.status || day.fx.rate !== live.rate || day.fx.sourceDate !== live.sourceDate) problems.push(`after ${why}: open ${day.date} FX ${JSON.stringify(day.fx)} ≠ live ${JSON.stringify(live)}`);
            }
          }
          if (daily.lastClosedDay !== world.wm) problems.push(`after ${why}: last closed day ${daily.lastClosedDay}, the model says ${world.wm}`);
          // What a day that has happened would cost never changes (nothing is repriced by a later edit).
          for (const d of [...world.closed.keys(), today()]) {
            if (d > today()) continue;
            for (const model of MODELS) {
              const key = `${model}|${d}`;
              const cost = probeCost(model, d);
              const want = world.effective(d) ? costOf(world.effective(d)!.rates.get(model)!, probe) : 0;
              if (Math.abs(cost - want) > 1e-6) problems.push(`after ${why}: ${model} on ${d} would cost $${cost}, the rules say $${want}`);
              const first = seenProbe.get(key);
              if (first !== undefined && d < today() && first !== cost) problems.push(`after ${why}: ${model} on ${d} was $${first}, now $${cost}: a past day was repriced`);
              if (d < today() || first === undefined) seenProbe.set(key, cost);
            }
          }
        };

        // Day zero: nothing closed, FX known for the days around the start.
        fx.records.set(addDays(world.startedDay, -1), { rate: 4.2, status: 'live', sourceDate: addDays(world.startedDay, -1) });
        await check('the start');
        const ops: [string, () => Promise<void> | void, number][] = [
          ['spend', spend, 8],
          ['tick', tick, 4],
          ['close', close, 3],
          ['publish', publish, 2],
          ['fx', changeFx, 3],
        ];
        for (let step = 0; step < 40 && !problems.length; step++) {
          const [name, fn] = rng.weighted(ops.map((o) => [o, o[2]] as const));
          await fn();
          await t.drain();
          await check(name);
        }
        // A rebuild reproduces every row and every frozen day.
        const tables = ['mtr_usage', 'mtr_rollups', 'mtr_ratecards', 'mtr_sessions'];
        const dump = () => Object.fromEntries(tables.map((tbl) => [tbl, (t!.rt.store.db.prepare(`SELECT * FROM ${tbl} ORDER BY 1, 2`).all() as Record<string, unknown>[]).map((r) => JSON.stringify(r))]));
        const live = dump();
        t.rt.store.rebuildProjections(['metering']);
        const rebuilt = dump();
        for (const tbl of tables) {
          const onlyLive = live[tbl]!.filter((r) => !rebuilt[tbl]!.includes(r));
          const onlyRebuilt = rebuilt[tbl]!.filter((r) => !live[tbl]!.includes(r));
          if (onlyLive.length || onlyRebuilt.length) problems.push(`rebuilding ${tbl} changes it:\n  live    ${onlyLive.slice(0, 2).join('\n  live    ')}\n  rebuilt ${onlyRebuilt.slice(0, 2).join('\n  rebuilt ')}`);
        }

        expect(problems.length ? `${problems.join('\n')}\n--- steps ---\n${log.join('\n')}` : '', `seed ${seed}`).toBe('');
        await t.close();
        t = undefined;
      },
      { count: 8 },
    );
    expect(reached.rows, 'usage rows').toBeGreaterThan(60);
    expect(reached.late, 'rows booked late').toBeGreaterThan(3);
    expect(reached.closes, 'days closed').toBeGreaterThan(10);
    expect(reached.published, 'rate cards published').toBeGreaterThan(5);
    expect(reached.refused, 'rate-card edits refused').toBeGreaterThan(5);
    expect(reached.inherited, 'closed days stamped inherited').toBeGreaterThan(0);
    expect(reached.closedAfterFx, 'FX changed for a day that was already closed').toBeGreaterThan(0);
  }, 120_000);
});
