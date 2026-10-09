# 0004. Enforcement centralised in daemon guards; hooks are thin relays; managed sessions fail closed

- Status: Accepted
- Date: 2026-10-09
- Deciders: Platform architect
- Spec: AOC-SPEC-003 §2.4, §3

## Context

- Hooks cannot inspect reasoning. Of the five decision tests, 1 (main), 2 (production) and 5 (data) can be
  enforced at the tool boundary; 3 (irreversible) and 4 (ambiguity) are self-reported (§2.4).
- Matching command patterns is a speed bump: `bash -c`, scripts and Make targets bypass it. The real wall is
  credential isolation (§3). The hook's job is to turn an attempt into a decision card.
- Verified on Claude Code 2.1.295 ([research](../research/claude-code-integration.md) §2.2, §4.4):
  - `--bare` and `--safe-mode` skip all settings hooks.
  - Settings that fail validation are ignored silently in `-p` mode.
  - A PreToolUse JSON `deny` wins even under `bypassPermissions`.
  - Exit code 2 leaks the hook's full command line into the model's context.
- Hook binaries run as short-lived processes, one per event, on many machines (managed hosts and developer
  laptops). Their versions can drift.
- Policy needs server state: whether a manifest exists, open decisions, the session's process type and read-only
  flag, the registry, and the self-modification paths.

## Decision

1. **The hook is a relay.** It sends `{mode, aocSessionId, hook stdin, sentAt, idempotencyKey}` to `/ingest/hook` and
   applies the `HookIngestResponse` (exit code, stdout JSON, stderr) unchanged. It holds no policy.
2. **Guards live in the daemon.** Modules register `PreToolGuard`s with the kernel's `GuardPolicy`. Guards run in
   `order`, the first non-allow result wins, and **a guard that throws counts as a deny** (it fails closed). The
   guards, all built, in order: `self-modification` (`mod-audit`, 5), `no-manifest` (`mod-ledger`, 10),
   `read-only` (`mod-sessions`, 20) and `protected-op` (`mod-change`, 30).
3. **Denials become decision cards.** A guard can return `raiseDecision`. The daemon then raises the card
   (`protected_operation`), appends `tool.denied` and `session.blocked`, and returns a JSON deny whose reason tells
   the agent which card was raised and to end its turn.
4. **Managed sessions fail closed.** An unknown managed session id gets exit 2 from the daemon. A hook that cannot
   reach the daemon must deny the tool call. A guard error denies.
5. **Observed sessions never block** (§2: "fail loudly" applies to managed sessions only). The ingest does not run
   guards for them, and `GuardPolicy` itself turns any denial for an observed session into an allow with a "would
   deny" note, as a second line of defence.
6. Denials use a JSON `permissionDecision: "deny"` rather than exit 2.

## Consequences

- **Good:** policy changes in one place, under review, and every denial is audited (`tool.denied`,
  `session.blocked`, the decision). Policy can use all server state. Hook binaries stay tiny and do not need
  updating when policy changes.
- **Bad: latency and coupling.** Every tool call of a managed session costs a localhost round trip, within the
  hook client's timeout (≤ 2.5 s on the hot path). An unresponsive aocd stops managed sessions. That is intended,
  but it makes aocd's responsiveness a production concern (ADR-0001).
- **Bad: hooks remain bypassable.** `--bare`, `--safe-mode`, invalid settings, editing `~/.claude/settings.json`,
  or simply working outside Claude Code all avoid hooks. Guards therefore protect against accidents and
  cooperative agents, not against a determined actor. Credential isolation and server-side branch protection carry
  that load ([R1 runbook](../runbooks/credential-isolation.md)).
- **Bad: forgeable events.** The ingest token reaches the hook through the `claude` environment, so the model can
  reach it too. Hook-relayed events are agent-asserted claims, and gates must not trust them alone
  ([threat model T-3](../security/threat-model.md#t-3-the-model-reads-its-own-environment)).
- **Launch checks** (supervisor): the generated settings are validated before launch, and the session is aborted if
  the `aoc` MCP server is not `connected` (both built). A missing `SessionStart` hook event within N seconds should
  also fail the launch; that check does not exist yet (threat model O-15).

## Alternatives rejected

| Alternative | Why rejected |
| --- | --- |
| Policy inside the hook binary | Drifts across machines, cannot see server state, and denials are hard to audit consistently |
| Claude Code permission rules only (`permissions.deny`) | Static, no decision cards, no audit, and just as bypassable |
| Fail open for managed sessions | Unrecorded work proceeds silently, which contradicts "fail loudly" |
| Block observed sessions too | Breaks developers' own Claude Code whenever the server is down; the spec limits fail-closed to managed sessions |
| Exit 2 for denials | Leaks the hook command line into the model context and the transcript |

## References

- `packages/kernel/src/host/policy.ts`, `packages/mod-sessions/src/ingest.ts` (`HookDispatcher`)
- `packages/contracts/src/ingest.ts`, `packages/contracts/src/services.ts` (`PreToolGuard`, `GuardResult`)
- [architecture.md §2.5](../architecture.md), [threat model](../security/threat-model.md)
