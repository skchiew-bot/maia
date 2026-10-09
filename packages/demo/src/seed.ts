/**
 * Demo history seeder — `pnpm --filter @aoc/demo seed -- --data-dir <abs dir> [--days 14] [--reset]`
 *
 * Builds a realistic, catalog-valid history (users, projects with git repos, sessions with manifests/evidence/usage,
 * phase pins, change control, intake tickets in every stage, decisions, playbooks, credits, FX, error learning) by
 * driving the REAL runtime with a moving fake clock, so every module's projections, the hash chain and anchors are
 * genuine. Deterministic (seeded PRNG), and no event is later than the seeding instant. Never use against a production
 * data dir. The sections of the seed are in ./seed/ (start at run.ts); the layout of the directory is ./layout.ts.
 *
 * "Now" has one session per liveness state. Working, Thinking and Stalled are queued launches: aocd's supervisor
 * starts them on claude-sim when it boots, so everything they show comes from a real managed process. Waiting on you,
 * Throttled and Dead are seeded states (no process) whose next turn — the decision answer, the limit reset, an
 * operator Restart — runs on claude-sim through the supervisor like any other.
 */
import { join } from 'node:path';
import { simEnv } from './daemon-env';
import { demoLayout, resetDemoDir } from './layout';
import { runSeed } from './seed/run';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};

const repoDir = new URL('../../..', import.meta.url).pathname.replace(/\/+$/, '');
const layout = demoLayout(arg('data-dir', join(repoDir, '.aoc/demo')));
const days = Number(arg('days', '14'));
if (!Number.isInteger(days) || days < 14 || days > 60) {
  console.error('--days must be a whole number of days between 14 and 60 (the scripted change control and tickets reach back two weeks)');
  process.exit(1);
}

try {
  if (process.argv.includes('--reset')) resetDemoDir(layout);
  const { tokens } = await runSeed({ dataDir: layout.root, days });
  const env = Object.entries({ AOC_CONFIG: layout.config, ...simEnv(layout) }).map(([k, v]) => `${k}=${v}`);
  console.log(`Seeded ${tokens.head.seq} events into ${layout.root}`);
  console.log(`Tokens: ${layout.tokens} (the "ceo" token signs you in as the Approver)`);
  console.log(`Live:  pnpm --filter @aoc/demo live -- --data-dir ${layout.root}`);
  console.log(`  or:  ${env.join(' ')} node --import tsx packages/daemon/src/main.ts`);
  console.log('       (managed sessions run on claude-sim, never the real claude CLI)');
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
