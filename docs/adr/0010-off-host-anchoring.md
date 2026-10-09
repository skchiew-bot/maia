# 0010. The chain head is anchored off-host (git and RFC 3161)

- Status: Accepted
- Date: 2026-10-09
- Deciders: Platform architect
- Spec: AOC-SPEC-003 §13, R2

## Context

- "The in-file hash chain alone is defeatable by anyone who can drop the trigger and recompute, so Verify must test
  against the external anchor" (§13). Anyone with write access to `aoc.db` can edit an event and recompute every
  later hash. The genesis value depends only on `chainId`, which is in the same file.
- The spec offers two anchors: a signed commit to a separate repository, or an RFC 3161 timestamp.
- A rewrite is detectable only for events that were **already anchored** when the rewrite happened. Anything
  between the last anchor and the attack can be rewritten and then anchored in its rewritten form. The anchor
  interval is therefore the window of undetectable tampering.

## Decision

1. `mod-audit` runs an anchor job that records `(chainId, seq, hash, timestamp)` of the current head with one of:
   - **`git`**: a signed commit to a separate anchor repository (`audit.anchorRepoPath`), pushed to an **off-host
     remote** (`audit.anchorRemote`) whose branch rules block force-pushes and deletions; or
   - **`rfc3161`**: a timestamp token from a Time-Stamping Authority (`audit.tsaUrl`) over the head hash, stored
     with the anchor record and copied off-host.
2. Each successful anchor appends `anchor.created {anchorId, seq, hash, provider, proofRef}`. A failure appends
   `anchor.failed` and raises an `anchor.missed` notification when the scheduled anchor is missed.
3. **Verify** recomputes the whole chain (`verifyChain({atSeqs})`) and compares the recomputed hash at every
   anchored seq with the **external** record, read from the anchor remote or the TSA tokens, never from
   `anchor.created` rows in the database being verified. RFC 3161 tokens are checked for signature and for time
   consistency. The result is chained as `chain.verified {anchorsChecked, anchorsMatched, firstBadSeq}`.
4. **Cadence.** The spec requires at least nightly (`audit.anchorAtLocalTime`, default 02:00). The recommended
   deployment anchors **hourly**, and also immediately after high-value events: `decision.resolved` for go-live,
   rollback or break-glass, `promotion.completed`, `rollback.executed`, `body.erased` and `config.changed`. Use both
   providers where possible.

## Consequences

- **Good:** tampering with anything anchored is detectable by anyone holding the anchor, without trusting the AOC
  host. It is cheap (one commit or one TSA request per anchor) and easy to explain to an auditor.
- **Bad: the window.** Events newer than the last anchor are unprotected against a host-level attacker. Cadence is a
  risk knob, owned by the platform architect.
- **Bad: the git anchor is only as strong as the remote's rules** and the account that holds them. If the aocd host
  key can force-push, the anchor is worthless. A signature made with a key that lives on the aocd host proves little
  by itself; the protection comes from the off-host, append-only history.
- **Bad: the TSA anchor depends on the TSA.** The default `freetsa.org` is a free service with no SLA. Use a
  commercial or qualified TSA for compliance evidence.
- **Bad: the defaults are local only.** The default (`git` with no `anchorRemote`) only commits to a local repo, which
  gives **no** protection against a host-level attacker. Production must configure a remote
  ([anchoring runbook](../runbooks/anchoring.md)).

## Implementation status (integration commit `a1c8a0c`)

`mod-audit` implements the decision with these differences, tracked in the threat model (O-11, O-29):

- **Built:** both providers (one at a time, chosen by `audit.anchorProvider`); the nightly job (governed-config
  check, anchor with two retries, then Verify); `aoc anchor` and `aoc verify`; Verify fetches the remote and
  compares it with the local anchor repository; anchoring refuses a chain that no longer matches earlier
  anchors, so a rewritten history is never anchored; RFC 3161 imprint and time checks (at most 1 h of skew).
- **Done since:** hourly anchors and anchors right after high-value events (gap G-40,
  `audit.anchorIntervalMinutes`, `audit.anchorAfterEvents`); every decision a person resolves counts, not only
  go-live, rollback and break-glass.
- **Not yet:** anchor-commit signing and the TSA certificate
  check exist as module options that `aocd`'s configuration cannot set, so the default build signs nothing and
  checks no TSA signature.
- **Done since:** evidence packs confirm anchors against the external records through mod-audit's Verify, and
  say `not_verifiable` when those records are unavailable (gap G-42).
- **Caution:** if the remote cannot be fetched, Verify falls back to the local copy with a warning. Treat that
  warning as a failed check.

## Alternatives rejected

| Alternative | Why rejected |
| --- | --- |
| The in-file chain plus triggers only | R2: defeatable by recomputation |
| Anchoring to a public blockchain | Cost and operational complexity. OpenTimestamps can be added later as a third provider |
| WORM object storage alone | Vendor-specific and still needs a verification protocol. Worth adding as a backup sink, not as the anchor |
| A public transparency log (Rekor) | Viable later. A public log of hashes and timing is unnecessary exposure for v1 |

## References

- `packages/kernel/src/store/event-store.ts` (`verifyChain`, `hashesAt`)
- `packages/contracts/src/events/audit.ts` (`anchor.*`, `chain.verified`), `packages/contracts/src/config.ts`
  (`audit.*`)
- [anchoring runbook](../runbooks/anchoring.md)
