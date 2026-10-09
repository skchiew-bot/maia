import path from 'node:path';
import { FILE_EDIT_TOOLS, NO_PERMISSION_TOOLS } from './constants';
import { globToRegExp } from './glob';
import { isWithin } from './paths';

/**
 * Print-mode permission model of Claude Code: deny rules always win; a PreToolUse hook may allow, deny or
 * ask (nobody can answer an ask in print mode, so it is a denial); then the permission mode and allow rules
 * decide. Anything still undecided would prompt the user — impossible with -p — so it is denied with the
 * real CLI's message.
 */

export type PermissionMode =
  'default' | 'manual' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';

export interface PermissionRule {
  tool: string;
  content?: string;
}

export interface PermissionPolicy {
  mode: PermissionMode;
  allow: PermissionRule[];
  deny: PermissionRule[];
  cwd: string;
  /** cwd plus --add-dir / additionalDirectories, absolute. */
  workingDirs: string[];
  homeDir: string;
}

export type HookVerdict = { behavior: 'allow' } | { behavior: 'deny' | 'ask'; message: string };

/** Why the permission layer itself refused (`source: 'prompt'`): the `decision_reason_type` of the stream's permission_denied line. */
export type DenialReason = 'other' | 'subcommandResults';

export type PermissionVerdict =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message: string; source: 'rule' | 'hook' | 'prompt'; reason?: DenialReason };

/** Split "Bash(git log:*),Edit Read" into rules, keeping commas and spaces inside parentheses. */
export function splitRuleList(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    let depth = 0;
    let current = '';
    for (const char of value) {
      if (char === '(') depth++;
      if (char === ')') depth = Math.max(0, depth - 1);
      if (depth === 0 && (char === ',' || /\s/.test(char))) {
        if (current) out.push(current);
        current = '';
        continue;
      }
      current += char;
    }
    if (current) out.push(current);
  }
  return out;
}

export function parseRule(raw: string): PermissionRule | undefined {
  const match = /^([^()\s]+)(?:\(([\s\S]*)\))?$/.exec(raw.trim());
  if (!match) return undefined;
  return { tool: match[1]!, ...(match[2] !== undefined && { content: match[2] }) };
}

export function parseRules(values: readonly string[]): PermissionRule[] {
  return splitRuleList(values)
    .map(parseRule)
    .filter((rule): rule is PermissionRule => rule !== undefined);
}

const READ_FAMILY = ['Read', 'Glob', 'Grep'];

function toolMatches(rule: PermissionRule, toolName: string): boolean {
  if (rule.tool === toolName) return true;
  if (rule.tool.startsWith('mcp__') && toolName.startsWith('mcp__')) {
    const parts = rule.tool.split('__');
    if (parts.length === 2) return toolName.startsWith(`${rule.tool}__`);
    if (parts.length === 3 && parts[2] === '*') return toolName.startsWith(`mcp__${parts[1]}__`);
  }
  if (rule.content !== undefined) {
    if (rule.tool === 'Edit' && FILE_EDIT_TOOLS.includes(toolName)) return true;
    if (rule.tool === 'Read' && READ_FAMILY.includes(toolName)) return true;
  }
  return false;
}

/** Split a shell command on && || ; | and newlines outside quotes, so each sub-command is judged. */
export function splitShellCommand(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote) {
      current += char;
      if (char === '\\' && quote === '"' && i + 1 < command.length) current += command[++i];
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      parts.push(current);
      current = '';
      i++;
      continue;
    }
    if (char === ';' || char === '|' || char === '\n') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function bashPatternMatches(content: string, command: string): boolean {
  if (content.endsWith(':*')) {
    const prefix = content.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  }
  if (content.includes('*')) {
    const source = content.split('*').map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`^${source.join('.*')}$`, 's').test(command);
  }
  return command === content;
}

function targetPath(toolName: string, input: Record<string, unknown>, cwd: string): string | undefined {
  const raw =
    FILE_EDIT_TOOLS.includes(toolName) || toolName === 'Read'
      ? (input.file_path ?? input.notebook_path)
      : input.path;
  if (READ_FAMILY.includes(toolName) && toolName !== 'Read' && raw === undefined) return cwd;
  return typeof raw === 'string' && raw !== '' ? path.resolve(cwd, raw) : undefined;
}

function pathPatternMatches(content: string, file: string, policy: PermissionPolicy): boolean {
  let pattern = content;
  let base = policy.cwd;
  if (pattern.startsWith('//')) {
    base = '/';
    pattern = pattern.slice(2);
  } else if (pattern.startsWith('~/')) {
    base = policy.homeDir;
    pattern = pattern.slice(2);
  } else if (pattern.startsWith('/')) {
    pattern = pattern.slice(1);
  } else if (pattern.startsWith('./')) {
    pattern = pattern.slice(2);
  }
  if (!isWithin(base, file)) return false;
  const rel = path.relative(base, file).split(path.sep).join('/');
  return globToRegExp(pattern.includes('/') ? pattern : `**/${pattern}`).test(rel);
}

function contentMatches(
  rule: PermissionRule,
  toolName: string,
  input: Record<string, unknown>,
  policy: PermissionPolicy,
  mode: 'any' | 'all',
): boolean {
  if (rule.content === undefined) return true;
  if (toolName === 'Bash') {
    const parts = splitShellCommand(String(input.command ?? ''));
    if (parts.length === 0) return false;
    return mode === 'any'
      ? parts.some((part) => bashPatternMatches(rule.content!, part))
      : parts.every((part) => bashPatternMatches(rule.content!, part));
  }
  if (FILE_EDIT_TOOLS.includes(toolName) || READ_FAMILY.includes(toolName)) {
    const file = targetPath(toolName, input, policy.cwd);
    return file !== undefined && pathPatternMatches(rule.content, file, policy);
  }
  if (toolName === 'WebFetch' && rule.content.startsWith('domain:')) {
    try {
      return new URL(String(input.url ?? '')).hostname === rule.content.slice('domain:'.length);
    } catch {
      return false;
    }
  }
  return false;
}

/** A deny rule without a specifier removes the tool entirely (it is left out of the init tool list). */
export function isWholeToolDenied(policy: PermissionPolicy, toolName: string): boolean {
  return policy.deny.some((rule) => rule.content === undefined && toolMatches(rule, toolName));
}

function allowedByRules(policy: PermissionPolicy, toolName: string, input: Record<string, unknown>): boolean {
  const candidates = policy.allow.filter((rule) => toolMatches(rule, toolName));
  if (candidates.some((rule) => rule.content === undefined)) return true;
  return candidates.some((rule) => contentMatches(rule, toolName, input, policy, 'all'));
}

// ── Bash under print mode (observed on Claude Code 2.1.295, research "Verified against the real CLI") ──────────────
// Nobody can answer a prompt, so a command runs only if it is read-only, a plain file command that acceptEdits waves
// through inside the working directory, or covered by an allow rule. Committing, running tests or scripts, curl and
// `bash -c` all answer "This command requires approval".

/** Commands Claude Code runs without asking in every mode. */
const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'stat', 'grep', 'egrep', 'fgrep', 'diff', 'du', 'df', 'echo', 'strings', 'hexdump',
  'od', 'nl', 'cut', 'column', 'tr', 'tac', 'rev', 'cmp', 'basename', 'dirname', 'realpath', 'readlink', 'sha256sum',
  'sha1sum', 'md5sum', 'cd', 'pwd', 'which', 'whoami', 'true', 'false',
]);
const READ_ONLY_GIT = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'ls-tree',
  'cat-file', 'rev-list',
]);
/** Tools whose version query is read-only (`curl --version` and `make --version` still need approval). */
const VERSION_QUERY = new Set(['node', 'python', 'python3', 'git']);
/** What acceptEdits approves inside the working directory (Claude Code's own list). */
const ACCEPT_EDITS_COMMANDS = new Set(['mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'sed']);

function tokenize(part: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(part); m; m = re.exec(part)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

/** `git branch` lists unless a flag or a bare name asks it to create, move, copy or delete (`git branch -D main`). */
const GIT_BRANCH_LISTING = /^(-a|-r|-v|-vv|-l|--all|--remotes|--verbose|--list|--show-current|--contains|--no-contains|--merged|--no-merged|--points-at|--sort|--format|--column|--no-column|--abbrev|--no-abbrev|--color|--no-color)(=.*)?$/;
const GIT_BRANCH_FILTERS = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format']);

function gitReadOnly(sub: string, args: string[]): boolean {
  // `--output=<file>` makes diff, log and show write a file.
  if (args.some((t) => t === '--output' || t.startsWith('--output='))) return false;
  if (sub !== 'branch') return true;
  const listing = args.some((t) => t === '-l' || t === '--list' || GIT_BRANCH_FILTERS.has(t.split('=')[0]!));
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!;
    if (t.startsWith('-')) {
      if (!GIT_BRANCH_LISTING.test(t)) return false;
      // The value of a filter flag is not a branch name.
      if (GIT_BRANCH_FILTERS.has(t) && !t.includes('=')) i++;
    } else if (!listing) return false;
  }
  return true;
}

function isReadOnlyCommand(tokens: string[]): boolean {
  const [cmd, sub] = tokens;
  if (!cmd) return false;
  if (tokens.length === 2 && (sub === '--version' || sub === '-v') && VERSION_QUERY.has(cmd)) return true;
  if (cmd === 'git') return sub !== undefined && READ_ONLY_GIT.has(sub) && gitReadOnly(sub, tokens.slice(2));
  if (cmd === 'find') return !tokens.some((t) => /^-(delete|exec|execdir|ok|okdir|fprint0?|fls|fprintf)$/.test(t));
  return READ_ONLY_COMMANDS.has(cmd);
}

/** A command's output redirections (file targets) and its remaining words. */
function redirectTargets(tokens: string[]): { files: string[]; rest: string[] } {
  const files: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const m = /^(\d?>>?|&>>?)(.*)$/.exec(t);
    if (!m) {
      rest.push(t);
      continue;
    }
    const target = m[2] || tokens[++i] || '';
    if (!target.startsWith('&') && target !== '/dev/null') files.push(target);
  }
  return { files, rest };
}

function insideWorkingDirs(policy: PermissionPolicy, file: string | undefined): boolean {
  return file === undefined || policy.workingDirs.some((dir) => isWithin(dir, file));
}

/** One sub-command that runs without a grant: read-only, or a file command acceptEdits approves inside the working directory. */
function bashPartNeedsNoGrant(policy: PermissionPolicy, part: string): boolean {
  const { files, rest } = redirectTargets(tokenize(part));
  const inCwd = (p: string) => insideWorkingDirs(policy, path.resolve(policy.cwd, p));
  const acceptEdits = policy.mode === 'acceptEdits' || policy.mode === 'auto';
  if (files.length > 0 && !(acceptEdits && files.every(inCwd))) return false;
  if (isReadOnlyCommand(rest)) return true;
  const [cmd, ...args] = rest;
  if (!acceptEdits || !cmd || !ACCEPT_EDITS_COMMANDS.has(cmd)) return false;
  return args.filter((a) => !a.startsWith('-')).every(inCwd);
}

function bashDenial(policy: PermissionPolicy, parts: string[], pending: string[]): PermissionVerdict {
  if (policy.mode === 'dontAsk') {
    return {
      behavior: 'deny',
      message:
        "Permission to use Bash has been denied because Claude Code is running in don't ask mode. If you believe this capability is essential to complete the user's request, STOP and explain to the user what you were trying to do and why you need this permission. Let the user decide how to proceed.",
      source: 'prompt',
    };
  }
  if (parts.length > 1) {
    return {
      behavior: 'deny',
      message: `This Bash command contains multiple operations. The following ${pending.length === 1 ? 'part requires' : 'parts require'} approval: ${pending.join(', ')}`,
      source: 'prompt',
      reason: 'subcommandResults',
    };
  }
  return { behavior: 'deny', message: 'This command requires approval', source: 'prompt', reason: 'other' };
}

function decideBash(policy: PermissionPolicy, input: Record<string, unknown>): PermissionVerdict {
  const parts = splitShellCommand(String(input.command ?? ''));
  const candidates = policy.allow.filter((rule) => toolMatches(rule, 'Bash'));
  const granted = (part: string) =>
    candidates.some((rule) => rule.content === undefined || bashPatternMatches(rule.content, part));
  const pending = parts.filter((part) => !granted(part) && !bashPartNeedsNoGrant(policy, part));
  return parts.length > 0 && pending.length === 0 ? { behavior: 'allow' } : bashDenial(policy, parts, pending);
}

export function decidePermission(
  policy: PermissionPolicy,
  toolName: string,
  input: Record<string, unknown>,
  hook?: HookVerdict,
): PermissionVerdict {
  for (const rule of policy.deny) {
    if (toolMatches(rule, toolName) && contentMatches(rule, toolName, input, policy, 'any')) {
      const message =
        toolName === 'Bash' && rule.content !== undefined
          ? `Permission to use Bash with command ${String(input.command ?? '')} has been denied.`
          : `Permission to use ${toolName} has been denied.`;
      return { behavior: 'deny', message, source: 'rule' };
    }
  }
  if (hook && hook.behavior !== 'allow') return { behavior: 'deny', message: hook.message, source: 'hook' };
  if (hook?.behavior === 'allow') return { behavior: 'allow' };
  // Only bypassPermissions skips grants; MCP tools in particular need an allow rule otherwise.
  if (policy.mode === 'bypassPermissions') return { behavior: 'allow' };

  if (toolName === 'Bash') return decideBash(policy, input);
  const file = targetPath(toolName, input, policy.cwd);
  if (NO_PERMISSION_TOOLS.includes(toolName) && insideWorkingDirs(policy, file)) return { behavior: 'allow' };
  const editsAccepted = policy.mode === 'acceptEdits' || policy.mode === 'auto';
  if (editsAccepted && FILE_EDIT_TOOLS.includes(toolName) && insideWorkingDirs(policy, file))
    return { behavior: 'allow' };
  if (allowedByRules(policy, toolName, input)) return { behavior: 'allow' };
  const what = FILE_EDIT_TOOLS.includes(toolName) && file !== undefined ? `write to ${file}` : `use ${toolName}`;
  return {
    behavior: 'deny',
    message: `Claude requested permissions to ${what}, but you haven't granted it yet.`,
    source: 'prompt',
  };
}
