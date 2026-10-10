/**
 * Plans, amendments, closes and rollovers under random sequences (spec §4, §5, §9).
 *
 * A model of the rules runs beside the real ledger (through the MCP routes the agent uses): after every step each
 * session's, the thread's and the project's measured progress must equal what the model computes from its own
 * list of tasks, every answer (200 / 409 / 422) must be the model's, and what the log shows must be what the model
 * says happened. Progress is monotone except through audited amendments and declarations: a close or a file change
 * never lowers a percentage, and any change of the denominator is a plan event whose before and after weights are
 * the model's. A task handed to the next writer session in a rollover is counted once, in the session that took it.
 * The failing seed is printed; replay it with AOC_SEED=<n>.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TASK_SIZES, type Actor, type TaskSize } from '@aoc/contracts';
import { forSeeds, type Rng } from '@aoc/kernel';
import { createHarness, type Harness } from './harness';

let h: Harness | undefined;
afterEach(async () => h?.close());

const supervisor: Actor = { kind: 'system', id: 'supervisor' };

// ── the rules, restated ───────────────────────────────────────────────────────────────────────────────────

const WEIGHT: Record<TaskSize, number> = { xs: 1, s: 2, m: 3, l: 5, xl: 8 };

type Status = 'open' | 'done' | 'removed' | 'carried';
interface MTask {
  id: string;
  phase: string;
  size: TaskSize;
  status: Status;
  flagged: boolean;
}
interface MSession {
  id: string;
  declared: boolean;
  version: number;
  tasks: Map<string, MTask>;
  /** File-changing tool calls since the last close. */
  fileChanges: number;
  /** Whether this session's last close changed files (R9 flags only a second empty close in a row, G-52). */
  lastCloseChanged: boolean;
  /** The session held the thread's writer lock and released it (a source for carry-over), or holds it now. */
  released: boolean;
  writer: boolean;
}

interface Totals {
  doneTasks: number;
  totalTasks: number;
  doneWeight: number;
  totalWeight: number;
  pct: number;
  flaggedTasks: number;
}

/** Tasks done over tasks declared, weighted by declared size (§4); 0 when nothing is declared. */
function totalsOf(tasks: { size: TaskSize; done: boolean; flagged: boolean }[]): Totals {
  const doneW = tasks.filter((t) => t.done).reduce((s, t) => s + WEIGHT[t.size], 0);
  const totalW = tasks.reduce((s, t) => s + WEIGHT[t.size], 0);
  return {
    doneTasks: tasks.filter((t) => t.done).length,
    totalTasks: tasks.length,
    doneWeight: doneW,
    totalWeight: totalW,
    pct: totalW === 0 ? 0 : Math.round((doneW / totalW) * 1000) / 10,
    flaggedTasks: tasks.filter((t) => t.done && t.flagged).length,
  };
}

/** A session's own view: tasks it handed to a successor are still open in its manifest. */
const sessionTotals = (s: MSession): Totals =>
  totalsOf([...s.tasks.values()].filter((t) => t.status !== 'removed').map((t) => ({ size: t.size, done: t.status === 'done', flagged: t.flagged })));

/** The master timeline: a handed-over task is counted once, where it went. */
const aggregateTotals = (sessions: MSession[]): Totals =>
  totalsOf(sessions.flatMap((s) => [...s.tasks.values()]).filter((t) => t.status === 'open' || t.status === 'done').map((t) => ({ size: t.size, done: t.status === 'done', flagged: t.flagged })));

const PLAUSIBLE_TESTS = ['src/widget.test.ts > stores widgets', 'pkg/foo_test.go::TestAdd', 'tests.auth.test_login'];
const IMPLAUSIBLE_TESTS = ['done', 'all tests pass', 'n/a'];
const GOOD_DIFFS = ['3 files changed, 40 insertions(+)', 'a1b2c3d4e5f6'];
const PLACEHOLDER_DIFFS = ['n/a', 'todo'];

// ── the world ─────────────────────────────────────────────────────────────────────────────────────────────

describe('plans, closes, amendments and rollovers against a model (§4, §5, §9)', () => {
  it('progress equals the model after every step, is monotone but for audited amendments, and counts a handed-over task once', async () => {
    const reached = { declared: 0, amended: 0, closed: 0, flagged: 0, carried: 0, rollovers: 0, refused: 0 };
    await forSeeds(
      'ledger',
      async (rng: Rng, seed) => {
        h = await createHarness();
        const projectId = h.project();
        const threadId = h.thread(projectId);
        const sessions: MSession[] = [];
        const log: string[] = [];
        const problems: string[] = [];
        let nTask = 0;
        let nSession = 0;

        const newSession = () => {
          const id = `ses_l${++nSession}`;
          h!.session({ sessionId: id, projectId, threadId });
          const s: MSession = { id, declared: false, version: 0, tasks: new Map(), fileChanges: 0, lastCloseChanged: false, released: false, writer: false };
          sessions.push(s);
          if (!h!.ledger.acquireWriter(threadId, id, supervisor)) problems.push(`${id}: could not take the writer lock`);
          s.writer = true;
          log.push(`new writer ${id}`);
          return s;
        };
        let current = newSession();

        const call = async (tool: string, sid: string, input: unknown) => {
          const res = await h!.t.request('POST', `/ingest/mcp/${tool}`, { headers: h!.t.ingestHeaders(sid), body: { sessionId: sid, input } });
          const text = await res.text();
          return { status: res.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
        };
        const sources = (s: MSession) => sessions.filter((o) => o !== s && o.released && !o.writer);
        /** Task ids of earlier writers that make a re-declaration impossible (done) or a hand-over (open). */
        const carryOf = (s: MSession, ids: string[]) => {
          const doneElsewhere: string[] = [];
          const carried: [MSession, MTask][] = [];
          for (const id of ids) {
            const copies = sources(s).flatMap((o) => (o.tasks.has(id) ? [[o, o.tasks.get(id)!] as [MSession, MTask]] : []));
            if (copies.some(([, t]) => t.status === 'done')) doneElsewhere.push(id);
            else for (const c of copies) if (c[1].status === 'open') carried.push(c);
          }
          return { doneElsewhere, carried };
        };
        const progressOf = async (path: string) => ((await h!.t.json<{ progress: Totals }>('GET', path, { headers: h!.owner.headers })).progress);
        const near = (a: Totals, b: Totals) => (Object.keys(b) as (keyof Totals)[]).every((k) => Math.abs(a[k] - b[k]) < 1e-9);

        /** Ids a successor re-declares to take over the work: open ones of the predecessor, sometimes a done one (refused). */
        const handover = (from: MSession | null) => {
          if (!from) return [] as string[];
          const open = [...from.tasks.values()].filter((t) => t.status === 'open').map((t) => t.id);
          const done = [...from.tasks.values()].filter((t) => t.status === 'done').map((t) => t.id);
          return [...rng.sample(open, rng.int(0, open.length)), ...(rng.chance(0.1) ? rng.sample(done, 1) : [])];
        };
        const randomPlan = (taken: string[] = []) => {
          const queue = [...taken];
          const phases = Array.from({ length: rng.int(1, 3) }, (_, i) => ({
            id: `P${i + 1}`,
            name: `Phase ${i + 1}`,
            tasks: Array.from({ length: rng.int(1, 4) }, () => ({
              // Handed-over ids first; otherwise mostly new ids, sometimes one already used (a clash or a hand-over).
              id: queue.shift() ?? (rng.chance(0.2) && nTask > 0 ? `t${rng.int(1, nTask)}` : `t${++nTask}`),
              title: 'A unit of work',
              size: rng.pick(TASK_SIZES),
            })),
          }));
          // Ids that did not fit in the random shape still belong to the plan.
          if (queue.length) phases[0]!.tasks.push(...queue.map((id) => ({ id, title: 'A unit of work', size: rng.pick(TASK_SIZES) })));
          return phases;
        };

        const declare = async (taken: string[] = []) => {
          const s = current;
          const phases = randomPlan(taken);
          const ids = phases.flatMap((p) => p.tasks.map((t) => t.id));
          const dup = new Set(ids).size !== ids.length;
          const carry = carryOf(s, ids);
          const want = s.declared ? 409 : dup || carry.doneElsewhere.length ? 422 : 200;
          const before = h!.t.rt.store.head().seq;
          const r = await call('declare_plan', s.id, { phases });
          log.push(`declare ${s.id} (${ids.join(',')}) → ${r.status}`);
          if (r.status !== want) problems.push(`declare_plan ${s.id}: HTTP ${r.status}, rules say ${want} (${JSON.stringify(r.body).slice(0, 160)})`);
          const events = h!.t.rt.store.list({ fromSeq: before + 1, types: ['plan.declared'] });
          if (events.length !== (want === 200 ? 1 : 0)) problems.push(`declare_plan ${s.id}: ${events.length} plan.declared events for a ${want}`);
          if (want !== 200) return void reached.refused++;
          s.declared = true;
          s.version = 1;
          for (const p of phases) for (const t of p.tasks) s.tasks.set(t.id, { id: t.id, phase: p.id, size: t.size, status: 'open', flagged: false });
          for (const [, t] of carry.carried) t.status = 'carried';
          reached.declared++;
          reached.carried += carry.carried.length;
          const total = [...s.tasks.values()].reduce((a, t) => a + WEIGHT[t.size], 0);
          if ((events[0]!.meta as { totalWeight: number }).totalWeight !== total) problems.push(`declare_plan ${s.id}: totalWeight ${(events[0]!.meta as { totalWeight: number }).totalWeight}, rules say ${total}`);
        };

        const amend = async () => {
          if (!current.declared) return;
          const s = current;
          const any = [...s.tasks.values()];
          const add = Array.from({ length: rng.int(0, 2) }, () => ({
            id: rng.chance(0.2) && nTask > 0 ? `t${rng.int(1, nTask)}` : `t${++nTask}`,
            title: 'More work',
            size: rng.pick(TASK_SIZES),
            phaseId: rng.pick(['P1', 'P2', 'P9']),
            phaseName: 'Added phase',
          }));
          const remove = rng.chance(0.5) && any.length ? rng.sample(any, rng.int(1, 2)).map((t) => t.id) : [];
          const resize = rng.chance(0.5) && any.length ? rng.sample(any, rng.int(1, 2)).map((t) => ({ taskId: t.id, size: rng.pick(TASK_SIZES) })) : [];
          const input: Record<string, unknown> = { reason: 'Scope changed after the first spike', ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}), ...(resize.length ? { resize } : {}) };

          // The model's verdict.
          const ids = [...add.map((t) => t.id), ...remove, ...resize.map((r) => r.taskId)];
          const dup = new Set(ids).size !== ids.length;
          const carry = carryOf(s, add.map((t) => t.id));
          const bad =
            dup ||
            add.some((t) => s.tasks.has(t.id)) ||
            remove.some((id) => s.tasks.get(id)?.status !== 'open') ||
            resize.some((r) => s.tasks.get(r.taskId)?.status !== 'open') ||
            carry.doneElsewhere.length > 0;
          const effectiveResize = resize.filter((r) => s.tasks.get(r.taskId)?.size !== r.size);
          const nothing = !add.length && !remove.length && !effectiveResize.length;
          const want = bad || nothing ? 422 : 200;
          const prevWeight = [...s.tasks.values()].filter((t) => t.status !== 'removed').reduce((a, t) => a + WEIGHT[t.size], 0);
          const progressBefore = { session: sessionTotals(s), thread: aggregateTotals(sessions) };
          const before = h!.t.rt.store.head().seq;
          const r = await call('amend_plan', s.id, input);
          log.push(`amend ${s.id} +${add.length} -${remove.length} ~${resize.length} → ${r.status}`);
          if (r.status !== want) problems.push(`amend_plan ${s.id}: HTTP ${r.status}, rules say ${want} (${JSON.stringify(r.body).slice(0, 200)})`);
          const events = h!.t.rt.store.list({ fromSeq: before + 1, types: ['plan.amended'] });
          if (events.length !== (want === 200 ? 1 : 0)) problems.push(`amend_plan ${s.id}: ${events.length} plan.amended events for a ${want}`);
          if (want !== 200) {
            reached.refused++;
            // A refused amendment changes nothing.
            if (!near(sessionTotals(s), progressBefore.session)) problems.push(`amend_plan ${s.id}: refused, but the session's progress changed`);
            return;
          }
          for (const t of add) {
            s.tasks.set(t.id, { id: t.id, phase: t.phaseId, size: t.size, status: 'open', flagged: false });
          }
          for (const id of remove) s.tasks.get(id)!.status = 'removed';
          for (const rz of effectiveResize) s.tasks.get(rz.taskId)!.size = rz.size;
          for (const [, t] of carry.carried) t.status = 'carried';
          s.version++;
          reached.amended++;
          reached.carried += carry.carried.length;
          const newWeight = [...s.tasks.values()].filter((t) => t.status !== 'removed').reduce((a, t) => a + WEIGHT[t.size], 0);
          const m = events[0]!.meta as { prevTotalWeight: number; newTotalWeight: number; added: number; removed: number; resized: number; manifestVersion: number };
          if (m.prevTotalWeight !== prevWeight || m.newTotalWeight !== newWeight) problems.push(`amend_plan ${s.id}: audited weights ${m.prevTotalWeight} → ${m.newTotalWeight}, rules say ${prevWeight} → ${newWeight}`);
          if (m.added !== add.length || m.removed !== remove.length || m.resized !== effectiveResize.length || m.manifestVersion !== s.version) problems.push(`amend_plan ${s.id}: audited counts ${JSON.stringify(m)} do not match what was asked`);
        };

        const closeTask = async () => {
          const candidates = sessions.filter((x) => x.declared);
          if (!candidates.length) return;
          const s = rng.chance(0.8) && current.declared ? current : rng.pick(candidates);
          const pool = [...s.tasks.values()];
          const t = rng.chance(0.85) && pool.some((x) => x.status === 'open') ? rng.pick(pool.filter((x) => x.status === 'open')) : pool.length ? rng.pick(pool) : null;
          const taskId = t ? t.id : 'nope';
          const kind = rng.pick(['test', 'test', 'diff', 'commit'] as const);
          const good = rng.chance(0.7);
          const ref = kind === 'test' ? rng.pick(good ? PLAUSIBLE_TESTS : IMPLAUSIBLE_TESTS) : kind === 'diff' ? rng.pick(good ? GOOD_DIFFS : PLACEHOLDER_DIFFS) : 'deadbeefcafe';
          // No repository in this world: a commit cannot be checked, a diff counts when it says something, a test id when it is plausible.
          const verified = kind === 'commit' ? false : kind === 'test' ? PLAUSIBLE_TESTS.includes(ref) : GOOD_DIFFS.includes(ref);
          const want = !t ? 422 : t.status === 'open' ? 200 : 409;
          const flag = !verified ? 'evidence_unverified' : s.fileChanges === 0 && !s.lastCloseChanged ? 'no_file_change' : null;
          const before = { session: sessionTotals(s), thread: aggregateTotals(sessions), seq: h!.t.rt.store.head().seq };
          const r = await call('task_done', s.id, { task_id: taskId, evidence: { kind, ref } });
          log.push(`close ${s.id}/${taskId} ${kind} "${ref}" fileChanges=${s.fileChanges} → ${r.status}${r.body?.flagged ? ` flagged ${r.body.flagged}` : ''}`);
          if (r.status !== want) problems.push(`task_done ${s.id}/${taskId}: HTTP ${r.status}, rules say ${want} (${JSON.stringify(r.body).slice(0, 160)})`);
          const events = h!.t.rt.store.list({ fromSeq: before.seq + 1, types: ['task.done'] });
          if (events.length !== (want === 200 ? 1 : 0)) problems.push(`task_done ${s.id}/${taskId}: ${events.length} task.done events for a ${want}`);
          if (want !== 200) {
            reached.refused++;
            if (!near(aggregateTotals(sessions), before.thread)) problems.push(`task_done ${s.id}/${taskId}: refused, but progress changed`);
            return;
          }
          if ((r.body.flagged ?? null) !== flag) problems.push(`task_done ${s.id}/${taskId}: flagged ${r.body.flagged ?? null}, rules say ${flag} (verified=${verified}, file changes ${s.fileChanges})`);
          const m = events[0]!.meta as { flag: string | null; evidenceVerified: boolean; fileChangesSinceLast: number };
          if (m.flag !== flag || m.evidenceVerified !== verified || m.fileChangesSinceLast !== s.fileChanges) problems.push(`task_done ${s.id}/${taskId}: audited ${JSON.stringify(m)}, rules say flag=${flag} verified=${verified} changes=${s.fileChanges}`);
          t!.status = 'done';
          t!.flagged = flag !== null;
          s.lastCloseChanged = s.fileChanges > 0;
          s.fileChanges = 0;
          reached.closed++;
          if (flag) reached.flagged++;
          // A close only ever moves progress up.
          const after = { session: sessionTotals(s), thread: aggregateTotals(sessions) };
          if (after.session.pct < before.session.pct || after.thread.pct < before.thread.pct) problems.push(`task_done ${s.id}/${taskId}: progress fell (${before.session.pct} → ${after.session.pct}, thread ${before.thread.pct} → ${after.thread.pct})`);
          const reply = r.body.progress as Totals;
          const want2 = sessionTotals(s);
          if (reply.doneTasks !== want2.doneTasks || reply.totalTasks !== want2.totalTasks || reply.doneWeight !== want2.doneWeight || reply.totalWeight !== want2.totalWeight || reply.pct !== want2.pct)
            problems.push(`task_done ${s.id}/${taskId}: reply progress ${JSON.stringify(reply)}, rules say ${JSON.stringify(want2)}`);
        };

        const edit = () => {
          const s = rng.chance(0.85) ? current : rng.pick(sessions);
          h!.toolUsed(s.id, { fileChanging: true });
          s.fileChanges++;
          log.push(`edit ${s.id}`);
        };

        const rollover = async () => {
          if (!current.declared || [...current.tasks.values()].every((t) => t.status !== 'open') || sessions.length >= 5) return;
          h!.ledger.releaseWriter(threadId, current.id, 'rollover', supervisor);
          current.released = true;
          current.writer = false;
          const predecessor = current;
          current = newSession();
          reached.rollovers++;
          // The successor starts from the handoff: it declares the work it takes over.
          if (rng.chance(0.8)) await declare(handover(predecessor));
        };

        for (let step = 0; step < 50; step++) {
          const op = rng.weighted<() => Promise<void> | void>([
            [declare, 3],
            [amend, 3],
            [closeTask, 8],
            [edit, 5],
            [rollover, 1],
          ]);
          await op();
          await h.t.drain();
          // Progress, everywhere, equals the model.
          for (const s of sessions) {
            if (!s.declared) continue;
            const got = h.ledger.sessionProgress(s.id)!;
            if (!near(got as unknown as Totals, sessionTotals(s))) problems.push(`step ${step}: ${s.id} progress ${JSON.stringify(pick(got))}, rules say ${JSON.stringify(sessionTotals(s))}`);
          }
          const declaredSessions = sessions.filter((s) => s.declared);
          if (declaredSessions.length) {
            const wantAll = aggregateTotals(declaredSessions);
            const thread = await progressOf(`/api/threads/${threadId}`);
            const project = await progressOf(`/api/projects/${projectId}`);
            for (const [what, got] of [['thread', thread], ['project', project]] as const)
              if (!near(got, wantAll)) problems.push(`step ${step}: ${what} progress ${JSON.stringify(got)}, rules say ${JSON.stringify(wantAll)}`);
          }
          if (problems.length) break;
        }

        // The ledger projection is what the log makes of itself.
        const dump = () => JSON.stringify(['ledger_manifests', 'ledger_phases', 'ledger_tasks', 'ledger_amendments'].map((t) => h!.t.rt.store.db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2, 3`).all()));
        const liveDump = dump();
        h.t.rt.store.rebuildProjections(['ledger']);
        if (dump() !== liveDump) problems.push('rebuilding the ledger projection changes it');

        expect(problems.length ? `${problems.join('\n')}\n--- steps ---\n${log.join('\n')}` : '', `seed ${seed}`).toBe('');
        await h.close();
        h = undefined;
      },
      { count: 8 },
    );
    expect(reached.declared, 'plans declared').toBeGreaterThan(8);
    expect(reached.amended, 'amendments accepted').toBeGreaterThan(5);
    expect(reached.closed, 'tasks closed').toBeGreaterThan(20);
    expect(reached.flagged, 'closes flagged').toBeGreaterThan(5);
    expect(reached.carried, 'tasks handed over in a rollover').toBeGreaterThan(0);
    expect(reached.rollovers, 'rollovers').toBeGreaterThan(2);
    expect(reached.refused, 'refused requests').toBeGreaterThan(5);
  }, 120_000);
});

const pick = (t: Totals): Totals => ({ doneTasks: t.doneTasks, totalTasks: t.totalTasks, doneWeight: t.doneWeight, totalWeight: t.totalWeight, pct: t.pct, flaggedTasks: t.flaggedTasks });
