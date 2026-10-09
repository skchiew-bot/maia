# 0002. `node:sqlite` in WAL mode as the store

- Status: Accepted
- Date: 2026-10-09
- Deciders: Platform architect
- Spec: AOC-SPEC-003 §15.1 ("append-only hash-chained SQLite (WAL)")

## Context

- The spec asks for append-only, hash-chained SQLite in WAL mode (§15.1).
- AOC must install with `pnpm install` on a developer workstation or a small server, with no native compilation
  step and no separate database server.
- Node ≥ 22.13 ships `node:sqlite` (`DatabaseSync`): a synchronous, built-in SQLite binding.
- The single-writer design (ADR-0001) benefits from a synchronous API. An append, its projections and the commit
  all happen inside one event-loop turn, with no interleaving.
- The console reads while sessions write. WAL lets readers proceed while a write is in progress.

## Decision

- Use `node:sqlite` with `PRAGMA journal_mode = WAL`, `synchronous = NORMAL` and `foreign_keys = ON`.
- Use two database files in `dataDir`:
  - `aoc.db`: the `events` chain, `chain_info`, projection tables, `projection_health`, `reactor_cursors`,
    `reactor_failures` and `job_runs`.
  - `bodies.db`: wrapped data keys, encrypted bodies and blob metadata, with `secure_delete = ON` so erased pages
    are zeroed.
- Store large encrypted blobs as files under `dataDir/blobs/<scope>/` (mode 0600).
- Make `events` append-only to the application with `BEFORE UPDATE` and `BEFORE DELETE` triggers. (These are not
  a security control against someone with file access; see ADR-0010.)
- Tests use `:memory:` databases. Node is pinned by `engines` (`>=22.13`).

## Consequences

- **Good:** no native build (unlike `better-sqlite3`) and no server to run. Atomic multi-event appends
  (`BEGIN IMMEDIATE` … `COMMIT`). Fast local reads for projections. Simple, well-understood backups.
- **Bad: platform maturity.** `node:sqlite` is newer than the Node runtime around it. Behaviour must be re-tested on
  every Node upgrade, and the runtime is pinned in production.
- **Bad: blocking.** Synchronous calls block the event loop. Long queries in request handlers delay ingest and
  hooks. Keep queries indexed and bounded (`list()` caps at 100,000 rows; API reads should page) and run rebuilds
  in a maintenance window.
- **Bad: durability window.** With `synchronous = NORMAL` in WAL mode, a power loss or OS crash can lose the
  most recent committed transactions. The database stays consistent, but a few recent events can be lost. The
  sidecar and observed hooks retry or spool, but some managed hook events would be gone. If the CEO wants
  power-loss durability for the audit log, set `synchronous = FULL` on `aoc.db` and accept slower appends. This is a
  recorded trade-off, and it is revisited if the log ever carries regulated records.
- **Backups:** never copy `aoc.db` alone while aocd runs. The `-wal` file holds committed data. Use the SQLite
  online backup (`VACUUM INTO`, or the backup API) or stop the service first
  ([operations](../runbooks/operations.md#6-backups)).
- **Scale ceiling:** one host and one writer. Moving to several hosts would mean moving to a server database
  (PostgreSQL), with a single sequencer for the chain. The kernel isolates SQL in the store and projectors to
  keep that path open.

## Alternatives rejected

| Alternative | Why rejected |
| --- | --- |
| `better-sqlite3` | Same semantics, but a native module that must compile on every machine |
| PostgreSQL | A separate server to install, secure and back up; concurrency is not needed with one writer. It stays the upgrade path for multi-host |
| Rollback journal (no WAL) | Readers block writers, so the console would stall ingest |
| LMDB, RocksDB or JSON files | No SQL for projections, no transactional multi-table updates, or no atomicity at all |
| SQLCipher (encrypt the whole database) | Native dependency. Whole-database encryption does not allow erasing one scope (ADR-0003) |

## References

- `packages/kernel/src/store/event-store.ts`, `packages/kernel/src/store/body-store.ts`
- ADR [0001](0001-modular-monolith-event-sourcing-single-writer.md), [0003](0003-blinded-payload-hashes-per-scope-keys.md)
