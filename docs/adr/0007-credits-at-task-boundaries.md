# 0007. Credits are enforced only at task boundaries

- Status: Accepted
- Date: 2026-10-09
- Deciders: CEO (policy) and platform architect (mechanism)
- Spec: AOC-SPEC-003 §10 (credits), R7, R8

## Context

- Credits are behaviour control with a hard cap, but a session must never be terminated mid-task (§10). Killing a
  session halfway through a migration or a refactor leaves a corrupt build (R7).
- The first time a developer hits the cap, the platform auto-grants up to 25 % of the original allocation, once per
  period (AI-approved). Any further need is a button-raised request to a human approver, never the requester. There
  is no compounding and no AI repeat grant. The CEO tops up.
- Credits meter cost; they never pick the model. The discovery-runs-on-Opus rule overrides budget (R8).
- Metering is read-only and separate. It observes and never gates.

## Decision

1. `CreditService.checkBoundary(sessionId, taskId)` is called **only** at the launch boundary and on every
   `task_done`. It returns a `BoundaryInstruction`, delivered to the agent in the `task_done` reply. The MCP server
   turns a stop into an unmissable "STOP: AOC task boundary" instruction.
2. Balance = period allocation + grants − used, where "used" is metering's **notional** cost for the user's
   sessions in the local calendar month. Users on `credits.exemptUserIds` are never capped.
3. At a boundary with no balance left:
   - On the first cap hit in the period, `credit.auto_granted` adds up to `autoGrantPct` (25 %) of the original
     allocation. It is recorded as a policy-resolved decision (`method: policy`) with the balance before and after.
   - Otherwise `credit.cap_reached`. The agent ends its turn, and the session is blocked: Waiting on you, awaiting a
     top-up, shown as its own aging state.
   - The developer raises `credit.topup_requested` with a button. A `credit_topup` decision goes to an Approver who
     is not the requester. `credit.topup_granted` (balance before and after) makes the supervisor resume with
     reason `topup`; `credit.topup_denied` leaves the session stopped.
4. Credits never change the model, the process type or the tool set.

## Consequences

- **Good:** no half-done work from a cap. Enforcement points are predictable and easy to explain. Every grant is an
  audited event with who, how much, which task, and the balance before and after.
- **Bad: overspend inside a task.** A large task can run past zero. The overspend is bounded by the task (declared
  sizes and `drift.detected {kind: overrun}` make it visible); the balance goes negative, and the next boundary
  stops.
- **Bad: boundary avoidance.** An agent that never calls `task_done` never meets a boundary. It also makes no
  progress (progress counts only evidenced `task_done`s). An ended turn with the plan incomplete goes to Waiting on
  you, and the overrun appears as drift. The launch check gates new work.
- **Bad: forged usage.** Credits are only as honest as metering. Usage that reaches the daemon with an
  agent-readable token can be manipulated (threat model
  [T-14](../security/threat-model.md#t-14-credit-gaming)). Metering is reconciled against supervisor-observed
  totals.

## Alternatives rejected

| Alternative | Why rejected |
| --- | --- |
| Terminate the session when the cap is hit | R7: corrupt builds |
| Downgrade to a cheaper model when the balance is low | R8: discovery work on a weak model; the spec forbids it |
| Warnings only | No behaviour control at all |
| Check at every turn end | A turn can end mid-task (for example waiting for a decision); stopping there strands a half-done task |
| Unlimited automatic grants | Compounding, with no human in the loop: exactly what §10 forbids |

## References

- `packages/contracts/src/services.ts` (`CreditService`), `packages/contracts/src/mcp.ts` (`BoundaryInstruction`)
- `packages/contracts/src/events/credits.ts`, `packages/contracts/src/config.ts` (`credits.*`)
- [architecture.md §9, §10](../architecture.md)
