# Architecture Decision Records

Each record captures one decision behind AOC: the forces that led to it, what was decided, what it costs, and
which alternatives were rejected and why. The binding requirements are in
[AOC-SPEC-003](../spec/AOC-SPEC-003.md), and the system overview is in [architecture.md](../architecture.md).

| ADR | Decision | Spec | Status |
| --- | --- | --- | --- |
| [0001](0001-modular-monolith-event-sourcing-single-writer.md) | A modular monolith with event sourcing and one writer (aocd) | §2, §13, §15.1 | Accepted |
| [0002](0002-node-sqlite-wal.md) | `node:sqlite` in WAL mode as the store | §15.1 | Accepted |
| [0003](0003-blinded-payload-hashes-per-scope-keys.md) | Blinded payload hashes and per-scope encryption keys | §7, §13 | Accepted |
| [0004](0004-enforcement-in-daemon-guards.md) | Enforcement centralised in daemon guards; hooks are thin relays; managed sessions fail closed | §2.4, §3 | Accepted |
| [0005](0005-process-type-fixed-at-launch.md) | The process type, and so the model, is fixed at launch | §2.2, §10 | Accepted |
| [0006](0006-waits-end-the-turn-and-resume.md) | Waits end the turn and resume later; no idle processes | §2.3 | Accepted |
| [0007](0007-credits-at-task-boundaries.md) | Credits are enforced only at task boundaries | §10, R7, R8 | Accepted |
| [0008](0008-deterministic-handoff-briefs.md) | Context rollover uses deterministic handoff briefs | §5, R16 | Accepted |
| [0009](0009-decisions-as-one-engine.md) | All human decisions run through one engine | §6, §8, §10, §11 | Accepted |
| [0010](0010-off-host-anchoring.md) | The chain head is anchored off-host (git and RFC 3161) | §13, R2 | Accepted |
| [0011](0011-infographic-first-ui-numbers-as-text.md) | An infographic-first UI that always shows numbers as text | §12 | Accepted |

## Conventions

- **File name:** `NNNN-short-title.md`. Numbers are never reused.
- **Status:** `Proposed`, `Accepted`, `Superseded by NNNN` or `Rejected`. An accepted ADR is not edited for
  substance; a new ADR supersedes it. Typos and links may be fixed.
- **Sections:** Context, Decision, Consequences, Alternatives rejected, References.
- **Governance core:** ADRs 0001, 0003, 0004, 0007, 0009 and 0010 describe the governance, audit and credit core.
  Superseding any of them is a change to the core and needs human review
  ([self-modification boundary](../compliance/self-modification-boundary.md)).

## Template

```markdown
# NNNN. Title

- Status: Proposed
- Date: YYYY-MM-DD
- Deciders: …
- Spec: AOC-SPEC-003 §…

## Context
The forces at play: requirements, constraints, facts (with evidence).

## Decision
What we do, stated so that it can be checked in code review.

## Consequences
What gets easier, what gets harder, and the new risks and how they are handled.

## Alternatives rejected
Each option, and why it lost.

## References
```
