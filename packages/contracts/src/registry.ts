/** Fixed process-type registry (§2.2): the type — and therefore the model — is declared at launch, never by the agent. */
import { z } from 'zod';
import { MODEL_TIERS, PROCESS_CLASSES } from './domain';

export const ProcessTypeSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
    name: z.string().min(1).max(80),
    description: z.string().max(500).default(''),
    class: z.enum(PROCESS_CLASSES),
    /** Model for discovery runs / runs without an approved playbook. Discovery-class MUST be opus (credits never override). */
    model: z.enum(MODEL_TIERS),
    /** Model used once an approved playbook exists for this type (the distillation payoff). */
    executionModel: z.enum(MODEL_TIERS).nullable().default(null),
    readOnly: z.boolean().default(false),
    /** Named credential profile injected by the supervisor; null = no credentials. Never for read-only types. */
    credentialProfile: z.string().nullable().default(null),
    permissionMode: z.enum(['acceptEdits', 'dontAsk', 'bypassPermissions', 'default', 'plan']).default('acceptEdits'),
    tools: z.object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() }).default({}),
    /** Restrict the built-in tool set (`--tools`), e.g. ["Read","Glob","Grep"] for read-only triage. Omit for the default set. */
    builtinTools: z.array(z.string()).optional(),
    requiresPlan: z.boolean().default(true),
    /** Rollover when context use crosses this % of the window (only at a clean task boundary). */
    rolloverContextPct: z.number().min(10).max(95).default(70),
    stallAfterMs: z.number().int().positive().optional(),
    diagnosisBudget: z.object({ tokens: z.number().int().positive(), minutes: z.number().int().positive() }).optional(),
    /** Risky types (migrations, deploys) never roll over mid-operation (R16). */
    risky: z.boolean().default(false),
  })
  .superRefine((t, ctx) => {
    if (t.class === 'discovery' && t.model !== 'opus' && t.model !== 'fable') {
      ctx.addIssue({ code: 'custom', message: `${t.id}: discovery-class types must run on opus (or fable)` });
    }
    if (t.readOnly && t.credentialProfile) {
      ctx.addIssue({ code: 'custom', message: `${t.id}: read-only types must not receive credentials` });
    }
  });
export type ProcessType = z.infer<typeof ProcessTypeSchema>;

export const ProcessRegistrySchema = z.object({
  version: z.string(),
  types: z.array(ProcessTypeSchema).min(1),
});
export type ProcessRegistry = z.infer<typeof ProcessRegistrySchema>;

/** Model routing (§2.2, §10): discovery → model; execution with an approved playbook → executionModel. Budget never changes it. */
export function routeModel(t: ProcessType, hasApprovedPlaybook: boolean): ProcessType['model'] {
  if (t.class === 'discovery') return t.model;
  if (hasApprovedPlaybook && t.executionModel) return t.executionModel;
  return t.model;
}
