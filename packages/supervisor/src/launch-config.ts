/**
 * Pure builders for what a managed `claude -p` turn is started with: argv, environment (credential isolation, §3),
 * the per-session MCP config and the hook settings. Verified against Claude Code 2.1.295 (research §2, §4.5, §8).
 */
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { AOC_MCP_SERVER_NAME, FILE_CHANGING_TOOLS, type ProcessType } from '@aoc/contracts';
import { builtinToolsOf, MANAGED_HOOK_EVENTS } from './claude-facts';

/** Linux caps a single argv string at 128 KiB (MAX_ARG_STRLEN); prompts and the system prompt stay below it. */
export const MAX_ARG_BYTES = 120_000;

export interface ToolPolicy {
  /** `--tools`: restricts the built-in set (undefined = default set). */
  builtinTools?: string[];
  allowedTools: string[];
  disallowedTools: string[];
}

/**
 * MCP tools are denied in -p mode unless allowed, so the AOC server is always allowed (server-level rule).
 * Read-only types additionally deny every file-changing tool, whatever the registry says (defence in depth).
 */
export function toolPolicy(t: ProcessType): ToolPolicy {
  const allowed = unique([`mcp__${AOC_MCP_SERVER_NAME}`, ...(t.tools.allow ?? [])]);
  const disallowed = unique([...(t.tools.deny ?? []), ...(t.readOnly ? FILE_CHANGING_TOOLS : [])]);
  const builtin = builtinToolsOf(t);
  return {
    ...(builtin ? { builtinTools: builtin } : {}),
    allowedTools: allowed,
    disallowedTools: disallowed,
  };
}

export interface ClaudeArgsInput extends ToolPolicy {
  model: string;
  mcpConfigPath: string;
  settingsPath: string;
  permissionMode: ProcessType['permissionMode'];
  systemPrompt: string;
  claudeSessionId: string;
  /** false → `--session-id` (new conversation); true → `--resume` (same id, same transcript). */
  resume: boolean;
  prompt: string;
}

export function buildClaudeArgs(i: ClaudeArgsInput): string[] {
  const a = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  a.push('--mcp-config', i.mcpConfigPath, '--strict-mcp-config', '--settings', i.settingsPath);
  // The registry's 'default' is the CLI's default mode, which 2.1.x names 'manual': omit the flag.
  if (i.permissionMode !== 'default') a.push('--permission-mode', i.permissionMode);
  a.push('--append-system-prompt', i.systemPrompt);
  if (i.builtinTools) a.push('--tools', i.builtinTools.join(','));
  a.push('--allowedTools', ...i.allowedTools);
  if (i.disallowedTools.length) a.push('--disallowedTools', ...i.disallowedTools);
  a.push(i.resume ? '--resume' : '--session-id', i.claudeSessionId);
  // Variadic tool flags swallow a following prompt: a single-value flag goes last, and `--` keeps a prompt that
  // starts with "-" from being parsed as an option.
  a.push('--model', i.model, '--', i.prompt);
  return a;
}

/** argv for the audit trail: the system prompt and the prompt are already recorded elsewhere (and can be large). */
export function redactArgv(argv: string[]): string[] {
  const out = [...argv];
  const sp = out.indexOf('--append-system-prompt');
  if (sp >= 0 && sp + 1 < out.length) out[sp + 1] = '@system-prompt.md';
  const dd = out.lastIndexOf('--');
  if (dd >= 0) out.splice(dd + 1, out.length - dd - 1, '@prompt');
  return out;
}

// ── environment ─────────────────────────────────────────────────────────────

/** Only allowlisted variables cross from aocd into a session. AOC_* never does: those are set per session. */
export function allowlistedEnv(
  source: Record<string, string | undefined>,
  allowlist: readonly string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of allowlist) {
    const v = source[k];
    if (!k.startsWith('AOC_') && typeof v === 'string') env[k] = v;
  }
  return env;
}

/** The identity and private directories of an isolated session (supervisor.isolation 'user'). */
export interface IsolatedIdentity {
  /** OS user the turn runs as. */
  user: string;
  home: string;
  claudeConfigDir: string;
  tmpDir: string;
}

export interface SessionEnvInput {
  source: Record<string, string | undefined>;
  allowlist: readonly string[];
  /** Credential profile env; ignored for read-only sessions (§3, §7: triage never holds credentials). */
  credentials: Record<string, string> | null;
  readOnly: boolean;
  aoc: Record<string, string>;
  timezone: string;
  /** Isolated sessions get their own HOME, config dir, TMPDIR and user variables instead of aocd's. */
  isolated?: IsolatedIdentity | null;
}

/** Variables that point into aocd's own account (its home, agent sockets, keyrings): never inherited when isolated. */
const AOCD_ACCOUNT_VARS = [
  'HOME',
  'USER',
  'LOGNAME',
  'MAIL',
  'CLAUDE_CONFIG_DIR',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'SSH_AUTH_SOCK',
  'GNUPGHOME',
];

/**
 * Everything in a session env is readable by the model's own Bash: only entitled sessions get credentials. An
 * isolated session's identity variables are pinned last (a profile cannot point HOME back at aocd's), and git
 * reads no global or system config — so no credential helper or include from the host applies (G-01).
 */
export function buildSessionEnv(i: SessionEnvInput): Record<string, string> {
  const env = allowlistedEnv(i.source, i.allowlist);
  if (i.isolated) for (const k of AOCD_ACCOUNT_VARS) delete env[k];
  if (i.credentials && !i.readOnly) {
    for (const [k, v] of Object.entries(i.credentials)) if (!k.startsWith('AOC_')) env[k] = v;
  }
  if (i.isolated) {
    const iso = i.isolated;
    Object.assign(env, {
      HOME: iso.home,
      USER: iso.user,
      LOGNAME: iso.user,
      CLAUDE_CONFIG_DIR: iso.claudeConfigDir,
      TMPDIR: iso.tmpDir,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    });
    // Without a global config git has no identity; a credential profile may name the machine user instead.
    env.GIT_AUTHOR_NAME ??= 'AOC agent';
    env.GIT_COMMITTER_NAME ??= env.GIT_AUTHOR_NAME;
    env.GIT_AUTHOR_EMAIL ??= `${iso.user}@localhost`;
    env.GIT_COMMITTER_EMAIL ??= env.GIT_AUTHOR_EMAIL;
  }
  // Claude Code renders limit reset times in the process zone.
  env.TZ = i.timezone;
  return { ...env, ...i.aoc };
}

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const FILE_REF = /\{\{file:([^}]*)\}\}/g;
/** Key files are small; anything bigger is a mistake in the profile, not a key. */
export const MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024;

const CredentialProfilesSchema = z.object({
  profiles: z.record(z.object({ env: z.record(z.string()), files: z.record(z.string()).optional() })),
});

/**
 * A credential profile: env for the session, plus the key files it needs. An env value refers to a key file as
 * `{{file:<name>}}`, so an isolated session can be handed a private per-session copy instead of the original.
 */
export interface CredentialProfile {
  env: Record<string, string>;
  /** Absolute path of each key file, by name. */
  files: Record<string, string>;
}

/**
 * Every profile of a `{ profiles: { [name]: { env, files? } } }` file. Errors never echo file content (a JSON
 * parse error would quote the secret it choked on) and name env variables, never their values.
 */
export function readCredentialProfiles(file: string): Record<string, CredentialProfile> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      code
        ? `credential profiles file is unreadable (${code})`
        : 'credential profiles file is not valid JSON',
    );
  }
  const parsed = CredentialProfilesSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      'credential profiles file must look like {"profiles":{"<name>":{"env":{...},"files":{"<key>":"/abs/path"}}}}',
    );
  const out: Record<string, CredentialProfile> = {};
  for (const [name, p] of Object.entries(parsed.data.profiles)) {
    const files = p.files ?? {};
    for (const [key, path] of Object.entries(files)) {
      if (!FILE_NAME.test(key))
        throw new Error(`credential profile "${name}": file names are 1-64 letters, digits, . _ -`);
      if (!isAbsolute(path))
        throw new Error(`credential profile "${name}": file "${key}" needs an absolute path`);
    }
    for (const [k, v] of Object.entries(p.env)) {
      for (const m of v.matchAll(FILE_REF)) {
        if (!Object.hasOwn(files, m[1]!))
          throw new Error(
            `credential profile "${name}": ${k} refers to a file that "files" does not declare`,
          );
      }
    }
    out[name] = { env: { ...p.env }, files: { ...files } };
  }
  return out;
}

export function readCredentialProfileSpec(file: string, profile: string): CredentialProfile {
  const p = readCredentialProfiles(file)[profile];
  if (!p) throw new Error(`credential profile "${profile}" is not defined`);
  return p;
}

/** Replaces `{{file:<name>}}` with the given paths (originals for aocd's own runs, copies for isolated sessions). */
export function resolveFileRefs(
  env: Record<string, string>,
  paths: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env))
    out[k] = v.replace(FILE_REF, (_, name: string) => paths[name] ?? '');
  return out;
}

/** Env of a named profile with key files at their original paths (supervisor-run commands, dev sessions). */
export function readCredentialProfile(file: string, profile: string): Record<string, string> {
  const p = readCredentialProfileSpec(file, profile);
  return resolveFileRefs(p.env, p.files);
}

// ── per-session MCP config and hook settings ───────────────────────────────

/** `alwaysLoad` keeps the AOC tools inline instead of deferred behind ToolSearch. */
export function buildMcpConfig(
  command: readonly string[],
  env: Record<string, string>,
): Record<string, unknown> {
  const [bin, ...args] = command;
  return {
    mcpServers: { [AOC_MCP_SERVER_NAME]: { type: 'stdio', command: bin, args, env, alwaysLoad: true } },
  };
}

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);
/** Seconds. PreToolUse may raise a decision card; SessionEnd shares a short budget and must only enqueue. */
const HOOK_TIMEOUT_S: Record<string, number> = {
  PreToolUse: 30,
  PermissionRequest: 30,
  UserPromptSubmit: 30,
  SessionStart: 30,
  Stop: 30,
  SessionEnd: 10,
};
const DEFAULT_HOOK_TIMEOUT_S = 15;

const HookSettingsSchema = z
  .object({
    hooks: z.record(
      z.string().refine((k) => MANAGED_HOOK_EVENTS.includes(k), 'unknown hook event'),
      z
        .array(
          z
            .object({
              matcher: z.string().optional(),
              hooks: z
                .array(
                  z
                    .object({
                      type: z.literal('command'),
                      command: z.string().min(1),
                      timeout: z.number().int().min(1).max(600),
                    })
                    .strict(),
                )
                .length(1),
            })
            .strict(),
        )
        .length(1),
    ),
  })
  .strict();
export type HookSettings = z.infer<typeof HookSettingsSchema>;

/**
 * One command hook per event (`<hookCommand> <Event>`). Invalid entries are silently dropped by Claude Code in -p
 * mode, so the result is validated before it is written (research §4.5). The command never carries secrets: a hook
 * that exits 2 leaks its command line into the transcript; the hook reads AOC_INGEST_TOKEN from its env.
 */
export function buildHookSettings(hookCommand: readonly string[]): HookSettings {
  const base = hookCommand.map(shellQuote).join(' ');
  const hooks: HookSettings['hooks'] = {};
  for (const ev of MANAGED_HOOK_EVENTS) {
    hooks[ev] = [
      {
        ...(TOOL_EVENTS.has(ev) ? { matcher: '' } : {}),
        hooks: [
          {
            type: 'command',
            command: `${base} ${ev}`,
            timeout: HOOK_TIMEOUT_S[ev] ?? DEFAULT_HOOK_TIMEOUT_S,
          },
        ],
      },
    ];
  }
  return HookSettingsSchema.parse({ hooks });
}

export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\/.:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function unique<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}
