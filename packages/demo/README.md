# @aoc/demo

Demo data and a live demo for the AOC console. Everything runs on **claude-sim** (`packages/claude-sim`), the
deterministic stand-in for the Claude Code CLI. The real `claude` CLI is never spawned, no plan quota is used and no
real repository is touched.

## `live`: one command for a live console

```sh
pnpm --filter @aoc/demo live -- --data-dir /abs/path/demo [--port 7420] [--reset] [--no-ui] [--relaunch-after 60]
```

1. **Seeds** the directory when it is empty, or rebuilds it with `--reset` (see `seed` below). `--reset` only
   deletes an empty directory or one the seeder created.
2. **Refuses to start** unless the config's managed-session command is claude-sim: `supervisor.claudeBin` must be
   node running claude-sim (or the claude-sim bundle). The LLM extractor must not be one that calls a real model.
3. **Starts aocd** as a child process with `AOC_CONFIG=<dir>/aoc.config.json` and the claude-sim settings of
   `src/daemon-env.ts`. It strips `AOC_*` overrides and API credentials from the environment. The daemon log goes
   to `<dir>/logs/aocd.log`. On first use it builds the console UI (`packages/web/dist`); `--no-ui` skips that and
   serves the API only.
4. **Keeps a fleet of real managed sessions** running (`src/fleet.ts`). Each is launched through
   `POST /api/sessions` by a demo Builder and runs a claude-sim scenario through the real supervisor, hooks, AOC MCP
   server and sidecar. When a run finishes, the next one starts on a new thread after `--relaunch-after` seconds
   (triage waits ten times longer). A Dead session is replaced after 10 minutes, an idle one after 15. Sessions
   waiting on you or throttled are never replaced.
5. **Prints** the console URL and the CEO (Approver) token. Paste the token on the sign-in page.

**Ctrl-C** first stops every managed session that has a process, through the API. It then stops aocd and waits for
it to exit. The launcher signals only the daemon it started, by PID, and never pattern-kills. Sessions waiting on
a decision or throttled have no process, so they keep their state and are still there on the next start. A second
Ctrl-C stops aocd without waiting for the sessions.

### What the CEO sees

| Slot | Console state | What happens |
| --- | --- | --- |
| `feature` | **Working** | Aisyah's ~25-minute feature build in CX Copilot: plan, playbook steps, a tool call every 15-25 s, every task closed with verified diff or test evidence. |
| `discovery` | **Thinking** | Wei Jie's OCR-fallback discovery: streaming thinking pauses of 2-5 minutes, few tool calls. |
| `stall` | **Stalled** | Priya's migration writes its first migration, then goes completely silent (process alive, heartbeats on). It turns Stalled once the 10-minute stall threshold passes. **Restart** or **Nudge** brings it back and it finishes. |
| `decision` | **Waiting on you** | A bug fix asks the Approver whether to backfill 1,284 production claims (`request_decision`, test=data) and ends its turn. Answer it: the supervisor resumes the session with the answer and it follows the chosen branch. |
| `throttle` | **Throttled** | A feature build hits the plan usage limit with a reset 4 minutes out. The supervisor resumes it after the reset and the idle time is metered. |
| `triage` | read-only triage | Priya triages the seeded ticket "My claim was submitted twice" with Read/Glob/Grep only and reports a diagnosis (confidence 0.84) on the ticket. No credentials, no file changes. |
| `rollover` | context rollover | A feature build's context reaches ~77% of the window at a clean task boundary. The supervisor distills a handoff brief and continues the thread in a fresh session, which carries over the open tasks. |

The first three slots start out with the seeded queued sessions (below). The seed also leaves these for the CEO to act on:

- **The intake path (§7).** "Receipt photos come out sideways" was triaged by two read-only agents that agree, and
  its **fix plan waits for your approval**. Approve it and intake launches the build session (a real `bug-fix` on
  claude-sim). The build fixes `src/uploads/normalize.ts`, adds a regression test and commits to `uat/<ticket>`,
  carrying the `AOC-Ticket` and `AOC-Session` trailers. The ticket then becomes ready for testing. Sign UAT off as
  the requester (Daniel's token in `demo-tokens.json`, on the portal, or `POST /portal/api/tickets/<id>/uat`), and
  intake requests go-live, which puts the promotion to the go-live gate.
- the "Merge the retry-dedupe fix to main?" decision. Answer it and that session resumes its conversation on claude-sim.
- a throttled CSAT overlay build, resumed when its limit resets about 95 minutes after seeding.
- a Dead docs session. Press **Restart** and it re-reads its manifest and finishes.
- an observed developer terminal whose hooks went quiet, shown as Stalled.

## `seed`: demo history

```sh
pnpm --filter @aoc/demo seed -- --data-dir /abs/path/demo [--days 14] [--reset]
```

Builds 14 days of catalog-valid history by driving the real runtime with a moving fake clock: users and tokens,
projects with git repos, sessions with manifests, evidence and usage, decisions, playbooks, credits, FX, error
learning and intake tickets. The hash chain and the projections are therefore genuine. The result is
deterministic (seeded PRNG). Then run aocd on it, either with `live` or by hand with the command the seeder prints:

```sh
AOC_CONFIG=<dir>/aoc.config.json CLAUDE_CONFIG_DIR=<dir>/claude CLAUDE_SIM_SCENARIO=<dir>/claude/demo-default-scenario.json \
  CLAUDE_SIM_USER_SETTINGS=<dir>/claude/settings.json CLAUDE_SIM_EXEC=1 node --import tsx packages/daemon/src/main.ts
```

Right after aocd starts, the console shows all six liveness states:

- **Working**, **Thinking** and **Stalled** are seeded as *queued launches*: lifecycle `launching`, no turn yet.
  The supervisor's startup recovery launches them on claude-sim, so their marks come from real processes. The
  managed stall session turns Stalled after 10 silent minutes (the stall threshold). Until then the observed
  terminal shows Stalled.
- **Waiting on you**, **Throttled** and **Dead** are seeded states with no process. Their next turn (decision
  answered, limit reset, Restart) runs on claude-sim. For the waiting session the seed writes its claude-sim
  conversation into `<dir>/claude`.

Directory layout (`src/layout.ts`):

| Path | Contents |
| --- | --- |
| `aoc.config.json` | aocd config: claude-sim as `claudeBin`, fake LLM extractor, FX job off, every path absolute |
| `demo-tokens.json` | demo users' tokens (`ceo` is the Approver), seeded session and ticket ids (0600) |
| `aoc/` | AOC's data dir: event log, body store, keys, anchors. aocd protects all of it as audit state. |
| `repos/<project>/` | the demo projects' git repos, outside the data dir so agents can work in them |
| `workspaces/` | `supervisor.workspacesDir` |
| `credential-profiles.json` | `supervisor.credentialProfilesFile` (0600). It holds every profile the demo references (`git-feature`, `uat-deploy`, `prod-promote`), each with an **empty** env: never a real credential. |
| `claude/` | claude-sim's `CLAUDE_CONFIG_DIR`: transcripts and scenario state, plus `settings.json` and `demo-default-scenario.json` (below) |
| `logs/`, `live-fleet.json` | `live`'s daemon log and its slot → session map |

## Scenarios

A session picks its scenario through a `[[scenario:<name>]]` marker on the last line of its prompt (the first line
is the session title). The demo scenarios are claude-sim built-ins (`packages/claude-sim/scenarios/demo-*.json`):

| Scenario | Used by |
| --- | --- |
| `demo-feature-build`, `demo-deep-think`, `demo-stall` | the `feature`, `discovery` and `stall` slots |
| `demo-decision`, `demo-throttle`, `demo-triage` | the `decision`, `throttle` and `triage` slots |
| `demo-rollover`, `demo-rollover-successor` | the `rollover` slot and its successor |
| `demo-dedupe-resume`, `demo-csat-resume`, `demo-runbook-restart` | the seeded waiting, throttled and dead sessions |

Some prompts are written by the platform itself and carry no marker: intake triage and builds, and the rollover
prompt. These run `<dir>/claude/demo-default-scenario.json` (`CLAUDE_SIM_SCENARIO`), which the seeder generates
(`src/default-scenario.ts`) because a build must name its ticket's `uat/<ticketId>` branch. It dispatches on the
prompt text:

- rollover successor;
- triage of the receipts ticket (confidence 0.86);
- build of the receipts ticket (git commit to `uat/<ticket>`);
- triage of any other ticket (confidence 0.40, so it bounces to a human);
- a small generic task for anything else.

Feature builds are not granted Bash, so the slot scenarios close tasks with diff and test evidence. The intake build
does need git: `<dir>/claude/settings.json` (`CLAUDE_SIM_USER_SETTINGS`, the sim's `~/.claude/settings.json`) allows
only `git checkout`, `git add`, `git commit` and `git rev-parse`. `CLAUDE_SIM_EXEC=1` lets those steps really run.
AOC's hooks still police every command. `CLAUDE_SIM_SPEED` (e.g. `0.2`) passes through to the sessions and speeds
every scenario up.

## `pulse` (retired)

`pulse` used to fake heartbeats and tool calls for the seeded live sessions. It is gone: those sessions are now real
managed processes, so there is nothing left to fake.

## Tests

`pnpm --filter @aoc/demo test`:

- **unit:** the claude-sim guard, the fleet keeper's decisions, and the generated default scenario.
- **`seed-daemon.e2e`:** seed, then aocd, then all six states at once. Working, Thinking and Stalled come from
  launched claude-sim processes. The test shortens the stall threshold to 15 s; the demo keeps 10 minutes.
- **`live.e2e`:** the launcher end to end. Real `session.launched`, `tool.used`, `task.done` and
  `decision.requested` events appear. Every `session.launched` argv is node plus claude-sim, a `claude` tripwire
  first on `PATH` is never run, and Ctrl-C leaves nothing running.
- **`intake.e2e`:** fix plan approved, then the build on claude-sim commits to `uat/<ticket>` (traced), then
  `ticket.uat_ready`, the requester's sign-off, `ticket.golive_requested` and the go-live decision.

Limitation: only the seeded receipts ticket can go live. A ticket filed during the demo is triaged with low
confidence. Its build cannot name `uat/<ticketId>`, because the scenario is generated at seed time, so its go-live
request finds no UAT branch.
