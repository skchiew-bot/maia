import type { LearningService, ModelTier } from '@aoc/contracts';
import type { AocModule } from '@aoc/kernel';
import { LearningAi } from './ai';
import { LearningEngine, type ResolvedLearningOptions } from './engine';
import { createLearningProjector } from './projector';
import { lessonDecisionReactor, offenceReactor, ruleReactor, sourcesReactor } from './reactors';
import { LearningReads } from './reads';
import { registerRoutes } from './routes';

export { errorSignature, normalizeMessage, toolErrorText } from './signature';
export { classVerdict, lessonPayoff, processVerdict, unusedStreak } from './rules';
export { LEARNING_TABLES } from './projector';

/** Options for the learning module (all optional; retirement and verification windows live in config.learning). */
export interface LearningModuleOptions {
  /** Minimum AI confidence to accept a root-cause suggestion; below it the error stays unassigned (default 0.7). */
  classifyMinConfidence?: number;
  /** Cost multiplier for UAT / high-priority occurrences when ranking offences (default 3). */
  highPriorityMultiplier?: number;
  /** Minutes of session usage after an error that count as its cost (default 30). */
  costWindowMinutes?: number;
  /** Runs needed on BOTH tiers before the model dimension gives a verdict (default 3). */
  minRunsPerTier?: number;
  /** A lesson application whose session never reports an end counts as settled after this long (default 24). */
  runSettleHours?: number;
  /** Model for lesson distillation (default sonnet; classification always uses haiku). */
  distillModel?: ModelTier;
  /** Max LLM classifications per AI job run (default 25). */
  classifyBatch?: number;
  /** Unassigned errors older than this are transient: never sent to the classifier (default 24). */
  classifyLookbackHours?: number;
  /** AI job interval (default 60 s). */
  aiEveryMs?: number;
}

function resolve(o: LearningModuleOptions): ResolvedLearningOptions {
  return {
    classifyMinConfidence: o.classifyMinConfidence ?? 0.7,
    highPriorityMultiplier: o.highPriorityMultiplier ?? 3,
    costWindowMinutes: o.costWindowMinutes ?? 30,
    minRunsPerTier: o.minRunsPerTier ?? 3,
    runSettleHours: o.runSettleHours ?? 24,
    distillModel: o.distillModel ?? 'sonnet',
    classifyBatch: o.classifyBatch ?? 25,
    classifyLookbackHours: o.classifyLookbackHours ?? 24,
    aiEveryMs: o.aiEveryMs ?? 60_000,
  };
}

function learningService(engine: LearningEngine): LearningService {
  return {
    lessonsForScope: (scope) => engine.lessonsForScope(scope),
    recordLessonsApplied: (lessonIds, sessionId, actor) => engine.applyLessons(lessonIds, sessionId, actor),
    recordError(input, actor) {
      engine.recordError(
        {
          source: input.source,
          sessionId: input.sessionId,
          projectId: input.projectId,
          message: input.message,
          context: input.context,
          fix: input.fix,
          rootCauseHint: input.rootCauseClass,
          codeArea: input.codeArea,
          priority: input.priority,
        },
        actor,
        'system',
      );
    },
  };
}

/**
 * Error learning (§11): occurrences → root-cause classes (rule / AI / human) → repeat offences ranked by cost of
 * recurrence → distilled, scoped, human-bound lessons that retire when unused. Root-cause classes only — never
 * per-person blame (R11).
 */
export function createLearningModule(opts: LearningModuleOptions = {}): AocModule {
  const options = resolve(opts);
  let engine: LearningEngine | null = null;
  let reads: LearningReads | null = null;
  let ai: LearningAi | null = null;
  const eng = (): LearningEngine => {
    if (!engine) throw new Error('learning module not initialised');
    return engine;
  };
  return {
    name: 'learning',
    projectors: [createLearningProjector()],
    reactors: [sourcesReactor(eng), ruleReactor(eng), offenceReactor(eng), lessonDecisionReactor(eng)],
    jobs: [
      { name: 'learning.ai', schedule: { everyMs: options.aiEveryMs }, run: () => ai?.tick() },
      {
        name: 'learning.verify-offences',
        schedule: { dailyAt: '03:10' },
        run: () => void eng().verifyOffences(),
      },
      {
        name: 'learning.retire-lessons',
        schedule: { dailyAt: '03:20' },
        run: () => void eng().retireUnusedLessons(),
      },
    ],
    init(ctx) {
      engine = new LearningEngine(ctx, options);
      reads = new LearningReads(engine);
      ai = new LearningAi(engine);
      ctx.services.provide('learning', learningService(engine));
    },
    routes(app) {
      registerRoutes(app, eng, () => {
        if (!reads) throw new Error('learning module not initialised');
        return reads;
      });
    },
  };
}
