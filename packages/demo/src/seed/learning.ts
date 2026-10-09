/**
 * Credits, error learning and the two cards waiting in the Approver's inbox that belong to those modules: a lesson to
 * bind and a credit top-up. Both cards are raised through their module's own request path (mod-learning's lesson
 * proposal, mod-credits' top-up request), so the lesson and the request exist and denying or approving the card moves
 * them.
 */
import { createHash } from 'node:crypto';
import { MODEL_ID_BY_TIER, newId } from '@aoc/contracts';
import { localDate } from '@aoc/kernel';
import { between, pick, rnd } from './rng';
import { DAY, HOUR, human, sys, type SeedWorld } from './world';

const TZ = 'Asia/Kuala_Lumpur';
const BUILDERS = ['aisyah', 'weijie', 'priya'] as const;

const CLASSES = [
  { classId: 'rcc_spec_ambiguity', name: 'Ambiguous acceptance criteria in tickets', dimension: 'spec' },
  { classId: 'rcc_missing_env_guard', name: 'Missing env-var guard in config loader', dimension: 'guardrail' },
  { classId: 'rcc_haiku_sql', name: 'Malformed SQL migrations on the cheap model', dimension: 'model_capability' },
] as const;

export const LESSON_CLASS = 'rcc_missing_env_guard';

/** Root-cause classes and the error occurrences assigned to them (the recurrence trend of §11). */
export function seedErrorLearning(w: SeedWorld): void {
  const projects = Object.values(w.projects);
  const priya = w.people.priya.userId;
  for (const c of CLASSES) {
    w.at(w.t0 + 2 * DAY);
    w.store.append({ type: 'rootcause.class_defined', actor: human(priya), scope: {}, meta: { classId: c.classId, dimension: c.dimension }, payload: { name: c.name }, source: 'api' });
    for (let i = 0; i < between(3, 7); i++) {
      w.at(w.t0 + between(2, w.days - 1) * DAY + between(0, 8) * HOUR);
      const errorId = newId('error', w.clock.now());
      w.store.append({
        type: 'error.observed',
        actor: sys('learning'),
        scope: { projectId: pick(projects).id },
        meta: {
          errorId,
          source: pick(['tool', 'test', 'uat'] as const),
          sessionId: null,
          projectId: null,
          processType: pick(['feature-build', 'test-repair', 'migration']),
          model: c.dimension === 'model_capability' ? MODEL_ID_BY_TIER.haiku : pick([MODEL_ID_BY_TIER.sonnet, MODEL_ID_BY_TIER.opus]),
          signature: createHash('sha256').update(c.classId).digest('hex').slice(0, 32),
          codeArea: 'src/config',
          priority: rnd() < 0.2 ? 'high' : 'normal',
          costUsd: Math.round(rnd() * 400) / 100,
          costMs: between(60_000, 1_800_000),
        },
        payload: { message: `${c.name} (occurrence ${i + 1})` },
        source: 'system',
      });
      w.store.append({ type: 'rootcause.assigned', actor: human(priya), scope: {}, meta: { errorId, classId: c.classId, assignedBy: 'human', confidence: 1 }, source: 'api' });
    }
  }
}

/**
 * The CEO's monthly allocations (mod-credits' own endpoint), made on the first morning of each month the history
 * covers; the history starts mid-month, so its first allocation is made the hour it starts.
 */
export function scheduleAllocations(w: SeedWorld): void {
  const periods = new Set<string>();
  for (let t = w.t0; t <= w.now; t += DAY) periods.add(localDate(t, TZ).slice(0, 7));
  for (const period of periods) {
    const at = Math.min(Math.max(w.t0 + HOUR, Date.parse(`${period}-01T09:00:00+08:00`)), w.now - HOUR);
    w.timeline.schedule(at, `credits: allocations for ${period}`, async () => {
      for (const b of BUILDERS) {
        await w.ok('POST', '/api/credits/allocations', 'ceo', { userId: w.people[b].userId, period, amountUsd: 300 });
      }
    });
  }
}

/** A lesson waiting to be bound (a human-required decision, §11), proposed through mod-learning. */
export async function seedLessonProposal(w: SeedWorld): Promise<string> {
  w.at(w.now - 26 * HOUR);
  const lesson = await w.ok<{ lessonId: string }>('POST', '/api/learning/lessons', 'priya', {
    classId: LESSON_CLASS,
    scopeType: 'code_area',
    scopeValue: 'src/config',
    rule: 'Config loaders must fail fast on missing env vars with a named error',
    fix: 'Check every required variable when the loader starts and throw one error that names each missing variable.',
    rationale: 'Missing variables surfaced as undefined deep inside request handlers six times this fortnight; a start-up check turns each of them into one obvious failure.',
  });
  return lesson.lessonId;
}

/**
 * Wei Jie's top-up request, made through the credits API with his real balance in the reason. It names no session: a
 * request tied to his throttled session would read as that session waiting on the Approver, and Throttled is a state
 * of its own on the console.
 */
export async function seedTopupRequest(w: SeedWorld): Promise<string> {
  const credits = w.rt.services.get('credits');
  const b = credits.balance(w.people.weijie.userId);
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const perDay = b.usedUsd / Math.max(1, Number(localDate(w.now, TZ).slice(8, 10)));
  w.at(w.now - 3 * HOUR);
  const requested = await w.ok<{ requestId: string }>('POST', '/api/credits/topup-requests', 'weijie', {
    amountUsd: 100,
    reason: `The CSAT overlay build runs for another two weeks. ${usd(b.usedUsd)} of the ${usd(b.allocationUsd)} October allocation is used (about ${usd(perDay)} a day); a ${usd(100)} top-up covers the remaining runs without stopping the build mid-task.`,
  });
  return requested.requestId;
}
