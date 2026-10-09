# 0005. The process type, and so the model, is fixed at launch

- Status: Accepted
- Date: 2026-10-09
- Deciders: Platform architect; the discovery-on-Opus rule is the CEO's
- Spec: AOC-SPEC-003 §2.2, §10 (credits never pick the model), R8

## Context

- Claude Code fixes the model when the process starts (`--model`). The plan manifest is written afterwards, so
  routing cannot read it (§2.2).
- If the agent could declare its own process type, it could name a discovery type to obtain Opus. That is a gaming
  path, and the spec closes it explicitly.
- Discovery work (novel, no approved playbook) must run on the strongest model regardless of budget. Execution work
  that follows an approved playbook can run on a cheaper model; that saving is the payoff of distillation (§10,
  R8).
- A process type is also a security profile: credentials, permission mode, tool set, read-only flag, plan
  requirement, rollover threshold and diagnosis budget.

## Decision

1. Sessions start only through `aoc run --type <id>` (or the console, or the intake flow), naming a type from the
   fixed registry [`config/process-types.json`](../../config/process-types.json).
2. The registry is validated by `ProcessTypeSchema` at load. A discovery-class type must use `opus` (or `fable`).
   A read-only type must not have a credential profile.
3. The model comes from `routeModel(type, hasApprovedPlaybook)`: a discovery type gets its `model`; an execution
   type with an approved playbook gets its `executionModel`; anything else gets its `model`. **Budget is never an
   input.**
4. The type fixes the credential profile, `permissionMode`, tool allow and deny lists, `builtinTools` (`--tools`),
   `readOnly`, `requiresPlan`, `rolloverContextPct`, `stallAfterMs`, `diagnosisBudget` and `risky`. All of these are
   recorded in `session.launch_requested` meta (`processType`, `model`, `readOnly`, `credentialProfile`).
5. A changed registry file is detected by hash at startup and recorded as `registry.changed`. The registry lives
   under `config/`, which is a protected path of the self-modification boundary.

## Consequences

- **Good:** nothing inside a session can change its model or privileges. Model spend is attributable to a type and
  comparable between discovery and execution runs, which feeds the registry hero chart (§12). Security profiles are
  reviewed in one file.
- **Bad: humans still choose.** A developer can pick an expensive type for routine work. That is visible and
  metered (cost per run per type), but not prevented, because the spec leaves model choice to people and
  playbooks, not to budget.
- **Bad: switching type** in the middle of a thread needs a new session (a launch or a rollover). The registry is
  read at startup, so edits apply only after a restart and are audited only after the fact (`registry.changed`).
  Edits to `config/` therefore go through review.
- **Required:** the supervisor must pass `--model` explicitly, re-pass the same flags on every `--resume`, and never
  read a model or type from agent output.

## Implementation status (integration commit `e97e53e`)

The registry's `tools.allow` and `tools.deny` are where the shell a builder may use is decided. The shipped writer
types grant scoped git verbs only, and the supervisor adds blanket `Bash` to a writer type whose entry says nothing
about Bash. Which of the two is the policy is an open CEO decision (threat model O-30, gap P-26). The registry also
lists a `rollback-verify` type that nothing launches: rollback verification runs through `runIsolated`.

## Alternatives rejected

| Alternative | Why rejected |
| --- | --- |
| The agent declares its type, or routing reads the manifest | A gaming path (§2.2), and the model is already fixed by then |
| Budget-driven model selection | Puts discovery work on cheap models and corrupts outcomes (R8); the spec says credits never pick the model |
| Switching model mid-session (`/model`) | Not observable at the tool boundary, breaks cost attribution, and defeats the registry |
| A free-form `--model` on `aoc run` | Bypasses the registry's security profiles and the discovery-on-Opus rule |

## References

- `packages/contracts/src/registry.ts` (`ProcessTypeSchema`, `routeModel`), `packages/contracts/src/services.ts`
  (`RegistryService.modelFor`)
- `packages/contracts/src/events/core.ts` (`session.launch_requested`), `packages/contracts/src/events/registry.ts`
