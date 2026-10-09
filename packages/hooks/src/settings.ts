/*
 * Claude Code `hooks` settings for aoc-hook: the supervisor writes buildHookSettings() into each managed session's
 * settings; `aoc hooks install-observed` merges the observed variant into the user's global settings.
 *
 * Claude Code (2.1.x, -p) silently ignores hook entries that fail its validation — a wrong-typed timeout or an unknown
 * event name just disables that hook — so everything emitted here uses numeric timeouts and known event names, and
 * validateHookSettings() lets callers self-check before writing.
 */
import { HOOK_EVENTS } from '@aoc/contracts';
import { HOOKS_ENV } from './constants';

/**
 * Claude Code 2.1.x events beyond the contract's HOOK_EVENTS (verified on 2.1.295). PostToolUseFailure fires instead of
 * PostToolUse when a tool fails; StopFailure instead of Stop when the turn ends on an API error. Notification (in
 * HOOK_EVENTS) never fires under -p but does in the interactive sessions observed hooks watch.
 */
const CLAUDE_CODE_EXTRA_EVENTS = [
  'PermissionRequest',
  'PostToolUseFailure',
  'PostToolBatch',
  'StopFailure',
  'SubagentStart',
  'PostCompact',
];

/** Every event aoc-hook registers for (contract events first; deduped so contract additions never double-register). */
export const REGISTERED_HOOK_EVENTS: readonly string[] = [
  ...new Set<string>([...HOOK_EVENTS, ...CLAUDE_CODE_EXTRA_EVENTS]),
];

/** Events that take a tool matcher; "" matches every tool, MCP tools included. */
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);

/**
 * Seconds. Far above the hook's own budgets (PreToolUse 2.5 s, others 5 s, flush ~1 s) so the hook always answers
 * first: a Claude Code timeout is a non-blocking error, which would let a managed tool call through.
 */
export const HOOK_TIMEOUT_SECONDS = 30;

/**
 * Prefix of every observed entry's command. It tags AOC's entries so uninstall removes exactly those, and tells the
 * binary it is the global registration, which stands down inside managed sessions (mode.ts).
 */
export const OBSERVED_HOOK_PREFIX = `${HOOKS_ENV.hookScope}=observed `;

export interface HookCommandEntry {
  type: 'command';
  command: string;
  timeout?: number;
}
export interface HookMatcherGroup {
  matcher?: string;
  hooks: HookCommandEntry[];
}
/** The value of a Claude Code settings file's `hooks` key. */
export type HookSettings = Record<string, HookMatcherGroup[]>;

export interface BuildHookSettingsOptions {
  /** 'observed' prefixes every command with OBSERVED_HOOK_PREFIX (global install). Default: managed. */
  scope?: 'managed' | 'observed';
  timeoutSeconds?: number;
}

/** `command` is the hook binary's argv prefix (e.g. ['node', '/opt/aoc/aoc-hook.js']); the event name is appended. */
export function buildHookSettings(
  command: readonly string[],
  o: BuildHookSettingsOptions = {},
): HookSettings {
  if (command.length === 0) throw new Error('buildHookSettings: the hook command is empty');
  const prefix = o.scope === 'observed' ? OBSERVED_HOOK_PREFIX : '';
  const timeout = o.timeoutSeconds ?? HOOK_TIMEOUT_SECONDS;
  const hooks: HookSettings = {};
  for (const event of REGISTERED_HOOK_EVENTS) {
    const entry: HookCommandEntry = {
      type: 'command',
      command: prefix + shellJoin([...command, event]),
      timeout,
    };
    hooks[event] = [TOOL_EVENTS.has(event) ? { matcher: '', hooks: [entry] } : { hooks: [entry] }];
  }
  return hooks;
}

export function isObservedHookCommand(command: unknown): boolean {
  return typeof command === 'string' && command.startsWith(OBSERVED_HOOK_PREFIX);
}

/**
 * Installs (or re-installs, replacing earlier AOC entries) the observed hooks into a settings file's text. Preserves
 * every other key and hook; returns the input unchanged when it already holds exactly these entries.
 */
export function mergeObservedHooks(
  existingSettingsJson: string | null | undefined,
  command: readonly string[],
): string {
  const settings = parseSettings(existingSettingsJson);
  const hooks = hooksOf(settings) ?? {};
  // Emptied events keep their key (and position) so a re-install reproduces the same file byte for byte.
  removeObservedEntries(hooks, false);
  for (const [event, groups] of Object.entries(buildHookSettings(command, { scope: 'observed' }))) {
    hooks[event] = [...((hooks[event] as unknown[] | undefined) ?? []), ...groups];
  }
  settings.hooks = hooks;
  return serialize(existingSettingsJson, settings);
}

/** Removes exactly the AOC observed entries (and the groups/events/`hooks` key they leave empty). */
export function removeObservedHooks(existingSettingsJson: string | null | undefined): string {
  const settings = parseSettings(existingSettingsJson);
  const hooks = hooksOf(settings);
  if (!hooks || !removeObservedEntries(hooks, true)) return existingSettingsJson ?? '';
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return serialize(existingSettingsJson, settings);
}

/**
 * Self-check for a settings object: lists the problems that would make Claude Code drop a hook silently. Entry types
 * other than `command` are only checked for shape.
 */
export function validateHookSettings(
  settings: unknown,
  knownEvents: readonly string[] = REGISTERED_HOOK_EVENTS,
): string[] {
  if (!isRecord(settings)) return ['settings: not a JSON object'];
  if (settings.hooks === undefined) return [];
  if (!isRecord(settings.hooks)) return ['hooks: not an object'];
  const known = new Set(knownEvents);
  const problems: string[] = [];
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const at = `hooks.${event}`;
    if (!known.has(event)) problems.push(`${at}: unknown hook event (Claude Code ignores it)`);
    if (!Array.isArray(groups)) {
      problems.push(`${at}: not an array of matcher groups`);
      continue;
    }
    groups.forEach((group: unknown, i) => {
      const g = `${at}[${i}]`;
      if (!isRecord(group)) return void problems.push(`${g}: not an object`);
      if (group.matcher !== undefined && typeof group.matcher !== 'string')
        problems.push(`${g}.matcher: not a string`);
      if (!Array.isArray(group.hooks)) return void problems.push(`${g}.hooks: not an array`);
      group.hooks.forEach((entry: unknown, j) => {
        const e = `${g}.hooks[${j}]`;
        if (!isRecord(entry)) return void problems.push(`${e}: not an object`);
        if (typeof entry.type !== 'string') problems.push(`${e}.type: not a string`);
        if (entry.type === 'command' && (typeof entry.command !== 'string' || !entry.command.trim()))
          problems.push(`${e}.command: empty or not a string`);
        if (
          entry.timeout !== undefined &&
          !(typeof entry.timeout === 'number' && Number.isFinite(entry.timeout) && entry.timeout > 0)
        ) {
          problems.push(`${e}.timeout: not a positive number of seconds`);
        }
      });
    });
  }
  return problems;
}

/** POSIX-shell quoting: Claude Code runs hook commands through a shell. */
export function shellJoin(argv: readonly string[]): string {
  return argv
    .map((a) => (/^[A-Za-z0-9_\/.,:=@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(' ');
}

type JsonObject = Record<string, unknown>;

function parseSettings(text: string | null | undefined): JsonObject {
  if (!text || !text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`settings file is not valid JSON (${(err as Error).message}); refusing to modify it`);
  }
  if (!isRecord(parsed)) throw new Error('settings file is not a JSON object; refusing to modify it');
  return parsed;
}

/** The settings' hooks object, refusing shapes we cannot edit without clobbering the user's configuration. */
function hooksOf(settings: JsonObject): JsonObject | null {
  if (settings.hooks === undefined) return null;
  if (!isRecord(settings.hooks)) throw new Error('settings.hooks is not an object; refusing to modify it');
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups))
      throw new Error(`settings.hooks.${event} is not an array; refusing to modify it`);
  }
  return settings.hooks;
}

/**
 * Drops AOC observed entries in place, plus any group they leave empty (and, with dropEmptiedEvents, any event).
 * Groups and events the user left empty themselves are not touched. True if anything was removed.
 */
function removeObservedEntries(hooks: JsonObject, dropEmptiedEvents: boolean): boolean {
  let changed = false;
  for (const [event, value] of Object.entries(hooks)) {
    const groups = value as unknown[];
    const kept = groups.filter((group) => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) return true;
      const entries = group.hooks.filter(
        (entry) => !(isRecord(entry) && isObservedHookCommand(entry.command)),
      );
      if (entries.length === group.hooks.length) return true;
      changed = true;
      group.hooks = entries;
      return entries.length > 0;
    });
    if (kept.length === groups.length) continue;
    if (kept.length === 0 && dropEmptiedEvents) delete hooks[event];
    else hooks[event] = kept;
  }
  return changed;
}

/** Keeps the file's own indentation; returns the original text untouched when the content did not change. */
function serialize(original: string | null | undefined, settings: JsonObject): string {
  if (original?.trim() && JSON.stringify(JSON.parse(original)) === JSON.stringify(settings)) return original;
  const indent = original?.match(/^([ \t]+)\S/m)?.[1] ?? 2;
  return JSON.stringify(settings, null, indent) + '\n';
}

function isRecord(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
