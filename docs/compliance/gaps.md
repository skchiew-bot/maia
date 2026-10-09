# AOC-SPEC-003 gap list

Every Partial / Missing row of [traceability.md](traceability.md), grouped into fixes small enough to hand to one
engineer. Baseline: integration `fb97e98` (978 tests, 976 pass, 2 fail).

* **P0** — breaks a binding control or the §3 make-or-break. Nothing ships to real users before these close.
* **P1** — binding requirement only partly met, or a contract defect that silently loses audit/metering data.
* **P2** — polish, missing tests, hardening.

Process items the CEO must own are at the end (P-xx). They cannot be fixed in code.

## P0 — software

### G-01 Supervisor: credential-isolated launch (`POST /api/sessions`)
Spec: §2.1, §2.2, §3, §5 (single writer), §9 (project/phase at launch), §10 (boundary check), R1, R4.
Rows: S2.1-a, S2.2-a/b, S2.4-c, S2-e, S2-k, S3-a, S3-b, S3-d, S4-g, S5-d, S5-i, S7-b/c/m, S9-b, S10.3-a, S11.1-d/e.

**Module:** `packages/supervisor` (in flight). **Change** — `SupervisorService.launch` + `POST /api/sessions`:
1. Resolve the type with `registry.getType`; model = `registry.modelFor(type)` (never from the request).
2. Build the session env **only** from `supervisor.envAllowlist`, then: give each session its own `HOME` and
   `CLAUDE_CONFIG_DIR` under `workspacesDir` (the default allowlist passes `HOME` through, which exposes the
   daemon user's `~/.ssh`, `~/.git-credentials` and global git credential helpers to every session's Bash),
   set `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_TERMINAL_PROMPT=0`, then merge the named profile from
   `credentialProfilesFile` **only** when `!type.readOnly && type.credentialProfile`.
3. Read-only types: `--tools Read,Glob,Grep` (`builtinTools`), `--disallowedTools` from `tools.deny`, no profile.
4. `ledger.ensureThread` + `ledger.acquireWriter` (refuse with 409 if another live writer holds the thread).
5. `credits.checkBoundary(sessionId, null, actor)` before spawning; refuse a capped launch with the instruction.
6. `identity.issueIngestToken(sessionId)` → `AOC_INGEST_TOKEN` for hooks, MCP server and sidecar; start the
   sidecar; `installGitHooks(<workspace>/.git/hooks)`; write managed hook settings + `.mcp.json`.
7. Opening prompt: require `mcp__aoc__declare_plan` first; append `learning.lessonsForScope(...)` and call
   `learning.recordLessonsApplied(ids, sessionId, actor)`.
8. Append `session.launch_requested` (human actor = owner), `session.launched`, `session.lifecycle_changed`.

**Tests to add** (with `@aoc/claude-sim`): env snapshot of a launched session contains no deploy variables,
`HOME` ≠ the daemon's, no `~/.ssh` reachable; a `bug-triage` launch has no profile and `--tools Read,Glob,Grep`;
the launched `--model` equals `modelFor(type)` for discovery and for execution-with-playbook; a second writer on
the same thread gets 409; a capped owner gets the cap instruction and no process; `lesson.applied` is appended.

### G-02 Supervisor: turn-end handling and resume with the answer injected
Spec: §2.3 (binding), §10 (aging top-up state, not a stall), R15. Rows: S2.3-a/b/c, S10.3-g.

**Change:**
* Map every turn end to a lifecycle: open decision → `waiting_decision`; `boundary.reason=credit_cap` →
  `blocked` (reason `credit_cap`); throttle → `throttled`; stop requested → `ended`. Today a capped session that
  ends its turn stays `running` and decays to **Stalled**.
* Reactors: `decision.resolved` (session-scoped kinds) → `resume(sessionId, answerText, 'decision_answered')`
  via `claude -p --resume <claudeSessionId>`; `credit.topup_granted` → resume `'topup'`; throttle reset time →
  resume `'throttle_reset'`. Idempotent via `store.findByCausation`. On start, resume anything whose answer
  arrived while aocd was down (cursor replay already redelivers the events).
* For guard denials that raise a card, return `permissionDecision: 'defer'` instead of `'deny'`
  (`packages/mod-sessions/src/ingest.ts:320`): `defer` ends a `-p` turn cleanly and `--resume` re-runs the same
  call (`packages/contracts/src/claude-code.ts:151`), so ending the turn no longer depends on the agent obeying.

**Tests:** claude-sim scenario: `request_decision` → turn ends → lifecycle `waiting_decision`, liveness Waiting
on you → resolve → resumed turn's prompt contains the answer; same after restarting the runtime between the
request and the answer; capped `task_done` → lifecycle `blocked`, never Stalled.

### G-04 Supervisor: `runIsolated` for rollback verification and promotion
Spec: §8 (gated rollback execution), §14 (main moves only through the gate), §3. Rows: S3-b, S7-f/g, S8-g, S8-j,
S14.2-a, S15-e.

**Change:** implement `SupervisorService.runIsolated({cwd, command, credentialProfile, timeoutMs})`: fresh
env built as in G-01 (no daemon HOME), profile env only when `credentialProfile` is set (e.g. `prod-promote`),
argument arrays only (no shell), output capped, never reachable from an agent session or the CLI. mod-change
already calls it (`packages/mod-change/src/engine.ts:788-862`).
**Tests:** rollback verification against a real temp repo with a failing and a passing acceptance test; a
promotion push succeeds with `prod-promote` and fails without it (pre-push gate); the env of the child holds the
profile variables and nothing from the daemon's env outside the allowlist.

### G-06 mod-audit: nightly off-host anchor and Verify against the external proof
Spec: §13 (binding), §15.1, R2. Rows: S13-e, S13-f, R2, S15-a.

**Module:** `packages/mod-audit` (in flight). **Change:**
* Daily job at `audit.anchorAtLocalTime`: commit `{chainId, seq, headHash}` to `audit.anchorRepoPath` as a
  signed commit and push to `audit.anchorRemote` (or request an RFC 3161 token from `audit.tsaUrl`); append
  `anchor.created` (proofRef = commit SHA / TSR hash) or `anchor.failed` + `anchor.missed` notification.
* `POST /api/audit/verify` and `POST /api/audit/anchor` (paths the CLI already calls,
  `packages/cli/src/paths.ts:28-29`): recompute the chain **and read every anchor back from the external
  proof** (git show of the anchor repo at proofRef / TSR verification), not from `anchor.created.meta` alone —
  that copy lives in the file an attacker rewrites. Append `chain.verified`.
* Make mod-evidence's verification use the same external check.

**Tests:** drop the append-only trigger, rewrite an old event and recompute every later hash *including the
`anchor.created` rows* → Verify fails because the anchor repo disagrees; an unreachable remote yields
`anchor.failed` and an alert; a clean chain passes.

### G-07 mod-audit: self-modification guard and self-change log outside AOC
Spec: §13 self-modification boundary (binding), R14. Rows: S13-i, S13-j, S13-k, R14.

**Change:** a `PreToolGuard` (`self-modification`, order ≤ 15): when the session cwd (or the target path) lies in
`selfModification.aocRepoPaths`, deny Edit/Write/MultiEdit/NotebookEdit on any `protectedPaths` prefix and Bash
commands that write there (reuse `splitShell` from `packages/mod-change/src/guard.ts`) with
`blockReason: 'self_modification'`; append `selfmod.blocked` (path hash in meta, path in payload); append a line
to `selfModification.externalAuditLog` (a location outside the AOC data dir, ideally another host — P-07) for
every blocked attempt **and** every allowed AOC self-change (commit SHAs promoted in an AOC repo).
**Tests:** an Edit to `packages/kernel/src/x.ts` in an AOC repo is denied and logged externally; the same edit
in a non-AOC repo is allowed; a Bash `sed -i packages/mod-credits/...` is denied; the guard fails closed when the
cwd is unknown.

## P1 — software

### G-08 Evidence mapping out of date with mod-change's new events (2 red tests)
Rows: S8-d, S13-g, S14.1-c. `packages/mod-evidence/test/mapping.test.ts` › "wires every required control to
its catalog evidence" and › "loads a valid file, expanding prefix wildcards and normalising filters" fail:
the provenance/promotion row lacks `promotion.rejected` and `promotion.failed`
(`packages/contracts/src/events/change.ts`); check `rollback.failed` and `breakglass.rejected` as well.
**Change:** add them to `packages/mod-evidence/src/default-mapping.ts` (and `config/iso42001-mapping.json` if
present); the mapping hash changes, so any earlier stamp is void — tell the compliance lead (P-05).
**Test:** add a catalog-coverage test: every `change.*`, `rollback.*`, `breakglass.*`, `promotion.*` event type
appears in at least one mapping row.

### G-10 Spool replay silently drops usage, throttle and exit events
Rows: S2-m, S10.1-a, S2.1-b. `packages/mod-sessions/src/ingest.ts:357-360` accepts only `/ingest/hook` items;
the client counts the 200 response as sent and deletes the rest (`packages/client/src/index.ts:134-143`).
Observed hooks spool `/ingest/usage`; the sidecar spools `/ingest/usage`, `/ingest/throttle`, `/ingest/process`.
After any daemon outage that usage is lost (metering hole, §3/§10) and a process exit is never recorded.
**Change:** in `/ingest/spool`, dispatch `/ingest/usage`, `/ingest/throttle` and `/ingest/process` items to the
same handlers as the live routes (factor the bodies of those routes into functions; keep the per-item principal
checks); drop stale heartbeats/activity explicitly. In `flushSpool`, keep items the daemon reports as rejected in
a `spool-rejected.jsonl` for inspection instead of deleting them.
**Test:** integration test in mod-sessions: real `createClient().flushSpool()` against the test runtime with a
spooled usage batch (observer and session tokens) → `usage.recorded` appended once, a replay is a duplicate.

### G-03 Supervisor: nudge, restart, stop (+ the diagnosis-budget stop)
Rows: S2.3-d, S2.3-e, S6-c, S7-n. **Change:** `/api/sessions/:id/{nudge,restart,stop,prompt,output}` (the CLI
already calls them, `packages/cli/src/paths.ts:18-22`): nudge = interrupt the turn, `session.nudged`, resume with
the operator text; restart = `session.restarted`, resume from the transcript; stop = `session.stop_requested`
(immediate or at the next boundary, which `task_done` already honours via `stopRequested`). Permission
`session.drive_own` / `drive_any`. **Tests:** claude-sim: nudge during a long tool call resumes with the text;
restart of a killed process resumes; a stop at boundary ends after the next `task_done`; the intake budget job
stops a triage session.

### G-05 Supervisor: rollover orchestration
Rows: S5-b, S5-c, S5-e, S5-f, S5-h, R16. **Change:** on a turn that ended with `boundary.reason='rollover'` (or
`POST /api/threads/:id/rollover`): re-check `ledger.boundaryState` → `buildHandoffBrief` → `validateBrief` →
`session.rollover_started` (brief in payload) → launch the successor with `LaunchRequest.brief` → release the
writer (`rollover`) / acquire for the successor → `session.ended` (retired) → `session.rollover_completed`;
any failed check → `session.rollover_aborted` with the problems. **Tests:** claude-sim run crossing 70% context
rolls over once, the successor re-declares open task ids (counted once); a risky type mid-phase or a stale brief
aborts and the old session keeps the lock.

### G-11 mod-audit: erasure API and audit-trail API
Rows: S13-c, S6-h. **Change:** `POST /api/audit/erase` (`audit.erase`, reason enum, optional decision id) →
`store.eraseScope`; `GET /api/audit/events` (filters by type/session/project/actor/date, headers only, paged)
for builders and approvers. **Tests:** erasure of a ticket scope → bodies/blobs gone, `body.erased`, chain still
verifies, requester media 410; builders can list events, requesters cannot.

### G-09 Web pages (after the CEO approves the mock, P-09)
Rows: S1-d, S4-d, S6-c, S6-g, S9-e, S11.2-d, S14.1-a, UI-12.1/3/4/5/8, R15. Every page under
`packages/web/src/pages/` except login/gallery is a "Not yet implemented" placeholder. **Change:** build Console
(APM small multiples + liveness badges + decision rail), Session (timeline strip + stacked phase bar + actions),
Registry (paired bars first), Decisions inbox (age on every card, passkey ceremony for go-live / rollback /
break-glass), Project (stacked per-phase bar), portal pages, Evidence (one button). **Tests:** per page: renders
from a recorded API fixture, every chart prints its numbers, liveness only as `LivenessBadge`, no element with an
infinite animation, keyboard path through the primary action, layout at 360 px.

### G-12 Malware scanning is heuristic by default
Rows: S7-j, R4. `config.intake.scanner` defaults to `builtin` (EICAR, script polyglots, PDF active content —
`packages/mod-intake/src/upload.ts:64-77`). **Change:** make `clamav` the default when the binary is present and
have `aocd` refuse to mount `/portal/api/intakes` (or refuse attachments) with `requireScan` and no AV engine in
production mode; surface the scanner in `aoc doctor` / `/api/health`. **Test:** with `scanner: 'clamav'` and no
binary, uploads are refused with 503 and the health endpoint reports it.

### G-21 Off-host backup of the event log, body store and keys
Rows: R6. Nothing backs up `aoc.db`, `bodies.db`, `blobs/` or the KEK. **Change:** a daily job (mod-audit) that
takes an SQLite online backup of both DBs (+ blobs) to `audit.backupDir` / remote, encrypted, with a restore
command and a restore test; never the KEK in the same place (P-03). **Test:** backup → wipe → restore → chain
verifies and bodies decrypt with the separately held KEK.

### G-25 Provenance trailers are self-asserted
Rows: S14.2-a, S14.2-b. `classifyCommit` (`packages/mod-change/src/provenance.ts:47-86`) accepts any commit whose
`AOC-Change` trailer names *some* approved change of the project, and the agent writes its own commit messages.
Also, change-driven (non-ticket) promotions need no UAT sign-off — confirm with the CEO that §14's "UAT sign-off"
applies to ticket work only. **Change:** trace a commit only when (a) its `AOC-Session` is a session linked to
that change (`change.started`) or ticket, and (b) the commit is reachable from a head SHA that session recorded
(`task.done.meta.headSha`, `phase.completed.meta.pinnedSha`) — or have the supervisor record the session's
commits itself. **Test:** a commit carrying a valid trailer for an unrelated approved change is an orphan.

## P2 — polish and missing tests

| ID | Gap | Rows | Fix | Test to add |
| --- | --- | --- | --- | --- |
| G-26 | No test runs the real ledger against the real credits module | S10.3-a | Integration test in mod-ledger with `createCreditsModule()` | Exhaust a balance, `task_done` returns `credit_cap`, auto-grant once, second cap stops |
| G-27 | Untested structural properties | S1-c, S10.1-e, S15-c | — | `prompt.submitted` never changes `sessionProgress`; mod-metering registers no guards and never appends `session.blocked` / `credit.*`; `PRAGMA journal_mode` is `wal` for both DBs |
| G-28 | Only `aoc run` is statically checked for spawning / env forwarding | S3-e | Extend the static import test to every CLI command | Module graph of each command imports no `child_process` and never reads `process.env` secrets |
| G-29 | Button approvals are attribution, passkey approvals are signatures — not labelled for viewers | S6-k | Label `method: 'button'` as "attribution (bearer)" in the decision views and evidence pack | Evidence pack renders the label per resolution method |
| G-30 | `uatSha` falls back to `0000000` when the project has no repo | S7-e | Refuse `readyForUat` without a resolvable UAT ref | No repo → no `ticket.uat_ready`, ticket escalated |
| G-31 | Lessons and playbooks use two distillation engines | S11.1-a | Extract a shared distillation core (LLM call, schema, fallback, Approver gate) from `mod-registry/src/distill.ts`, reuse in `mod-learning/src/ai.ts` | Both proposal paths go through the shared core |
| G-32 | No automated accessibility checks | UI-12.8 | Add axe + token-contrast checks to web tests | Every page passes axe; token pairs ≥ 4.5:1 |
| G-33 | `decision.expired` is in the catalog but expiry is a `decision.withdrawn` labelled `expired`; mod-sessions ignores `decision.expired` | — | Pick one: emit `decision.expired` and handle it in `mod-sessions/src/projector.ts`, or delete the event type | Expired card no longer keeps the session Waiting on you |
| G-34 | ~~Mock says the stall threshold is 10 min; code said 5 min~~ **Resolved 2026-10-09:** CEO chose 10 min; `stallAfterMs` default is now 600 000 ms in config and `DEFAULT_LIVENESS_THRESHOLDS` | S4-b | — | `contracts` and `mod-sessions` liveness tests assert thinking at 9 min, stalled at 11 min |
| G-35 | ~~Sole-Approver fallback is always on~~ **Resolved 2026-10-09:** CEO chose off. `decisions.soleApproverFallback` (default `false`) gates it; when enabled it still never covers credit top-ups and stops applying once a second Approver is active | S6-m | — | `mod-decisions/test/engine.test.ts` › "sole-Approver fallback" |

## Process items the CEO must own

| ID | Item | Spec / risk | Owner | Done when |
| --- | --- | --- | --- | --- |
| P-01 | **Branch protection** on every project remote: protect main/master/production/release/*, require the go-live path, allow pushes only by the supervisor's promotion identity, forbid force-push and deletion | §2.4, §3, R1 | CEO / Platform Architect | Remote settings exported and attached to the stage-1 sign-off |
| P-02 | **Remove deploy keys and protected-branch push rights from developer machines and accounts**; rotate every existing deploy key; issue new ones only into the supervisor's credential profiles | §3, R1 | CEO | Key inventory shows no developer-held deploy credential; `aoc doctor` clean on every laptop |
| P-03 | **Key custody**: who holds `AOC_MASTER_KEY`, where it is backed up, rotation and break-glass access. `docs/runbooks/key-custody.md` is referenced by code but does not exist. Off-host backup target for the DBs | R6, §13 | CEO / Platform Architect | Runbook written and approved before real data lands |
| P-04 | **Anchor target**: create the separate anchor repo on another host (or pick an RFC 3161 TSA) and decide who holds the anchor signing key | §13, R2 | Platform Architect | First nightly anchor verified from outside AOC |
| P-05 | **Compliance-lead review of the ISO/IEC 42001 mapping** against the standard (all rows, incl. the five §13 corrections and A.4.5 vs A.4), then stamp it via `POST /api/compliance/mapping/stamp`. Name the compliance lead and give that person the `complianceLead` flag (never by role). Until stamped every pack says "Provisional — do not cite" | §13, §14, R3 | Compliance lead | `mapping.stamped` event bound to the current mapping hash |
| P-06 | **Human review of the governance core.** kernel, mod-audit, mod-credits, mod-decisions, mod-identity (and contracts, hooks, config) were written by AI agents in this build; §13 requires that core to be human-built and human-changed. Assign named reviewers, review and sign off, and add CODEOWNERS + required human review on those paths | §13, R14 | CEO / Governance | Signed review record per package; CODEOWNERS enforced |
| P-07 | **Where AOC self-changes are audited outside AOC**: choose the external log location (not the AOC data dir) and who reviews it | §13, R14 | CEO / Governance | `selfModification.externalAuditLog` points off-host; review cadence agreed |
| P-08 | **Per-stage CEO sign-off** (§15). Stage 1 cannot be signed until the supervisor and the off-host anchor are merged and verified | §15, R5 | CEO | Sign-off recorded per stage |
| P-09 | ~~**Approve the static mock**~~ **Done 2026-10-09:** the CEO approved the mock as shown, with its proposed defaults (recorded in `mocks/README.md`). Originally: approve the mock and answer its "Decisions for the CEO to confirm" — UI foundation code was merged before approval. Includes: do flagged no-file-change tasks count toward completion; stall threshold; passkey scope | §12, §15 | CEO | Approval (date) recorded in `mocks/README.md` |
| P-10 | **Sequencing deviation**: the intake portal API (stage 5) merged before identity (stage 3). Accept, or require the portal routes disabled until identity and the portal UI are signed off | §6, §15, R5 | CEO | Decision recorded |
| P-11 | **Separation-of-duties exception**: the sole active Approver may resolve their own requests (not credit top-ups), recorded as self-approval (`packages/mod-decisions/src/engine.ts:338-343`). Accept, or appoint a second Approver and turn it off (G-35) | §6 | CEO | Decision recorded |
| P-12 | **Malware scanning in production**: provision ClamAV for the portal host; the builtin scanner is a heuristic | §7, R4 | CEO / CX lead | `scanner: 'clamav'` in production config |
| P-13 | **Credential profiles file** (`supervisor.credentialProfilesFile`, readable only by the supervisor user) with least-privilege `git-feature`, `uat-deploy`, `prod-promote` profiles; run aocd as a dedicated OS user whose home holds no developer credentials | §3, R1 | Platform Architect | File reviewed; aocd service user created |
| P-14 | **Observed-session coverage**: install the observed hooks (`aoc hooks install-observed`) on every developer machine and run `aoc doctor` | §2, R1 | CEO / DevEx | Every developer machine reports in |
| P-15 | **Discovery-class build stages on Opus** (§15) — how this build itself is run | §15 | CEO | Recorded per stage |
| P-16 | **Credit policy settings**: period allocations, exempt users, who the top-up approvers are | §10 | CEO / FinOps | `config.credits` reviewed |
| P-17 | **Decision webhook** (opt-in, R15): choose the endpoint and on-call owner | R15 | CEO | `decisions.webhookUrl` set or explicitly declined |
