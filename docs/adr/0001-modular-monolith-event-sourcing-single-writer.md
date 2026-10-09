# 0001. A modular monolith with event sourcing and one writer

- Status: Accepted
- Date: 2026-10-09
- Deciders: Platform architect; scope approved by the CEO in AOC-SPEC-003
- Spec: AOC-SPEC-003 §2, §13, §15.1

## Context

- The product **is** the audit trail. One append-only, hash-chained event log has to be both what the CEO sees and
  what the auditor sees (§13). Every other feature (progress, metering, credits, decisions, change control) is a
  view of, or a reaction to, that log.
- Hooks fire concurrently, as separate short-lived processes. If several processes appended to a hash chain, two of
  them could read the same head and both link to it. The chain would fork, and nobody could later tell which branch
  is the truth. The spec makes the ingest daemon the sole writer for exactly this reason (§15.1).
- The team is small, runs on one host, and needs to install AOC on a developer workstation in minutes. Roughly 20
  agents build the code in parallel, so module boundaries must be explicit and testable in isolation.
- Read models change often (new console views, new projections). Rebuilding them from history must be routine, not
  a migration project.

## Decision

1. **One process, `aocd`, is the only writer.** It hosts the HTTP API, ingest, SSE, the job scheduler, the
   launcher/supervisor and every domain module. Nothing else opens the database. Hooks, the MCP server, the
   sidecar, the CLI and the browser talk to aocd over HTTP.
2. **Event sourcing.** Every state change is a catalog event (`packages/contracts/src/events`) appended through
   `EventStore.append()`. Writes are synchronous and serialised by the Node event loop, so the chain cannot fork.
   Domain tables are written only by projectors, inside the append transaction. Follow-up work is done by reactors
   after commit, at least once, using cursors and causation ids.
3. **A modular monolith.** Each domain module (`packages/mod-*`) exports an `AocModule` (events, projectors,
   reactors, guards, routes, jobs, services). Modules depend only on the service interfaces in
   `contracts/services.ts`, which are resolved through a typed service registry, never on each other's code.
   Shared types and the event catalog live in `packages/contracts`, owned by the lead.

## Consequences

- **Good:** a single serial log, so no fork is possible and ordering is total. One audit trail covers sessions,
  decisions, money and code movement. Read models are disposable and rebuildable. Modules are testable on their
  own with the kernel test kit (`createTestRuntime`). Deployment is one service plus small helper binaries.
- **Bad: availability.** aocd is a single point of failure. When it is down, managed sessions stop at their next
  hook (they fail closed, by design: "fail loudly", §2) and observed sessions buffer locally. Mitigations are
  backups and a restore drill (R6, [key custody](../runbooks/key-custody.md)), a supervised service, and a
  [health checklist](../runbooks/operations.md).
- **Bad: throughput.** One writer bounds throughput, but the load is small (by default at most 8 concurrent
  sessions, each producing tens of events per minute). Projections run inside the append transaction, so slow
  projector code slows ingestion. Projectors must stay simple and indexed.
- **Bad: blocking.** Anything synchronous and long in aocd (a projection rebuild, a large query) blocks the event
  loop, and with it the hooks of every managed session. Those hooks then time out and fail closed. Long work is
  bounded, paged, or done in a maintenance window.
- **Schema evolution:** events are forever. Change a type by adding a new type or an optional field, never by
  changing the meaning of an existing field. The hash header carries `v: 1` so the hashing scheme itself can be
  versioned.

## Implementation status (integration commit `e97e53e`)

The mitigations for blocking are built, except for projection rebuilds:

- The kernel's and the ledger's git calls run off aocd's thread, each with its own time limit.
- Evidence packs are built by a queued job, and chain verification hands the event loop back between batches.
- A backup snapshots the databases in a worker thread.
- On SIGTERM the modules quiesce while the HTTP server still answers (the supervisor interrupts running turns and
  lets each sidecar send its last usage), then the server drains, then the runtime stops
  ([architecture §2.1](../architecture.md)).
- A projection rebuild still holds the write lock. It is maintenance: it runs at startup or in a window.

## Alternatives rejected

| Alternative | Why rejected |
| --- | --- |
| Each hook or helper writes to SQLite directly | Concurrent writers fork the chain; every helper would need database access and the key material; policy would be spread across binaries |
| Microservices with a message broker | Too much to operate for a small team on one host. The audit log needs one global order, which brings back a single sequencer anyway, with more attack surface |
| A CRUD database with an audit table on the side | The audit trail becomes a side effect that can drift from the state it claims to describe. It cannot be rebuilt or verified |
| A dedicated event store (EventStoreDB, Kafka) | An extra server to run and secure. No per-scope crypto-shred. The hash chain would still need a single writer |

## References

- [architecture.md §2, §5](../architecture.md)
- `packages/kernel/src/store/event-store.ts`, `packages/kernel/src/host/runtime.ts`
- ADR [0002](0002-node-sqlite-wal.md) (storage), [0004](0004-enforcement-in-daemon-guards.md) (enforcement)
