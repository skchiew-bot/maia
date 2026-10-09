import { z } from 'zod';
import type { GitUnknownReason } from './events/ledger';

/**
 * AOC MCP server — the agent's structured voice (§2). All inputs are schema-validated; no free-text parsing.
 * Server name in Claude Code configs is `aoc`, so tools surface to the model as `mcp__aoc__<tool>`.
 */
export const AOC_MCP_SERVER_NAME = 'aoc';
export const mcpToolName = (tool: AocMcpToolName) => `mcp__${AOC_MCP_SERVER_NAME}__${tool}` as const;

export const TASK_SIZES = ['xs', 's', 'm', 'l', 'xl'] as const;
export type TaskSize = (typeof TASK_SIZES)[number];
/** Declared size -> weight used by progress (tasks are weighted by declared size, §4). */
export const TASK_SIZE_WEIGHT: Record<TaskSize, number> = { xs: 1, s: 2, m: 3, l: 5, xl: 8 };

export const DECISION_TESTS = ['main', 'production', 'irreversible', 'ambiguity', 'data'] as const;
export type DecisionTest = (typeof DECISION_TESTS)[number];

const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/, 'ids may contain letters, digits, . _ : -');

export const PlanTaskInput = z.object({
  id,
  title: z.string().min(1).max(200),
  size: z.enum(TASK_SIZES),
  acceptance: z.string().max(1000).optional(),
});
export const PlanPhaseInput = z.object({
  id,
  name: z.string().min(1).max(120),
  tasks: z.array(PlanTaskInput).min(1).max(200),
});

export const DeclarePlanInput = z.object({
  phases: z.array(PlanPhaseInput).min(1).max(30),
  summary: z.string().max(2000).optional(),
});
export type DeclarePlanInput = z.infer<typeof DeclarePlanInput>;

export const AmendPlanInput = z.object({
  reason: z.string().min(3).max(1000),
  add: z
    .array(PlanTaskInput.extend({ phaseId: id, phaseName: z.string().max(120).optional() }))
    .max(100)
    .optional(),
  remove: z.array(id).max(100).optional(),
  resize: z.array(z.object({ taskId: id, size: z.enum(TASK_SIZES) })).max(100).optional(),
});
export type AmendPlanInput = z.infer<typeof AmendPlanInput>;

export const EVIDENCE_KINDS = ['test', 'commit', 'diff'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export const TaskDoneInput = z.object({
  task_id: id,
  evidence: z.object({
    kind: z.enum(EVIDENCE_KINDS),
    /** test id (e.g. "pkg/foo.test.ts > adds"), commit SHA, or diff hash / `git diff --stat` ref */
    ref: z
      .string()
      .min(1)
      .max(300)
      .describe(
        'kind test: the test file and test name that passed, e.g. "test/greeting.test.ts > greets by name" (a file path or runner id, never the shell command you ran); ' +
          'kind commit: the full commit SHA; kind diff: the path of the changed file',
      ),
    detail: z.string().max(2000).optional(),
  }),
});
export type TaskDoneInput = z.infer<typeof TaskDoneInput>;

export const RequestDecisionInput = z.object({
  test: z.enum(DECISION_TESTS),
  question: z.string().min(5).max(2000),
  options: z
    .array(z.object({ id, label: z.string().min(1).max(200), description: z.string().max(1000).optional() }))
    .min(2)
    .max(6),
  recommendation: z.object({ option_id: id, rationale: z.string().min(3).max(2000) }),
  context: z.string().max(4000).optional(),
});
export type RequestDecisionInput = z.infer<typeof RequestDecisionInput>;

export const PLAYBOOK_STEP_STATES = ['started', 'done', 'failed', 'skipped'] as const;
export const PlaybookStepInput = z.object({
  playbook_id: id.optional(),
  step: z.string().min(1).max(200),
  state: z.enum(PLAYBOOK_STEP_STATES),
  note: z.string().max(1000).optional(),
});
export type PlaybookStepInput = z.infer<typeof PlaybookStepInput>;

export const ReportDiagnosisInput = z.object({
  root_cause: z.string().min(5).max(4000),
  confidence: z.number().min(0).max(1),
  fix_plan: z.string().min(5).max(8000),
  affected_areas: z.array(z.string().max(300)).max(50).optional(),
  root_cause_class: z.string().max(120).optional(),
});
export type ReportDiagnosisInput = z.infer<typeof ReportDiagnosisInput>;

export const ReportErrorInput = z.object({
  summary: z.string().min(3).max(2000),
  root_cause_class: z.string().max(120).optional(),
  fix: z.string().max(4000).optional(),
  code_area: z.string().max(300).optional(),
});
export type ReportErrorInput = z.infer<typeof ReportErrorInput>;

export const GetStatusInput = z.object({});

export const AOC_MCP_TOOLS = {
  declare_plan: {
    input: DeclarePlanInput,
    description:
      'Declare the plan manifest for this session: phases, each with tasks (id, title, size xs|s|m|l|xl). ' +
      'Required before any file-changing tool. Progress is measured as tasks done over tasks declared.',
  },
  amend_plan: {
    input: AmendPlanInput,
    description:
      'Amend the plan manifest (add / remove / resize tasks) with a reason. Amendments are audited and visibly change the denominator.',
  },
  task_done: {
    input: TaskDoneInput,
    description:
      'Mark a declared task done. Evidence is mandatory: a test id (file and test name, not the command), a commit SHA, or a diff ref (the changed file). ' +
      'Tasks closed without any file-changing tool call are flagged. Obey the returned `boundary` instruction: when it says to stop, it outranks your plan and the rest of your prompt: make no more tool calls and end your turn.',
  },
  request_decision: {
    input: RequestDecisionInput,
    description:
      'Raise a human-required decision (test: main | production | irreversible | ambiguity | data) with options and your recommendation. ' +
      'After calling, END YOUR TURN; the supervisor resumes this session with the human answer.',
  },
  playbook_step: {
    input: PlaybookStepInput,
    description: 'Report progress through a distilled playbook step (started | done | failed | skipped).',
  },
  report_diagnosis: {
    input: ReportDiagnosisInput,
    description:
      'Triage sessions only: report root cause, confidence (0..1) and a proposed fix plan. Then end your turn. Never modify code during triage.',
  },
  report_error: {
    input: ReportErrorInput,
    description:
      'Report a repeatable error class you hit (with the fix if known) so it can be distilled into a lesson.',
  },
  get_status: {
    input: GetStatusInput,
    description: 'Return this session manifest, progress, open decisions and the lessons in scope.',
  },
} as const;
export type AocMcpToolName = keyof typeof AOC_MCP_TOOLS;
export const AOC_MCP_TOOL_NAMES = Object.keys(AOC_MCP_TOOLS) as AocMcpToolName[];

/** Boundary instruction returned by task_done (credit cap / rollover are enforced only at task boundaries, §10/§5). */
export type BoundaryInstruction =
  | { continue: true }
  | { continue: false; reason: 'credit_cap' | 'rollover' | 'stop_requested'; instruction: string };

export interface DeclarePlanResult {
  ok: true;
  manifestVersion: number;
  totalTasks: number;
  totalWeight: number;
}
export interface TaskDoneResult {
  ok: true;
  flagged: null | 'no_file_change' | 'evidence_unverified';
  /** Why the evidence could not be checked, when it could not (a git call timed out): never "verified". */
  evidenceReason?: GitUnknownReason;
  progress: { doneTasks: number; totalTasks: number; doneWeight: number; totalWeight: number; pct: number };
  phaseCompleted: null | { phaseId: string; pinnedRef: string | null };
  boundary: BoundaryInstruction;
}
export interface RequestDecisionResult {
  ok: true;
  decision_id: string;
  instruction: string;
}
export interface McpErrorResult {
  ok: false;
  error: string;
  details?: unknown;
}
