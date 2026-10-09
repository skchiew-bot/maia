/**
 * Projections are a pure function of the log (CLAUDE.md event-sourcing rules, spec §13).
 *
 * A realistic multi-module history (the demo seeder: users, projects, sessions with manifests, evidence and usage,
 * decisions, playbooks, credits, FX, error learning, intake tickets) is reopened with the production module list.
 * Every projection table of every module is snapshotted, rebuilt from the log and compared; a difference is a
 * projector that read the clock, an id, an insertion order or another module's half-rebuilt table.
 *
 * Erasure (crypto-shred of a body scope) must also be a pure function of the log: the live state after
 * `eraseScope` has to equal what a rebuild makes of the same log, and nothing that was in the erased bodies may
 * survive in any table, FTS shadow table or database file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forSeeds, type EventStore } from '@aoc/kernel';
import { bodiesByScope, ftsOrphanTerms, plaintextOnlyIn, scanFiles, scanTables } from './support/erasure';
import { cleanupHistoryDirs, copyHistory, discardHistory, openHistory, seedDemoHistory, type SeededHistory } from './support/history';
import { describeDiffs, diffSnapshots, snapshotProjections, undeclaredTables } from './support/snapshot';

let seeded: SeededHistory;
beforeAll(async () => {
  seeded = await seedDemoHistory();
}, 300_000);
afterAll(() => cleanupHistoryDirs(), 120_000);

/** State the modules keep outside the log on purpose (alert dedupe), so a rebuild does not need to restore it. */
const KNOWN_UNDECLARED = ['dec_notices'];

describe('a rebuild reproduces the live projections', () => {
  it('rebuilding every projector, one projector at a time, and twice gives exactly the live state', async () => {
    const o = await openHistory(copyHistory(seeded));
    try {
      const store = o.rt.store;
      expect(store.projectionHealth(), 'no projector failed while the history was written').toEqual([]);
      expect(undeclaredTables(store.db, o.projectors)).toEqual(KNOWN_UNDECLARED);
      const live = snapshotProjections(store.db, o.projectors);
      expect(Object.values(live.tables).reduce((n, t) => n + t.ordered.length, 0), 'the history is not empty').toBeGreaterThan(500);

      store.rebuildProjections();
      expect(describeDiffs(diffSnapshots(live, snapshotProjections(store.db, o.projectors)))).toBe('');

      // One projector alone: it must not depend on what another projection looked like when the event arrived.
      for (const p of o.projectors) {
        store.rebuildProjections([p.name]);
        const d = diffSnapshots(live, snapshotProjections(store.db, o.projectors));
        expect(describeDiffs(d), `after rebuilding only "${p.name}"`).toBe('');
      }

      store.rebuildProjections();
      expect(describeDiffs(diffSnapshots(live, snapshotProjections(store.db, o.projectors)))).toBe('');
      expect(store.verifyChain().ok).toBe(true);
      expect(store.projectionHealth()).toEqual([]);
    } finally {
      await o.close();
    }
  });

  it('a restart reproduces them as well: reopening the data dir changes nothing', async () => {
    const h = copyHistory(seeded);
    const first = await openHistory(h);
    const live = snapshotProjections(first.rt.store.db, first.projectors);
    await first.close();
    const second = await openHistory(h);
    try {
      expect(describeDiffs(diffSnapshots(live, snapshotProjections(second.rt.store.db, second.projectors)))).toBe('');
    } finally {
      await second.close();
    }
  });
});

/**
 * The body scopes worth erasing, by kind: people, projects, tickets, sessions and learning records (system scopes are
 * not data subjects). Sessions whose words were distilled into the knowledge index come first: erasing those has to
 * reach the FTS index too.
 */
function erasable(store: EventStore): Record<string, string[]> {
  const indexed = new Set((store.db.prepare('SELECT DISTINCT scope_id AS s FROM reg_kn_links').all() as { s: string }[]).map((r) => r.s));
  const kinds: Record<string, string[]> = { user: [], project: [], ticket: [], session: [], indexedSession: [], offence: [] };
  for (const scope of bodiesByScope(store).keys()) {
    if (scope.startsWith('user:')) kinds.user!.push(scope);
    else if (scope.startsWith('prj_')) kinds.project!.push(scope);
    else if (scope.startsWith('tkt_')) kinds.ticket!.push(scope);
    else if (scope.startsWith('ses_')) (indexed.has(scope) ? kinds.indexedSession! : kinds.session!).push(scope);
    else if (scope.startsWith('off_')) kinds.offence!.push(scope);
  }
  return kinds;
}

describe('erasing a scope (§13)', () => {
  it('leaves none of the erased text anywhere, and live equals rebuilt afterwards', async () => {
    const probe = await openHistory(copyHistory(seeded));
    const kinds = erasable(probe.rt.store);
    await probe.close();
    const order = ['indexedSession', 'user', 'ticket', 'project', 'session', 'offence'];
    const failures: string[] = [];
    await forSeeds(
      'projection erasure',
      async (rng, seed) => {
        const kind = order[(seed - 1) % order.length]!;
        const scope = rng.pick(kinds[kind]!);
        const h = copyHistory(seeded);
        const o = await openHistory(h);
        try {
          const store = o.rt.store;
          const needles = plaintextOnlyIn(store, scope);
          store.eraseScope(scope, { actor: { kind: 'human', id: 'usr_dpo' }, reason: 'pdpa_request' });
          const problems: string[] = [];

          const hits = new Map<string, string>();
          for (const hit of scanTables(store.db, needles)) hits.set(hit.where, hit.needle);
          for (const [where, needle] of hits) problems.push(`erased text survives in ${where}: ${JSON.stringify(needle.slice(0, 50))}`);
          const orphans = ftsOrphanTerms(store.db);
          if (orphans.length) problems.push(`the knowledge index still holds terms of no remaining document: ${orphans.slice(0, 8).join(', ')}`);
          const files = scanFiles(h.aocData, needles);
          if (files.length) problems.push(`${files.length} erased string(s) are still in ${[...new Set(files.map((f) => f.where))].join(' and ')}, e.g. ${JSON.stringify(files[0]!.needle.slice(0, 50))}`);

          const live = snapshotProjections(store.db, o.projectors);
          store.rebuildProjections();
          const diffs = diffSnapshots(live, snapshotProjections(store.db, o.projectors));
          if (diffs.length) problems.push(`rebuilding after the erasure changes the projections:\n   ${describeDiffs(diffs)}`);
          const unindexed = store.db.prepare('SELECT count(*) AS n FROM reg_kn_docs WHERE k NOT IN (SELECT rowid FROM reg_knowledge)').get() as { n: number };
          const dangling = store.db.prepare('SELECT count(*) AS n FROM reg_knowledge WHERE rowid NOT IN (SELECT k FROM reg_kn_docs)').get() as { n: number };
          if (unindexed.n || dangling.n) problems.push(`knowledge documents and index rows no longer match (${unindexed.n} unindexed, ${dangling.n} dangling)`);
          if (!store.verifyChain().ok) problems.push('the chain no longer verifies');
          if (store.bodies.countScope(scope) !== 0) problems.push('bodies remain in the erased scope');
          if (problems.length) failures.push(`erasing ${kind} scope ${scope} (seed ${seed}, ${needles.length} text values):\n - ${problems.join('\n - ')}`);
        } finally {
          await o.close();
          await discardHistory(h);
        }
      },
      { count: 5 },
    );
    expect(failures.join('\n\n')).toBe('');
  }, 900_000);
});
