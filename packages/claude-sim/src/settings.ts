import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SimEnv } from './paths';

/** A configuration problem reported like the real CLI: message on stderr, exit 1. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface HookCommand {
  command: string;
  /** Seconds. */
  timeout?: number;
}
export interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}
export type HooksConfig = Record<string, HookMatcher[]>;

export interface EffectiveSettings {
  hooks: HooksConfig;
  allow: string[];
  deny: string[];
  defaultMode?: string;
  additionalDirectories: string[];
  env: Record<string, string>;
  model?: string;
  disableAllHooks: boolean;
}

const HookEntrySchema = z.object({
  type: z.string(),
  command: z.string().optional(),
  timeout: z.number().positive().optional(),
});
const HookMatcherSchema = z.object({ matcher: z.string().optional(), hooks: z.array(HookEntrySchema) });
const SettingsFileSchema = z.object({
  hooks: z.record(z.array(HookMatcherSchema)).optional().catch(undefined),
  permissions: z
    .object({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
      defaultMode: z.string().optional(),
      additionalDirectories: z.array(z.string()).optional(),
    })
    .optional()
    .catch(undefined),
  env: z.record(z.string()).optional().catch(undefined),
  model: z.string().optional().catch(undefined),
  disableAllHooks: z.boolean().optional().catch(undefined),
});
type SettingsFile = z.infer<typeof SettingsFileSchema>;

function readJsonFile(file: string, missingMessage: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(missingMessage);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`Error: Invalid settings file ${file}: ${(error as Error).message}`);
  }
}

/** `--settings` takes inline JSON or a path; anything that does not parse as JSON is treated as a path. */
function readFlagSettings(value: string, cwd: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through: the real CLI then reports it as a missing file
    }
  }
  const file = path.resolve(cwd, value);
  return readJsonFile(file, `Error: Settings file not found: ${file}`);
}

function normalise(raw: unknown): SettingsFile {
  // Settings that fail validation are ignored in print mode, as in the real CLI.
  const parsed = SettingsFileSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/**
 * Effective settings: the CLAUDE_SIM_USER_SETTINGS file (standing in for ~/.claude/settings.json, i.e. the
 * global hooks of an observed session) merged with `--settings`. Hooks from both sources all run.
 */
export function loadSettings(flagValue: string | undefined, env: SimEnv, cwd: string): EffectiveSettings {
  const sources: SettingsFile[] = [];
  const userFile = env.CLAUDE_SIM_USER_SETTINGS ? path.resolve(cwd, env.CLAUDE_SIM_USER_SETTINGS) : undefined;
  // Like a missing ~/.claude/settings.json, a missing user settings file just means no global settings.
  if (userFile && fs.existsSync(userFile)) {
    sources.push(normalise(readJsonFile(userFile, `Error: Settings file not found: ${userFile}`)));
  }
  if (flagValue !== undefined) sources.push(normalise(readFlagSettings(flagValue, cwd)));

  const effective: EffectiveSettings = {
    hooks: {},
    allow: [],
    deny: [],
    additionalDirectories: [],
    env: {},
    disableAllHooks: false,
  };
  for (const source of sources) {
    for (const [event, matchers] of Object.entries(source.hooks ?? {})) {
      const list = (effective.hooks[event] ??= []);
      for (const matcher of matchers) {
        const hooks = matcher.hooks
          .filter(
            (hook) =>
              hook.type === 'command' && typeof hook.command === 'string' && hook.command.trim() !== '',
          )
          .map((hook) => ({
            command: hook.command!,
            ...(hook.timeout !== undefined && { timeout: hook.timeout }),
          }));
        if (hooks.length > 0)
          list.push({ ...(matcher.matcher !== undefined && { matcher: matcher.matcher }), hooks });
      }
    }
    effective.allow.push(...(source.permissions?.allow ?? []));
    effective.deny.push(...(source.permissions?.deny ?? []));
    effective.additionalDirectories.push(...(source.permissions?.additionalDirectories ?? []));
    if (source.permissions?.defaultMode) effective.defaultMode = source.permissions.defaultMode;
    Object.assign(effective.env, source.env ?? {});
    if (source.model) effective.model = source.model;
    if (source.disableAllHooks) effective.disableAllHooks = true;
  }
  return effective;
}
