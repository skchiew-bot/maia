# Security review: wave 4 (invariants and authorization hunt)

Not a reading review: a hunt with tests. An agent wrote seeded property, concurrency and authorization tests against
the invariants this platform promises (the chain verifies, a rebuild equals the live state, erasure leaves no
plaintext, every route checks who is calling), and fixed what failed. Every defect below has a test that failed first.
Like the other waves, it was done by an agent and has not been reviewed by a human; three of the files it changed are
governance core (see the end), so [gap P-06](../compliance/gaps.md) applies to them.

Merged as `9c69286`; the lead branch at `b4fdf57` contains it. Finding ids are `W4-n`. The earlier waves are
[wave 1](review-wave1.md), [wave 2](review-wave2.md) and [wave 3](review-wave3.md).

## The 13 defects

| # | File | Defect, and what it does now | Commit |
| --- | --- | --- | --- |
| W4-01 | `packages/kernel/src/store/event-store.ts` | `verifyChain` and `verifyChainAsync` threw on a row whose `meta` or `scope_json` was not JSON, so one corrupt row stopped Verify. Now it reports `ok: false` at that seq | `87eccbd` |
| W4-02 | `packages/kernel/src/store/event-store.ts` | `verifyBody` threw for a tampered body (the audit event-detail route and restore answered 500). Now it returns `false` | `87eccbd` |
| W4-03 | `packages/kernel/src/store/event-store.ts`, `body-store.ts` | `eraseScope` shredded the bodies before the `body.erased` record was validated and appended, so a failing record left shredded bodies with no record in the chain. Now it is write-ahead: the record is validated and appended first | `87eccbd` |
| W4-04 | `packages/kernel/src/store/event-store.ts` | A projection rebuild stopped at the first event a projector threw on, so one accepted poison event could stop aocd from starting. Now each projector is isolated with savepoints and marked `degraded`, as on the live path | `659d098` |
| W4-05 | `packages/kernel/src/store/event-store.ts` | `write()` gave projectors, listeners and callers the caller's own objects, while a rebuild reads canonical JSON, so live and rebuilt state differed (key order, `undefined` members, wide actor objects). `write()` now normalises first. Found through `mtr_ratecards.rates_json` and `mtr_rollups.breakdown_json` | `4bdd9a8` |
| W4-06 | `packages/kernel/src/store/event-store.ts` | SQLite's `secure_delete` leaves cells that a b-tree rebalance moved in the unallocated gap of reused pages, so erased text (message ids) stayed in raw `aoc.db` outside every table and the WAL (reproduced in a standalone SQLite script at about 0.7 % of layouts). `eraseScope` now runs `VACUUM` after the shred, then truncates the WAL. A `VACUUM` runs in the daemon's thread for as long as it takes to rewrite `aoc.db` | `004bbf9` |
| W4-07 | `packages/kernel/src/store/event-store.ts` | `wal_checkpoint(TRUNCATE)` returns busy while a reader holds a snapshot (the backup's `VACUUM INTO` worker), which left pre-erasure pages on disk without a signal. Now a warning is logged | `33dec29` |
| W4-08 | `packages/mod-identity/src/projector.ts` | Erasing a person left passkey `transports`, `device_type`, `backed_up` and the registration counter, which a rebuild clears. Now the live scrub empties every passkey column | `c29c55c` |
| W4-09 | `packages/supervisor/src/routes.ts` | Prompt, nudge, restart, stop and rollover looked the session up before authenticating, so 404 against 401 told an unauthenticated caller which session and thread ids exist (and a requester got 404, not 403). `requireDriverRole` now runs first | `7f1816d` |
| W4-10 | `packages/mod-learning/src/routes.ts` | `report_error` chained the agent's idempotency key verbatim: client text in the clear chain that can never be erased. It is now hashed, like hooks and usage | `7f1816d` |
| W4-11 | `packages/mod-sessions/src/ingest.ts`, `projector.ts` | A usage `lastAt` of `not-a-date` was accepted, the projector threw, the projection went degraded, and aocd failed to start on every restart: any holder of a session token could brick aocd. Client timestamps, token counts and message ids are now validated at ingest, the projector tolerates old bad rows, hook body fields are typed (500 became 422), and erasing a person, project or session now scrubs the session directory and equals a rebuild | `a95237b` |
| W4-12 | `packages/mod-ledger/src/mcp-handlers.ts`, `projector.ts`, `packages/mod-tower/src/projector.ts`, `packages/contracts/src/events/ledger.ts` | An erased plan manifest lost its tasks, phases and denominator on replay (progress inflated, the next `task_done` answered 422). `plan.declared` and `plan.amended` now carry `meta.shape` (ids and sizes only), and replay keeps the shape | `76b745b` |
| W4-13 | `packages/mod-sessions/src/ingest.ts` (`isReadOnlyBash`) | The read-only Bash guard passed a second command after a newline, `cat <(cmd)`, `git branch -D` and branch creation, `--output=file`, `rg --pre`, `tree -o`, `file -C` and look-alike programs (`ls-evil`, `cat.sh`, `git log-evil`). It is now one simple inspection command, with linear-time patterns. The primary control is unchanged: `bug-triage` has no `Bash` | `ff45949` |

## Governance-core files this wave changed (§13)

These need the human review of [the self-modification boundary](../compliance/self-modification-boundary.md#5-the-go-live-code-review):

- `packages/kernel/src/store/event-store.ts`: W4-01 to W4-07 (the verifier, `verifyBody`, write-ahead erasure, rebuild
  isolation, normalisation in `write()`, the `VACUUM`, the busy-checkpoint warning). The chained bytes are unchanged:
  existing logs verify as before.
- `packages/kernel/src/store/body-store.ts`: `countScope`, a read-only helper for the pre-count of an erasure.
- `packages/kernel/src/testing/random.ts` (and one export line in `packages/kernel/src/index.ts`): the seeded `Rng` and
  `forSeeds` test kit.
- `packages/mod-identity/src/projector.ts`: W4-08.

`mod-audit`, `mod-credits` and `mod-decisions` changed in tests only: their erase, credit and decision rules held
(decisions over 80 seeds, credits over 60).

## Tests added

All seeded; a failing seed is printed, `AOC_SEED=<n>` replays it and `AOC_SEEDS=<count>` runs seeds 1 to count for a soak (see
[testing](../testing.md)).

- kernel: `chain-properties`, `chain-tamper`, `body-integrity`, `rebuild-resilience`, `projection-input`,
  `erase-residue` (pinned seeds 187 and 269 fail without the `VACUUM`).
- daemon: `authz-matrix` (every route against nine principals), `authz-attacks`, `authz-surface`, `event-meta` (a lint
  of what the catalog's `meta` may hold), `ingest-fuzz`, `projection-purity` (a rebuild equals the live state, and
  erasing every kind of scope leaves no plaintext in tables, FTS terms, or the raw database and WAL),
  `credits-properties`, `usage-pipeline`.
- mod-decisions, mod-ledger, mod-sessions, mod-metering, mod-identity: property and erasure tests. The new
  cost-per-outcome ringgit figures match an independent oracle over 400 seeds, with no defect.

## Found and not fixed

These are recorded in the [gap list](../compliance/gaps.md) (G-57 and the residual risks):

- **Usage dedupe against growth.** The server drops a batch whose message ids were all seen, and the sidecar's
  idempotency key hashes the id set, so a message that grows across two flushes can lose its growth when the second
  window holds nothing new. The real CLI 2.1.295 prints identical usage on every line of a message, so nothing is
  lost today; other versions could under-count. The fix needs per-message amounts on the wire (a contract change).
- **Erasure crash window.** A crash between appending `body.erased` and the shred leaves the bodies recoverable with
  the record chained; the operator re-runs the erasure. An automatic reconcile at start is unsafe as written, because
  later bodies in the scope reuse the old data key.
- **Erase and backup are not serialised.** With a backup reading, the erasure cannot truncate the WAL (now logged).
- `dec_notices` (decision alert dedupe) lives outside the log by design; `GET /api/audit/verify` appends an event;
  decision-card flooding by a session (O-16, T-17) is not addressed; truncating the tail of the chain is visible only
  against the off-host anchors; the push gateway's positive path is covered only by the supervisor tests.
- A doc nit in `OutcomeCostItemDTO.notionalRm` was fixed in the contract (`b4fdf57`): null when priced usage has no
  rate, 0 when the usage cost US$0.
