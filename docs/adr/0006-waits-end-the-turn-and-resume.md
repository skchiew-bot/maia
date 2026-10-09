# 0006. Waits end the turn and resume later; no idle processes

- Status: Accepted
- Date: 2026-10-09
- Deciders: Platform architect
- Spec: AOC-SPEC-003 §2.3, R15

## Context

- "Waits indefinitely" cannot mean a live idle process. Hook timeouts (600 s by default), machine sleep and plan
  limits kill it (§2.3).
- Human decisions can take hours or days (R15). A waiting process would also hold a concurrency slot
  (`maxConcurrentSessions`) and a writer lock, and it would not survive an aocd restart or a reboot.
- Verified on Claude Code 2.1.295 ([research](../research/claude-code-integration.md) §7):
  - `claude -p --resume <uuid> "<text>"` keeps the session id, appends to the same transcript and fires
    `SessionStart(source: resume)`.
  - Settings, MCP config and permission mode are per process, so they must be passed again on every resume.
  - A SIGTERM leaves the session resumable.
  - In `-p` mode, a PreToolUse `defer` ends the turn cleanly (`terminal_reason: tool_deferred`), and
    `--resume` with no prompt re-runs the exact same tool call (same `tool_use_id`).

## Decision

1. **A decision ends the turn.** After `request_decision`, the MCP reply tells the agent to end its turn. A guard
   denial that raised a card says the same. The process exits. The supervisor records
   `session.turn_ended {outcome: decision}` and the lifecycle `waiting_decision`. Liveness shows **Waiting on you**.
2. **Resolution resumes.** A reactor on `decision.resolved` calls
   `supervisor.resume(sessionId, answer, 'decision_answered')`. The supervisor spawns
   `claude -p --resume <uuid> "<answer>"` with the same flags, settings and MCP config, and appends
   `session.turn_started {reason}`.
3. **The same mechanism serves every pause.** Nudge means ending the current turn and resuming with operator text.
   Restart means resuming a dead or stalled session from its transcript. Throttle resets, top-ups and
   auto-continue (`autoContinueLimit`) work the same way. A stop is honoured at the next task boundary, or at once if
   the session is idle.
4. **`defer`, where the agent should perform the approved action itself** (an option the design keeps open; no
   guard uses it yet). For example: a migration on a dev database. A guard may return `defer`; on approval the
   supervisor resumes without a prompt and the hook allows that `tool_use_id`. This does not depend on the model
   choosing to stop. It is **not** for cases where the approved action is performed by the supervisor, such as a
   promotion to main, because the session has no rights for it.

## Consequences

- **Good:** waiting costs nothing, holds no slot and survives restarts and upgrades. Every resume is an audited event
  with a reason. Waiting on you is unambiguous because no process is alive. Decision age is meaningful (R15).
- **Bad: cooperation.** "End your turn" depends on the agent complying. If it carries on, it can only do work that
  is not blocked, and the decision stays open. Guards still stop protected operations, and `defer` removes the
  dependency where it applies. Gap G-48 proposes answering `defer` for every guard denial that raises a card, so
  that those turns end without relying on the agent. That needs a rule for the deferred call when the session
  resumes (a resume without a prompt re-runs it): right for item 4, but wrong where the supervisor performs the
  approved action itself (a promotion), where the guard must deny the re-run.
- **Bad: cache cost.** A resume after a long wait re-reads the context, and the prompt cache has probably expired
  (`prompt_cache_likely_expired`). Metering shows the resulting cache writes.
- **Bad: turns are not tasks.** A turn can end mid-task (waiting for a decision), so turn boundaries are not task
  boundaries. Credits and rollover are enforced only at task boundaries (ADR-0007, ADR-0008).

## Alternatives rejected

| Alternative | Why rejected |
| --- | --- |
| Block inside the hook until a human answers | Hook timeouts kill it; it holds the process, the plan quota and a concurrency slot |
| Keep an interactive session open and idle | Dies on sleep or limits; not resumable cleanly; liveness is ambiguous |
| The agent polls for the answer | Burns tokens, and liveness looks like work |
| A `sleep` tool loop | The same problems, plus it hides the stall that R15 wants to make visible |

## References

- `packages/contracts/src/services.ts` (`SupervisorService.resume`, `nudge`, `restart`, `stop`)
- `packages/contracts/src/events/core.ts` (`session.turn_started.reason`, `session.turn_ended.outcome`)
- `packages/mcp-server/src/server.ts` (`END_TURN_FOR_DECISION`)
