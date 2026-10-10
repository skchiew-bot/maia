import { AOC_MCP_SERVER_NAME, READ_ONLY_TOOLS, type PreToolGuard } from '@aoc/contracts';
import type { LedgerCore } from './core';

export const NO_MANIFEST_REASON = 'Declare your plan with mcp__aoc__declare_plan first (AOC-SPEC-003 §4)';
const AOC_TOOL_PREFIX = `mcp__${AOC_MCP_SERVER_NAME}__`;
const READ_ONLY: ReadonlySet<string> = new Set(READ_ONLY_TOOLS);

export const BOUNDARY_STOP_REASON =
  'You were told to stop at this task boundary (see the boundary instruction of your last task_done). No more tool calls are allowed in this turn: end your turn now.';

/**
 * Boundary stop (G-54, §5, §10, R7). Once a task_done answer told the agent to stop (stop order, credit cap or
 * rollover), every further tool call of the turn is denied, so the stop no longer rests on the model obeying it.
 * The supervisor ends or continues the session when the turn ends; the next turn starts with the stop cleared.
 */
export function createBoundaryStopGuard(core: LedgerCore): PreToolGuard {
  return {
    name: 'boundary-stop',
    order: 5,
    evaluate(ctx) {
      if (ctx.mode !== 'managed' || !core.read.boundaryStop(ctx.session.sessionId)) return null;
      return { decision: 'deny', guard: 'boundary-stop', reason: BOUNDARY_STOP_REASON };
    },
  };
}

/**
 * Plan gate (§4: a session without a manifest is blocked). Until a managed session whose process type
 * requires a plan has declared one, only read-only tools and the AOC MCP tools are allowed — Bash included
 * in the denial, since it can change files.
 */
export function createNoManifestGuard(core: LedgerCore): PreToolGuard {
  return {
    name: 'no-manifest',
    order: 10,
    evaluate(ctx) {
      if (ctx.mode !== 'managed') return null;
      if (READ_ONLY.has(ctx.toolName) || ctx.toolName.startsWith(AOC_TOOL_PREFIX)) return null;
      if (!core.requiresPlan(ctx.session) || core.read.hasManifest(ctx.session.sessionId)) return null;
      return {
        decision: 'deny',
        guard: 'no-manifest',
        reason: NO_MANIFEST_REASON,
        blockReason: 'no_manifest',
      };
    },
  };
}
