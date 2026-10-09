/**
 * Command-line parsing with the same semantics as Claude Code's commander setup: variadic options keep
 * consuming arguments until the next `-`-prefixed token (so `--allowedTools Edit "prompt"` swallows the
 * prompt, exactly like the real CLI), unknown options and bad choices fail with commander's wording, and
 * excess positionals are ignored (the first one is the prompt).
 */

export type OutputFormat = 'text' | 'json' | 'stream-json';
export type InputFormat = 'text' | 'stream-json';

export interface CliOptions {
  print: boolean;
  outputFormat: OutputFormat;
  inputFormat: InputFormat;
  verbose: boolean;
  includePartialMessages: boolean;
  sessionId?: string;
  /** `true` when -r/--resume was given without a value. */
  resume?: string | true;
  continue: boolean;
  forkSession: boolean;
  model?: string;
  mcpConfig: string[];
  strictMcpConfig: boolean;
  settings?: string;
  appendSystemPrompt?: string;
  systemPrompt?: string;
  permissionMode?: string;
  dangerouslySkipPermissions: boolean;
  allowedTools: string[];
  disallowedTools: string[];
  /** Raw `--tools` values; undefined when the flag was not given. */
  tools?: string[];
  maxBudgetUsd?: string;
  maxTurns?: string;
  addDir: string[];
  noSessionPersistence: boolean;
  debug: boolean;
  help: boolean;
  version: boolean;
  prompt?: string;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

type OptionKind = 'flag' | 'value' | 'optional' | 'variadic';
type OptionValue = string | string[] | true;

interface OptionSpec {
  /** Commander-style flags string, used verbatim in error messages. */
  flags: string;
  kind: OptionKind;
  choices?: readonly string[];
  /** Values accepted although commander does not list them (e.g. the legacy `default` permission mode). */
  alsoAccepted?: readonly string[];
  apply?: (options: CliOptions, value: OptionValue) => void;
}

const asString = (value: OptionValue): string => (typeof value === 'string' ? value : '');
const asList = (value: OptionValue): string[] =>
  Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];

export const PERMISSION_MODES = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan',
] as const;

const OPTION_SPECS: OptionSpec[] = [
  { flags: '-p, --print', kind: 'flag', apply: (o) => (o.print = true) },
  {
    flags: '--output-format <format>',
    kind: 'value',
    choices: ['text', 'json', 'stream-json'],
    apply: (o, v) => (o.outputFormat = asString(v) as OutputFormat),
  },
  {
    flags: '--input-format <format>',
    kind: 'value',
    choices: ['text', 'stream-json'],
    apply: (o, v) => (o.inputFormat = asString(v) as InputFormat),
  },
  { flags: '--verbose', kind: 'flag', apply: (o) => (o.verbose = true) },
  { flags: '--include-partial-messages', kind: 'flag', apply: (o) => (o.includePartialMessages = true) },
  { flags: '--session-id <uuid>', kind: 'value', apply: (o, v) => (o.sessionId = asString(v)) },
  {
    flags: '-r, --resume [value]',
    kind: 'optional',
    apply: (o, v) => (o.resume = v === true ? true : asString(v)),
  },
  { flags: '-c, --continue', kind: 'flag', apply: (o) => (o.continue = true) },
  { flags: '--fork-session', kind: 'flag', apply: (o) => (o.forkSession = true) },
  { flags: '--model <model>', kind: 'value', apply: (o, v) => (o.model = asString(v)) },
  { flags: '--mcp-config <configs...>', kind: 'variadic', apply: (o, v) => o.mcpConfig.push(...asList(v)) },
  { flags: '--strict-mcp-config', kind: 'flag', apply: (o) => (o.strictMcpConfig = true) },
  { flags: '--settings <file-or-json>', kind: 'value', apply: (o, v) => (o.settings = asString(v)) },
  {
    flags: '--append-system-prompt <prompt>',
    kind: 'value',
    apply: (o, v) => (o.appendSystemPrompt = asString(v)),
  },
  { flags: '--system-prompt <prompt>', kind: 'value', apply: (o, v) => (o.systemPrompt = asString(v)) },
  {
    flags: '--permission-mode <mode>',
    kind: 'value',
    choices: PERMISSION_MODES,
    alsoAccepted: ['default'],
    apply: (o, v) => (o.permissionMode = asString(v)),
  },
  {
    flags: '--dangerously-skip-permissions',
    kind: 'flag',
    apply: (o) => (o.dangerouslySkipPermissions = true),
  },
  {
    flags: '--allowedTools, --allowed-tools <tools...>',
    kind: 'variadic',
    apply: (o, v) => o.allowedTools.push(...asList(v)),
  },
  {
    flags: '--disallowedTools, --disallowed-tools <tools...>',
    kind: 'variadic',
    apply: (o, v) => o.disallowedTools.push(...asList(v)),
  },
  {
    flags: '--tools <tools...>',
    kind: 'variadic',
    apply: (o, v) => (o.tools = [...(o.tools ?? []), ...asList(v)]),
  },
  { flags: '--max-budget-usd <amount>', kind: 'value', apply: (o, v) => (o.maxBudgetUsd = asString(v)) },
  { flags: '--max-turns <turns>', kind: 'value', apply: (o, v) => (o.maxTurns = asString(v)) },
  { flags: '--add-dir <directories...>', kind: 'variadic', apply: (o, v) => o.addDir.push(...asList(v)) },
  { flags: '--no-session-persistence', kind: 'flag', apply: (o) => (o.noSessionPersistence = true) },
  { flags: '-d, --debug [filter]', kind: 'optional', apply: (o) => (o.debug = true) },
  { flags: '--mcp-debug', kind: 'flag', apply: (o) => (o.debug = true) },
  { flags: '-h, --help', kind: 'flag', apply: (o) => (o.help = true) },
  { flags: '-v, --version', kind: 'flag', apply: (o) => (o.version = true) },
  // Accepted and ignored: harmless for a simulated print-mode session.
  { flags: '--agent <agent>', kind: 'value' },
  { flags: '--agents <json-or-file>', kind: 'value' },
  { flags: '--allow-dangerously-skip-permissions', kind: 'flag' },
  { flags: '--append-system-prompt-file <file>', kind: 'value' },
  { flags: '--system-prompt-file <file>', kind: 'value' },
  { flags: '--autocompact <auto|tokens>', kind: 'value' },
  { flags: '--ax-screen-reader', kind: 'flag' },
  { flags: '--bg, --background', kind: 'flag' },
  { flags: '--bare', kind: 'flag' },
  { flags: '--betas <betas...>', kind: 'variadic' },
  { flags: '--brief', kind: 'flag' },
  { flags: '--chrome', kind: 'flag' },
  { flags: '--no-chrome', kind: 'flag' },
  { flags: '--cloud [description|session_id|url]', kind: 'optional' },
  { flags: '--debug-file <path>', kind: 'value', apply: (o) => (o.debug = true) },
  { flags: '--desktop', kind: 'flag' },
  { flags: '--disable-slash-commands', kind: 'flag' },
  { flags: '--effort <level>', kind: 'value', choices: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { flags: '--environment <environment_id>', kind: 'value' },
  { flags: '--exclude-dynamic-system-prompt-sections', kind: 'flag' },
  { flags: '--fallback-model <model>', kind: 'value' },
  { flags: '--file <specs...>', kind: 'variadic' },
  { flags: '--forward-subagent-text', kind: 'flag' },
  { flags: '--from-pr [value]', kind: 'optional' },
  { flags: '--ide', kind: 'flag' },
  { flags: '--include-hook-events', kind: 'flag' },
  { flags: '--json-schema <schema>', kind: 'value' },
  { flags: '--max-thinking-tokens <tokens>', kind: 'value' },
  { flags: '-n, --name <name>', kind: 'value' },
  { flags: '--permission-prompt-tool <tool>', kind: 'value' },
  { flags: '--permission-prompts <target>', kind: 'value', choices: ['host', 'none'] },
  { flags: '--plugin-dir <path>', kind: 'value' },
  { flags: '--plugin-url <url>', kind: 'value' },
  { flags: '--prompt-suggestions [value]', kind: 'optional' },
  { flags: '--remote-control [name]', kind: 'optional' },
  { flags: '--remote-control-session-name-prefix <prefix>', kind: 'value' },
  { flags: '--replay-user-messages', kind: 'flag' },
  { flags: '--restricted', kind: 'flag' },
  { flags: '--safe-mode', kind: 'flag' },
  { flags: '--setting-sources <sources>', kind: 'value' },
  { flags: '--system-prompt-snapshot <on|off>', kind: 'value' },
  { flags: '--teleport [session]', kind: 'optional' },
  { flags: '--tmux', kind: 'flag' },
  { flags: '-w, --worktree [name]', kind: 'optional' },
];

const LONG_OPTIONS = new Map<string, OptionSpec>();
const SHORT_OPTIONS = new Map<string, OptionSpec>();
for (const spec of OPTION_SPECS) {
  for (const name of spec.flags.split(/[ ,]+/)) {
    if (name.startsWith('--')) LONG_OPTIONS.set(name, spec);
    else if (/^-[A-Za-z]$/.test(name)) SHORT_OPTIONS.set(name, spec);
  }
}

function defaults(): CliOptions {
  return {
    print: false,
    outputFormat: 'text',
    inputFormat: 'text',
    verbose: false,
    includePartialMessages: false,
    continue: false,
    forkSession: false,
    mcpConfig: [],
    strictMcpConfig: false,
    dangerouslySkipPermissions: false,
    allowedTools: [],
    disallowedTools: [],
    addDir: [],
    noSessionPersistence: false,
    debug: false,
    help: false,
    version: false,
  };
}

const looksLikeOption = (arg: string | undefined): boolean =>
  arg !== undefined && arg.length > 1 && arg[0] === '-';

export function parseArgs(argv: readonly string[]): CliOptions {
  const options = defaults();
  const positionals: string[] = [];
  let i = 0;

  const take = (spec: OptionSpec, inline: string | undefined): void => {
    let value: OptionValue;
    switch (spec.kind) {
      case 'flag':
        value = true;
        break;
      case 'value': {
        const next = inline ?? argv[++i];
        if (next === undefined) throw new UsageError(`error: option '${spec.flags}' argument missing`);
        value = next;
        break;
      }
      case 'optional':
        if (inline !== undefined) value = inline;
        else if (argv[i + 1] !== undefined && !looksLikeOption(argv[i + 1])) value = argv[++i]!;
        else value = true;
        break;
      case 'variadic': {
        const first = inline ?? argv[++i];
        if (first === undefined) throw new UsageError(`error: option '${spec.flags}' argument missing`);
        const values = [first];
        while (argv[i + 1] !== undefined && !looksLikeOption(argv[i + 1])) values.push(argv[++i]!);
        value = values;
        break;
      }
    }
    if (spec.choices && typeof value === 'string') {
      if (!spec.choices.includes(value) && !spec.alsoAccepted?.includes(value)) {
        throw new UsageError(
          `error: option '${spec.flags}' argument '${value}' is invalid. Allowed choices are ${spec.choices.join(', ')}.`,
        );
      }
    }
    spec.apply?.(options, value);
  };

  for (; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token : token.slice(0, eq);
      const spec = LONG_OPTIONS.get(name);
      if (!spec) throw new UsageError(`error: unknown option '${name}'`);
      take(spec, eq === -1 ? undefined : token.slice(eq + 1));
      continue;
    }
    if (looksLikeOption(token)) {
      const letters = token.slice(1);
      for (let j = 0; j < letters.length; j++) {
        const spec = SHORT_OPTIONS.get(`-${letters[j]}`);
        if (!spec) throw new UsageError(`error: unknown option '-${letters[j]}'`);
        if (spec.kind === 'flag') {
          spec.apply?.(options, true);
          continue;
        }
        const rest = letters.slice(j + 1);
        take(spec, rest === '' ? undefined : rest);
        break;
      }
      continue;
    }
    positionals.push(token);
  }
  options.prompt = positionals[0];
  return options;
}

export const HELP_TEXT = `Usage: claude [options] [prompt]

claude-sim — a deterministic stand-in for the Claude Code CLI (print mode only).

Options (Claude Code compatible):
  -p, --print                         Print response and exit
  --output-format <format>            text | json | stream-json (stream-json requires --verbose)
  --input-format <format>             text | stream-json
  --verbose                           Verbose output (required for stream-json)
  --include-partial-messages          Emit stream_event partial deltas (stream-json)
  --session-id <uuid>                 Use a specific session id
  -r, --resume <id>                   Resume a session (appends to its transcript)
  -c, --continue                      Resume the most recent session in this directory
  --fork-session                      With --resume/--continue: continue under a new session id
  --model <model>                     opus | sonnet | haiku | fable or a full model id
  --mcp-config <configs...>           MCP server configs (files or JSON strings)
  --strict-mcp-config                 Only use --mcp-config servers (always true for the sim)
  --settings <file-or-json>           Settings (hooks, permissions, env, model)
  --permission-mode <mode>            acceptEdits | auto | bypassPermissions | manual | dontAsk | plan
  --dangerously-skip-permissions      Bypass permission checks
  --allowedTools <tools...>           Permission allow rules, e.g. "Bash(git log:*)" Edit mcp__aoc
  --disallowedTools <tools...>        Permission deny rules
  --tools <tools...>                  Built-in tools to offer ("" = none, "default" = all)
  --max-budget-usd <amount>           Stop once notional spend reaches this amount
  --max-turns <turns>                 Stop after this many model turns
  --add-dir <directories...>          Extra directories readable without a grant
  --no-session-persistence            Do not write a transcript
  -v, --version                       Print the version

Variadic options (--allowedTools, --mcp-config, --tools, ...) consume the following arguments, as in
Claude Code: put the prompt first, after "--", or on stdin.

Simulation (environment):
  CLAUDE_SIM_SCENARIO        Built-in scenario name or path to a scenario JSON file (default: happy-path)
                             A "[[scenario:<name>]]" marker in the prompt takes precedence.
  CLAUDE_SIM_SPEED           Multiplier for every simulated duration (e.g. 0.01 in tests)
  CLAUDE_SIM_USER_SETTINGS   Extra settings file loaded like ~/.claude/settings.json (global hooks)
  CLAUDE_SIM_EXEC=1          Really execute bash steps marked "exec": true
  CLAUDE_SIM_DEBUG=1         Log simulator internals to stderr
`;
