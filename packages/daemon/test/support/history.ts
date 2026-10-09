/**
 * A realistic multi-module history to test projections against: the demo seeder (users, projects with git repos,
 * sessions with manifests, evidence and usage, decisions, playbooks, credits, FX, error learning, intake tickets),
 * run as a child process into a temp directory and reopened here with the production module list. The supervisor
 * contributes only its projector: reopening must never start a claude process.
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { AocConfigSchema, type AocConfig } from '@aoc/contracts';
import { AocRuntime, FakeClock, silentLogger, type AocModule, type AppEnv, type Projector } from '@aoc/kernel';
import { createAuditModule } from '@aoc/mod-audit';
import { createChangeModule } from '@aoc/mod-change';
import { createCreditsModule } from '@aoc/mod-credits';
import { createDecisionsModule } from '@aoc/mod-decisions';
import { createEvidenceModule } from '@aoc/mod-evidence';
import { createFxModule } from '@aoc/mod-fx';
import { createIdentityModule } from '@aoc/mod-identity';
import { createIntakeModule } from '@aoc/mod-intake';
import { createLearningModule } from '@aoc/mod-learning';
import { createLedgerModule } from '@aoc/mod-ledger';
import { createMeteringModule } from '@aoc/mod-metering';
import { createRegistryModule } from '@aoc/mod-registry';
import { createSessionsModule } from '@aoc/mod-sessions';
import { createTowerModule } from '@aoc/mod-tower';
import { createSupervisorModule } from '@aoc/supervisor';
import { repoRoot } from '../helpers';

const tmpDirs: string[] = [];

/** Removing tens of history copies is long: asynchronously, so the vitest worker keeps answering its RPC calls. */
export async function cleanupHistoryDirs(): Promise<void> {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

/** Drop a private copy as soon as its test is done: one per seed would otherwise pile up on disk. */
export async function discardHistory(h: SeededHistory): Promise<void> {
  const i = tmpDirs.indexOf(h.root);
  if (i >= 0) tmpDirs.splice(i, 1);
  await rm(h.root, { recursive: true, force: true });
}

export interface SeededHistory {
  /** The seeder's directory (aoc.config.json, repos, aoc/ = AOC's data dir). */
  root: string;
  aocData: string;
  config: AocConfig;
}

/**
 * Run the demo seeder for `days` days of history into a fresh temp directory. Asynchronous on purpose: a minute of
 * blocked event loop starves vitest's worker of its RPC replies and fails the run with a timeout.
 */
export async function seedDemoHistory(days = 14): Promise<SeededHistory> {
  const root = mkdtempSync(join(tmpdir(), 'aoc-history-'));
  tmpDirs.push(root);
  const tsx = pathToFileURL(createRequire(join(repoRoot, 'package.json')).resolve('tsx')).href;
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('AOC_') || k.startsWith('CLAUDE_SIM_') || ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(k)) continue;
    env[k] = v;
  }
  const child = spawn(
    process.execPath,
    ['--import', tsx, join(repoRoot, 'packages', 'demo', 'src', 'seed.ts'), '--data-dir', join(root, 'demo'), '--days', String(days), '--reset'],
    { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk));
  const timer = setTimeout(() => child.kill('SIGKILL'), 240_000);
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  }).finally(() => clearTimeout(timer));
  if (status !== 0) throw new Error(`the demo seeder failed (${status}):\n${output}`);
  return loadHistory(join(root, 'demo'));
}

function loadHistory(root: string): SeededHistory {
  const config = AocConfigSchema.parse(JSON.parse(readFileSync(join(root, 'aoc.config.json'), 'utf8')));
  return { root, aocData: config.dataDir, config };
}

/** A private copy of a history (tests erase and rebuild in theirs). */
export function copyHistory(h: SeededHistory): SeededHistory {
  const root = mkdtempSync(join(tmpdir(), 'aoc-history-copy-'));
  tmpDirs.push(root);
  cpSync(h.root, root, { recursive: true });
  // Absolute paths in the seeded config point at the original; re-point them at the copy.
  const text = readFileSync(join(root, 'aoc.config.json'), 'utf8').split(h.root).join(root);
  return { root, aocData: join(root, 'aoc'), config: AocConfigSchema.parse(JSON.parse(text)) };
}

/** The production module list as the seeder composed it, plus the supervisor's projection only. */
export function historyModules(): AocModule[] {
  const supervisorView: AocModule = { name: 'supervisor-projection', projectors: createSupervisorModule().projectors };
  return [
    createIdentityModule({ bootstrap: false }),
    createRegistryModule(),
    createSessionsModule({ sweepIntervalMs: 0 }),
    createDecisionsModule(),
    createLedgerModule(),
    createMeteringModule(),
    createFxModule(),
    createCreditsModule(),
    createLearningModule(),
    createChangeModule(),
    createAuditModule(),
    createEvidenceModule(),
    createIntakeModule(),
    createTowerModule(),
    supervisorView,
  ];
}

export interface OpenedHistory {
  rt: AocRuntime;
  app: Hono<AppEnv>;
  projectors: Projector[];
  close(): Promise<void>;
}

export async function openHistory(h: SeededHistory, opts: { modules?: AocModule[] } = {}): Promise<OpenedHistory> {
  const modules = opts.modules ?? historyModules();
  // Later than anything in the log, so time-driven reads (ageing, windows) behave as on a running system.
  const clock = new FakeClock(Date.now() + 60_000);
  const rt = await AocRuntime.create({ config: h.config, modules, clock, log: silentLogger });
  return {
    rt,
    app: rt.mount(new Hono<AppEnv>()),
    projectors: modules.flatMap((m) => m.projectors ?? []),
    close: () => rt.stop(),
  };
}
