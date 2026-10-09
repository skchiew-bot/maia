# Security review — wave 2

Fixes for the findings wave 1 reported but did not fix ([`review-wave1.md`](review-wave1.md), "Reported"): **R-02, R-05,
R-07, R-08, R-09, R-10, R-11, R-12, R-13**, and a nit from the hooks review (the spool replay budget). R-01, R-03, R-04,
R-06 and G-04 belong to other agents. Every fix has a regression test that fails before the fix and passes after it:
`test/security.test.ts` of the touched package, and for R-02 `packages/supervisor/test/gateway.test.ts` (a real git
client against the real routes over a real socket), with the supervisor's isolation, launch and security tests
updated to the new credential model.

Severity as in wave 1: **High** a token holder, agent or requester can defeat a binding control or take the platform
down · **Medium** partial defeat or data-protection gap · **Low** hardening.

## Summary

| # | Sev | Finding | Status |
| --- | --- | --- | --- |
| R-02 | High | A builder can extract a session's push credential from the model-visible environment | Fixed `b55850b` (draft `cae2425`; aligned with G-04's clone in `655073a`) |
| R-05 | Medium | Evidence packs build on the daemon thread and any builder can trigger them repeatedly | Fixed `5a5a1f0` |
| R-07 | Medium | At-least-once reactors can launch a second session (two writers on `uat/<ticket>`) | Fixed `4834930` |
| R-08 | Low | Usage `firstAt`/`lastAt` are client-chosen and decide the credit period | Fixed `19b0ce1` |
| R-09 | Low | A launch's `cwd` may be any directory | Fixed `d294fb7` |
| R-10 | Low | The rollover brief sits in the successor's system prompt | Fixed `427317d` |
| R-11 | Low | Any builder can close any ticket, even as `withdrawn` | Fixed `21947c2` |
| R-12 | Low | The erase API accepts `.` and `..` as scope ids | Fixed `1890793` |
| R-13 | Low | The observer token has no rate limits | Fixed `4830a80` |
| N-01 | Info | Hooks: the 1 s spool-flush budget also covered the lazy import of the client | Fixed `0246583`, then superseded upstream (`a861c7f` imports the client statically) |

## Fixed

### R-02 High — a builder can extract the session's push credential

`packages/supervisor/src/{push-gateway,supervisor,launch-config,routes,prompts,isolation}.ts`.

**The problem.** The session environment held the type's credential profile (`GIT_SSH_COMMAND` and a copy of the key, or
a token). F-06 redacts the verbatim value in the output API, but the model can print anything it can read, and every
Builder can ask it to: `base64`, a split string, a key file's bytes. Whoever extracts the key holds a deploy credential on a
developer machine (§3, R1).

**The fix: the credential never enters a session.** A profile has two halves. `env`/`files` are the credential, read by
aocd alone; the optional `session` part is what a session gets (read-only values, model-visible by design);
`push.refs` names the branches its sessions may push. A session pushes with `git push aoc <commit>:refs/heads/<branch>`:

- Remote `aoc` is `<publicUrl>/ingest/git/<project>.git`, git's smart HTTP served by the supervisor's routes under the
  ingest prefix, set in the session environment through `GIT_CONFIG_*` (which outranks every config file, so the
  workspace cannot repoint it) and authenticated by the session's ingest token, scoped to that one URL by git's own
  `http.<url>.extraHeader`. A push is accepted only while a turn of the session is running, only from a managed
  session of a credentialed type, and only to its own project's repository.
- aocd receives the push into the project's **service-owned clone** (`<dataDir>/git/<project>.git`, the repository
  mod-change's G-04 clone uses: same path, same init flags, same `origin`), checks every ref against `push.refs`, and
  forwards the allowed ones to the operator-configured `origin` through `runIsolated` with the profile's credential.
- **Always refused, whatever a profile says:** `main`, `master`, `production`, `HEAD`, `release/*` and rollback
  evidence branches (in any letter case), tags and anything outside `refs/heads/`, deletions, invalid ref names.
  Upstream pushes are never forced. A push naming one refused ref is refused whole.
- **What git executes is what was checked.** The command section handed to `git receive-pack` is rebuilt from the
  parsed commands with only the capabilities the gateway speaks, so a parser differential, a side band, `atomic` or
  push options cannot change what runs. The request body is bounded after gzip, and a request that goes quiet for 60 s
  is dropped, so neither a gzip bomb nor a stalled upload can hold the CPU or the project's push lock; a request that
  breaks off kills the child.
- Per-session sliding-window rate limit (30 per 10 minutes, 429 with `Retry-After`), 100 refs per push, 256 MiB per
  pack (`receive.maxInputSize`; the kernel and daemon give the path its own body cap), `fsck` on receive, one push at a
  time per project, hooks/fsmonitor/gc off (the kernel's `GIT_SAFETY_ARGS`), `refs/aoc`, tags and rollback evidence
  hidden. A failed ref is put back in the service repository. Outputs are redacted, and git's stderr (which can carry a
  URL with a token) is never relayed: the model sees `fatal: remote error: aoc: …` at advertise time or a per-ref
  summary.
- Every push is a `session.git_pushed` event: counts and the profile name in the clear chain, ref names and shas in
  the encrypted body. The system prompt (rule 9) names the remote and the branches the profile allows with the
  session's own ids filled in; mod-intake's build prompt tells the builder to `git push aoc HEAD:refs/heads/uat/<ticket>`.

**Tests** (`packages/supervisor/test/gateway.test.ts`; fail before, because the session held the key and there was no
gateway): an allowed branch reaches upstream with the credential only aocd holds, and the credential is in no
environment variable, session file or key copy (also at OS level in `isolation.test.ts`, with real session users);
`main`, `release/*`, unlisted branches, tags and deletions are refused, a mixed push whole; placeholders expand to the
session's own ids; an upstream refusal is reported and the service repository restored; no `origin`, or an `ext::`
one, forwards nothing; size, rate, gzip and other encodings; a token works only during a turn, only for its own project,
and only at its own URL; and, on the gateway class itself, a broken, stalled or bombing request, rebuilt commands and
case-insensitive protected branches.

**Operator action.** Existing profiles files keep working for aocd's own commands, but a profile with only `env`/`files`
no longer reaches its sessions: add `push.refs` and, if a session itself must read something, a `session` part
([runbook §4, items 5 and 11](../runbooks/credential-isolation.md)).

### R-05 Medium — evidence packs block the daemon thread

`packages/mod-evidence/src/{jobs,pack,index}.ts`, `packages/contracts/src/dto/evidence.ts`.
A pack (up to a year of events, a whole-chain verification, a zip) ran synchronously for any Builder who asked, and every
managed hook timed out and failed closed meanwhile. The build now hands the event loop back every ~10 ms (event pages,
verification steps via `verifyChainAsync`, between sections) and deflates in worker threads (identical bytes). One pack
builds at a time: an uncontended request is answered 201 as before; while one builds, a request is queued (202, with a
job at `GET /api/evidence/jobs/:id`); a caller with a pack pending, over 12 an hour, or facing a full queue (4) gets 429
with `Retry-After`. Test: "evidence packs never hold the daemon thread (R-05)".

### R-07 Medium — a replayed reactor launches a second session

`packages/supervisor/src/supervisor.ts`, `packages/mod-intake/src/flow.ts`, `packages/contracts/src/services.ts`.
Reactors run at least once. A crash between a launch and the reactor's follow-up event replayed the launch: a ticket
could get a second build session, and the triage reactor's guard stranded a half-started triage for good.
`LaunchRequest` gains `idempotencyKey`; the supervisor chains a hash of (actor, key) on `session.launch_requested` and
answers a repeated key with the session already started, without a second process. The HTTP launch body does not accept
the key (callers outside the daemon cannot claim someone else's launch). Intake keys triage and build launches on the
event it reacts to and drops the guard; a rollover keys its successor on `rollover_started`. Tests: "a redelivered
launch never starts a second process (R-07)", "a redelivered intake reaction never launches a session twice (R-07)".

### R-08 Low — client-chosen usage times

`packages/mod-sessions/src/ingest.ts`. `lastAt` decides the credit period and metering day, and the client chose it: a
token holder could backdate usage into a closed period or forward-date it. Both times must now be timestamps and are
kept within [max(session start, receipt − 1 h), receipt]; what the client claimed stays in the encrypted body when a
value was moved. Test: "usage timestamps are bounded by the receipt time and the session (R-08)".

### R-09 Low — a session can work outside its project

`packages/supervisor/src/supervisor.ts`. A launch accepted any existing absolute directory as `cwd`. It must now
resolve, through symlinks, inside the project's repository or its own directory under `supervisor.workspacesDir`; the
session keeps the physical path and every turn checks again, so a directory swapped for a link between turns is
refused (409 `cwd_outside_project`). Test: "a managed session works only in its own project (R-09)".

### R-10 Low — the rollover brief has system-prompt authority

`packages/supervisor/src/{prompts,supervisor}.ts`. The handoff brief is distilled from records that agent-written text
feeds, yet sat in the successor's system prompt above the untrusted-data rule: injected instructions persisted across
rollover with system authority. The system prompt now holds human-approved text only; the brief opens the first user
turn inside a per-prompt random delimiter (its own tag stripped from it), labelled untrusted data, and is clipped to fit
the argv limit. Test: "frames the brief as untrusted data the predecessor cannot break out of (R-10)".

### R-11 Low — any Builder closes any ticket

`packages/contracts/src/roles.ts`, `packages/mod-intake/src/index.ts`. `POST /api/tickets/:id/close` needed only
`ticket.view_internal`. It now needs `ticket.close_any` (Approver), or `ticket.close_own` (Builder) for a ticket a
session the Builder owns works on; a withdrawal speaks for the requester, so only `close_any` may record it. Test:
"closing a ticket (R-11)".

### R-12 Low — erase API scope ids

`packages/mod-audit/src/routes.ts`. `scopeId` must start with a letter or digit and contain no `..` and no trailing
dot; every id AOC writes still passes. (The body store already mapped `.`/`..` to hashes since F-04; this is defence in
depth.) Test: "the erase API takes scope ids, never path segments".

### R-13 Low — the observer token has no limits

`packages/mod-sessions/src/{rate-limit,ingest,index}.ts`. Per observer token, observed ingest is a token bucket
(default 600 a minute, burst 1000; a spool flush costs one request per item) and so is observed-session creation (60 an
hour). Refusals are 429 with `Retry-After`; buckets run on the injected clock; `observerLimits` overrides the defaults.
Test: "observer tokens are rate limited per token (R-13)".

### N-01 Info — hooks spool budget

`packages/hooks/src/spool.ts`. The 1 s budget for flushing a spool at the end of a hook started before the lazy import of
the client, so a cold import ate it. The budget now starts after the import (`0246583`); the merged client (`a861c7f`)
imports statically and replaced the lazy path, so the upstream version stands.

## Residual risk

- **The gateway authenticates with the session's ingest token, which the model can read (R-01, T-3).** A manipulated
  model can push whatever `push.refs` allows, during a turn, within the rate limit: what it could do with the tool anyway.
  What the key was worth outside AOC is gone. A separate gateway principal needs the same change as O-3 (G-44 did it
  for the sidecar).
- **`isolation: "none"`** (the development default) leaves the profiles file, the keys and the service clone readable
  by sessions of aocd's user. The gateway is a wall only with session isolation on (G-01); production refuses to
  start without it.
- **Credentials that are not git** (a deploy API token, a cloud CLI) have no proxy: do not put one in a profile's
  `env` for a session type; only the `session` part reaches sessions.
- The service clone is a staging copy shared with mod-change. A branch the upstream refused is restored, but its
  objects stay until an operator runs `git gc --prune=now`; the gateway creates SHA-1 clones (a SHA-256 project needs
  the clone created first); deletions and forced pushes are not supported through it; the per-session rate limit lives
  in memory and resets when aocd restarts; one slow upstream push holds the project's push lock for up to its 2 minute
  deadline.
- R-09 constrains where a session *starts*, not what it can read: a session can still open absolute paths it has
  rights to (G-01/R-03 is the control for that).
- R-10 stops the brief from outranking the system prompt; it is still text in the model's context, which can follow
  injected instructions, as any untrusted data can (mitigated, not eliminated).
- R-13 limits each observer token; the token is still a shared bearer per machine (O-6).

## Contract and shared-file changes

- `packages/contracts/src/services.ts`: `LaunchRequest.idempotencyKey?` (R-07).
- `packages/contracts/src/roles.ts`: permissions `ticket.close_own` (Builder) and `ticket.close_any` (Approver) (R-11).
- `packages/contracts/src/events/core.ts`: event `session.git_pushed` (R-02).
- `packages/contracts/src/ingest.ts`: `INGEST_GIT_PREFIX`, `MAX_PUSH_BYTES` (R-02).
- `packages/contracts/src/dto/evidence.ts`: `EvidencePackJobDTO` (R-05).
- `packages/contracts/src/config.ts`: the `credentialProfilesFile` description (the schema is the supervisor's).
- `packages/kernel/src/host/http.ts`, `packages/daemon/src/http.ts`: the gateway path's own body cap (`MAX_BODY_BYTES.push`).
- `aoc.config.example.json`, [`credential-isolation.md`](../runbooks/credential-isolation.md), the threat model
  (§3.6, §3.12, T-3), `architecture.md` and `traceability.md` describe the new credential model.
- Operational: the credential profiles file format (above); `config/process-types.json` is unchanged.
