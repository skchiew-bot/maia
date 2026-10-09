# @aoc/demo

Demo data and a live demo for the AOC console. Everything runs on **claude-sim** (`packages/claude-sim`), the
deterministic stand-in for the Claude Code CLI. The real `claude` CLI is never spawned, no plan quota is used and no
real repository is touched. (AOC is driven against the real CLI only by the separate, opt-in real-CLI suite:
[docs/testing.md](../../docs/testing.md).)

## `live`: one command for a live console

```sh
pnpm --filter @aoc/demo live -- --data-dir /abs/path/demo [--port 7420] [--reset] [--no-ui] [--relaunch-after 60] [--slots decision,triage]
```

1. **Seeds** the directory when it is empty, or rebuilds it with `--reset` (see `seed` below; up to a minute).
   `--reset` only deletes an empty directory or one the seeder created (it has `demo-tokens.json` or
   `aoc.config.json`), and never a filesystem root. A directory that holds something else is refused.
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
   waiting on you or throttled are never replaced. `--slots` keeps only the named slots (table below), for a
   lighter fleet on a small machine. A slot that edits files runs in a **workspace** of its own, a linked git
   worktree under `<dir>/workspaces/<project id>/<slot>` (`src/workspaces.ts`). The project checkouts that
   promotions and rollbacks fast-forward are therefore never dirtied, and the gates the seed leaves open still
   execute while the fleet runs.
5. **Prints** the console URL and the CEO (Approver) token. Paste the token on the sign-in page.

**Ctrl-C** first stops every managed session that has a process, through the API. It then stops aocd and waits for
it to exit, then for anything left in its process group (aocd waits for its per-session sidecars itself; only a killed
aocd leaves them behind, to spool a final flush into the data directory). `Stopped.` therefore means nothing of the demo is still running or writing, and `--reset` or `rm -rf`
right after is safe. The launcher signals only the daemon it started and that daemon's own process group, by PID,
and never pattern-kills. Sessions waiting on a decision or throttled have no process, so they keep their state and
are still there on the next start. A second Ctrl-C stops aocd without waiting for the sessions.

### The fleet

| Slot | Console state | What happens |
| --- | --- | --- |
| `feature` | **Working** | Aisyah's ~25-minute feature build in CX Copilot: plan, playbook steps, a tool call every 15-25 s, every task closed with verified diff or test evidence. |
| `discovery` | **Thinking** | Wei Jie's OCR-fallback discovery: streaming thinking pauses of 2-5 minutes, few tool calls. |
| `stall` | **Stalled** (after 10 silent minutes) | Priya's migration writes its first migration, then goes completely silent (process alive, heartbeats on). It turns Stalled once the 10-minute stall threshold passes. **Restart** or **Nudge** brings it back and it finishes. |
| `decision` | **Waiting on you** | A bug fix asks the Approver whether to backfill 1,284 production claims (`request_decision`, test=data) and ends its turn. Answer it: the supervisor resumes the session with the answer and it follows the chosen branch. |
| `throttle` | **Throttled** (resets ~4 min later) | A feature build hits the plan usage limit with a reset 4 minutes out. The supervisor resumes it after the reset and the idle time is metered. |
| `triage` | read-only investigation | Priya investigates "My claim was submitted twice" with Read/Glob/Grep only and summarises the root cause and a fix in text. No credentials, no file changes. It is launched by a Builder, so it files no diagnosis on the ticket: only the triage agents intake launches itself can. |
| `rollover` | context rollover | A feature build's context reaches ~77% of the window at a clean task boundary. The supervisor distills a handoff brief and continues the thread in a fresh session, which carries over the open tasks. |

The first three slots start out with the seeded queued sessions (below).

## `seed`: demo history

```sh
pnpm --filter @aoc/demo seed -- --data-dir /abs/path/demo [--days 14] [--reset]
```

Builds 14 days of history (`--days` 14 to 60) by driving the real runtime with a moving fake clock. It takes 20 to
45 seconds. Every state change is made through a module's own API (people, tickets, change records, rollbacks,
promotions, credits, lessons) or is the event a session's own tools would record (plans, tool calls, usage, task
closes), so the projections, the hash chain and the anchors are genuine. The result is deterministic for a given
day (seeded PRNG). **No event is later than the seeding instant**, and the seeder refuses to finish otherwise; the
repositories' commits and tags are dated the same way. The FX history is BNM's 1700 USD/MYR rate, stamped with its
session and recorded by the 18:00 MYT run, so today's rate appears only once that run has passed.

`seed` refuses a directory that already holds data (`--reset` deletes it first, under the rule above). The code is
`src/seed/`, one section per file, driven by `runSeed()` in `run.ts` (`src/seed.ts` is its command line):

| File | Section |
| --- | --- |
| `history.ts`, `sessions.ts` | about thirty finished sessions across the three projects: plans, tool calls, usage, task closes with evidence, phase pins, the odd agent decision, playbooks |
| `change.ts` | change control (below) |
| `tickets.ts` | intake tickets in every stage (below) |
| `learning.ts` | error classes, credit allocations, the lesson and the top-up waiting for the Approver |
| `now.ts` | one session per liveness state |
| `git.ts` | real commits and annotated tags, built with plumbing on side branches so only the platform moves `main` |

Then run aocd on it, either with `live` or by hand with the command the seeder prints:

```sh
AOC_CONFIG=<dir>/aoc.config.json CLAUDE_CONFIG_DIR=<dir>/claude CLAUDE_SIM_SCENARIO=<dir>/claude/demo-default-scenario.json \
  CLAUDE_SIM_EXEC=1 node --import tsx packages/daemon/src/main.ts
```

### Change control (§8, §14)

All of it goes through mod-change's API as the people would drive it; the AI drafts come from a scripted stand-in
model, and every passkey gate is signed through the real WebAuthn ceremony with a software authenticator that the
seeder removes again at the end.

- Seven change records, each with four AI-drafted fields that a developer edited or affirmed (one record has its
  fields affirmed by two people, the Approver tightening an acceptance test herself; one confirmation is a blind
  one-click, which Governance flags). Three are completed work records with a pinned `aoc/change/<id>` tag, one is
  submitted and waiting for the Approver, one is a draft with two of its four fields affirmed, and the last two are
  the post-incident records of the break-glasses (one completed, one half written).
- **Promotions** that passed the provenance check: an OCR retry cap promoted through the go-live gate, two ticket
  fixes, and two break-glass hotfixes. The promotions need no real credential: the demo's credential profiles have
  empty environments and the project repositories have no remote, so the platform updates their own `main`.
- **Rollbacks**: one executed (the OCR cap undone, verified by really running the repository's `node --test`
  acceptance suite on the target) and one verified clean and **waiting for your passkey**.
- **Break-glass**: one at night, approved with a passkey, its post-incident record filed the same morning; and one
  still open inside its 24 hours, with the record half written.

### Intake tickets (§7)

Eleven tickets from Daniel and Nur, filed through the portal and advanced by intake's own flow (triage on submit,
fix-plan gate, build, UAT, go-live). Requester text is what a customer would type; no scenario marker is in it.

| Ticket | Severity | Stage | What is real |
| --- | --- | --- | --- |
| Cannot attach a PDF bank statement | low | received | filed 9 minutes before the seed while nothing could start triage; nobody has picked it up |
| Customer panel goes blank when a call is transferred twice | medium | triage | its two read-only agents are queued launches: aocd starts them on claude-sim at boot (about 7 minutes at normal speed). Both agree, and the fix plan then reaches you; approve it and the build runs. |
| The app shows a blank white screen after I log in | high | awaiting a human | the agents are unsure (confidence 0.42 and 0.55): a Builder decides |
| Receipt photos come out sideways | medium | fix-plan gate | two agents agree (0.86 and 0.81); approve the fix plan and intake builds it to UAT |
| My claim was submitted twice | high | building | fix plan approved; the build asked whether to merge to `main` and its turn ended on that decision (the "Waiting on you" session) |
| Older policy numbers are rejected | **critical** | UAT, about 2 days | built on a real `uat/<ticket>` branch; the requester has not signed off. This is the funnel's bottleneck and a customer waiting on the Tower. |
| Suggested replies greet the caller by the previous caller's name | high | go-live gate | UAT passed; the passkey-gated promotion waits for you |
| The claim total has no currency, Customer panel runs off the edge | low, medium | completed | promoted for real through the provenance check and the passkey gate |
| Upload progress bar sticks at 99% | low | closed | cannot reproduce: a Builder closed the low-confidence card |
| My receipt picture is sideways after upload | medium | closed | closed as a duplicate by the Approver before triage |

The triage agents' diagnoses are on every ticket past triage, and the fixes on the `uat/<ticket>` branches are real
commits with the `AOC-Ticket` and `AOC-Session` trailers that go-live provenance traces. Any ticket you file in the
portal while the demo runs also goes all the way: two agents triage it, a low-confidence card goes to a Builder,
then the fix plan, a generic build on its own `uat/<ticket>`, your sign-off and the go-live gate.

### What else is waiting for you

- the "Merge the retry-dedupe fix to main?" decision (answer it and that session resumes its conversation);
- a credit top-up request from Wei Jie, raised through mod-credits (deny it and `credit.topup_denied` follows);
- a lesson to bind for `src/config`, proposed through mod-learning (the Knowledge page links to it);
- a throttled CSAT overlay build, resumed when its limit resets about 95 minutes after seeding;
- a Dead docs session (press **Restart**: it re-reads its manifest and finishes);
- an observed developer terminal whose hooks went quiet, shown as Stalled.

Passkey-gated cards (go-live, rollback, break-glass) need a passkey of yours: register one in Admin first.

### The six liveness states

Right after aocd starts, the console shows all six:

- **Working**, **Thinking** and **Stalled** are seeded as *queued launches*: lifecycle `launching`, no turn yet.
  The supervisor's startup recovery launches them on claude-sim, so their marks come from real processes. The
  managed stall session turns Stalled after 10 silent minutes (the stall threshold). Until then the observed
  terminal shows Stalled.
- **Waiting on you**, **Throttled** and **Dead** are seeded states with no process. Their next turn (decision
  answered, limit reset, Restart) runs on claude-sim. For the waiting session the seed writes its claude-sim
  conversation into `<dir>/claude`.

### Directory layout (`src/layout.ts`)

| Path | Contents |
| --- | --- |
| `aoc.config.json` | aocd config: claude-sim as `claudeBin`, fake LLM extractor, FX job off, every path absolute |
| `demo-tokens.json` | demo users' tokens (`ceo` is the Approver), the seeding instant, seeded session and ticket ids (0600) |
| `aoc/` | AOC's data dir: event log, body store, keys, anchors, and `git/`, the service-owned clones mod-change promotes through. aocd protects all of it as audit state. |
| `repos/<project>/` | the demo projects' git repositories, outside the data dir so agents can work in them |
| `workspaces/<project id>/<name>/` | linked worktrees for the sessions that edit files (above); `supervisor.workspacesDir` |
| `credential-profiles.json` | `supervisor.credentialProfilesFile` (0600). It holds every profile the demo references (`git-feature`, `uat-deploy`, `prod-promote`), each with an **empty** env: never a real credential. |
| `claude/` | claude-sim's `CLAUDE_CONFIG_DIR`: transcripts and scenario state, plus `demo-default-scenario.json` (below) |
| `logs/`, `live-fleet.json` | `live`'s daemon log and its slot to session map |

## Scenarios

The operator-launched sessions (the fleet and the seeded Working, Thinking, Stalled, Throttled and Dead ones) pick
their scenario through a `[[scenario:<name>]]` marker on the last line of the prompt (the first line is the session
title). Those prompts are written by the demo, never by a requester. The scenarios are claude-sim built-ins
(`packages/claude-sim/scenarios/demo-*.json`):

| Scenario | Used by |
| --- | --- |
| `demo-feature-build`, `demo-deep-think`, `demo-stall` | the `feature`, `discovery` and `stall` slots |
| `demo-decision`, `demo-throttle`, `demo-triage` | the `decision`, `throttle` and `triage` slots |
| `demo-rollover`, `demo-rollover-successor` | the `rollover` slot and its successor |
| `demo-csat-resume`, `demo-runbook-restart` | the seeded throttled and dead sessions |
| `demo-dedupe-resume` | the intake build of "My claim was submitted twice" (its conversation is written by the seed) |

**Prompts the platform writes carry no marker**: intake triage and builds (which contain the requester's text) and
the rollover prompt. They run `<dir>/claude/demo-default-scenario.json` (`CLAUDE_SIM_SCENARIO`), which the seeder
generates (`src/default-scenario.ts`) because a build must name its ticket's `uat/<ticketId>` branch. It dispatches on
the platform's own wording (`diagnosing customer ticket <id> `, `fix plan for ticket <id>.`):

- rollover successor;
- triage of the receipts ticket (confidence 0.86) and of the transfer ticket (slow, about 7 minutes, confidence 0.87);
- build of the receipts ticket and of the transfer ticket (a real fix and test committed to `uat/<ticket>`);
- a generic build of any other ticket (a fix note committed to its own `uat/<ticket>`, named by `$AOC_TICKET_ID`);
- triage of any other ticket (confidence 0.40, so it bounces to a human);
- a small generic task for anything else.

Every build closes its commit task while HEAD is the UAT commit and only then switches back, because go-live
provenance traces a commit only if it is in a HEAD the session recorded (G-25).

### Git for builds

Every write-capable process type with a credential profile (`bug-fix`, `feature-build`, `discovery`, `migration`, `test-repair`, `docs`) is granted a scoped set of git in `config/process-types.json` (`tools`; a registry test keeps them identical): `status`,
`diff`, `log`, `show`, `rev-parse`, `add`, `commit`, `checkout -b`, `switch -c`, `switch uat/*`, `switch -` and
`push aoc …` (the supervisor's push gateway, which holds the credential; sessions never do). `merge`, `rebase` and
`reset` are denied, anything else is not granted, and the protected-operation PreToolUse guard still bounces a push
to `main` before the permission rules are consulted. It also bounces a commit (or cherry-pick, revert, `am`, pull)
while `main` or another protected branch is checked out, so a build branches before it commits, as the scenarios do; a
workspace is a detached worktree, where there is no branch to protect. `CLAUDE_SIM_EXEC=1` lets the scenarios' git
steps really run, so a build's commits are real. There is no operator-settings workaround: the demo uses the same
rules as any deployment. `config/process-types.json` is governed configuration; mod-audit records its changed hash.
Under `claude -p` nothing can answer a permission prompt, so these types cannot run tests or builds: the scenarios
only run git. Whether builders should get more is an open CEO decision (gap P-26, threat model O-30).

`CLAUDE_SIM_SPEED` (e.g. `0.2`) passes through to the sessions and speeds every scenario up.

## Limits

- **No upstream remote.** A build's commits stay in the project repository on `uat/<ticket>`, which intake resolves.
  The gateway push the intake build prompt asks for (`git push aoc HEAD:refs/heads/uat/<ticket>`) is not exercised:
  the demo defines no `origin` on the service clones and no `push.refs` on its credential profiles.
- **Promotions are fast-forward only.** Once one ticket of a project goes live, the other open UAT branches of that
  project no longer contain `main`; the platform refuses their promotion until they are rebased, which is the
  behaviour a real team sees. Take one ticket per project through go-live per demo.
- The seeded history was signed with a software passkey that is removed at the end, so the demo has no passkey until
  you register yours.
- Start the console within about 20 minutes of seeding: the ticket in triage has a 30-minute diagnosis budget that
  started at the seeding instant, and past it intake stops the agents and escalates the ticket instead.

## `pulse` (retired)

`pulse` used to fake heartbeats and tool calls for the seeded live sessions. It is gone: those sessions are now real
managed processes, so there is nothing left to fake.

## Tests

`pnpm --filter @aoc/demo test` (the daemon end-to-end files run one at a time, `vitest.config.ts`):

- **unit:** the claude-sim guard, the fleet keeper's decisions and workspaces, the generated default scenario
  (dispatch, git ordering, no marker), the workspaces, and **permissions**: the shipped process types judged by
  claude-sim's permission engine and mod-change's protected-operation guard (what a build may and may not run, and
  that every git step the demo scenarios run is granted).
- **`seed`:** the seeder in-process on a fixed Wednesday (and a Monday morning). It reads the result back through the
  modules' APIs and the repositories: nothing after the seeding instant, every phase and change pin resolves, change
  records, rollbacks, break-glass and promotions in the states above, `main` moved only by gates, tickets in every
  stage and in the Tower's funnel and attention queue, no scenario marker in requester-visible text, distinct task
  ids, empty credential profiles, and that denying the top-up or binding the lesson moves the real records.
- **`seed-daemon.e2e`:** seed, then aocd, then all six states at once. Working, Thinking and Stalled come from
  launched claude-sim processes. The test shortens the stall threshold to 60 s; the demo keeps 10 minutes.
- **`live.e2e`:** the launcher end to end, with only the `decision` slot. Real `session.launched`, `tool.used`,
  `task.done` and `decision.requested` events appear. Every `session.launched` argv is node plus claude-sim, a
  `claude` tripwire first on `PATH` is never run, Ctrl-C leaves nothing running, and the project checkout was never
  dirtied.
- **`intake.e2e`:** fix plan approved, then the build on claude-sim commits to `uat/<ticket>` (traced), then
  `ticket.uat_ready`, the requester's sign-off, `ticket.golive_requested` and the go-live decision.
- **`tickets-live.e2e`:** the ticket seeded in triage is diagnosed by two claude-sim agents, planned, approved and
  built; a ticket filed through the portal goes through the low-confidence card, the fix plan and a generic build to
  the go-live gate.
