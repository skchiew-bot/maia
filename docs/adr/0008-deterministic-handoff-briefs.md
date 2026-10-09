# 0008. Context rollover uses deterministic handoff briefs

- Status: Accepted
- Date: 2026-10-09
- Deciders: Platform architect
- Spec: AOC-SPEC-003 §5, R16

## Context

- A project thread outlives any one Claude Code context. When context grows large, the supervisor launches a fresh
  session seeded with a compact handoff brief. The code is the source of truth, not the transcript (§5).
- Rollover is an audited event. It happens only at clean task boundaries (never mid-migration or mid-deploy), and
  the brief is validated against the manifest and open decisions before the old session retires (§5). Losing a
  constraint in a rollover during a risky operation is risk R16.
- An LLM-written summary is non-deterministic and can silently drop or invent constraints. Nobody can verify it
  afterwards.
- Claude Code's own compaction (`/compact`, auto-compaction) works in place. It is lossy, not validated against
  anything, and its usage appears only as overhead in the cumulative totals
  ([research](../research/claude-code-integration.md) §6.3, §7.5).

## Decision

1. `LedgerService.buildHandoffBrief(threadId, fromSessionId)` is a **deterministic** function of the event log. It
   produces the manifest status (phases, done and open tasks with acceptance text), key decisions **with their
   reasons**, open decision ids and file pointers, as a `HandoffBrief` with a `hash`.
2. `validateBrief(brief)` checks that every open task and open decision is present. Any problem aborts the rollover
   (`session.rollover_aborted {problems}`), and the old session keeps the thread.
3. Triggers: context tokens above the type's `rolloverContextPct` of the model's window (default 70 %; 85 % for
   `migration`). It then happens at the next clean boundary, where `task_done` returns
   `{continue: false, reason: rollover}` and `boundaryState()` reports no half-done task and no risky playbook
   step. `risky` types never roll over mid-operation.
4. Sequence: `session.rollover_started {contextTokens, contextPct, briefHash}` with the brief in the payload, then
   the successor launches with the brief as opening context, the writer lock moves to the successor, the old
   session ends as `retired`, and `session.rollover_completed` closes it out. There is one active writer per thread
   throughout.
5. The supervisor sets Claude Code's auto-compaction threshold above the rollover threshold (`--autocompact`), so
   AOC's rollover happens first.

## Consequences

- **Good:** reproducible. The same log yields the same brief, and its hash is in the chain. Validation catches
  dropped tasks and decisions. No LLM cost, nothing hallucinated. Rollover can be audited and replayed.
- **Bad: no tacit context.** The brief does not carry reasoning that lives only in the transcript. Constraints must
  be recorded where the brief can see them: as decisions with reasons, as manifest acceptance text, or in the code
  and its documentation. This is deliberate: it pushes knowledge into durable places.
- **Bad: deferral.** A session that never reaches a clean boundary cannot roll over. Its context keeps growing until
  a task completes. Very large tasks should be split at planning time.

## Alternatives rejected

| Alternative | Why rejected |
| --- | --- |
| An LLM summary of the transcript | Non-deterministic, unverifiable, and can drop or invent constraints (R16) |
| Rely on `/compact` or auto-compaction | In place, lossy, not validated against the manifest; usage hidden as overhead |
| Parallel writer sessions on one thread | Merge conflicts, and it breaks the single-writer rule (§5) |
| Never roll over | Quality and cost degrade as context fills |

## References

- `packages/contracts/src/services.ts` (`LedgerService.buildHandoffBrief`, `validateBrief`, `boundaryState`)
- `packages/contracts/src/events/core.ts` (`session.rollover_*`), `packages/contracts/src/registry.ts`
  (`rolloverContextPct`, `risky`)
