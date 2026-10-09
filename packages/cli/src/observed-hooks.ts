/**
 * Observed-session hooks (§2): register the AOC hook command for every Claude Code hook event in a
 * user's settings.json, so sessions started outside AOC are still observed (read-only, buffered locally).
 *
 * AOC entries are tagged with a trailing shell comment in the command string rather than an extra JSON
 * key, so Claude Code's settings validation never sees an unknown field. Everything else in the file —
 * foreign hooks, their order, unrelated settings — is preserved. Install and uninstall are idempotent.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { claudeConfigDir, HOOK_EVENTS, type HookEventName } from '@aoc/contracts';
import { CliError } from './errors';

export const AOC_HOOK_TAG = '# aoc:observed-hook';
/** Seconds; observed hooks must never hold up a developer's session (the hook itself spools when aocd is down). */
export const OBSERVED_HOOK_TIMEOUT_SEC = 10;
export const BACKUP_SUFFIX = '.aoc-bak';
const TOOL_EVENTS: ReadonlySet<string> = new Set<HookEventName>(['PreToolUse', 'PostToolUse']);

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function defaultSettingsPath(env: Record<string, string | undefined>, homeDir: string): string {
  return join(claudeConfigDir(env, homeDir), 'settings.json');
}

export function tagCommand(command: string): string {
  return `${untagCommand(command)} ${AOC_HOOK_TAG}`;
}

export function untagCommand(command: string): string {
  const s = command.trim();
  return (s.endsWith(AOC_HOOK_TAG) ? s.slice(0, -AOC_HOOK_TAG.length) : s).trim();
}

export function isAocHandler(h: unknown): boolean {
  return isObj(h) && typeof h.command === 'string' && h.command.trimEnd().endsWith(AOC_HOOK_TAG);
}

function aocGroup(event: string, taggedCommand: string): Json {
  const handler = { type: 'command', command: taggedCommand, timeout: OBSERVED_HOOK_TIMEOUT_SEC };
  return TOOL_EVENTS.has(event) ? { matcher: '*', hooks: [handler] } : { hooks: [handler] };
}

function hooksOf(settings: Json): Json {
  if (settings.hooks === undefined) return {};
  if (!isObj(settings.hooks)) throw new CliError('settings "hooks" is not an object — refusing to modify it');
  return settings.hooks;
}

export interface MergeResult {
  settings: Json;
  changed: boolean;
}

/** Ensure exactly one AOC handler group per event, placed where the previous AOC entry was (else last). */
export function mergeObservedHooks(
  input: unknown,
  command: string,
  events: readonly string[] = HOOK_EVENTS,
): MergeResult {
  if (input !== undefined && input !== null && !isObj(input))
    throw new CliError('settings file is not a JSON object — refusing to modify it');
  const settings: Json = structuredClone(isObj(input) ? input : {});
  const hooks = hooksOf(settings);
  const tagged = tagCommand(command);
  for (const event of events) {
    const current = hooks[event];
    if (current !== undefined && !Array.isArray(current))
      throw new CliError(`settings hooks.${event} is not an array — refusing to modify it`);
    const out: unknown[] = [];
    let insertAt = -1;
    for (const group of current ?? []) {
      if (!isObj(group) || !Array.isArray(group.hooks) || !group.hooks.some(isAocHandler)) {
        out.push(group);
        continue;
      }
      const foreign = group.hooks.filter((h) => !isAocHandler(h));
      if (insertAt < 0) insertAt = foreign.length ? out.length + 1 : out.length;
      if (foreign.length) out.push({ ...group, hooks: foreign });
    }
    out.splice(insertAt < 0 ? out.length : insertAt, 0, aocGroup(event, tagged));
    hooks[event] = out;
  }
  settings.hooks = hooks;
  return { settings, changed: JSON.stringify(settings) !== JSON.stringify(isObj(input) ? input : {}) };
}

/** Remove every AOC-tagged handler (any event); groups/events/hooks emptied by the removal are dropped. */
export function removeObservedHooks(input: unknown): MergeResult & { removed: number } {
  if (input !== undefined && input !== null && !isObj(input))
    throw new CliError('settings file is not a JSON object — refusing to modify it');
  const settings: Json = structuredClone(isObj(input) ? input : {});
  if (settings.hooks === undefined) return { settings, changed: false, removed: 0 };
  const hooks = hooksOf(settings);
  let removed = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    let touched = false;
    const out: unknown[] = [];
    for (const group of groups) {
      if (!isObj(group) || !Array.isArray(group.hooks)) {
        out.push(group);
        continue;
      }
      const kept = group.hooks.filter((h) => !isAocHandler(h));
      const n = group.hooks.length - kept.length;
      if (n === 0) {
        out.push(group);
        continue;
      }
      removed += n;
      touched = true;
      if (kept.length) out.push({ ...group, hooks: kept });
    }
    if (touched) {
      if (out.length) hooks[event] = out;
      else delete hooks[event];
    }
  }
  if (removed > 0 && Object.keys(hooks).length === 0) delete settings.hooks;
  return { settings, changed: removed > 0, removed };
}

export interface HookInspection {
  installed: HookEventName[];
  missing: HookEventName[];
  /** Distinct AOC hook commands (untagged) found in the file. */
  commands: string[];
}

export function inspectObservedHooks(input: unknown): HookInspection {
  const hooks = isObj(input) && isObj(input.hooks) ? input.hooks : {};
  const installed: HookEventName[] = [];
  const commands = new Set<string>();
  for (const event of HOOK_EVENTS) {
    const groups = hooks[event];
    let found = false;
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of isObj(g) && Array.isArray(g.hooks) ? g.hooks : []) {
        if (isAocHandler(h)) {
          found = true;
          commands.add(untagCommand((h as Json).command as string));
        }
      }
    }
    if (found) installed.push(event);
  }
  return { installed, missing: HOOK_EVENTS.filter((e) => !installed.includes(e)), commands: [...commands] };
}

// ── file I/O ─────────────────────────────────────────────────────────────────
export interface SettingsFile {
  exists: boolean;
  raw: string | null;
  data: Json;
}

export function readSettingsFile(path: string): SettingsFile {
  if (!existsSync(path)) return { exists: false, raw: null, data: {} };
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) return { exists: true, raw, data: {} };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new CliError(`${path} is not valid JSON — fix it first; nothing was changed`);
  }
  if (!isObj(data)) throw new CliError(`${path} is not a JSON object — refusing to modify it`);
  return { exists: true, raw, data };
}

/** Back up the previous bytes to <file>.aoc-bak, then replace the file atomically keeping its mode. */
export function writeSettingsFile(
  path: string,
  data: Json,
  previous: SettingsFile,
): { backupPath: string | null } {
  mkdirSync(dirname(path), { recursive: true });
  const mode = previous.exists ? statSync(path).mode & 0o777 : 0o600;
  let backupPath: string | null = null;
  if (previous.exists && previous.raw !== null) {
    backupPath = path + BACKUP_SUFFIX;
    writeFileSync(backupPath, previous.raw, { mode });
  }
  const tmp = `${path}.${process.pid}.aoc-tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  return { backupPath };
}

export function installObservedHooks(
  path: string,
  command: string,
): { changed: boolean; backupPath: string | null; events: number } {
  const file = readSettingsFile(path);
  const { settings, changed } = mergeObservedHooks(file.data, command);
  const backupPath = changed ? writeSettingsFile(path, settings, file).backupPath : null;
  return { changed, backupPath, events: HOOK_EVENTS.length };
}

export function uninstallObservedHooks(path: string): { removed: number; backupPath: string | null } {
  const file = readSettingsFile(path);
  if (!file.exists) return { removed: 0, backupPath: null };
  const { settings, removed } = removeObservedHooks(file.data);
  const backupPath = removed > 0 ? writeSettingsFile(path, settings, file).backupPath : null;
  return { removed, backupPath };
}
