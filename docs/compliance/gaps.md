# AOC-SPEC-003 gap list

Open Partial rows of [traceability.md](traceability.md), grouped into fixes small enough for one engineer.
Baseline: integration `a1c8a0c` — 125 test files, **1173 tests, all pass**. No requirement is Missing any more.
Re-verified on 2026-10-09 at `ea18d4a`: every row marked closed below was checked in the code, and its package tests
run green (e2e 19/19).

* **P0** — breaks a binding control or the §3 make-or-break. Nothing ships to real users before these close.
* **P1** — a binding requirement only partly met, wrong by default, or a defect that lets agents or outages corrupt
  audit / metering data.
* **P2** — polish, missing tests, hardening.

"Owner" says who is on it, as reported by the lead at this baseline. **Unassigned** items need an owner.
Threat-model items are cited as O-n (`docs/security/threat-model.md` §6).

## Resolved since `a1c8a0c` (re-verified 2026-10-09)

| Gap | Was | Closed by | Evidence |
| --- | --- | --- | --- |
| G-09 | Every operator and portal page was a placeholder | web `30978aa`, `535e7cc`, `73fb637`, `20c57bd`, `a68466d`, `e2d583a`, `ec37f5e`, `a6366f6` | Every route renders from an API fixture: `packages/web/test/tower/ControlTowerPage.test.tsx` › "renders every section with its numbers as text", `test/console/ConsolePage.test.tsx`, `test/sessions/SessionPage.test.tsx`, `test/decisions/DecisionsPage.test.tsx` (passkey: `test/decisions/passkey.test.tsx`), `test/projects/ProjectPage.test.tsx`, `test/portal/PortalTicketPage.test.tsx`; `test/aliveIndicator.test.tsx` › "declares no infinite animation anywhere in the stylesheets". Keyboard and 360 px: the axe run (G-32 residual) |
| G-10 | Spool replay dropped usage, throttle and exit reports | integration `0de1f65` | `packages/mod-sessions/test/sessions.test.ts` › "replays everything clients spool: observed usage, and the sidecar’s usage, throttle and process exit"; `packages/client/test/spool.test.ts` › "moves the items reported rejected (per-item results) to spool-rejected.jsonl"; `packages/e2e/test/failure.test.ts` › "managed fails closed and spools, observed never blocks; after a restart both spools flush exactly once" |
| G-12 | Default malware scanner was a heuristic | mod-intake `7f41aa7` | `packages/mod-intake/test/scanner.test.ts` › "production mode refuses attachments when only the heuristic is available", › "auto prefers ClamAV when a client is installed, else falls back to the builtin heuristic"; `packages/daemon/test/server.test.ts` › "GET /api/health reports a missing malware scanner…". Development mode still accepts the heuristic; provisioning is P-12 |
| G-21 | No automated off-host backup / restore | mod-audit `1160c0c` | `packages/mod-audit/test/restore.test.ts` › "restores into an empty data dir; the chain verifies in-file and against the off-host anchor, bodies decrypt with the escrowed KEK"; `backup.test.ts` › "runs at backupAtLocalTime once per local day, after the anchor job, and health tracks its age". Off until `audit.backupKeyFile` is set; the drill is the manual quarterly procedure (`docs/runbooks/backup-restore.md` §6) |
| G-25 | Provenance trusted agent-written trailers | mod-change `8964a30`, `89a0e95` | `packages/mod-change/test/promotion.test.ts` › "a valid trailer for an unrelated approved change is an orphan: trailers are corroborated, never trusted (G-25)"; `pure.test.ts` › "never trusts a trailer the platform cannot corroborate (G-25)". The UAT rule for non-ticket promotions is **narrowed** to a CEO decision: row G-25 below |
| G-26 | No test wired real modules across the main contracts | `53e0852`, e2e `4084012` | `packages/mod-ledger/test/credits-boundary.test.ts` › "first cap auto-grants 25% once; the second cap stops work at the boundary, and keeps stopping it"; `packages/e2e/test/intake.test.ts` › "upload → read-only triage on claude-sim → report_diagnosis via the MCP server → fix-plan gate → build" |
| G-27 | Untested structural properties | `77b882d` | `packages/mod-ledger/test/prompts.test.ts` › "prompt.submitted from any origin leaves session and project progress, status and timelines unchanged"; `packages/mod-metering/test/observes-only.test.ts` › "registers no PreToolUse guard and no reactor"; `packages/kernel/test/journal.test.ts` › "aoc.db and bodies.db are in WAL mode, recorded in the files themselves" |
| G-28 | Only `aoc run` was statically checked | cli `4dd41b2` | `packages/cli/test/isolation.test.ts` › "covers every command module and finds the deps boundary", › "enumerates every leaf command" |
| G-29 | Attribution vs signature not labelled | `3bd0012` | `packages/contracts/test/contracts.test.ts` › "labels a bearer-token button as attribution and only a verified passkey as a signature (G-29)"; the pack and decision views carry the label |
| G-30 | `uatSha` fell back to `0000000` | mod-intake `3b3f14e` | `packages/mod-intake/test/intake.test.ts` › "never asks the requester to test a build that does not exist: no repository → escalated, not ready (G-30)" |
| G-31 | Two distillation engines | distill `dabe381` | `packages/mod-learning/test/shared-core.test.ts` › "AI path: the distillation call and the Approver gate are the shared ones"; `packages/mod-registry/test/shared-core.test.ts` › "the model call, the fallback and the Approver gate are the shared ones" |
| G-32 | No automated accessibility checks | web `e77296a`, `ab2ec78` | `packages/web/test/tokenContrast.test.ts` (in `pnpm test`); axe over every page at 1440 and 360 px, light and dark: `pnpm --filter @aoc/web a11y` (`packages/web/test/a11y/report.md`). **Narrowed**: row G-32 below |
| G-33 | `decision.expired` vs a labelled withdrawal | `34b84c5` | `packages/mod-sessions/test/sessions.test.ts` › "an expired card no longer keeps the session Waiting on you (G-33)" |
| G-36 | FX defaults contradicted BNM semantics | mod-fx `36f5c90`, `64727b0` | `packages/mod-fx/test/fx.test.ts` › "records the 1700 middle rate at 18:00, stamped with its session and reconciled at 4 dp with the API for that date and session", › "never reconciles against the session 1130 counter rates (middle_rate null) served when no session is sent". Sign-off of the defaults is P-19 |
| G-37 | Managed workspaces got no `pre-push` / `prepare-commit-msg` | hooks `ea18d4a` (installed by the hook binary at `SessionStart`, as the session user; a project's own hook is left alone) | `packages/hooks/test/managed.test.ts` › "installs the git hooks at SessionStart, so a commit carries AOC-Session without the agent adding it (G-37)"; `prepush.test.ts` › "ensureGitHooks (G-37)" |
| G-41 | Self-changes only partly audited outside AOC | mod-change `df7d47a` | `packages/mod-change/test/selfmod.test.ts` › "refuses a promotion whose commits from a managed session change the core of an AOC repo, and records it outside AOC", › "a break-glass promotion that lands core changes in an AOC repo is recorded outside AOC"; `packages/daemon/test/selfmod-promotion.test.ts`. P-06, P-07 and P-18 remain |
| G-40 | Anchors were nightly only: up to a day of events could be rewritten (O-11) | mod-audit: `audit.anchor_interval` every `audit.anchorIntervalMinutes` (60) and the `audit.anchor_after` reactor (`audit.anchorAfterEvents`), both skipping when only anchoring's own records are new; an outage alerts once | `packages/mod-audit/test/anchor-cadence.test.ts` › "a break-glass approval is followed by an anchor that covers it", › "a burst of high-value events yields one anchor; routine events and policy resolutions yield none", › "the hourly job anchors only when something new was logged since the last anchor", › "an anchor store outage is recorded and alerted once, not every hour, and again after it recovers", › "an anchor whose push failed is retried on the next hour even when nothing new was logged". Up to an hour of routine events stays unanchored by default |
| G-45 | UAT feedback reached a credentialed build session | mod-intake `bb43d43` | `packages/mod-intake/test/security.test.ts` › "UAT feedback reaches only a read-only triage pass, framed; no build turn starts before the fix-plan gate (G-45)". **Narrowed** to egress: row G-45 below |

## Resolved since the previous baseline (`fb97e98`)

| Gap | Was | Closed by | Evidence |
| --- | --- | --- | --- |
| G-02 | Turn end and resume with the answer injected | supervisor `d30ffda` | `packages/supervisor/test/turns.test.ts` › "waits on an open decision with no process alive, then resumes with the injected answer"; capped turn → `blocked` › "blocks when the credit cap is reached during a turn and resumes on a top-up" |
| G-03 | Nudge, restart, stop, diagnosis-budget stop | supervisor | `packages/supervisor/test/turns.test.ts` › "nudge interrupts a hanging turn with SIGINT and resumes with the operator text", › "marks a crash Dead and restarts it from the transcript", › "stop without immediate ends the session at the next task boundary" |
| G-05 | Rollover orchestration | supervisor | `packages/supervisor/test/rollover.test.ts` (5 tests) |
| G-06 | Off-host anchor; Verify against the external proof | mod-audit `6284a04` | `packages/mod-audit/test/anchor-git.test.ts` › "R2: rewriting the anchor.created events as well is caught by the off-host record, and the forged head is never anchored"; `anchor-rfc3161.test.ts` |
| G-08 | Evidence mapping missed the new promotion / break-glass events | `78bc38d` | `packages/mod-evidence/test/mapping.test.ts` green |
| G-11 | Erasure API and audit-trail API | mod-audit | `packages/mod-audit/test/routes.test.ts` › "destroys the scope key: bodies gone, counts returned, chain and anchors still verify", › "lists headers only, with filters and pagination both ways" |
| G-34 | Stall threshold | CEO decision 2026-10-09: 10 min (`a2a4e96`) | `packages/contracts/test/contracts.test.ts`, `packages/mod-sessions/test/sessions.test.ts` |
| G-35 | Sole-Approver fallback always on | CEO decision 2026-10-09: off by default (`a2a4e96`) | `packages/mod-decisions/test/engine.test.ts` › "is off by default: the only Approver cannot resolve their own requests" |
| G-39 | Erasure left decrypted read-model text in `aoc.db` free pages and the WAL; FTS5 kept erased terms in live index segments | kernel `63331da` (`secure_delete` on `aoc.db`, `wal_checkpoint(TRUNCATE)` after `eraseScope`), mod-registry `503b8df` (FTS5 `optimize` when an erasure removes knowledge documents) | `packages/kernel/test/security.test.ts` › "scrubbed projection text is gone from aoc.db and its WAL, not just from the table"; `packages/mod-registry/test/security.test.ts` › "leaves no trace of an erased document in the FTS index pages on disk" (raw `aoc.db` / `-wal` bytes) |
| G-42 | Evidence packs checked anchors in-chain only, so a full-chain forgery yielded a pack saying every anchor matched | mod-evidence `d9fa2e3` (packs take the `audit` service's verify-against-anchor; `verification.status` is `verified`, `failed` or `not_verifiable` with a reason), e2e `1562cae` | `packages/mod-evidence/test/pack.test.ts` › "records failed anchors and a tampered chain instead of hiding them", › "without the audit service the pack is not verifiable: in-chain anchors are never taken as proof (G-42)", › "an unreadable off-host anchor store makes the pack not verifiable rather than verified"; `packages/e2e/test/evidence.test.ts` (j); confirmed in `docs/security/review-wave3.md` |
| G-04 / G-07 | Supervisor launch, `runIsolated`, self-modification guard | supervisor, mod-audit | **Narrowed**, not closed — what remains is below. (G-01 was narrowed with them and is now closed: next row. G-04 is now enforced in code: its entry under P0.) |
| G-01 | Sessions ran as the aocd OS user | session isolation (supervisor, contracts config, daemon) | `packages/supervisor/test/isolation.test.ts` (end-to-end part needs root; it creates two OS users): › "runs a build turn, its hooks and its MCP server as the session user, who can read none of aocd’s secrets" (claude-sim Bash tries the profiles file, the KEK, `aoc.db`, the data dir, aocd's `~/.ssh` key and the original key file → all `Permission denied`; `HOME` is the session's, not aocd's), › "a read-only session cannot open a profile key file, a build session’s key copy or its environment", › "startup self-check › refuses to start while a session user can read the data dir, and starts once it is private" (and the KEK / profiles / key-file and runner variants), › "runs supervisor commands without credentials (acceptance tests) as the session user, never as root"; `packages/daemon/test/production.test.ts` › "refuses to run managed sessions as the aocd OS user". Residuals below. |
| G-44 | Agents could forge metering and liveness: the sidecar posted with the session's own ingest token, which is in the model's env | separate sidecar principal (contracts, mod-identity, kernel `requireIngest`, mod-sessions, supervisor, sidecar) and per-turn reconciliation (supervisor, mod-tower) | `packages/mod-sessions/test/security.test.ts` › "refuses the session token the model can read (403), and every principal but the sidecar of that session", › "never lets the sidecar post hook events, and holds spool replays to the same per-item rules" (a spooled usage / throttle / exit under the session token is rejected, accepted under the sidecar's); `packages/supervisor/test/launch.test.ts` › "starts claude with the fixed argv, an allowlisted env, per-session files and the sidecar" (the sidecar token is only in the sidecar's env: not in the claude env, `mcp.json`, settings, prompt or argv); `packages/supervisor/test/turns.test.ts` › "stops the sidecar as soon as its turn ends, and revokes its token once that last report is in"; `packages/supervisor/test/usage.test.ts` › "flags a turn whose sidecar totals disagree with modelUsage — missing usage, then forged usage", › "reconciles real Claude Code captures: cumulative modelUsage differences equal the transcript per message; compaction is overhead"; `packages/e2e/test/supervisor.test.ts` (claude-sim turns reconcile as `match`, both tokens revoked); `packages/mod-tower/test/anomalies.test.ts` › "metering_discrepancy". Residuals: a partly seen usage batch is still recorded whole (O-5); without session isolation the model can read the sidecar token from the sidecar's `/proc` environ (flagged by reconciliation, not prevented); a killed sidecar is not restarted. |
| G-46 | KEK from `AOC_MASTER_KEY`; git children inherited all of `process.env` | kernel `crypto.ts`, `runtime.ts`, `git.ts`, `child-env.ts`; mod-audit `anchor/git.ts`, `anchor/rfc3161.ts`, `backup/restore.ts`, `exec.ts`; llm `claude-cli.ts`; mod-intake `upload.ts` | `packages/kernel/test/secrets.test.ts` › "a git child (and whatever git starts) sees no AOC_*, ANTHROPIC_* or tokens", › "production › refuses a KEK from AOC_MASTER_KEY, even when the file is fine" (and never generated, mode 0400/0600 only, not inside `dataDir`, owner check), › "development: a KEK from AOC_MASTER_KEY is accepted, and warned about at startup"; `packages/mod-audit/test/child-env.test.ts` (the anchor git, the restore clone, openssl and the exec default see no `AOC_*`, API keys or tokens); `packages/llm/test/claude-cli.test.ts` › "starts the CLI with an allowlisted environment…"; `packages/mod-intake/test/scanner.test.ts` › "the ClamAV client is an aocd child"; `packages/daemon/test/production.test.ts` › "refuses a KEK from AOC_MASTER_KEY even beside a valid key file, without echoing it". Development still accepts `AOC_MASTER_KEY` and logs a warning at every start; the backup copy command keeps its documented deny list (it carries the operator's own transfer credentials). |

## P0 — software

### G-01 Sessions must not run as the aocd OS user (threat model O-1) — closed; residuals
Rows: S3-a, S3-d, S7-m, R1, R4. **Closed** by session isolation (evidence in the Resolved table above).
**Enforced now** with `supervisor.isolation: "user"` (on as soon as `supervisor.sessionUser` is set, and always in
`"mode": "production"`): every turn — `claude`, its hooks, its MCP server and the model's tools — runs as
`sessionUser`, read-only types as `readOnlySessionUser` (production requires a separate user with its own uid and
group), directly by uid/gid or through `supervisor.runner` (per-session container, `setpriv`); aocd must be root. Each
session has its own `HOME`, `CLAUDE_CONFIG_DIR` and `TMPDIR` under `supervisor.sessionHomesDir`, root-owned
`mcp.json`/`settings.json` it cannot rewrite, `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`; a profile's
key files (`files` + `{{file:<name>}}`) become private `0400` copies that exist only while a turn runs. The startup
self-check refuses to start when a session user can read `dataDir`, `aoc.db`, `bodies.db`, the KEK, the profiles
file, a key file it names or aocd's session files, when a turn's commands are unreachable, or when a runner does not
switch users. `runIsolated` without a credential profile (acceptance tests) runs as the session user, not root. The
sidecar stays with aocd. Development keeps `isolation: "none"` as the default, warned at startup and on every launch.
`session.launched.payload.runAs` records who each turn ran as. Operator setup: `docs/runbooks/credential-isolation.md`
§4.
**Residuals** (owners to assign):
- **Egress is not restricted** (O-14, O-9): a session can still send out whatever it holds — its own key copy, the
  Claude token, the ingest token. Isolation narrows what it holds; it does not stop exfiltration.
- **Credentialed sessions share one OS user**: a build session can read a concurrent build session's key copy and
  `/proc/<pid>/environ` (a `git-feature` session can reach a `bug-fix` session's `uat-deploy` key while it runs).
  Per-session uids or containers (`supervisor.runner`) close this.
- **With aocd as root, root's git refuses agent-owned repositories** (dubious ownership). G-04 handles it: AOC's own
  git runs there as the repository's owner, and promotions, pin tags, rollback checkouts and the ledger's
  commit-evidence check work. Never work around it with `safe.directory`; run your own git as the session user.
- The session's ingest token stays in its environment (hooks and the MCP server need it): with it the model can still
  forge its own hook and MCP events (T-3), no longer its liveness or metering (G-44 closed: the sidecar has its own
  token, which isolation keeps out of the model's reach).
- A non-root aocd with a `sudo` runner is not supported: the sidecar cannot read the 0600 transcript and aocd cannot
  SIGKILL another user's process.
- A session's own `HOME` keeps what the agent writes there across that session's turns (it no longer reaches other
  sessions or aocd). `~/.claude/settings.json` gets the workspace-settings rules before every turn (no
  `disableAllHooks`, no `env`); other Claude Code state there (for example `.claude.json`) is not checked.

### G-04 Privileged git never in agent-writable trees (threat model O-2) — enforced in code; residuals
Rows: S3-b, S8-g, S14.2-a, R1. **Status: enforced in code** (G-04 agent; `packages/mod-change`,
`packages/supervisor`, `packages/kernel/src/git.ts`), on top of G-01. **The promotion credential can hold a real key**
once session isolation is on (`supervisor.sessionUser` with its startup self-check; production requires both): the key
file is root's `0600`, only the push process receives the profile, and sessions run as their own OS user, so they can
neither read the key nor write the clone. With `isolation: "none"` (the development default) any session can do both,
so no real credential belongs in the profile there. Operator setup: `docs/runbooks/credential-isolation.md` §4 item 9
(the clone's `origin` is the protected remote).
**Now enforced:** promotion, rollback, break-glass, pin tags and rollback verification run in a service-owned bare
clone per project (`<dataDir>/git/<project>.git`; refused when it would overlap the project repository). Commits
enter it by id only (`git fetch --no-tags -- <repo> <sha>`, `protocol.allow=never` + `protocol.file.allow=user`,
`transfer.fsckObjects`); `protocol.file.allow=never`, as first proposed here, would refuse that fetch. Every git
command there runs with hooks off, no fsmonitor, signing or verification program, every transport denied unless
needed, no system or global config and a scrubbed environment. **No `safe.directory`, ever:** with G-01 the project
repositories belong to the session user and root's git refuses them (dubious ownership), so the fetch's serving side
(`upload-pack`) and every other kernel git command in a project repository (existence, refs, log, the recorded-heads
walk, fingerprints, commit evidence, ledger phase pins) run as the repository's owner (supplementary groups dropped,
no home, no system or global config); root never parses agent-written config. Provenance (G-25's recorded session
heads, unchanged) and the fast-forward checks run in the clone against where AOC last moved the branch, and again at
execution; governance-core changes (G-41) are read from the clone too. The push target is AOC's configuration (the
clone's `origin`, or mod-change's `promotionRemote` option when embedded), never the project's `.git/config`; remotes
there with none configured → `promotion_remote_unconfigured`, already when the promotion or rollback is requested. The
`prod-promote` profile reaches one process: `git push --no-verify` from the clone, a compare-and-swap of a verified
fast-forward (`--force-with-lease=<branch>:<base>`; `default_branch_moved` when the remote moved outside AOC).
Rollback verification checks out of the clone into a fresh standalone checkout, hands it to the session user, and
runs the acceptance tests through `runIsolated` sandboxed: as the session user, never with a credential, with nothing
of aocd's environment. The project's own branch follows a push (and moves for a project without a remote) as the
session user, with hooks, fsmonitor and filter drivers off.
**Tests:** `packages/mod-change/test/privileged-git.test.ts` › "ignores a planted pre-push hook, core.hooksPath,
aliases and core.sshCommand (and more): promotion and rollback to a remote still succeed", › "ignores the same
planted config when the project has no remote…", › "keeps the service clone outside the project repository, and
refuses a clones directory inside it", › "never pushes where the project repository points…", › "moves the remote
only from the base it verified…", › "traces against the branch as AOC moved it…", › "G-04 end to end, with the
real supervisor" (the project repository belongs to the session user as under G-01; the remote sees the credential on
AOC's push only; an acceptance test that writes outside its checkout fails as the session user; the project's branch
follows the rollback, written by its owner; skipped with the reason when aocd is not root or there is no `nobody`
user); `packages/kernel/test/git.test.ts` › "runs git there as its owner: no dubious-ownership refusal…", › "fetches
from it into a repository of aocd's through an upload-pack run as the owner…" (same skip rule) and the planted-config
tests; `packages/supervisor/test/isolated.test.ts`.
**Still open:**
- `SupervisorService.runIsolated` needs the `sandbox` field in the contract (`services.ts`, lead-owned; used through a
  local type today), and `promotionRemote` / `promoteCredentialProfile` need a config section (the daemon passes
  mod-change no options, so the clone's `origin` and the `prod-promote` default are the only operator interface).
- Nothing fetches the protected remote: the clone learns a branch from AOC's own pushes and, for the first promotion,
  from the project repository's view. The push lease turns a wrong guess into `default_branch_moved`, never into an
  unchecked push.
- Acceptance commands still run through `sh -c`, inside the sandbox (as the session user; as aocd, without
  credentials, when isolation is off: development only, warned).
- Pin tags stay in the clone (not pushed), so ruleset C is unused.
- A candidate that fails git's object checks is refused; accepting known old damage means setting
  `fetch.fsck.<msg-id>=warn` in that project's clone.
- A local-path remote runs its hooks inside the push, with the credential (tests and same-host mirrors only; it must
  belong to root).
- With `isolation: "none"` the kernel git service runs as aocd, with hardened flags but not as another user.

## P1 — software

| ID | Gap | Rows | Owner | Fix | Test to add |
| --- | --- | --- | --- | --- | --- |
| G-25 | Non-ticket promotions need no UAT sign-off (`packages/mod-change/src/engine.ts`, UAT only when the promotion has a `ticketId`) | S14.2-b | CEO | Decide whether every promotion needs UAT; then enforce it in the promotion gate | A non-ticket promotion without UAT is refused (if the CEO requires it) |
| G-45 | Build-session egress is unrestricted, so a session that read requester text can still reach the network (O-9, O-14) | S7-m, R4 | **Unassigned** (with P-20 O-14) | Restrict build-session egress (allowlist proxy or network namespace) | A build session cannot reach a host outside the allowlist |

## P2 — polish, tests, hardening

| ID | Gap | Rows | Owner | Fix | Test to add |
| --- | --- | --- | --- | --- | --- |
| G-32 | The axe run is not part of `pnpm test` or the CI example, so nothing runs it automatically; its report dates from `0f9e608` | UI-12.8 | **Unassigned** | Add `pnpm --filter @aoc/web a11y` to `.github/workflows/ci.yml.example`; seed ids for `/changes/:id`, `/tickets/:id`, `/portal/tickets/:id` | CI fails when a page breaks axe |
| G-47 | Remaining threat-model hardening: O-4 (hook-relayed prompts recorded as supervisor), O-15 (fail a launch with no `SessionStart` in N s), O-16 (rate limits on cards, ingest, uploads, SSE), O-17 (lesson / playbook hygiene: output caps and untrusted framing done; provenance on the card, confusable characters, no auto-proposals from sessions that read untrusted input still open), O-23 (KEK rotation tool), O-25 (observed sessions outside any project), O-26 (audited admin re-drive / rebuild / run-job) | S6-f, R10, R6 | **Unassigned** | One small change per item (see the threat model) | One test per item |
| G-48 | Ending the turn after a card still relies on the agent: guard denials answer `permissionDecision: 'deny'` | S2.3-a | Waiting on a CLI probe: run `docs/research/probes/defer-resume-with-prompt.mjs` with the real `claude` | Answer `'defer'` for card-raising denials (`packages/contracts/src/claude-code.ts:168`). Blocked on one unobserved behaviour: what `claude -p --resume <id> "<answer>"` does with a deferred call (only a resume **without** a prompt is observed, and it re-runs the call; ADR-0006). If a prompt drops the call, only the guard changes; if not, a deferred session resumes without a prompt and the re-run's denial carries the answers | claude-sim: a protected push ends the turn with `tool_deferred`, and the resume delivers the answer without a second card |

## Process items the CEO must own

| ID | Item | Spec / risk | Owner | Status |
| --- | --- | --- | --- | --- |
| P-01 | **Branch protection** (rulesets per `docs/runbooks/credential-isolation.md` §3): protect main / release/*, no force-push or deletion, only the supervisor identity updates main | §2.4, §3, R1 | CEO / Platform Architect | Open |
| P-02 | **Remove deploy keys and protected-branch rights from developer machines**; rotate existing keys; issue new ones only into the supervisor's profiles | §3, R1 | CEO | Open |
| P-03 | **Key custody and backups**: adopt `docs/runbooks/key-custody.md` (KEK holder, location, rotation, break-glass access) and decide backup retention against the PDPA erasure promise (O-12) before real data lands | R6, §13 | CEO / Platform Architect | Runbook written; adoption and the O-12 decision open |
| P-04 | **Anchor target**: the off-host anchor remote (another account, no force-push or deletion) and signing key, or a qualified TSA (`docs/runbooks/anchoring.md`, O-11) | §13, R2 | Platform Architect | Open |
| P-05 | **Compliance-lead review of the ISO/IEC 42001 mapping** (`docs/compliance/iso42001-annex-a.md` is input), then the stamp via `POST /api/compliance/mapping/stamp` by a named person holding the `complianceLead` flag. Until then every pack says "Provisional — do not cite" | §13, §14, R3 | Compliance lead | Open |
| P-06 | **Human review of the AI-built governance core** (`docs/compliance/self-modification-boundary.md` §5 checklist: kernel, contracts, mod-audit, mod-credits, mod-decisions, mod-identity, hooks, config, plus the supervisor and change-control paths it lists); CODEOWNERS with required human review (start from `.github/CODEOWNERS.example` and `.github/workflows/ci.yml.example`) | §13, R14 | CEO / Governance | Open |
| P-07 | **Ship the external self-modification log off-host** as it is written (central log, append-only bucket or anchor repo) and name its reviewer | §13, R14 | CEO / Governance | Open |
| P-08 | **Per-stage CEO sign-off** (§15). Stage 1 is functionally complete; sign-off should wait for the P-13 host setup that G-01 and G-04 (both closed in software) depend on | §15, R5 | CEO | Open |
| P-09 | Approve the static mock | §12, §15 | CEO | **Done 2026-10-09** (recorded in `mocks/README.md`) |
| P-10 | **Enablement gates** (O-21): keep the intake portal and Builder surfaces off in production until the identity stage is signed off — the portal API was merged before identity | §6, §15, R5 | CEO | Open |
| P-11 | **Separation of duties with one Approver** (O-8): the fallback is now off (CEO, 2026-10-09), so the only Approver's own requests have no eligible resolver — appoint a deputy Approver with a passkey | §6 | CEO | Decision made; deputy Approver open |
| P-12 | **Malware scanning in production**: provision ClamAV on the portal host | §7, R4 | CEO / CX lead | Open |
| P-13 | **Credential profiles file and OS users**: least-privilege `git-feature`, `uat-deploy`, `prod-promote` profiles, key files declared under `files` (`{{file:<name>}}`); aocd run as root (reduced capability set) with two session users, `aoc-agent` and `aoc-reader`, each with its own group; `"mode": "production"`; file ownership per `docs/runbooks/credential-isolation.md` §4; no process type may name `prod-promote`; each project's service clone given its protected remote (`git --git-dir=<dataDir>/git/<project>.git remote add origin …`, §4 item 9) | §3, R1 | Platform Architect | Open (G-01 and G-04 software done; host setup outstanding) |
| P-14 | **Observed-session coverage**: observed hooks with each developer's own observer token, quarterly `aoc doctor` checklist (`docs/runbooks/credential-isolation.md` §5) | §2, R1 | CEO / DevEx | Open |
| P-15 | Discovery-class build stages on Opus | §15 | CEO | Process |
| P-16 | Credit policy: allocations, exemptions, top-up approvers | §10 | CEO / FinOps | Open |
| P-17 | Decision webhook (R15): endpoint and on-call owner | R15 | CEO | Open |
| P-18 | **Set `selfModification.aocRepoPaths`** (default `[]`, so the core of the AOC repo is not yet protected) and review `protectedPaths` in production config (O-10; the default now covers all of Tier 1) | §13, R14 | CEO / lead | Open |
| P-19 | **FX policy** (O-18): session 1700 or 1200, run time, tolerance, carried-forward alert after 3 weekdays (`docs/research/bnm-fx.md` §0) | §10, R13 | FinOps | Open (feeds G-36) |
| P-20 | **Threat-model decisions**: O-14 (Claude credentials readable by every session; egress), O-19 (passkeys on every Approver gate, not only go-live / rollback / break-glass), O-20 (`synchronous = NORMAL` vs `FULL`), O-25 (observed sessions outside projects, PDPA) | §3, §6, §13 | CEO / architect | Open |
| P-21 | **HTTPS `publicUrl` in production** (cookie `Secure` flag, WebAuthn origin) — O-22 | §6 | Ops | Open |
