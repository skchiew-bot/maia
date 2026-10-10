# Runbook: observed sessions

- **What:** visibility of Claude Code sessions that developers start themselves, outside AOC (§2, "session
  classes").
- **Owner:** the platform architect. Each developer installs the hooks on their own machine.
- **When:** on onboarding a Builder; after a Claude Code upgrade; when an observed session misbehaves.

## 1. What observed sessions are, and what they are not

| Observed sessions do | Observed sessions never |
| --- | --- |
| Show up in the console as `Observed · <directory>`, mapped to a project when the working directory is inside a project's repository path (longest match) | Block anything. Guards are not applied to observed sessions, and the developer's Claude Code is never stopped, including when aocd is down |
| Record prompts (`prompt.submitted {origin: terminal}`), tool calls (`tool.used`), throttle hits and token usage | Count as progress, close tasks, raise gates, or charge credits |
| Buffer events locally while aocd is unreachable, and replay them later | Get declared **Dead** by silence: there is no sidecar, so an idle terminal is not a dead process |
| End when Claude Code fires `SessionEnd` | Provide any assurance. They are visibility, not control |

Observed sessions support R1 by making off-platform work **visible**. They do not prevent it. Prevention is
[credential isolation](credential-isolation.md).

## 2. What gets recorded (tell your team)

Developers' own prompts and tool activity in observed sessions are recorded:

- prompt text (up to 4,000 characters);
- tool input and output summaries (up to 500 characters each) and file paths;
- usage per model.

Bodies are encrypted under the session's scope. Builders and the Approver can read them through the audit trail,
which is a transparent team console by design (§6).

Before installing:

- Tell every developer what is captured, and who can see it. It is employee personal data under the PDPA; the
  employee notice should cover it.
- Global hooks capture **every** Claude Code session on the machine, including personal or unrelated work. Today
  the daemon records a session even when its directory maps to no project (`projectId: null`), by the CEO's
  decision of 2026-10-10 (threat model O-25). Advise developers to use a separate OS account, or to disable the
  hooks, for non-work use.
- An erasure request for an observed session follows the [crypto-shred procedure](key-custody.md#6-crypto-shred)
  with the session scope.

## 3. Install

Prerequisites:

- aocd is reachable from the developer machine (the `publicUrl`, through the company network or VPN);
- an Approver has issued the developer an observer token. Observer tokens carry a label and an expiry, but are
  not yet bound to a person (threat model O-6), so issue **one per developer**, label it with their name, and
  revoke it when they leave.

```bash
aoc login --token -                              # your user token from stdin; stored in ~/.aoc/client.json (0600)
aoc hooks install-observed --observer-token -    # registers the AOC hook for every hook event; stores the observer token
aoc doctor                                       # daemon, login, file permissions, hooks, secrets, pre-push guard
```

`install-observed` is idempotent and keeps your other hooks. It writes to `~/.claude/settings.json` by default (it
honours `CLAUDE_CONFIG_DIR`; `--settings <file>` picks another file). The hook command defaults to the
`aoc-hook.mjs` bundle next to the CLI (`--command` overrides it).

The installer adds one entry per AOC hook event (`HOOK_EVENTS` in `packages/contracts/src/claude-code.ts`) to the
documented Claude Code hooks format. Each entry runs the AOC hook binary in observed mode:

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "<aoc hook command, observed mode>", "timeout": 10 }] }]
  }
}
```

Do not hand-edit these entries. A malformed hook entry is **silently ignored** by Claude Code (verified on 2.1.295:
a wrongly typed `timeout` disables that event's hook with no message). Reinstall instead.

**Check it worked:** run `claude` in a project directory and ask it to read a file. Within seconds the console shows
`Observed · <directory>` with a tool tick.

## 4. When aocd is down

- Hooks never block. Each event is appended to a local spool, `~/.aoc/spool/observed/spool-<pid>.jsonl`
  (directory mode 0700, file mode 0600). Later runs replay it through `/ingest/spool`, which is idempotent:
  duplicates are counted and not stored twice.
- **What aocd refuses is kept, not dropped.** An item that fails ingest validation (an unreadable timestamp, say) or
  is too large moves to `spool-rejected.jsonl` in the same directory, with a reason (`too_large`, `invalid`,
  `rejected_by_daemon`, `unreadable`). The client never replays that file. It holds clear text like the rest of the
  spool: look at it when events are missing, then delete it.
- **Observer tokens are rate limited** (R-13), per token: 600 requests a minute with a burst of 1000, and 60 new
  observed sessions an hour. Over the limit aocd answers 429 with `Retry-After`; hooks still never block, and a
  replay that is told to wait stays in the spool for the next flush. A developer with a very long backlog is slowed
  down, not refused. The limits are fixed in this release.
- Without a usable `~/.aoc/client.json` (daemon URL and observer token), the observed hook switches itself **off**
  silently. A machine that was never logged in records nothing, and says nothing.
- Inside a managed session, which inherits the user's global settings, the observed entries stand down, so each event
  is relayed once, by the managed registration.
- `SessionEnd` hooks get a budget of only about 1.5 s, so the `SessionEnd` hook only enqueues to the spool
  ([research](../research/claude-code-integration.md) §4.6).
- **The spool holds clear text** (prompts, tool summaries) until it is flushed. Developer machines must use
  full-disk encryption. A long backlog is a privacy liability as well as a data gap. `aoc doctor` does not report
  the backlog yet, so check the spool directory after an outage.
- Spooled events keep their source time (`sourceTs`), so the timeline places them correctly after replay. Their
  `ts` is the time aocd accepted them.

## 5. Limits

Developers can bypass observation, intentionally or not:

- `claude --bare` or `claude --safe-mode` skips all settings hooks;
- the hooks can be removed from `~/.claude/settings.json`;
- other machines, other accounts, and work without Claude Code at all are never seen.

This is why observed sessions are labelled as such, why they never feed gates, credits or evidence, and why the
provenance gate refuses any commit on its way to `main` that does not trace to an approved change. An observed
session can never be linked to a change (W3-01), so a commit made in one does not trace, whatever trailer it carries.

## 6. Known behaviours and troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| No observed session appears | Wrong daemon URL or token; hooks not installed; aocd unreachable (the events are spooled) | `aoc doctor`; check `~/.aoc/client.json`; check the spool directory |
| Session shows no project | The working directory is outside every project's `repoPath` | Set the project's repository path in AOC (`project.updated`), or work inside the registered clone |
| Session shows **Waiting on you** | The last event was `Stop`: Claude Code finished its turn and is waiting for the developer | Expected |
| Session shows **Stalled** for a long time | The terminal was closed mid-turn, so no `SessionEnd` arrived | Expected for observed sessions. They are never Dead by silence; the console can hide old ones |
| Events arrive in a burst after an outage | Spool replay | Expected; the timeline uses `sourceTs` |
| Replay is slow, or aocd answers 429 | The observer token's rate limit (section 4) | Wait: the spool is kept and the next flush retries. `Retry-After` says how long |
| Some events never arrive although aocd is up | They were refused and moved to `spool-rejected.jsonl` | Read that file in `~/.aoc/spool/observed/`: each line carries `rejectedAt` and `reason`, and can be moved back into a queued spool file by hand once fixed |
| A protected action (a push to `main`, a deploy) shows in an observed timeline with no decision card | Guards never run for observed sessions | Expected. In a managed session it would have been blocked or turned into a card; the GitHub rulesets still stop the push itself |

## 7. Uninstall and leaving

- `aoc hooks uninstall` removes the AOC entries and leaves other hooks untouched. Delete `~/.aoc/spool` once it
  has been flushed.
- When someone leaves: revoke their user token and their observer token (`token.revoked`), and run the
  [credential isolation checklist](credential-isolation.md#5-developer-machines) on returned hardware.
