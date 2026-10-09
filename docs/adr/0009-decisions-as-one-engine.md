# 0009. All human decisions run through one engine

- Status: Accepted
- Date: 2026-10-09
- Deciders: Platform architect
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
4. **Passkeys** for `go_live`, `rollback` and `break_glass`: the WebAuthn challenge is bound to
   `(decisionId, optionId, user)`, and the result is chained (`passkeyVerified`).
5. **Policy resolutions** (the 25 %-once credit auto-grant) are explicit decisions resolved with `method: policy`.
   They are never silent side effects.
6. Modules react to `decision.resolved` through reactors keyed by `subjectType` and `subjectId`, using stable
   option ids (`approve`, `reject`, `pass`, `fail`, `retriage`, …).
7. Every card shows its age. Reminders fire after `decisions.remindAfterMinutes`, with an opt-in webhook, and
   `ageMs` is chained on resolution.

## Consequences

- **Good:** one inbox, one aging rule, one audit trail. Separation-of-duties and passkey logic is implemented and
  tested once. A new decision kind is a routing entry plus a reactor, not a new workflow. The evidence pack can
  report on all decisions uniformly.
- **Bad: a high-value target.** The engine decides who may approve what, so it is governance core: `mod-decisions` is
  a protected path ([self-modification boundary](../compliance/self-modification-boundary.md)).
- **Bad: coupling through option ids.** Option ids are part of each module's contract with the engine and must stay
  stable.
- **Bad: a single Approver deadlocks.** Approver-level decisions raised from the Approver's own sessions exclude the
  only Approver. That needs a deputy Approver or an explicit, audited self-approval rule
  ([threat model T-8](../security/threat-model.md#t-8-self-approval-and-separation-of-duties)).
- **Expiry must be chained** so that it is auditable. The catalog has `decision.expired {ageMs}`; at the time of
  writing `mod-decisions` still records expiry as `decision.withdrawn {reason: expired}` and should adopt the
  dedicated event.

## Alternatives rejected

| Alternative | Why rejected |
| --- | --- |
| A separate approval flow per module | Inconsistent separation of duties and passkey handling; several inboxes; gaps in the audit |
| GitHub pull request reviews as the decision system | Covers code only (not FX, credits, lessons or UAT); no per-decision passkey; not in the hash chain |
| Chat or email approvals | Unstructured, no enforcement of separation of duties, easily forged |

## References

- `packages/contracts/src/decisions.ts`, `packages/contracts/src/services.ts` (`DecisionService`)
- `packages/contracts/src/events/core.ts` (`decision.*`)
- [architecture.md §8](../architecture.md)
