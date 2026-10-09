import { resolve } from 'node:path';
import {
  FILE_CHANGING_TOOLS,
  type AocConfig,
  type GuardResult,
  type PreToolContext,
  type PreToolGuard,
} from '@aoc/contracts';
import { canonicalJson, sha256hex, type ModuleContext } from '@aoc/kernel';
import { appendExternalAuditLine } from './external-log';
import { BoundaryMatcher, type BoundaryConfig, type ProtectedHit } from './matcher';
import { analyzeBash } from './shell';

export const SELF_MODIFICATION_GUARD = 'self-modification';

export interface Violation {
  /** Machine label: `<core|audit_store>.<edit|redirect|command|patch|patch_unverifiable|interpreter|xargs|too_large>`. */
  rule: string;
  hit: ProtectedHit | null;
  /** AOC repo the session works in (for findings without a concrete path). */
  repoRoot: string | null;
}

const PATH_FIELDS = [
  'file_path',
  'notebook_path',
  'path',
  'filePath',
  'filepath',
  'paths',
  'files',
  'target',
  'destination',
  'dest',
  'source',
  'from',
  'to',
  'new_path',
  'old_path',
  'directory',
];
/** Non-built-in tools (MCP filesystem servers…) whose name says they change files. */
const WRITE_TOOL =
  /(write|edit|create|delete|remove|move|rename|patch|apply|replace|insert|update|upload|put|append|mkdir|touch|copy|save)/i;

function collectPaths(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  const take = (v: unknown, depth: number) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v) && depth < 2) for (const x of v) take(x, depth + 1);
    else if (v && typeof v === 'object' && depth < 2)
      for (const k of PATH_FIELDS) take((v as Record<string, unknown>)[k], depth + 1);
  };
  for (const k of PATH_FIELDS) take(input[k], 0);
  return out.filter((p) => p.length > 0 && p.length < 4096);
}

/** The protected areas for this configuration: the core of each AOC repo plus AOC's own audit state. */
export function boundaryConfig(config: AocConfig, dataDir: string, tsrDir?: string): BoundaryConfig {
  const store = [
    dataDir === ':memory:' ? null : dataDir,
    config.audit.anchorRepoPath,
    // The anchor signing keyring and the TSA trust anchors decide what Verify accepts as proof.
    config.audit.gnupgHome,
    config.audit.tsaCaFile,
    config.audit.tsaUntrustedFile,
    config.selfModification.externalAuditLog,
    config.keys.masterKeyFile,
    config.supervisor.credentialProfilesFile,
    tsrDir,
  ];
  return {
    aocRepoPaths: config.selfModification.aocRepoPaths,
    protectedPaths: config.selfModification.protectedPaths,
    auditStorePaths: store.filter((p): p is string => typeof p === 'string' && p.length > 0),
  };
}

/** Pure decision: does this tool call modify the protected core or the audit store? */
export function findViolation(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  m: BoundaryMatcher,
): Violation | null {
  if (toolName === 'Bash') {
    const command = input.command;
    if (typeof command !== 'string') return null;
    const f = analyzeBash(command, cwd, m);
    if (!f) return null;
    return { rule: `${f.hit?.area ?? 'core'}.${f.kind}`, hit: f.hit, repoRoot: m.repoOf(cwd) };
  }
  if (!(FILE_CHANGING_TOOLS as readonly string[]).includes(toolName) && !WRITE_TOOL.test(toolName))
    return null;
  for (const p of collectPaths(input)) {
    const hit = m.check(p, cwd, false);
    if (hit) return { rule: `${hit.area}.edit`, hit, repoRoot: m.repoOf(cwd) };
  }
  return null;
}

function reasonFor(v: Violation): string {
  const tail = 'The attempt was recorded outside AOC. Raise it with a human instead.';
  if (!v.hit) {
    return v.rule.endsWith('patch_unverifiable')
      ? `AOC self-modification boundary: patches applied inside an AOC repo must come from a file or here-document so the paths they touch can be checked. ${tail}`
      : `AOC self-modification boundary: command too large to inspect inside an AOC repo. ${tail}`;
  }
  if (v.hit.area === 'audit_store') {
    return `AOC self-modification boundary: ${v.hit.display} is AOC audit state (event log, anchors, keys or the external audit log); agents may never modify it. ${tail}`;
  }
  return `AOC self-modification boundary: ${v.hit.display} is part of AOC's governance/audit/credit core (${v.hit.pattern}). The platform may build its own features but never its own governance, audit or credit core — that code is human-built and human-changed. ${tail}`;
}

function inputHash(input: Record<string, unknown>): string {
  try {
    return sha256hex(canonicalJson(input));
  } catch {
    return sha256hex(String(input));
  }
}

/** Record a blocked attempt: first the external (outside-AOC) log, then the chained selfmod.blocked event. */
function record(ctx: ModuleContext, p: PreToolContext, v: Violation, cwd: string): void {
  const sessionId = p.session.sessionId;
  const projectId = p.session.projectId ?? undefined;
  const target = v.hit?.path ?? v.repoRoot ?? cwd;
  const display = v.hit?.display ?? '.';
  const pathHash = sha256hex(target);
  let externalLogged = false;
  try {
    appendExternalAuditLine(resolve(ctx.config.selfModification.externalAuditLog), {
      v: 1,
      ts: ctx.clock.iso(),
      kind: 'selfmod.blocked',
      chainId: ctx.store.chainId,
      sessionId,
      projectId: projectId ?? null,
      toolName: p.toolName,
      rule: v.rule,
      path: display,
      root: v.hit?.root ?? v.repoRoot,
      pathHash,
      inputHash: inputHash(p.toolInput),
    });
    externalLogged = true;
  } catch (err) {
    ctx.log.error('self-modification: external audit log write failed', { sessionId, err: String(err) });
  }
  const command = typeof p.toolInput.command === 'string' ? p.toolInput.command.slice(0, 4000) : undefined;
  try {
    ctx.store.append({
      type: 'selfmod.blocked',
      actor: { kind: 'agent', id: sessionId },
      scope: { sessionId, projectId },
      meta: { sessionId, rule: v.rule, pathHash, externalLogged },
      payload: { path: display, toolName: p.toolName, ...(command !== undefined ? { command } : {}) },
      source: 'hook',
    });
  } catch (err) {
    ctx.log.error('self-modification: selfmod.blocked append failed', { sessionId, err: String(err) });
  }
}

/**
 * §13 / R14: AOC-managed agents may build platform features but never touch the governance, audit or credit core
 * of an AOC repo, nor AOC's own audit state. Targets are resolved from the tool input (not from the session's
 * cwd), so an absolute path from a session in another repo is caught too; sessions working in other repos are
 * unaffected. Observed sessions are never blocked (§2), so the guard abstains for them.
 */
export function createSelfModificationGuard(deps: {
  ctx: () => ModuleContext | null;
  tsrDir: () => string | undefined;
}): PreToolGuard {
  return {
    name: SELF_MODIFICATION_GUARD,
    order: 5,
    evaluate(p: PreToolContext): GuardResult | null {
      const ctx = deps.ctx();
      if (!ctx || p.mode !== 'managed') return null;
      const cwd = resolve(p.cwd || p.session.cwd || process.cwd());
      const matcher = new BoundaryMatcher(boundaryConfig(ctx.config, ctx.dataDir, deps.tsrDir()));
      const v = findViolation(p.toolName, p.toolInput ?? {}, cwd, matcher);
      if (!v) return null;
      record(ctx, p, v, cwd);
      return {
        decision: 'deny',
        guard: SELF_MODIFICATION_GUARD,
        reason: reasonFor(v),
        blockReason: 'self_modification',
      };
    },
  };
}
