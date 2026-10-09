import { AOC_MCP_SERVER_NAME, READ_ONLY_TOOLS, type PreToolGuard } from '@aoc/contracts';
import type { LedgerCore } from './core';

export const NO_MANIFEST_REASON = 'Declare your plan with mcp__aoc__declare_plan first (AOC-SPEC-003 §4)';
const AOC_TOOL_PREFIX = `mcp__${AOC_MCP_SERVER_NAME}__`;
const READ_ONLY: ReadonlySet<string> = new Set(READ_ONLY_TOOLS);

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
