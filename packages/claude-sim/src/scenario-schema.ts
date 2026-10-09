import { z } from 'zod';

/**
 * Scenario format. A scenario is an ordered list of steps; the cursor into it is persisted per session so
 * `--resume` continues where the previous turn ended. Every step may carry a `label` (a `branch` target) and
 * a free-text `note` for scenario authors.
 */

const label = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'labels may contain letters, digits, . _ : -');
const saveAs = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'saveAs must be an identifier');
const tokens = z.number().int().nonnegative();
const common = { label: label.optional(), note: z.string().max(2000).optional() };

/**
 * Model "thinking": sleeps `ms` (scaled by CLAUDE_SIM_SPEED) while streaming progress, and opens (or extends)
 * an API response whose output tokens are `outputTokens`; input/cache tokens default to the session's context
 * model. `thinking` is the block's text — empty by default, like Claude Code's redacted thinking.
 */
export const ThinkStepSchema = z
  .object({
    kind: z.literal('think'),
    ms: z.number().int().nonnegative(),
    outputTokens: tokens,
    inputTokens: tokens.optional(),
    cacheRead: tokens.optional(),
    cacheWrite: tokens.optional(),
    thinking: z.string().max(20_000).optional(),
    ...common,
  })
  .strict();

/** Assistant text block (templated). */
export const TextStepSchema = z
  .object({ kind: z.literal('text'), text: z.string().min(1).max(100_000), ...common })
  .strict();

/** A tool call. Built-ins run against the real cwd unless `result` scripts the output; `mcp__s__t` names route to MCP. */
export const ToolStepSchema = z
  .object({
    kind: z.literal('tool'),
    name: z.string().min(1).max(200),
    input: z.record(z.unknown()).default({}),
    result: z.string().optional(),
    isError: z.boolean().optional(),
    saveAs: saveAs.optional(),
    ...common,
  })
  .strict();

/** MCP tool call on a server from --mcp-config. The parsed result can be saved for later `{{saveAs.path}}` use. */
export const McpStepSchema = z
  .object({
    kind: z.literal('mcp'),
    server: z.string().min(1).max(200),
    tool: z.string().min(1).max(200),
    args: z.record(z.unknown()).default({}),
    saveAs: saveAs.optional(),
    /** Honour `boundary.continue === false` and request_decision by ending the turn (default true). */
    obey: z.boolean().optional(),
    ...common,
  })
  .strict();

/** Bash tool call: scripted stdout unless CLAUDE_SIM_EXEC=1 and `exec: true`. */
export const BashStepSchema = z
  .object({
    kind: z.literal('bash'),
    command: z.string().min(1).max(20_000),
    description: z.string().max(500).optional(),
    stdout: z.string().default(''),
    stderr: z.string().optional(),
    exitCode: z.number().int().min(0).max(255).optional(),
    exec: z.boolean().optional(),
    saveAs: saveAs.optional(),
    ...common,
  })
  .strict();

/** End the turn (Stop hooks run). `final` also marks the scenario complete so later resumes do no more work. */
export const EndTurnStepSchema = z
  .object({ kind: z.literal('endTurn'), final: z.boolean().optional(), ...common })
  .strict();

/**
 * Plan usage limit hit: rate_limit_event, synthetic error message, StopFailure hooks, `is_error` result with
 * api_error_status 429, exit 1. Resume continues after it. `form`: "current" (default) is
 * `You've hit your session limit · resets 3pm (<zone>)`, "legacy" is `Claude AI usage limit reached|<epoch>`,
 * "classic" is `5-hour limit reached ∙ resets 3pm`.
 */
export const RateLimitStepSchema = z
  .object({
    kind: z.literal('rateLimit'),
    resetsInMinutes: z
      .number()
      .positive()
      .max(60 * 24 * 14),
    limit: z.enum(['session', 'weekly', 'opus', 'sonnet']).optional(),
    form: z.enum(['current', 'legacy', 'classic']).optional(),
    ...common,
  })
  .strict();

/** Abrupt exit: no result line, no Stop/SessionEnd hooks, unflushed assistant blocks are lost. */
export const CrashStepSchema = z
  .object({
    kind: z.literal('crash'),
    exitCode: z.number().int().min(1).max(255).optional(),
    stderr: z.string().optional(),
    ...common,
  })
  .strict();

/** Produce no output at all for `ms` (scaled) — for stall detection. */
export const HangStepSchema = z
  .object({ kind: z.literal('hang'), ms: z.number().int().positive(), ...common })
  .strict();

/** Grow the cached context so the next request reads `tokens` more cache-read tokens. */
export const ContextGrowthStepSchema = z
  .object({ kind: z.literal('contextGrowth'), tokens: z.number().int().positive(), ...common })
  .strict();

/**
 * Jump to `goto` (a label or step index). With `onResumeTextIncludes` the jump happens only if the latest
 * input (prompt, resume prompt or Stop-hook feedback) contains one of the strings, case-insensitively; with
 * `onLastToolError` only if the last tool result's error state equals the flag. No condition = always jump.
 */
export const BranchStepSchema = z
  .object({
    kind: z.literal('branch'),
    onResumeTextIncludes: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    onLastToolError: z.boolean().optional(),
    goto: z.union([label, z.number().int().nonnegative()]),
    ...common,
  })
  .strict();

/** Fire the Notification hook. */
export const NotificationStepSchema = z
  .object({
    kind: z.literal('notification'),
    message: z.string().min(1).max(2000),
    notificationType: z.string().min(1).max(64).optional(),
    ...common,
  })
  .strict();

/** Compact the conversation: PreCompact hooks, a compact boundary, then SessionStart(source=compact). */
export const CompactStepSchema = z
  .object({
    kind: z.literal('compact'),
    trigger: z.enum(['auto', 'manual']).optional(),
    instructions: z.string().max(2000).optional(),
    ...common,
  })
  .strict();

export const ScenarioStepSchema = z.discriminatedUnion('kind', [
  ThinkStepSchema,
  TextStepSchema,
  ToolStepSchema,
  McpStepSchema,
  BashStepSchema,
  EndTurnStepSchema,
  RateLimitStepSchema,
  CrashStepSchema,
  HangStepSchema,
  ContextGrowthStepSchema,
  BranchStepSchema,
  NotificationStepSchema,
  CompactStepSchema,
]);

export const ScenarioSchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().max(4000).optional(),
    steps: z.array(ScenarioStepSchema).min(1).max(10_000),
  })
  .strict()
  .superRefine((scenario, ctx) => {
    const labels = new Map<string, number>();
    scenario.steps.forEach((step, index) => {
      if (step.label === undefined) return;
      if (labels.has(step.label)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps', index, 'label'],
          message: `duplicate label "${step.label}"`,
        });
      }
      labels.set(step.label, index);
    });
    scenario.steps.forEach((step, index) => {
      if (step.kind !== 'branch') return;
      if (step.onResumeTextIncludes !== undefined && step.onLastToolError !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps', index],
          message: 'a branch takes at most one condition',
        });
      }
      const target = step.goto;
      const valid = typeof target === 'number' ? target < scenario.steps.length : labels.has(target);
      if (!valid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps', index, 'goto'],
          message: `unknown goto target ${JSON.stringify(target)}`,
        });
      }
    });
  });

export type Scenario = z.infer<typeof ScenarioSchema>;
/** What a scenario author writes (defaults not yet applied). */
export type ScenarioInput = z.input<typeof ScenarioSchema>;
export type ScenarioStep = z.infer<typeof ScenarioStepSchema>;
export type ScenarioStepKind = ScenarioStep['kind'];
export type StepOf<K extends ScenarioStepKind> = Extract<ScenarioStep, { kind: K }>;

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioError';
  }
}

/** Validate a scenario, turning zod issues into one readable message. */
export function parseScenario(raw: unknown, source: string): Scenario {
  const result = ScenarioSchema.safeParse(raw);
  if (result.success) return result.data;
  const issues = result.error.issues
    .slice(0, 8)
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new ScenarioError(`invalid scenario ${source}:\n${issues}`);
}
