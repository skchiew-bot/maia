/**
 * "Now": one session per liveness state. Working, Thinking and Stalled are queued launches that aocd's supervisor
 * starts on claude-sim when it boots, so everything they show comes from a real managed process. Waiting on you,
 * Throttled and Dead are seeded states with no process; their next turn (the decision answered, the limit reset, an
 * operator Restart) runs on claude-sim through the supervisor like any other. Every event of a session falls inside
 * its own window, before the moment it reached its state and never after the seeding instant.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { simStatePathFor, type SimState } from '@aoc/claude-sim';
import { newId, transcriptPathFor } from '@aoc/contracts';
import type { LiveKind } from '../layout';
import { simPrompt } from '../scenarios';
import { ensureWorkspace, workspaceDir } from '../workspaces';
import { planFor } from './plans';
import type { WaitingBuild } from './tickets';
import { MINUTE, agent, sys, type ProjectInfo, type SeedWorld } from './world';

/**
 * The waiting build's turn ended on a decision, so the supervisor resumes its conversation (`--resume`) once the
 * decision is answered: give claude-sim that conversation, an empty transcript plus the scenario cursor.
 */
export function writeResumableConversation(w: SeedWorld, waiting: WaitingBuild): void {
  const { session: s } = waiting;
  const transcript = transcriptPathFor(realpathSync(s.project.repo), s.claude, w.layout.claudeConfig);
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, '');
  const iso = new Date(waiting.waitingSince).toISOString();
  const state: SimState = {
    version: 1,
    sessionId: s.claude,
    scenario: { kind: 'builtin', name: 'demo-dedupe-resume' },
    cursor: 0,
    saved: {},
    context: { cachedPrefix: waiting.contextTokens, uncached: 0, lastRequestAt: null },
    idCounter: 0,
    turns: 1,
    createdAt: iso,
    updatedAt: iso,
  };
  const file = simStatePathFor(s.claude, w.layout.claudeConfig);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

export interface NowSessions {
  ids: Record<Exclude<LiveKind, 'waiting'>, string>;
}

export function seedNow(w: SeedWorld): NowSessions {
  const { cx, aoc, claims } = w.projects;
  const now = w.now;
  const owner = (k: 'aisyah' | 'weijie' | 'priya') => w.people[k].userId;
  // These sessions edit files when they run on claude-sim, so each works in a workspace of its own (the names are the
  // fleet slots they belong to): the checkouts that promotions and rollbacks move stay clean.
  const workspace = (project: ProjectInfo, name: string) => ensureWorkspace(project.repo, workspaceDir(w.layout, project.id, name));

  // Throttled: the plan limit hit 22 minutes ago, with a reset time; the supervisor resumes the session after it.
  w.at(now - 52 * MINUTE);
  const throttled = w.kit.launch(owner('weijie'), cx, 'feature-build', simPrompt('Real-time CSAT sentiment overlay', 'Show a rolling sentiment colour on the agent desktop while the call is live.', 'demo-csat-resume'), {
    thread: 'thr_cx-copilot_csat',
    plan: planFor('feature', 'csat'),
    cwd: workspace(cx, 'csat'),
  });
  w.kit.workedUntil(throttled, now - 24 * MINUTE);
  w.at(now - 22 * MINUTE);
  w.store.append({
    type: 'throttle.hit',
    actor: agent(throttled.sessionId),
    scope: { sessionId: throttled.sessionId },
    meta: { sessionId: throttled.sessionId, resetAt: new Date(now + 95 * MINUTE).toISOString(), source: 'stream' },
    payload: { message: "You've hit your session limit · resets 2:05pm (Asia/Kuala_Lumpur)" },
    source: 'supervisor',
  });
  w.store.append({ type: 'session.turn_ended', actor: sys('supervisor'), scope: { sessionId: throttled.sessionId }, meta: { sessionId: throttled.sessionId, turn: 1, outcome: 'throttled', exitCode: 1, durationMs: 1000 }, payload: {}, source: 'supervisor' });
  w.store.append({ type: 'session.lifecycle_changed', actor: sys('supervisor'), scope: { sessionId: throttled.sessionId }, meta: { sessionId: throttled.sessionId, from: 'running', to: 'throttled', reason: 'plan_limit' }, source: 'supervisor' });

  // Dead: its process crashed 12 minutes ago; Restart starts a fresh conversation from its launch prompt.
  w.at(now - 46 * MINUTE);
  const dead = w.kit.launch(owner('priya'), aoc, 'docs', simPrompt('Document the rollback runbook', 'Add the rollback flow diagram and check every link in docs/runbooks/rollback.md.', 'demo-runbook-restart'), {
    thread: 'thr_aoc-platform_rollback-docs',
    plan: planFor('docs', 'runbook'),
    cwd: workspace(aoc, 'runbook'),
  });
  w.kit.workedUntil(dead, now - 14 * MINUTE);
  w.at(now - 12 * MINUTE);
  w.store.append({ type: 'session.turn_ended', actor: sys('supervisor'), scope: { sessionId: dead.sessionId }, meta: { sessionId: dead.sessionId, turn: 1, outcome: 'crashed', exitCode: 143, durationMs: 1000 }, payload: {}, source: 'supervisor' });
  w.store.append({ type: 'session.lifecycle_changed', actor: sys('supervisor'), scope: { sessionId: dead.sessionId }, meta: { sessionId: dead.sessionId, from: 'running', to: 'failed', reason: 'exit_143_no_result' }, source: 'supervisor' });

  // Observed session (a developer terminal, read-only): its hooks went quiet 12 minutes ago, so it reads Stalled.
  const observed = newId('session', w.clock.now());
  w.store.append({ type: 'session.observed', actor: sys('sessions'), scope: { sessionId: observed }, meta: { sessionId: observed, claudeSessionId: randomUUID(), projectId: aoc.id }, payload: { cwd: aoc.repo, transcriptPath: '' }, source: 'hook' });

  // Working / Thinking / Stalled: launches requested while aocd was down; aocd starts them on claude-sim at boot.
  w.at(now - 3 * MINUTE);
  const queued = {
    working: w.kit.queue(owner('aisyah'), cx, 'feature-build', simPrompt('Add supervisor whisper suggestions to the agent desktop', 'Rank reply suggestions by live intent confidence, show at most three cards in the agent panel and emit whisper telemetry.', 'demo-feature-build'), 'thr_cx-copilot_whisper', workspace(cx, 'feature')),
    thinking: w.kit.queue(owner('weijie'), claims, 'discovery', simPrompt('Design an OCR fallback for handwritten claim forms', 'Handwritten claim forms fail the printed-text OCR engine. Find the cheapest safe fallback and prototype it.', 'demo-deep-think'), 'thr_claims-bot_ocr', workspace(claims, 'discovery')),
    stalled: w.kit.queue(owner('priya'), cx, 'migration', simPrompt('Migrate interaction history to the partitioned table', 'Move interaction history to monthly partitions without downtime: migration, resumable backfill, dual-write, read switch.', 'demo-stall'), 'thr_cx-copilot_history', workspace(cx, 'stall')),
  };

  return { ids: { ...queued, throttled: throttled.sessionId, dead: dead.sessionId, observed } };
}
