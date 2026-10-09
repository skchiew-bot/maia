# 0009. All human decisions run through one engine

- Status: Accepted
- Date: 2026-10-09 (updated the same day with the CEO's decision on a single Approver, item 8)
- Deciders: Platform architect; the single-Approver rule by the CEO
- Spec: AOC-SPEC-003 §6, §7, §8, §10, §11, R15, R17

## Context

- Human-required decisions arise everywhere: agents (`request_decision`, tests 1 to 5), guards (a blocked push to
  main), intake (fix plan, low-confidence diagnosis, triage disagreement, UAT), change control (change requests,
  go-live, rollback, break-glass), credits (top-ups), FX (discrepancies), learning (lesson binding) and the registry
  (playbook approval). The contract lists 14 kinds (`DECISION_KINDS`).
- The same rules apply to all of them:
  - Role routing: Builders self-approve reversible off-main work; main, production and data go to the Approver.
  - Separation of duties: requests never route back to the requester.
  - Per-decision passkeys for go-live, rollback and break-glass.
  - Decision age and reminders, because indefinite waits are silent stalls (R15).
  - One audit trail.
- If every module built its own approval flow, the result would be several inboxes, inconsistent separation of
  duties, and gaps an auditor would find.

## Decision

1. One `DecisionService` (`mod-decisions`) with `request`, `resolve`, `resolveByPolicy`, `withdraw`, `get`, `list`
   and `canResolve`.
2. Routing is pure and shared: `requiredRoleFor({kind, test, changeScope})`, `requiresPasskey(kind)` and
   `roleSatisfies(actual, required)`. A caller may escalate the required role, never lower it.
3. **Separation of duties** is data on the card, chained in `decision.requested` meta: `requesterId` is always in
   `excludedApproverIds` (UAT sign-off is the exception, where `eligibleUserIds` names the ticket's requester).
   `decision.escalated` targets a role, never the requester.
4. **Passkeys** for `go_live`, `rollback` and `break_glass`: the WebAuthn challenge is the hash of a binding of
   the user, the decision, the option, a hash of the card as shown, a nonce and an expiry. The result is chained
   (`passkeyVerified`), and `passkey.asserted` keeps the signed assertion so the approval can be re-verified later.
5. **Policy resolutions** (the 25 %-once credit auto-grant) are explicit decisions resolved with `method: policy`.
   They are never silent side effects.
6. Modules react to `decision.resolved` through reactors keyed by `subjectType` and `subjectId`, using stable
   option ids (`approve`, `reject`, `pass`, `fail`, `retriage`, …).
7. Every card shows its age. Reminders fire after `decisions.remindAfterMinutes`, with an opt-in webhook, and
   `ageMs` is chained on resolution. Per-kind SLAs (approved with the static mock on 2026-10-09: rollback 30 min,
   agent decision 1 h, credit top-up 1 h, go-live 2 h, fix plan 4 h, lesson binding 2 days; a protected operation
   keeps the agent decision's 1 h) drive breaches and the gate-latency KPI.
8. **A single Approver gets no exception** (CEO decision, 2026-10-09). The sole-Approver fallback is **off**
   (`decisions.soleApproverFallback: false`). With one active Approver, an Approver-level request raised by that
   Approver, including one from their own session, waits until a second Approver exists. If the flag is ever
   turned on, the only active Approver may resolve their own request, recorded `selfApproved: true`, but never a
   credit top-up, and only while no second Approver is active. Each such resolution is chained, and so is the
   switch itself: `decisions` is governed configuration, so turning the flag on appends `config.changed`
   (`decisions_config`, threat model O-8).

## Consequences

- **Good:** one inbox, one aging rule, one audit trail. Separation-of-duties and passkey logic is implemented and
  tested once. A new decision kind is a routing entry plus a reactor, not a new workflow. The evidence pack can
  report on all decisions uniformly.
- **Bad: a high-value target.** The engine decides who may approve what, so it is governance core: `mod-decisions` is
  a protected path ([self-modification boundary](../compliance/self-modification-boundary.md)).
- **Bad: coupling through option ids.** Option ids are part of each module's contract with the engine and must stay
  stable.
- **Bad: the cost of item 8.** With one Approver, the Approver's own Approver-level requests wait: gates raised
  from the CEO's own sessions, and a break-glass the CEO invokes. In practice, appoint a second Approver (with a
  passkey) before the CEO runs sessions that raise such gates, and let a Builder invoke break-glass
  ([threat model T-8](../security/threat-model.md#t-8-self-approval-and-separation-of-duties)).
- **Expiry is chained** so that it is auditable: `mod-decisions` appends the catalog's `decision.expired
  {decisionId, ageMs}` (gap G-33, closed). Older logs recorded expiry as `decision.withdrawn {reason: expired}` and
  still read as expired.

## Alternatives rejected

| Alternative | Why rejected |
| --- | --- |
| A separate approval flow per module | Inconsistent separation of duties and passkey handling; several inboxes; gaps in the audit |
| GitHub pull request reviews as the decision system | Covers code only (not FX, credits, lessons or UAT); no per-decision passkey; not in the hash chain |
| Chat or email approvals | Unstructured, no enforcement of separation of duties, easily forged |
| A sole-Approver self-approval exception that is on by default | The only Approver would mark their own homework on exactly the gates that matter most. Rejected by the CEO on 2026-10-09: the flag exists but stays off |

## References

- `packages/contracts/src/decisions.ts`, `packages/contracts/src/services.ts` (`DecisionService`)
- `packages/contracts/src/events/core.ts` (`decision.*`)
- [architecture.md §8](../architecture.md)
