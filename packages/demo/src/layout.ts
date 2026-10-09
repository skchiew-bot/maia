/**
 * Layout of a demo directory (`--data-dir`). AOC's own data dir is a subdirectory: aocd's self-modification guard
 * protects its whole data dir as audit state, so the project repositories the demo agents edit must live outside it.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';

export interface DemoLayout {
  root: string;
  /** aocd config (AOC_CONFIG); its dataDir is `aocData`. */
  config: string;
  /** Demo users' tokens and the ids of the seeded live sessions (0600). */
  tokens: string;
  /** AOC's data dir: event log, body store, keys, anchors, per-session supervisor files. */
  aocData: string;
  /** Git repositories of the demo projects (the agents' working directories). */
  repos: string;
  /** CLAUDE_CONFIG_DIR for claude-sim: transcripts and scenario state stay out of the operator's ~/.claude. */
  claudeConfig: string;
  /** The scenario for prompts without a marker: intake triage and builds of the seeded tickets, rollover successors. */
  simDefaultScenario: string;
  /** supervisor.credentialProfilesFile: every profile the demo references, each with an empty env (0600). */
  credentialProfiles: string;
  workspaces: string;
  logs: string;
  /** `live` launcher state: which session occupies which fleet slot (survives restarts). */
  fleet: string;
}

export function demoLayout(dir: string): DemoLayout {
  const root = resolve(dir);
  return {
    root,
    config: join(root, 'aoc.config.json'),
    tokens: join(root, 'demo-tokens.json'),
    aocData: join(root, 'aoc'),
    repos: join(root, 'repos'),
    claudeConfig: join(root, 'claude'),
    simDefaultScenario: join(root, 'claude', 'demo-default-scenario.json'),
    credentialProfiles: join(root, 'credential-profiles.json'),
    workspaces: join(root, 'workspaces'),
    logs: join(root, 'logs'),
    fleet: join(root, 'live-fleet.json'),
  };
}

/** The directory under `repos/` of each demo project's repository. */
export const PROJECT_SLUGS = { cx: 'cx-copilot', claims: 'claims-bot', aoc: 'aoc-platform' } as const;

export type LiveKind = 'working' | 'thinking' | 'stalled' | 'waiting' | 'throttled' | 'dead' | 'observed';

export interface DemoUser {
  userId: string;
  role: string;
  token: string;
}

/** `<root>/demo-tokens.json`, written by the seeder. */
export interface DemoTokens {
  dataDir: string;
  console: string;
  /** The seeding instant (ms since the epoch): no seeded event is later than this. */
  seededAt: number;
  tokens: Record<'ceo' | 'aisyah' | 'weijie' | 'priya' | 'daniel' | 'nur', DemoUser>;
  /** The seeded "now" sessions, one per liveness state. */
  sessions: Record<LiveKind, string>;
  /** Intake tickets filed by the demo requesters, one or more per funnel stage (`key` names the scripted ticket). */
  tickets: { ticketId: string; key: string; projectId: string }[];
  projects: Record<'cx' | 'claims' | 'aoc', string>;
  head: { seq: number; hash: string; chainId: string };
}

export function readDemoTokens(layout: DemoLayout): DemoTokens {
  return JSON.parse(readFileSync(layout.tokens, 'utf8')) as DemoTokens;
}

export function isSeeded(layout: DemoLayout): boolean {
  return existsSync(join(layout.aocData, 'aoc.db')) && existsSync(layout.tokens) && existsSync(layout.config);
}

/**
 * `--reset` deletes the directory, so it only does that to an empty directory or one this package created
 * (it has demo-tokens.json or aoc.config.json); anything else, or a filesystem root, is refused.
 */
export function resetDemoDir(layout: DemoLayout): void {
  if (!existsSync(layout.root)) return;
  if (parse(layout.root).root === layout.root) throw new Error(`refusing to reset ${layout.root}: it is a filesystem root`);
  const entries = readdirSync(layout.root);
  const ours = entries.includes('demo-tokens.json') || entries.includes('aoc.config.json');
  if (entries.length && !ours) {
    throw new Error(`refusing to reset ${layout.root}: it is not empty and was not created by the demo seeder`);
  }
  // A straggler of a previous run (a sidecar's last spool write) can recreate a directory mid-removal: retry on ENOTEMPTY.
  rmSync(layout.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
