# Claude Code integration: verified facts for AOC

Research note for the supervisor, sidecar, hooks, MCP server and claude-sim builders.
Captured 2026-10-09 (UTC) against **Claude Code 2.1.295** (native linux-x64 build), model alias `haiku`
→ `claude-haiku-5-5`. Fixtures: [`fixtures/claude-code/`](fixtures/claude-code/).
§0–§12 are probe captures. [§13](#13-verified-against-the-real-cli-on-2026-10-09) is AOC itself run against the real CLI
(what held, the divergences found and fixed, what could not be checked).

Every fact carries one evidence tag:

| Tag | Meaning |
| --- | --- |
| **OBS** | Observed in a live capture run for this note. |
| **BIN** | Read from the JavaScript embedded in the 2.1.295 executable (strings or code). Not exercised live. |
| **DOC** | Official docs, code.claude.com (fetched 2026-10-09). |
| **ISSUE** | GitHub issue reports or third-party tools; the version is noted where known. |
| **INF** | Inference. Not verified. |

## 0. How the captures were made

- Real `claude -p` runs, in a throwaway directory outside the repo. Each run used `env -i` with an explicit,
  scrubbed environment: `PATH`, a temporary `HOME`, proxy and CA variables, `ANTHROPIC_BASE_URL`,
  `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`, `CLAUDE_CONFIG_DIR=<tmp>/cfg`, and the marker
  `AOC_PROBE_PARENT=set-on-claude-process`. The parent agent session's variables were never passed through.
- Auth in this container is host-managed (`init.apiKeySource: "none"`). **Login and credential behaviour on a
  developer workstation (OAuth, keychain, `setup-token`) is not covered.** See §2.6.
- `--settings` registered a hook for each of the 31 events this build accepts (all except `WorktreeCreate` and
  `WorktreeRemove`, which replace built-in behaviour). Each hook command was a small node script that appends its
  stdin JSON plus the `CLAUDE_*`/`AOC_*` environment (secret-like values redacted) to a capture file.
- `--mcp-config` started a stdio MCP server named `probe`, built on `@modelcontextprotocol/sdk` 1.32.1 (the
  repo's pinned version). It exposes one tool, `probe_echo`, and logs its own env, the `initialize` client info
  and every `tools/call` request.
- About 25 runs in total. Variants covered: baseline (Read → Write → Bash `ls` → MCP tool), resume, `/compact`,
  subagent, deny by exit 2, deny by JSON, `defer`, Stop block, SessionStart `additionalContext`, failing tool,
  SIGTERM mid-tool, permission-mode matrix, `--tools` / `--disallowedTools`, invalid settings, failing MCP
  server, MCP `alwaysLoad`. Total model spend was under US$0.05.

## 1. Corrections to `packages/contracts/src/claude-code.ts` and `mcp.ts`

> **Status: history.** These rows were requested changes when the note was written, and the contracts follow them now
> (for example `HOOK_EVENTS` lists the events named in C1). The contracts are the current truth: where a row and
> `packages/contracts/src/claude-code.ts` differ, the contracts win.

These are the facts that contradict, or are missing from, the current contracts. The lead owns those files, so
each row is a requested change.

| # | Contract today | Verified fact | Suggested change |
| --- | --- | --- | --- |
| C1 | `HOOK_EVENTS` has 9 events. | 2.1.295 accepts **33** events (BIN, DOC). Live in `-p` mode (OBS): `PostToolUseFailure` fires **instead of** `PostToolUse` when a tool fails. `PostToolBatch` fires after every tool batch. `PermissionRequest` fires when a tool needs approval. `SubagentStart`, `PostCompact` and `MessageDisplay` also fire. `StopFailure` fires when a turn ends on an API error such as `rate_limit` (DOC). `Notification` **never fired in any `-p` run** (OBS). | Add at least `PostToolUseFailure`, `PostToolBatch`, `StopFailure`, `SubagentStart`, `PostCompact` and `PermissionRequest`. Without `PostToolUseFailure`, failed tool calls are missing from the timeline. |
| C2 | `SessionStartInput.source` is `startup \| resume \| clear \| compact`. | Docs add `fork` (DOC). With `resume`, extra fields appear: `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`, `estimated_cache_write_usd` (OBS). With `compact`, `model` appears (OBS). With `startup`, there is no `permission_mode` (OBS). | Add `'fork'` and the optional fields. |
| C3 | `HookInputBase` has 5 fields. `tool_use_id` is optional. | Every event after the first prompt carries `prompt_id`. Tool and stop events carry `effort: {level}` (OBS). `tool_use_id` was present on every `Pre`/`PostToolUse` (OBS). MCP tools add `mcp_server: {name, source}`. `PostToolUse` adds `duration_ms` (OBS). `PermissionRequest` has **no** `tool_use_id` (OBS). | Add `prompt_id?`, `effort?`, `mcp_server?` and `duration_ms?`. |
| C4 | `StopInput` = `stop_hook_active` only. | `Stop` adds `last_assistant_message`, `background_tasks[]` and `session_crons[]`. `SubagentStop` adds `agent_id`, `agent_type` and `agent_transcript_path` (OBS). | Extend the type. Split `SubagentStopInput`. |
| C5 | `PreCompactInput.custom_instructions?: string` | For a manual `/compact` the value is `null`, not absent (OBS). | Type it `string \| null`. |
| C6 | `NotificationInput` = `message` | Docs add `notification_type` (`permission_prompt`, `idle_prompt`, …) and an optional `title` (DOC). It never fired in `-p` (OBS). | Add the fields. Do **not** rely on `Notification` for managed (`-p`) sessions. |
| C7 | `permissionDecision: allow \| deny \| ask` | `defer` also exists. In `-p` it ends the turn cleanly with `terminal_reason: "tool_deferred"` and `deferred_tool_use`, and `--resume` re-runs that exact call (OBS, §7.4). `PreToolUse` output also accepts `updatedInput` and `additionalContext`. `SessionStart` output accepts `additionalContext`, `initialUserMessage`, `watchPaths`, `sessionTitle`, `reloadSkills`. `suppressOutput` has no effect (DOC). | Add `'defer'` and the extra fields. |
| C8 | `FILE_CHANGING_TOOLS` includes `MultiEdit`. | No `MultiEdit` tool exists in 2.1.295; `--tools` silently drops the name (OBS). Bash also changes files: `touch` is auto-allowed under `acceptEdits` (OBS). | Drop `MultiEdit`, or keep it only for older versions. Do not infer "no file change" from tool names alone: use a git diff or commit as the evidence. |
| C9 | `READ_ONLY_TOOLS` = Read, Glob, Grep, **LS**, WebFetch, WebSearch, **TodoWrite** | `LS` and `TodoWrite` do not exist (silently dropped, OBS). `Glob` and `Grep` exist but are **left out of the default tool set whenever Bash is available**. They appear only with `--tools …Glob,Grep…` or when Bash is disallowed (OBS). | Use `["Read","Glob","Grep"]`, plus `WebFetch`/`WebSearch` only if triage may fetch the web. Launch triage with `--tools "Read,Glob,Grep"` (§2.4). |
| C10 | n/a | `init.tools` lists the subagent tool as **`Task`**, but `tool_use.name` and the hook `tool_name` are **`Agent`** (OBS). | Hook matchers and guards must use `Agent`; match `Task` as well for older versions. |
| C11 | `projectSlug(cwd)` = replace each non-alphanumeric character with `-`. | Correct up to 200 characters. Longer slugs become `slug.slice(0,200) + "-" + Math.abs(javaStringHash(cwd)).toString(36)` (BIN). | Add the truncation, or better: take `transcript_path` from hook stdin (§6.1). |
| C12 | `TranscriptLine.type` = user, assistant, system, summary, attachment | Also seen: `queue-operation`, `atis-latch`, `last-prompt`, `mode`, `cost-state`, plus `system` lines with subtypes `stop_hook_summary` and `compact_boundary` (OBS). No `summary` line was seen. Subagent lines go to **separate files**. Compaction usage never appears on an assistant line (OBS, §6.3). | Extend the type list. Make the metering rules explicit (§6.3). |
| C13 | `THROTTLE_PATTERNS` (5 regexes) | **None** of them matches the 2.x message family, e.g. `You've hit your session limit · resets 12:50am (America/Los_Angeles)` (tested, §9.4). Structured signals exist and should come first: the stream-json `rate_limit_event` with `status:"rejected"` and `resetsAt`, the `StopFailure` hook with `error:"rate_limit"`, and `result.api_error_status` (§9.1). | Replace with §9.4 and prefer the structured signals. |
| C14 | n/a | After `--resume`, `result.total_cost_usd` and `result.modelUsage` are **cumulative for the whole session**, while `result.usage` covers this invocation only (OBS). | Metering must never sum `total_cost_usd` across invocations. |
| C15 | `mcp.ts`: tools surface as `mcp__aoc__<tool>` | Correct (OBS pattern `mcp__probe__probe_echo`). Two gaps: (a) in `-p` mode under `default`, `acceptEdits` and `dontAsk`, MCP tools are **denied unless allowed** (OBS); (b) under the default tool set they are **deferred behind `ToolSearch`** unless the server entry sets `"alwaysLoad": true` or `--tools` is used (OBS). | Supervisor passes `--allowedTools mcp__aoc` and sets `"alwaysLoad": true` (§5). |
| C16 | `MODEL_CONTEXT_TOKENS.haiku = 1_000_000` | Confirmed for `claude-haiku-5-5`: `modelUsage.contextWindow: 1000000`, `maxOutputTokens: 128000` (OBS). Other models were not checked. | n/a |

## 2. Launching sessions (supervisor)

### 2.1 Recommended argv

Managed writer session (INF from the observations below):

```ts
const argv = [
  '-p',
  '--session-id', claudeSessionId,          // new session. Use '--resume', id to continue one.
  '--output-format', 'stream-json', '--verbose',
  '--include-partial-messages',             // liveness while the model generates (§3.5)
  '--include-hook-events',                  // optional: hook_started/hook_response lines for every hook
  '--settings', aocSettingsPath,            // AOC hooks. Validate before launch (§4.5).
  '--strict-mcp-config', '--mcp-config', aocMcpConfigPath, // aoc server with "alwaysLoad": true
  '--allowedTools', 'mcp__aoc',             // MCP tools are denied in -p otherwise. Writers also need 'Bash' (§13.3 D1)
  '--permission-mode', 'acceptEdits',
  '--model', model,                         // fixed at launch from the process-type registry (spec §2.2).
                                            // A single-value flag goes last, before the prompt (§2.2).
  prompt,
];
spawn('claude', argv, { cwd, env: { ...sessionEnv, TZ: 'Asia/Kuala_Lumpur', AOC_SESSION_ID: aocSessionId } });
```

Read-only triage session (§7 of the spec): `--tools "Read,Glob,Grep" --permission-mode dontAsk`. Keep the same
`--settings`, `--strict-mcp-config --mcp-config <aoc-mcp.json>` and `--allowedTools mcp__aoc`. Do not put
deploy credentials in the process env (§8).

### 2.2 Flag facts

- **Variadic flags swallow the prompt** (OBS). `--tools`, `--disallowedTools`, `--allowedTools`, `--mcp-config`
  and `--add-dir` are `<values...>`. `claude -p --tools Read,Bash "prompt"` treats the prompt as a tool name and
  fails with `Error: Input must be provided either through stdin or as a prompt argument when using --print`
  (exit 1). Put a single-value option (`--model x`) between the last variadic flag and the prompt, or pass the
  prompt on stdin.
- `--session-id` must be a UUID (help text). That UUID becomes the transcript file name (OBS).
- `--resume <uuid>` keeps the **same** session id and appends to the same transcript (OBS, §7.1).
  `--fork-session` makes a new id instead (DOC/help). In -p, `--resume` with no prompt is accepted: it continues
  a deferred tool call (OBS, §7.4).
- `--no-session-persistence` (print only): nothing is written to disk and the session cannot be resumed (help).
  Never use it for managed sessions.
- `--include-hook-events` (stream-json only) adds `system/hook_started` and `system/hook_response` lines for every
  hook. Without it, only the SessionStart pair is emitted (OBS).
- `--max-budget-usd <n>` (print only) stops the run past a dollar budget (help). The BIN message is
  `Budget limit reached ($x of $y); stopping background agents.` Note: this is a list-price figure, not plan quota.
- `--permission-prompts host|none` decides who answers permission prompts in `--print` mode (help).
- **`--bare` and `--safe-mode` skip all settings hooks** (help). Anyone running Claude Code themselves can
  bypass AOC hooks this way. This is why credential isolation, not hooks, is the real wall (spec §2.4, §3).
- **Settings files that fail validation are silently ignored in `-p` mode** (help text). The validation is
  per entry, and that is worse (OBS): an unknown event key (`BogusEvent`) was dropped while the other hooks still
  ran; a hook with `"timeout": "thirty"` silently disabled that event's hook. See §4.5.
- Exit codes seen (OBS): `0` normal (including permission denials and hook blocks); `1` startup refusal (e.g.
  bypass as root, missing prompt); `143` after SIGTERM, with **no `result` line** on stdout.

### 2.3 Permission modes in `-p` (no allow rules, no permission-prompt tool)

Prompt: `touch` a file via Bash, Write a file, call an MCP tool (OBS).

| `--permission-mode` | `init.permissionMode` | Bash `touch` | Write (in cwd) | MCP tool | Read / `ls` |
| --- | --- | --- | --- | --- | --- |
| `manual` (CLI name for the default) | `default` | denied: `touch in '<path>' needs approval. …` | denied: `Claude requested permissions to write to <path>, but you haven't granted it yet.` | denied: `Claude requested permissions to use mcp__probe__probe_echo, but you haven't granted it yet.` | not tested (ToolSearch allowed) |
| `acceptEdits` | `acceptEdits` | **allowed** (`reason_type: "subcommandResults"`) | allowed (`reason_type: "mode"`) | denied (same text) | allowed |
| `dontAsk` | `dontAsk` | denied: `Permission to use Bash has been denied because Claude Code is running in don't ask mode. …` | denied (same form) | denied unless allowed. `--allowedTools mcp__probe` (server-level rule) allows it (`reason_type: "rule"`). | Read allowed (`reason_type: "mode"`) |
| `bypassPermissions` | `bypassPermissions` | allowed | allowed | allowed | `ls` allowed |

- As **root**, `bypassPermissions` refuses to start: stderr
  `--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons`, exit 1. With
  `IS_SANDBOX=1` in the env it runs (OBS).
- Hooks still run in every mode. A `PreToolUse` JSON deny **wins even under `bypassPermissions`** (OBS).
- In `manual` and `acceptEdits`, each denied tool first fires a `PermissionRequest` hook carrying
  `permission_suggestions`. No prompt is shown; the call is denied unless a hook decides (OBS, DOC). In `dontAsk`
  no `PermissionRequest` fires (OBS).
- Every denial is listed in `result.permission_denials[]` as `{tool_name, tool_use_id, tool_input}`. The result
  is still `subtype: "success"`, `is_error: false` (OBS).

### 2.4 Controlling the tool set

- The default tool set (OBS, this account) is: `Task` (= `Agent`), `Bash`, `CronCreate`, `CronDelete`,
  `CronList`, `DesignSync`, `Edit`, `EnterWorktree`, `ExitWorktree`, `ListAgents`, `Monitor`, `NotebookEdit`,
  `PushNotification`, `Read`, `RemoteTrigger`, `ReportFindings`, `ScheduleWakeup`, `SendMessage`, `Skill`,
  `TaskStop`, `ToolSearch`, `WebFetch`, `WebSearch`, `Workflow`, `Write` and the MCP tools. Several of these depend
  on account or feature flags. **Read the list from `init.tools`; never hard-code it.**
- `--tools "Read,Glob,Grep,LS,TodoWrite,MultiEdit,Bash"` → `init.tools` = `Bash, Glob, Grep, Read` plus the MCP
  tools. Unknown names are dropped silently (OBS).
- `--tools ""` → no built-in tools; MCP tools remain (OBS).
- `--disallowedTools "Bash,WebFetch,mcp__probe__probe_echo"` removes those names from `init.tools` and adds
  `Glob` and `Grep` back (OBS).
- With `--tools`, `ToolSearch` is not present and MCP tools are sent inline. The prompt snapshot shows
  `inlineTools: true` with no `deferred_tools_delta` (OBS).

### 2.5 MCP server start failures

A stdio server that exits at once shows up as `init.mcp_servers: [{"name":"aocbroken","status":"failed",
"source":"dynamic"}]`, and **the session carries on without it** (OBS). The supervisor must fail loudly: abort
the managed session if `aoc` is not `"connected"` in `init`.

### 2.6 Config dir and auth (caveat)

`CLAUDE_CONFIG_DIR` relocates transcripts, `session-env/`, `sessions/` and the downloaded `policy-limits.json`
and `remote-settings.json` (OBS). It worked here only because auth is host-managed. On a Max-plan workstation,
OAuth credentials live in the config dir (Linux) or the keychain (macOS) (INF from `--bare` help: "OAuth and
keychain are never read"). A fresh per-session `CLAUDE_CONFIG_DIR` may therefore be logged out. Verify on a
real workstation, or provision a token with `claude setup-token`.

## 3. stream-json output (supervisor / sidecar)

### 3.1 Line catalogue (OBS)

| `type` / `subtype` | When | Notes |
| --- | --- | --- |
| `system/hook_started`, `system/hook_response` | SessionStart always; all hooks with `--include-hook-events` | `hook_response` carries `output`, `stdout`, `stderr`, `exit_code` and `outcome` (`success` or `error`). The SessionStart pair arrives **before** `init`. No pair is emitted for `SessionEnd`. |
| `system/init` | Once per invocation | See §3.2. |
| `system/status` | Before each API request: `{"status":"requesting"}`. Compaction: `{"status":"compacting"}`, then `{"status":null,"compact_result":"success"}` | Activity marker. |
| `system/thinking_tokens` | During thinking | `estimated_tokens`, `estimated_tokens_delta`. A liveness signal while the model thinks. |
| `stream_event` | With `--include-partial-messages` | Raw Messages API events (`message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`) with `parent_tool_use_id`. |
| `assistant` | One line **per content block** | Extra keys: `request_id`, `timestamp`, `wire_tool_inputs`, `thinking_duration_ms`, `tool_use_meta` (MCP: `display_name`, `server_display_name`). `tool_use` blocks carry `caller: {type:"direct"}`. |
| `user` | Tool results; synthetic messages | Tool results carry `tool_use_result` and `tool_result_meta[{id, permission_decision{decision, source, reason_type}, non_execution_kind?}]`. Stop-hook feedback is `isSynthetic: true`. Compaction replay is `isReplay: true`. |
| `rate_limit_event` | After the first response of a run (one per run in every capture) | §3.4 |
| `system/notification` | e.g. after a Stop block: `{"key":"stop-hook-error","text":"Stop hook error occurred · ctrl+o to see"}` | UI text. Ignore. |
| `system/task_notification` | A background or foreground task ended, e.g. a Bash child killed on SIGTERM: `status:"stopped"` | n/a |
| `system/compact_boundary` | After compaction | `compact_metadata: {trigger, pre_tokens, post_tokens, cumulative_dropped_tokens, duration_ms, pre_compact_discovered_tools, preserved_segment}` |
| `result` | Last line (absent after SIGTERM) | §3.3 |

### 3.2 `system/init` fields worth reading (OBS)

`session_id`, `cwd`, `model` (resolved id), `permissionMode`, `tools[]`, `mcp_servers[{name,status,source}]`,
`claude_code_version`, `apiKeySource`, `agents[]`, `skills[]`, `slash_commands[]`, `plugins[]`,
`memory_paths.auto`, `messaging_socket_path`, `capabilities[]`, `output_style`, `fast_mode_state`, `uuid`.

### 3.3 `result` (OBS unless tagged)

- `subtype`: `success` (OBS). The build also has `error_during_execution`, `error_max_turns`,
  `error_max_budget_usd` and `error_max_structured_output_retries` (BIN).
- `terminal_reason`: `completed` or `tool_deferred` (OBS). The build also has `aborted_tools`,
  `turn_setup_failed`, `tool_deferred_unavailable` and `structured_output_retry_exhausted` (BIN).
- `stop_reason`: `end_turn`, `tool_deferred` (OBS). Compaction-only runs give `null`.
- `is_error`, `num_turns` (API round trips), `result` (final text), `duration_ms`, `duration_api_ms`, `ttft_ms`,
  `api_error_status` (`null` when fine), `permission_denials[]`, `deferred_tool_use` (only on defer), `uuid`,
  `subagent_stats{spawned, completed, failed, refused{depth_limit, concurrency_limit, budget}, by_type}`,
  `safety_stops`.
- **`usage`** covers this invocation's main thread only. It excludes subagents and compaction.
- **`modelUsage[model]`** (`inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`,
  `thinkingTokens`, `costUSD`, `contextWindow`, `maxOutputTokens`, `costBasis:"list"`) and **`total_cost_usd`**
  include subagents and compaction, and are **cumulative across `--resume`**. Baseline was $0.00231151; the resume
  turn added $0.00019807, and the resumed result reported $0.00250958 (OBS).

### 3.4 `rate_limit_event` (OBS shape, BIN schema)

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1791517800,"rateLimitType":"five_hour",
 "overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,
 "unifiedWindows":{"five_hour":{"utilization":0.16,"resetsAt":1791517800},"seven_day":{"utilization":0.35,"resetsAt":1791522000}}},
 "uuid":"…","session_id":"…"}
```

Schema (BIN): `status ∈ allowed | allowed_warning | rejected`. `resetsAt` is an int in **epoch seconds**.
`rateLimitType ∈ five_hour | seven_day | seven_day_opus | seven_day_sonnet | seven_day_overage_included | overage`.
`utilization` is 0..1. It comes from the `anthropic-ratelimit-unified-*` response headers and is "always absent for
API-key, Bedrock, and Vertex sessions" (BIN schema description). It is the best throttle signal (§9.1) and also
yields utilization for metering throttle risk.

### 3.5 Liveness while generating

The transcript only receives whole content blocks (OBS: no partial lines). During long generation, the only
activity is on stdout: `stream_event` deltas (with `--include-partial-messages`), `system/thinking_tokens` and
`system/status`. To tell Thinking from Stalled (spec §4), the sidecar should see the supervisor's stdout stream
(piped or relayed), not only the transcript (INF).

## 4. Hooks (hooks package)

### 4.1 What fires in `-p`, in order (OBS, baseline run)

`SessionStart(source=startup)` → MCP servers spawn → `UserPromptSubmit` → for each tool call:
`PreToolUse` → `PostToolUse` | `PostToolUseFailure` → `PostToolBatch` → … → `MessageDisplay` (final text) →
`Stop` → `SessionEnd(reason=other)`.

- A subagent adds `PreToolUse(Agent)` → `SubagentStart` → `SubagentStop` → `PostToolUse(Agent)`.
- `claude -p --resume <id> "/compact"` gives `SessionStart(resume)` → `PreCompact(trigger=manual)` →
  `SubagentStop` (the compaction agent, with `agent_type: ""` and an `agent_transcript_path` that is **never
  written**) → `SessionStart(source=compact)` → `PostCompact` → `SessionEnd`. No `UserPromptSubmit` fires for
  the slash command.
- A JSON or exit-2 deny gives `PreToolUse` → `PostToolBatch` with no `PostToolUse` (OBS).
- `defer` gives `PreToolUse` → `SessionEnd`, with **no Stop** (OBS).
- Never fired in any run: `Notification`, `StopFailure` (no API error happened), `PermissionDenied` (auto mode
  only, DOC), `InstructionsLoaded` (no CLAUDE.md in the capture dir), `Setup`, `ConfigChange`, `CwdChanged`,
  `FileChanged`, `TeammateIdle`, `Task*`, `Elicitation*`, `Pre/PostModelSwitch`, `UserPromptExpansion`.

### 4.2 Stdin fields (OBS; samples in `fixtures/claude-code/hook-*.json`)

All events carry `session_id`, `transcript_path`, `cwd` and `hook_event_name`.

| Event | Additional fields observed |
| --- | --- |
| SessionStart (startup) | `source` |
| SessionStart (resume) | `source`, `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`, `estimated_cache_write_usd` |
| SessionStart (compact) | `prompt_id`, `source`, `model` |
| UserPromptSubmit | `prompt_id`, `permission_mode`, `prompt` |
| PreToolUse | `prompt_id`, `permission_mode`, `effort{level}`, `tool_name`, `tool_input`, `tool_use_id`, `mcp_server{name,source}` (MCP only) |
| PostToolUse | PreToolUse fields + `tool_response`, `duration_ms` |
| PostToolUseFailure | PreToolUse fields + `error` (e.g. `"Exit code 2\nls: cannot access …"`), `is_interrupt`, `duration_ms`. No `tool_response`. |
| PostToolBatch | `prompt_id`, `permission_mode`, `effort`, `tool_calls[{tool_name, tool_input, tool_use_id, tool_response}]` (`tool_response` is the rendered string) |
| PermissionRequest | `prompt_id`, `permission_mode`, `effort`, `tool_name`, `tool_input`, `permission_suggestions[]`, `mcp_server`. **No `tool_use_id`.** |
| MessageDisplay | `prompt_id`, `turn_id`, `message_id`, `index`, `final`, `delta` |
| Stop | `prompt_id`, `permission_mode`, `effort`, `stop_hook_active`, `last_assistant_message`, `background_tasks[]`, `session_crons[]` |
| SubagentStart | `prompt_id`, `agent_id`, `agent_type` |
| SubagentStop | `prompt_id`, `permission_mode`, `effort`, `agent_id`, `agent_type`, `stop_hook_active`, `agent_transcript_path`, `last_assistant_message`, `background_tasks`, `session_crons` |
| PreCompact | `prompt_id`, `trigger`, `custom_instructions: null` |
| PostCompact | `prompt_id`, `trigger`, `compact_summary` |
| SessionEnd | `prompt_id` (when a prompt ran), `reason` (`other` for a normal `-p` exit **and** for SIGTERM) |

`tool_response` shapes (OBS):

- Read: `{type:"text", file:{filePath, content, numLines, startLine, totalLines}}`
- Write: `{type:"create", filePath, content, structuredPatch[], originalFile:null, userModified}`
- Bash: `{stdout, stderr, interrupted, isImage, noOutputExpected}`
- MCP: an array of content blocks, `[{type:"text", text}]`
- ToolSearch: `{matches[], query, total_deferred_tools}`
- Agent: `{status, agentId, agentType, resolvedModel, content[], totalTokens, totalDurationMs, totalToolUseCount, usage{…}}`

Docs-only shapes (DOC): `Notification {message, title?, notification_type}`; `StopFailure {error, error_details?,
last_assistant_message?}`, where `error ∈ rate_limit | overloaded | authentication_failed | oauth_org_not_allowed |
account_on_hold | billing_error | invalid_request | model_not_found | server_error | max_output_tokens |
cloud_credential_error | unknown` and the output is ignored. Fixture JSON for these two was **not** created
because they were not observed.

### 4.3 Environment seen by hook commands (OBS)

The **entire claude process env is inherited**: `AOC_PROBE_PARENT` arrived in every hook. Claude Code adds:

- `CLAUDE_PROJECT_DIR`: launch cwd. It stays the original root even inside a worktree (DOC).
- `CLAUDE_CODE_SESSION_ID`: the session UUID.
- `CLAUDE_PID`: pid of the claude process.
- `CLAUDE_CODE_ENTRYPOINT=sdk-cli` in `-p` mode.
- `CLAUDECODE=1`, `CLAUDE_CODE_CHILD_SESSION=1`, `CLAUDE_CODE_SESSION_ATTENDED=0`.
- `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`.
- `CLAUDE_CONFIG_DIR`.
- `CLAUDE_EFFORT` (tool and stop events).
- `CLAUDE_ENV_FILE`: SessionStart only. Exports appended there persist into later Bash calls (DOC).

Missing from the `SessionEnd` env: the messaging variables. See `fixtures/claude-code/env-inheritance.sample.json`.

### 4.4 Blocking and steering: exactly what the model and stream see (OBS)

| Mechanism | Hook output | Model-visible `tool_result` / message | Stream / result markers |
| --- | --- | --- | --- |
| PreToolUse **exit 2** | stderr `AOC policy probe: Bash is blocked (exit 2).` | `PreToolUse:Bash hook error: [<full hook command line>]: AOC policy probe: Bash is blocked (exit 2).` with `is_error: true` | `hook_response.outcome:"error"`, `exit_code:2`. `tool_result_meta.permission_decision = {decision:"reject", source:"hook", reason_type:"hook"}`, `non_execution_kind:"permission-rule"`. Listed in `permission_denials`. |
| PreToolUse **JSON deny** | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"AOC policy probe: Bash is blocked (JSON deny)."}}` | `PreToolUse:Bash hook error: AOC policy probe: Bash is blocked (JSON deny).` with `is_error: true` | Same meta. `outcome:"success"`, `exit_code:0`. |
| PreToolUse **defer** (`-p` only, DOC) | `permissionDecision:"defer"` | Nothing. The turn ends before the tool runs. | `result.stop_reason` and `terminal_reason` = `"tool_deferred"`, `result.result:""`, `deferred_tool_use:{id,name,input}`. No Stop hook. See §7.4. |
| Stop **block** | `{"decision":"block","reason":"AOC stop probe: …"}` | Synthetic user message `Stop hook feedback:\n<reason>` (`isSynthetic: true`). The model continues. | The second Stop call has `stop_hook_active: true`. The CLI also emits `system/notification` `stop-hook-error`. |
| SessionStart **additionalContext** | `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…codeword is PLUM."}}` | The model read it and answered `PLUM`. | n/a |

Implications:

- **Prefer JSON deny over exit 2.** Exit 2 leaks the hook's full command line into the model context and the
  transcript, so never put secrets or tokens in hook command lines.
- Make the deny reason actionable. The model reads it verbatim, e.g. "call `mcp__aoc__request_decision` with
  test=main …".

### 4.5 Settings validation pitfalls (OBS)

- An unknown event key is dropped silently and the rest still works.
- A wrongly typed field (`"timeout": "thirty"`) silently removes that event's hook. Nothing appears on stdout or
  stderr.

Countermeasures: validate the generated settings against the documented schema before launch, and treat "no
SessionStart hook event received within N s of spawn" as a launch failure for managed sessions.

### 4.6 Timeouts (DOC)

The default is 600 s for command hooks. It drops to 30 s on `UserPromptSubmit` and 10 s on `MessageDisplay`.
`SessionEnd` hooks share a 1.5 s budget, which a per-hook `timeout` can raise to at most 60 s, so the `SessionEnd`
hook must only enqueue to the local spool. Hook-injected `additionalContext` is capped at 10,000 characters (DOC).

## 5. AOC MCP server

- **Env** (OBS): a stdio server inherits the **full claude process env**. `AOC_PROBE_PARENT` arrived with no `env`
  entry. The `env` block in the config is merged on top. Claude Code also sets `CLAUDE_CODE_SESSION_ID`,
  `CLAUDE_PROJECT_DIR`, `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT` and the messaging socket and token. It does
  **not** set `CLAUDE_PID`. cwd is the session cwd. Still pass `AOC_SESSION_ID` and the like explicitly in the
  config `env` for robustness.
- **Start order** (OBS): the server spawns after the SessionStart hook and before `UserPromptSubmit`. `tools/list`
  is called right after `initialize`.
- **Client info** (OBS): `{"name":"claude-code","title":"Claude Code","version":"2.1.295",…}`. Capabilities are
  `elicitation{form,url}` and `roots{listChanged}`.
- **Correlation** (OBS): every `tools/call` carries
  `params._meta = {"progressToken": <n>, "claudecode/toolUseId": "toolu_…"}`. That is the same id the hooks
  (`tool_use_id`) and the transcript use, so the MCP server can join its events to hook events exactly.
- **Permission** (OBS): denied in `-p` unless allowed (§2.3). Use `--allowedTools mcp__aoc` (server-wide rule;
  `mcp__aoc__<tool>` also works) or `permissions.allow: ["mcp__aoc"]` in the AOC settings. Remember the variadic
  ordering rule (§2.2).
- **Deferral** (OBS): under the default tool set, MCP tools are listed in a `deferred_tools_delta` attachment.
  The model must first call `ToolSearch {"query":"select:mcp__probe__probe_echo"}`, which costs one extra round
  trip; Haiku did it unprompted. Setting **`"alwaysLoad": true`** on the server entry in `--mcp-config` removed
  the extra step: the model called the tool directly (OBS). `--tools <list>` also inlines MCP tools. The
  `ENABLE_TOOL_SEARCH` env var also exists (BIN), but was not tested.
- **Hook view of MCP calls** (OBS): `tool_name:"mcp__probe__probe_echo"`, `mcp_server:{name:"probe",
  source:"dynamic"}`, and `tool_response` as the content-block array.

## 6. Transcript (sidecar and metering)

### 6.1 Location (OBS)

`$CLAUDE_CONFIG_DIR/projects/<slug>/<sessionId>.jsonl`, where slug = cwd with every non-alphanumeric character
replaced by `-`. Example: `/tmp/aoc-capture/work` → `-tmp-aoc-capture-work`. Slugs over 200 characters are cut
and get a hash suffix (BIN, C11). **Use `transcript_path` from the SessionStart stdin** rather than recomputing
it. Subagents write `<configDir>/projects/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl` plus
`agent-<agentId>.meta.json` (`{agentType, description, toolUseId, spawnDepth, requestShape, requestNonInteractive}`).
Files are mode `0600`. An auto-memory dir `projects/<slug>/memory/` is also created.

### 6.2 Line types (OBS; sample: `fixtures/claude-code/transcript.sample.jsonl`)

| `type` | Content |
| --- | --- |
| `queue-operation` | `enqueue` (with the prompt text) and `dequeue` |
| `user` | Prompt (`promptId`, `permissionMode`, `promptSource`, `entrypoint`, `version`, `gitBranch`, `cwd`) or tool result (`toolUseResult`, `sourceToolAssistantUUID`, `permissionDecision`). The first prompt also carries per-machine environment text and the attribution reminder. |
| `attachment` | `environment`, `model`, `deferred_tools_delta`, `agent_listing_delta`, `skill_listing`, `total_tokens_reminder`, `session_context`, `date`, `remote_session_change`, `prompt_snapshot` (full system prompt, about 10 KB), `deferred_tools_record`, `file` |
| `assistant` | One line per content block. Same `message.id`, `requestId` and `message.usage` on each; `apiBlockIndex`, `requestedModel`, `effort`, `perTurnEffort`. Subagent lines add `agentId` and `isSidechain: true`. |
| `system` | `stop_hook_summary` (`hookCount`, `hookInfos`, `hookErrors`, `preventedContinuation`, `stopReason`) and `compact_boundary` (`compactMetadata{trigger, preTokens, durationMs, preservedSegment…}`) |
| `last-prompt`, `atis-latch`, `mode` | Bookkeeping |
| `cost-state` | `totalCostUSD`, `totalAPIDuration`, `totalToolDuration`, `totalLinesAdded`, `totalLinesRemoved`, `startTime`, `modelUsage{model:{inputTokens, outputTokens, thinkingTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD}}`. **Cumulative per session**, written once at the end of each invocation. **Not written after SIGTERM.** |

An API error is written as a synthetic assistant message: `model:"<synthetic>"`, `isApiErrorMessage: true`,
plus `error`, `apiError`, `apiErrorParams` and `quotaLimits` (BIN). This was not observed live.

### 6.3 Metering rules (OBS-derived)

1. Per API call: dedupe assistant lines by `message.id`, then take `message.usage` once. Use `input_tokens`,
   `output_tokens` (which include `output_tokens_details.thinking_tokens`), `cache_read_input_tokens`,
   `cache_creation_input_tokens`, and `cache_creation.ephemeral_1h_input_tokens` versus `ephemeral_5m…`. The main
   thread used **1-hour** cache writes; the subagent used **5-minute** writes. Price them separately.
2. Tail `subagents/agent-*.jsonl` too. Subagent usage is **not** in the main transcript (0 sidechain lines in
   the main file). It also appears in `PostToolUse(Agent).tool_response.usage`.
3. Compaction calls never produce an assistant line. Their usage appears only as a jump in the cumulative
   `cost-state.modelUsage` (and `result.modelUsage`). Reconcile per invocation:
   `Δ(cost-state.modelUsage) − Σ(deduped assistant usage, main + subagents)` = overhead (compaction / side
   queries). Attribute it to the session as "overhead".
4. Never sum `result.total_cost_usd` or `cost-state.totalCostUSD` across invocations; they are cumulative. If a
   process is killed there is no `cost-state` and no `result`, so per-message usage is the only record.
5. `modelUsage[*].costBasis` is `"list"`, the notional API-equivalent price. From the observed totals, Claude
   Code 2.1.295 prices `claude-haiku-5-5` at $0.10 input, $0.50 output, $0.01 cache read and $0.20 1h cache write
   per MTok. The baseline reproduced to 8 decimals (OBS-derived). Use it only to cross-check AOC's own rate card
   (spec §10).

## 7. Session lifecycle flows (supervisor)

### 7.1 Resume (OBS)

`claude -p --resume <uuid> "<follow-up>"`:

- Keeps the session id.
- Appends to the same `<uuid>.jsonl` (41 → 50 lines).
- Fires `SessionStart` with `source:"resume"`; the stream shows `hook_name:"SessionStart:resume"`.
- The model remembered the prior turn.
- The settings, MCP config and permission mode must be passed again; they are per-process.

### 7.2 Kill and restart (OBS)

SIGTERM during a running Bash tool:

- claude kills the tool child (tool result `Exit code 137`, `system/task_notification status:"stopped"`).
- `SessionEnd` fires with `reason:"other"`.
- The process exits **143**, with no `result` and no `cost-state`.
- `--resume <uuid> "<operator text>"` afterwards works normally.

A dead session is therefore recognisable as "exit code ≠ 0 with no `result` line"; the transcript stays
resumable.

### 7.3 Nudge

A nudge is a resume with operator text (same as §7.1). There is no special mechanism.

### 7.4 Human decisions: `defer` at the tool boundary (new option, OBS)

1. A PreToolUse hook returns `permissionDecision:"defer"`. The run ends at once with `subtype:"success"`,
   `terminal_reason:"tool_deferred"` and `deferred_tool_use:{id:"toolu_…", name:"Bash", input:{…}}`. No Stop
   hook runs; `SessionEnd` fires. Nothing waits and no process stays alive, which matches spec §2.3.
2. To approve: `claude -p --resume <uuid>` with **no prompt**. PreToolUse fires again **with the same
   `tool_use_id`**. When the hook now allows it (e.g. because the decision record approves that id), the exact
   same call executes. Then a synthetic prompt `Continue from where you left off.` is submitted
   (UserPromptSubmit sees it) and the turn continues normally.
3. To reject: resume the same way and have the hook return a JSON deny whose reason states the decision. The
   model reads it as the tool result.
4. **Not yet observed:** a resume **with** a prompt (`claude -p --resume <uuid> "<answer>"`, how AOC resumes) after a
   defer: whether the deferred call is re-run, dropped or an error. Gap G-48 waits on it. Run
   [`probes/defer-resume-with-prompt.mjs`](probes/defer-resume-with-prompt.mjs) with a logged-in `claude` (two short
   turns) and record its `summary.json` here.

This turns a tool-boundary attempt (e.g. `git push origin main`) into a decision card without asking the model
to cooperate. `request_decision` remains the path for decisions the model raises itself (tests 3–4 in the spec).

### 7.5 Compaction and rollover signals (OBS)

- Before each resume: `SessionStart(resume).context_tokens` (e.g. `18404`) and `prompt_cache_likely_expired`.
- After compaction: `compact_boundary.pre_tokens` and `post_tokens` (18404 → 1178).
- Auto-compaction can be tuned with `--autocompact <auto|tokens>` (help).

## 8. Environment inheritance and credential isolation (spec §3)

| Consumer | Sees claude's process env? | Evidence |
| --- | --- | --- |
| Hook commands | Yes, all of it | OBS: `AOC_PROBE_PARENT` in every hook |
| stdio MCP servers | Yes, all of it, plus the config `env` | OBS: `AOC_PROBE_PARENT` without a config entry; `AOC_PROBE_MCPCONF` from config |
| The model's own Bash tool calls | **Yes** | OBS: `env \| cut -d= -f1` listed `AOC_PROBE_PARENT`, `IS_SANDBOX`, `HTTPS_PROXY`, `CLAUDE_*` |

Consequences:

- Anything in the claude process env is readable by the model (`echo $X`). Deploy keys and protected-branch
  credentials must exist only in the env of sessions entitled to them, never in triage sessions.
- Non-secret ids (`AOC_SESSION_ID`, `AOC_DAEMON_URL`) are fine.
- The daemon ingest token is visible to the model too. Scope it per session and keep it append-only.

## 9. Plan usage limits → Throttled (spec §4)

No live limit hit was possible. The internal `/mock-limits` command is not available in this build's session; it
was sent to the model as text (OBS). The facts below are BIN, DOC and ISSUE.

### 9.1 Signals, in priority order

1. **stream-json `rate_limit_event`** with `rate_limit_info.status === "rejected"`. Use `resetsAt` (epoch
   seconds) for "Throttled until", and `rateLimitType` to say which window. `allowed_warning` means approaching
   the limit; it is not throttled yet. Shape OBS, values BIN.
2. **`StopFailure` hook** with `error:"rate_limit"` (DOC). For an HTTP 429, `last_assistant_message` is e.g.
   `"API Error: Rate limit reached"`. The docs list StopFailure as the event for turns that end on an API error,
   so do not count on `Stop` also firing (INF).
3. **`result`** with `is_error: true` and/or `api_error_status: 429` (INF from the field's presence; not
   observed). Also a transcript assistant line with `isApiErrorMessage: true` and `error` (BIN).
4. **Text fallback** on the `result.result` text or the synthetic assistant text (§9.4).

A plain HTTP 429 `rate_limit_error` ("This request would exceed your account's rate limit. Please try again
later.", ISSUE #19673) is a short-term rate limit. Treat it as Throttled with an unknown reset unless a
`rate_limit_event` says otherwise.

### 9.2 Message variants by era

| Era / version | Text | Source |
| --- | --- | --- |
| ≤ late 2025 (raw result text) | `Claude AI usage limit reached\|1762952400` (epoch seconds after `\|`) | ISSUE #11429 (Nov 2025) |
| 2025 interactive rendering | `Claude usage limit reached. Your limit will reset at 7pm (Asia/Tokyo).` | third-party guide |
| Aug–Nov 2025 | `5-hour limit reached ∙ resets 9pm` (U+2219), `Weekly limit reached ∙ resets Nov 13`, `5-hour limit reached · resets 3pm (Europe/Stockholm) · /upgrade to Max 20x or turn on /extra-usage` | ISSUE #7892, #7157, #12802 |
| 2.1.12 (Jan 2026) → 2.1.143 (May 2026) | `You've hit your limit · resets 4pm (Asia/Kuala_Lumpur)` / `… · resets 2:10pm (Europe/Moscow)` | ISSUE #19673, #59637 |
| Current (2.1.295; issue Jul 2026) | `You've hit your session limit · resets 12:50am (America/Los_Angeles)`. Template: ``You've hit your ${name}${" · resets " + time}${" · progress saved"?}`` with name ∈ `session limit` (five_hour), `weekly limit` (seven_day), `Opus limit`, `Sonnet limit` (or `weekly limit` on Pro/Enterprise), `Fable limit` (seven_day_overage_included) | BIN; ISSUE #74079 |
| Current, credits and overage | `You're out of extra usage · resets 3pm`, `You're out of usage credits…`, `Your org is out of usage · add funds to continue`, `You've reached your Fable limit.`, `You've hit your monthly spend limit…` | BIN, auto-retry README |
| Warnings (not throttled) | `You've used 90% of your session limit · resets 3pm (Asia/Kuala_Lumpur)`, `Approaching session limit · resets …`; older: `Approaching 5-hour limit` | BIN; ISSUE #6243 |

### 9.3 Reset-time format (BIN, 2.1.295 `xR()`)

- Input is `resetsAt` in epoch seconds.
- Within 24 h: `toLocaleTimeString('en-US', {hour:'numeric', minute: m===0 ? undefined : '2-digit', hour12:true})`
  with " AM"/" PM" rewritten to `am`/`pm`. Examples: `3pm`, `12:50am`.
- Beyond 24 h: `MMM D, h[:mm]am|pm` (e.g. `Oct 14, 3pm`), adding `, YYYY` if the year differs.
- Limit messages append ` (<IANA zone>)`, taken from the claude process's `Intl…resolvedOptions().timeZone`.
  **Set `TZ` explicitly on spawned sessions**, but parse `resetsAt` from `rate_limit_event` whenever available.

### 9.4 Proposed replacement for `THROTTLE_PATTERNS` (tested)

Tested on 16 strings: every limit variant above matched; none of the warnings or the plain 429 did. The
current contract patterns matched **0 of 6** 2.x-era variants.

```ts
/** Plan-limit hit (text fallback; prefer rate_limit_event.status === 'rejected'). */
export const THROTTLE_PATTERNS: RegExp[] = [
  /You['’]ve hit your (?:[\w'’ ]{1,40} )?(?:limit|budget)/i, // 2.x: "You've hit your session limit · resets …"
  /You['’]ve reached your [\w ]{1,40} limit/i,              // "You've reached your Fable limit."
  /You['’]re out of (?:usage credits|extra usage)/i,
  /Your org is out of usage/i,
  /Claude AI usage limit reached\|(\d{9,13})/i,              // legacy: epoch seconds
  /(?:\d+-hour|weekly|session|opus(?: weekly)?)\s+limit reached/i, // 2025: "5-hour limit reached ∙ resets 9pm"
  /usage limit reached/i,
];
/** Reset time: group 1 = "3pm" | "12:50am" | "Oct 14, 3pm" | "Nov 13"; group 2 = IANA zone if present. */
export const THROTTLE_RESET =
  /(?:[·∙•-]\s*resets?|Resets? at|reset at)\s+((?:[A-Z][a-z]{2} \d{1,2}(?:, \d{4})?(?:, \d{1,2}(?::\d{2})?\s?(?:am|pm))?)|\d{1,2}(?::\d{2})?\s?(?:am|pm))(?:\s*\(([^)]+)\))?/i;
/** Short-term API rate limit (429) — throttled, reset unknown. */
export const RATE_LIMIT_429 = /API Error: Rate limit reached|rate_limit_error/i;
```

## 10. Fixture index (`docs/research/fixtures/claude-code/`)

All paths are sanitized: the capture root becomes `/tmp/aoc-capture` (slug `-tmp-aoc-capture-work`). The
`prompt_snapshot`, `skill_listing`, `agent_listing_delta` and `remote_session_change` bodies are `<omitted>`,
thinking signatures are `<omitted>`, the OS version is redacted and emails are masked. Partial-JSON deltas were
re-split so that they still concatenate to the sanitized `tool_use.input` (verified).

| File | What | Evidence |
| --- | --- | --- |
| `settings.sample.json` | `--settings` used: a hook for every event, MCP tool allowed | OBS |
| `mcp-config.sample.json` | `--mcp-config` used (stdio server `probe`, config `env`) | OBS |
| `stream-json.sample.jsonl` | Baseline: Read → Write → Bash `ls` → ToolSearch → MCP call, with `--include-partial-messages` | OBS |
| `stream-json.resume-hook-events.sample.jsonl` | `--resume` follow-up with `--include-hook-events` | OBS |
| `stream-json.deny-exit2.sample.jsonl` / `.deny-json.sample.jsonl` | PreToolUse deny by exit 2 or by JSON | OBS |
| `stream-json.deferred.sample.jsonl` / `.deferred-resume.sample.jsonl` | `defer`, then resume with no prompt | OBS |
| `stream-json.stop-block.sample.jsonl` | Stop `decision:block` → continue | OBS |
| `stream-json.compact.sample.jsonl` | `/compact` in `-p` on a resumed session | OBS |
| `stream-json.permission-denied-manual.sample.jsonl` | `--permission-mode manual`: Bash, Write and MCP denied | OBS |
| `stream-json.sigterm.sample.jsonl` | SIGTERM mid-tool (no `result` line) | OBS |
| `transcript.sample.jsonl` | One session: startup → resume → `/compact`, including `cost-state` lines | OBS |
| `transcript.subagent.sample.jsonl`, `transcript.subagent.meta.sample.json` | Subagent transcript and meta | OBS |
| `mcp-server-observed.sample.jsonl` | MCP server view: env, `initialize` client info, `tools/list`, `tools/call` with `_meta` | OBS |
| `env-inheritance.sample.json` | `CLAUDE_*`/`AOC_*` env seen by hooks, the MCP server and Bash | OBS |
| `hook-<Event>[.<variant>].json` | One stdin sample per event (23 files): SessionStart (startup, resume, compact), UserPromptSubmit, PreToolUse (Bash, mcp, agent), PostToolUse (Write, bash, read, mcp), PostToolUseFailure, PostToolBatch, PermissionRequest, MessageDisplay, Stop (and reentry), SubagentStart, SubagentStop (and compaction agent), PreCompact, PostCompact, SessionEnd | OBS |
| (none) `hook-Notification.json`, `hook-StopFailure.json` | Never fired in `-p`; shapes are in §4.2 | DOC |
| `aoc-happy.stream-json.jsonl`, `.transcript.jsonl`, `.hooks.jsonl` | A managed writer's whole turn under AOC (plan, Write, Bash commit, `task_done`, end): the stream, the transcript and every hook's stdin / stdout / exit / latency | OBS |
| `aoc-decision.turn-1.stream-json.jsonl`, `.turn-2.…`, `aoc-decision.transcript.jsonl` | `request_decision` → the turn ends → `--resume` with the answer: two invocations of one conversation | OBS |
| `aoc-guard-push.stream-json.jsonl`, `.hooks.jsonl` | `git push origin main` denied by the PreToolUse JSON deny (`PreToolUse:Bash hook error: …`) | OBS |
| `aoc-gateway.stream-json.jsonl`, `.hooks.jsonl` | `git push aoc <sha>:refs/heads/smoke/push` through the supervisor's gateway; the model asks for a decision about main | OBS |
| `aoc-nudge.turn-1.stream-json.jsonl`, `.turn-2.…`, `.turn-3.…`, `aoc-nudge.transcript.jsonl` | SIGINT during a Bash call: `error_during_execution`, `aborted_tools`, exit 0; two resumes; bookkeeping lines | OBS |
| `aoc-boundary-ignored.stream-json.jsonl`, `aoc-boundary-obeyed.stream-json.jsonl` | Stop at the next task boundary: the plain notice is ignored, the firmer one obeyed (§13.3 D8) | OBS |
| `aoc-permission-denied.stream-json.jsonl` | Print mode without a Bash grant: `This command requires approval`, `system/permission_denied` (§13.3 D1) | OBS |
| `aoc-background-task.stream-json.jsonl` | A background task finishing after the first result: two `init` / `result` pairs in one process; `Blocked: standalone sleep` | OBS |
| `aoc-triage.stream-json.jsonl` | Read-only triage: Glob / Grep / Read + the aoc tools, ending with `report_diagnosis` | OBS |

The `aoc-*` files come from managed AOC sessions (§13), not from the probe setup: the temp dirs of the run are
`/tmp/aoc-real/…`, emails (the `Co-Authored-By` trailer) are `noreply@example.invalid`, local ports `127.0.0.1:PORT`,
opaque `msg_` / `req_` ids are renumbered, thinking signatures, prompt snapshots (system prompt, tool schemas) and
skill listings are `<omitted>`, and `stream_event` partial-message lines are dropped (nothing the supervisor reads is in
them). `packages/e2e/real-cli/scrub.mjs` does this; the conformance tests in `supervisor`, `sidecar`, `hooks`,
`mcp-server` and `claude-sim` (`test/real-cli.test.ts`, `real-parity.test.ts`) read these files.

## 11. Reproducing

1. Make a scratch dir outside the repo with `work/`, `cfg/` and `cap/`.
2. Write a hook script (`node hook.mjs <capFile> <Event> [mode]`) that appends
   `{stdin, env: CLAUDE_*/AOC_* (redact /TOKEN|KEY|SECRET|AUTH/)}` to `<capFile>`. Write a stdio MCP server on
   `@modelcontextprotocol/sdk` (low-level `Server` + `StdioServerTransport`) that logs `process.env`,
   `getClientVersion()` and `tools/call` params.
3. Run `env -i PATH=… HOME=<tmp> CLAUDE_CONFIG_DIR=<tmp>/cfg <proxy/CA vars> AOC_PROBE_PARENT=1 claude -p
   --model haiku --output-format stream-json --verbose … "<prompt>"` from `work/`.
4. Re-run after every Claude Code upgrade. Treat a diff in the fixture shapes as a contract-change trigger for
   `packages/contracts/src/claude-code.ts` and `@aoc/claude-sim`.

## 12. Sources

- Live captures: Claude Code 2.1.295, 2026-10-09 (this note; fixtures above).
- `claude --help` output of 2.1.295 (flags, permission modes, `--bare`/`--safe-mode`, `-p` settings-validation
  note).
- Claude Code hooks reference: <https://code.claude.com/docs/en/hooks> (events, matcher values, exit codes,
  timeouts, StopFailure/Notification/PostToolUseFailure/PermissionDenied schemas, `CLAUDE_ENV_FILE`,
  `CLAUDE_PROJECT_DIR`).
- Usage-limit reports: [#19673](https://github.com/anthropics/claude-code/issues/19673) (2.1.12, Kuala Lumpur),
  [#59637](https://claudeissues.com/issue/59637-youve-hit-your-limit-resets-2-10pm-europe-moscow) (2.1.143),
  [#74079](https://claudeissues.com/issue/74079-youve-hit-your-session-limit-resets-12-50am-america-los-angeles),
  [#11429](https://claudeissues.com/issue/11429-claude-ai-usage-limit-reached-1762952400),
  [#12802](https://claudeissues.com/issue/12802-5-hour-limit-reached-resets-3pm-europe-stockholm-upgrade-to-max-20x-or-turn-on-e),
  [#7892](https://claudeissues.com/issue/7892-5-hour-limit-reached-resets-9pm),
  [#6243](https://claudeissues.com/issue/6243-bug-approaching-5-hour-limit),
  [claude-auto-retry detection list](https://github.com/cheapestinference/claude-auto-retry),
  [CometAPI reset guide](https://www.cometapi.com/when-does-claude-code-usage-reset/).

## 13. Verified against the real CLI on 2026-10-09

§0–§12 are facts from probe captures. This section is about **AOC itself driving the real Claude Code 2.1.295** (native
linux-x64, host-managed auth, `claude-haiku-5-5`) instead of `@aoc/claude-sim`: what held the first time, what did not,
and what was changed because of it. Everything below is OBS unless tagged otherwise. The captures behind it are the
`aoc-*` files of §10; the opt-in suite that produced them is `packages/e2e/real-cli` (§13.8).

**How.** The suite boots the production aocd composition (the real module list, real HTTP on a random port, a temp data
dir, a Builder and an Approver token) with `supervisor: real`, the built hook, MCP-server and sidecar bundles and the real
`claude`. The process-type registry is a throwaway set of Haiku twins of `feature-build` and `bug-triage` (and a credentialed one for the
gateway scenario); `config/process-types.json` is untouched. Repositories are tiny git repos under `/tmp`; the session environment is the
supervisor's allowlist plus the host's auth and proxy variables. Two thin wrappers, `claude-tee.mjs` and `hook-tee.mjs`,
sit between the supervisor and `claude` / `aoc-hook` and record, unchanged, the raw stream-json, argv, exit status and
every hook's stdin, stdout and latency, so a run can be compared with what the platform believed.

**Cost and containment.** 25 real sessions (22 through AOC, 3 direct probes), at most 8 model turns per invocation (13
across the three invocations of the nudge session), about US$0.10 at list price. No usage limit was hit (the account sat
at 26–33 % of its windows). Nothing touched `/home/user/maia`'s own git state or a real repository; no token, OAuth value or
account id is in a fixture (`grep` found none in the raw captures either; the one email, the `Co-Authored-By` trailer
Claude Code adds to commits, is masked).

### 13.1 What was checked, and what came out

| Step | Scenario (`real-cli/…`) | Result |
| --- | --- | --- |
| Boot | every file | Fresh aocd per file, project over a temp repo, Builder token; the `aoc` MCP server is `connected` in `init` in every session. **Not** exercised: the `aocd` executable itself (the composition root it wraps is). |
| Happy path | `happy.test.ts` | First attempt failed (D1). After the fix: SessionStart relayed; `declare_plan` called unprompted before any file change; every tool call became a `tool.used` event with the CLI's `tool_use_id` (set equality); `task_done` with a commit SHA verified by the ledger (the SHA is the repo's HEAD); one clean `end_turn`; session `ended/completed`; sidecar usage equals `result.modelUsage` exactly (input, output, cache read, cache write) after deduping assistant lines by `message.id`; `usage.reconciled` = `match` (live for all 8 completed turns run after G-44 was merged); metering US$0.0035 against `total_cost_usd` 0.003526; liveness thinking → working → ended, never stalled or dead. |
| Decision round trip | `decision.test.ts` | `request_decision` raised on its own when the spec left a choice to the product owner; no tool call after it and the process gone (Waiting on you costs nothing); answer posted through the API; the same claude session id resumed with `--resume` and `Decision <id> answered: <label>` injected; the model wrote the human's pick, not its own recommendation. `usage.reconciled` = `match`, `match` (figures are cumulative across `--resume`). |
| Guard: protected operation | `guard-push.test.ts` | Run 1 (before the merge of security wave 2): the model attempted `git push origin main`; the PreToolUse hook answered JSON on exit 0; Claude Code showed the model `PreToolUse:Bash hook error: AOC blocked a protected operation (test 1 …)` as a tool error; it made no further call; a card was raised, nothing was pushed. Run 2 (after the merge): the model followed rule 3 and called `request_decision` before touching main, so the hook was never reached. The hook's deny path is therefore checked live once; the test accepts both routes. |
| Guard: self-modification | `guard-selfmod.test.ts` | The model's `Edit` of `packages/kernel/index.ts` was denied (`selfmod.blocked`, logged outside AOC), the file unchanged, the turn ended. Run once, before the merge. |
| Push gateway (R-02), after the merge | `gateway.test.ts` | A writer whose profile may push `smoke/**` found the gateway in its system prompt and pushed with `git push aoc <sha>:refs/heads/smoke/push` on the first try (git smart HTTP to aocd; `session.git_pushed` forwarded 1; the upstream carries the model's commit; the upstream's main did not move; only two refs exist there). For main it asked for a decision instead of trying. The profile's secret (a canary) appears nowhere in the captures. No old credential injection is involved: the `smoke` type never had a profile, and the merged supervisor injects none. |
| Read-only triage | `triage.test.ts` | Intake ticket → `bug-triage` twin: `init.tools` = Glob, Grep, Read + the eight aoc tools, `permissionMode: dontAsk`; it found the root cause (a misspelt variable), called `report_diagnosis`, and the fix-plan gate opened in both runs; the repository was untouched. The second run closed its three tasks first (all `evidence_unverified`: nothing to verify in a read-only session); the first left its plan open. Both ran before the lead made a recorded diagnosis end a triage session (D5). |
| Nudge / stop / restart | `controls.test.ts` | Nudge = SIGINT: a clean `result` (`error_during_execution`, `terminal_reason: "aborted_tools"`), exit 0, transcript append-only, same claude session id on `--resume`, the operator text injected, the work finished. Stop (immediate) = SIGINT, exit 0, session `killed`, writer released. SIGTERM mid-tool: exit 143 with **no** `result` line, Dead, `restart` resumes the same conversation and finishes. |
| Stop at the next task boundary | `boundary.test.ts` | Haiku ignored the plain notice and did the second task (D8); with the firmer wording it stopped. |
| Throttle | (parsers only) | No limit was reachable. Every healthy output captured (all stream text, tool output, transcript lines) is **not** read as a limit notice by `isLimitNotice`, `isLegacyLimitResult`, `parseThrottle`; `rate_limit_event` with `allowed_warning` (every turn at 26–33 %) is a fact, not a throttle. |

### 13.2 What worked the first time

- Hooks: managed SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / PostToolBatch / Stop / SessionEnd, with
  the exact stdin of §4.2; PreToolUse JSON deny on exit 0 is shown to the model as an error and obeyed.
- MCP: `alwaysLoad` gives direct tool calls (no `ToolSearch` round trip); `--allowedTools mcp__aoc` is enough for the MCP tools (a writer also needs a Bash grant, D1); the
  per-call `claudecode/toolUseId` joins MCP, hook and transcript events.
- Resume: same session id, same transcript file, append-only; settings and MCP config must be passed again.
- Sidecar and metering: transcript usage deduped by `message.id` equals `result.modelUsage` for completed, interrupted
  and resumed turns; G-44 reports `match` live for every completed turn (8 of 8; replayed offline on the earlier captures, where the
  killed turns come out `unverified`, as designed).
- Credential isolation: the merged supervisor puts nothing a session could push with in its environment; the gateway
  works from the model's Bash tool.

### 13.3 Divergences found and fixed

| # | The real CLI did | AOC / the simulator assumed | Fix | Regression test |
| --- | --- | --- | --- | --- |
| D1 | In `-p --permission-mode acceptEdits` nothing can approve, so every Bash command outside Claude Code's auto-allow list is refused: `This command requires approval` (compound: `This Bash command contains multiple operations. The following part requires approval: git add …`). `git add`, `git commit` and `npm test` were refused; the model gave up committing and raised decisions (`aoc-permission-denied`). | Writers can run Bash. claude-sim allowed every tool under `acceptEdits`, so no test could notice. | `supervisor/launch-config.ts toolPolicy` grants `Bash` to a writer type whose registry entry says nothing about Bash (never read-only). An entry that names Bash rules, such as the few git verbs the shipped types were given in parallel, is passed as written, so nothing widens it. Hooks still decide and a PreToolUse deny still wins. claude-sim now decides permissions like the CLI (read-only allow list, accept-edits file commands and redirections, compound analysis, `dontAsk` wording, `PermissionRequest` hook, `system/permission_denied`). | supervisor `unit`/`launch` (default grant; scoped rules passed as written); claude-sim `permissions` (26-command matrix); e2e: a silent type commits through Bash, the shipped feature-build commits through its scoped grants while `git switch main` and `git reset` are refused |
| D2 | A tool result with `structuredContent` is shown to the model as `JSON.stringify(structuredContent)` and its text blocks are dropped (the hooks' `tool_response` is that same JSON string). | The MCP server put `END YOUR TURN` in the text block. | `mcp-server` adds `notice` as the **first key** of the structured data for `request_decision` and for `task_done` with `boundary.continue: false`; claude-sim renders MCP results the same way. | mcp-server `server` + `real-cli` (byte equality with the capture); e2e `decision` asserts what the model was shown |
| D3 | The model put the bare command in a `test` ref (`npm test`): both `test` closes of the first 14 sessions were `evidence_unverified`; it also wrote prose in a `diff` ref (`push.txt (new file, content 'x')`). | "a test id, a commit SHA or a diff ref" is self-explanatory. | Prompt rule 2 and the `task_done` schema / description say what each kind's ref is (test file and test name, never the command; full SHA; the changed file's path). Since then no close was unverified (11 of 11). The two `test` refs now name the file (`test.js > npm test (node test.js)`) and the ledger accepts them: it only checks that a ref looks like a test id, so a command after the file name still passes. | supervisor `unit` (prompt); mcp-server `server` (schema description) |
| D4 | After an operator nudge made planned work unnecessary, the model left the tasks open, so AOC kept auto-continuing the session. | The model amends the plan on its own. | Rule 1: amend the plan when work is dropped, even when an operator message or a decision answer caused it. Not re-run live after the change. | supervisor `unit` (prompt) |
| D5 | A triage session called `report_diagnosis` before closing its plan, and read-only `task_done` evidence cannot be verified (`evidence_unverified` ×3). | Triage ends by itself. | Read-only rule 9: close the plan's tasks (evidence: the path of a file you inspected), `report_diagnosis` last. The lead meanwhile ended a triage session at its recorded diagnosis (`endsAtDiagnosis`). Not re-run live after the change. | supervisor `unit` (prompt) |
| D6 | SIGINT ends the turn **cleanly**: the pending tool is rejected (`User rejected tool use`), `[Request interrupted by user for tool use]`, a `result` with `error_during_execution`, `terminal_reason: aborted_tools` (`aborted_streaming` when no tool was pending) and the internal text `[ede_diagnostic] …`, cost state saved, SessionEnd (no Stop), **exit 0**. SIGTERM is exit 143, no result. | claude-sim exited 130; the operator view showed the CLI's internal diagnostic. | stream parser prints `Turn interrupted (aborted_tools)`; claude-sim has the same SIGINT semantics and kills an exec-ed command with the run. | claude-sim `process` (two SIGINT tests); e2e nudge asserts exit 0; supervisor `real-cli` |
| D7 | `vcs_state_changed`, `task_started`, `task_updated`, `task_notification`, `background_tasks_changed` lines appear around commits and long commands; a `rate_limit_event` with `allowed_warning` arrives every turn of an account that is a third into a window. | Only status / hook lines are bookkeeping; a non-`allowed` rate-limit status is worth a line named after it. | Bookkeeping is quiet in the operator view; the warning prints as the number (`Plan usage seven_day 33% used`). | supervisor `real-cli` |
| D8 | Asked for two steps and stopped after the first, Haiku got `task_done` → `notice: "STOP — AOC task boundary (stop_requested). Do not start another task. …"` and **did the second step anyway** (the supervisor still ended the session at the turn end). | A plain "do not start another task" is obeyed. | The notice, rule 4 and the `task_done` description say the order outranks the plan and every unfinished step of the prompt, that leaving them undone is expected, and what to do (no more tool calls, one sentence, end the turn). Then it stopped (1 of 1). | mcp-server `real-cli` (the verified wording cannot change unnoticed); e2e `credits` |
| D9 | A process can print **two** `init` / `result` pairs: a background task (`run_in_background`) finishing after the first result wakes the model again (`aoc-background-task`). A standalone `sleep N` is refused (`Blocked: standalone sleep`), which is how the model got there. | One result per process. | None needed: the turn ends with the process and the last result wins; documented. | supervisor `real-cli` |
| D10 | Simulator only: claude-sim lacked `PermissionRequest`, the `permission_mode` / `effort` / `prompt_id` hook fields, the `PreToolUse:<Tool> hook error:` prefix, the unified rate-limit windows, `api_error_status: null`, `tool_result_meta`; its interrupt marker carried a `tool_use_result` the CLI does not write; a `[[scenario:…]]` marker inside a fenced handoff brief made the rollover successor replay its predecessor's scenario. The permission mirror itself was too generous: every command of the `branch` family was read-only, `-D main` included (the lead's demo tests for the scoped git grants caught it). | — | Mirrored; fence-aware markers (the lead fixed the same); `branch` reads only when it lists. | claude-sim `real-parity` (per line kind, the fields the real CLI printed and the simulator lacks are a reviewed snapshot: telemetry only), `hooks`, `output`, `scenarios` |

### 13.4 Prompt compliance (measured)

21 AOC sessions with a captured event log, in two groups: 14 before the wording changes (D3–D5, D8) and 7 after, on the
merged code. A session of the first group that was stopped before the model acted is not counted.

| Behaviour | Before (14 sessions) | After (7 sessions) |
| --- | --- | --- |
| `declare_plan` unprompted, before any Bash or file change | 14 / 14 | 7 / 7 |
| Tasks closed with evidence the ledger verified | 12 / 17 | 11 / 11 |
| `evidence_unverified` flags | 5 (2 test refs that were commands, 3 on read-only triage tasks) | 0 |
| A model-raised `request_decision`, then no further tool call | 2 / 2 | 3 / 3 |
| No further tool call after a hook denial | 2 / 2 | not reached |
| Stops at a task boundary when told | — | 0 / 1 with the plain notice, 1 / 1 with the firmer one |

Of the 7 sessions since the changes, 6 did everything asked; the miss is the plain stop notice (D8), fixed and re-run
once. Plan-first over all 21 sessions is 21 / 21 on Haiku. The dedicated compliance sampler
(`AOC_REAL_CLI_RUNS`) was not used: the 25-session budget went on the scenarios above, so each rate is a count over
sessions made for other purposes, not a designed sample.

`no_file_change` flags (1 before, 5 after) are false positives of the ledger: a commit task closed after a diff task
(nothing changed since the previous `task_done`), a task that only ran the tests, a task that only pushed.

### 13.5 Measured numbers

- Hook latency, 425 invocations (`hooks.jsonl`): p50 119 ms, p95 312 ms, max 609 ms; PreToolUse (115): p50 117 ms, p95
  336 ms, max 526 ms, none over 1 s against the 2.5 s budget. These are the built bundles; tsx sources are about 7× slower per spawn.
- A whole happy turn takes 10–16 s and 5–7 model turns; context at the first request is about 21 k tokens (14 k cached
  read, 7 k written).
- Process end: SIGINT exit 0 with a result; SIGTERM exit 143 without one; a clean turn exit 0.

### 13.6 Not checked, and why

- The usage-limit path (`rate_limit_event` `rejected`, the synthetic limit message, `StopFailure`, reset-time parsing):
  the account was far from its windows and a limit cannot be provoked. Only the parsers were run against real output.
- OAuth / keychain login, `setup-token`, and a fresh `CLAUDE_CONFIG_DIR` on a workstation (§2.6): auth here is
  host-managed.
- The `aocd` executable and `AOC_CONFIG` boot; session isolation modes (per-user sandboxing); macOS.
- Models other than Haiku. The wording that mattered (D3, D8) was tuned on Haiku; Sonnet and Opus were not run.
- Compaction and automatic rollover with the real CLI (needs a context of hundreds of thousands of tokens), subagents
  (`Task`), long sessions, `defer`.
- The default tool set beyond Bash: `RemoteTrigger`, `CronCreate`, `PushNotification`, `WebFetch`, `WebSearch` and others
  are in `init.tools` for writer types (the registry has no `tools` policy for them); under `-p` they are refused unless
  granted, which was observed for `Monitor`. Deny them in the registry if a type must never have them.
- MCP error results as the model sees them.
- The shipped writer types' **scoped Bash grants** (`Bash(git commit:*)` …, merged after the last live session): the
  suite's writer twins leave Bash unscoped, the policy every live run here verified, and claude-sim's permission engine
  (checked against the real CLI on unscoped grants only) judged the scoped ones. Two things to look at when they are run
  live: a prefix rule does not match `git -c user.name=… commit`, which the model improvised in two runs when its
  session had no git identity (isolation sets `GIT_AUTHOR_*` / `GIT_COMMITTER_*`; a non-isolated session depends on the
  operator's git config); and no test runner is granted, so a `test` evidence run is refused in print mode.
- What an **approved** protected-operation card does for the session: no run answered one. The session holds no
  credential to carry the operation out and the `defer` flow of §7.4 is not used, so the intended path is mod-change's
  promotion, not the model retrying.

### 13.7 Requested changes for code the verifier does not own

- **mod-ledger**: `no_file_change` is flagged on tasks that cannot change files (run the tests, push, commit after a
  diff task) although the evidence is verified; read-only sessions' `task_done` evidence is always `evidence_unverified`.
- **mod-change / mod-sessions**: a `PermissionRequest` denial (print mode refusing a command) is not audited as a
  `tool.denied` event (the hook is relayed, nothing reads it), so a session that keeps hitting the permission wall (D1 before the fix) shows up only as the model's own words.
- **config/process-types.json**: the writer types grant git verbs only. A task closed with `test` evidence needs a test
  runner (`Bash(npm test:*)` and the like, per project): in print mode a refused test run is a dead end.
- **Boundary obedience** (credit cap, rollover, stop) rested on the model; D8 shows a model can ignore it. Done (G-54,
  `3c2fdf4`): the ledger's `boundary-stop` PreToolUse guard denies every tool call after a boundary stop was delivered,
  until the next turn starts.

### 13.8 Re-running and refreshing

```
AOC_REAL_CLI=1 pnpm --filter @aoc/e2e real-cli          # happy path + decision round trip (2 sessions, ~1 minute)
AOC_REAL_CLI=1 pnpm --filter @aoc/e2e real-cli:full     # every scenario (about 10 sessions)
```

Nothing runs without `AOC_REAL_CLI=1` (the runner refuses, the tests skip, `pnpm test` never reaches them). Optional:
`AOC_REAL_CLI_CLAUDE` (the binary), `AOC_REAL_CLI_CLAUDE_CONFIG_DIR` (a logged-in config dir; with host-managed auth none
is needed), `AOC_REAL_CLI_CAPTURE` (keep the raw captures and event dumps), `AOC_REAL_CLI_KEEP=1` (keep the temp dirs),
`AOC_REAL_CLI_RUNS=n` (n two-task sessions, compliance rate printed as `COMPLIANCE …`). Sessions get only allowlisted
variables, so with host-managed auth (this sandbox: `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`) the suite
adds those to `supervisor.envAllowlist`; a deployment on such a host has to do the same, the default list carries only
the API-key, token, proxy and CA variables. A model's choice differs from run
to run: the guard and gateway tests accept both routes seen and log which one a run took (`GUARD-ROUTE`, `MAIN-ROUTE`).

After a Claude Code upgrade: run `real-cli:full` with `AOC_REAL_CLI_CAPTURE` set, scrub what is worth keeping with
`node packages/e2e/real-cli/scrub.mjs stream|transcript|hooks <capture> <fixture>`, and read the diff of the
`claude-sim` `real-parity` snapshots: a field the CLI newly prints, or one the simulator stopped printing, shows up there
first (§11 step 4).
