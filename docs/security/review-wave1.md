# Security review — wave 1

Adversarial review of the merged AOC packages against AOC-SPEC-003 (§3, §6, §7, §13, risk register).
Scope: `kernel`, `client`, `mod-sessions`, `sidecar`, `mod-intake`, `mod-decisions`, `mod-credits`, `mod-registry`,
`mod-evidence`, `hooks`, `mcp-server`; on the lead's request also `supervisor`, `mod-audit` (erasure residue,
self-modification analyzer) and one `mod-identity` follow-up. Every fix has a regression test that fails before and
passes after: `test/security.test.ts` in each touched package (client and sidecar: their existing test files).

Severity: **Critical** breaks §3 or the audit chain for everyone · **High** a token holder, agent or requester can
defeat a binding control or take the platform down · **Medium** partial defeat or data-protection gap · **Low**
hardening.

## Summary

| # | Sev | Finding | Status |
| --- | --- | --- | --- |
| F-01 | High | Observer token writes into managed sessions | Fixed `c588db0` |
| F-02 | High | Unbounded client text in chained headers; cross-session idempotency collisions | Fixed `45196aa` |
| F-03 | High | No body caps; ingest parsed before auth; intake buffered before size checks | Fixed `8f41cf7`, `e637e1f` |
| F-04 | High | `eraseScope('..')` deletes the whole data directory; blob paths collide/escape | Fixed `896bd5c` |
| F-05 | High | Workspace `.claude/settings*.json` switches off AOC hooks / overrides the session env | Fixed `4dc51ef` |
| F-06 | High | Session credentials and ingest token reach every builder through session output | Fixed `122a713` (verbatim); R-02 fixed in [wave 2](review-wave2.md) |
| F-07 | High | Self-modification analyzer ReDoS stalls the daemon (all managed sessions fail closed) | Fixed `6dfe11f` |
| F-08 | Medium | Erasure residue in `aoc.db` free pages / WAL and in FTS5 index segments (G-39) | Fixed `63331da`, `503b8df`, docs `6aeae69` |
| F-09 | Medium | Ticket erasure leaves triage diagnoses readable | Fixed `e91f745` |
| F-10 | Medium | UAT feedback framed with a forgeable delimiter in the credentialed build prompt | Fixed `c00b112` |
| F-11 | Medium | `verifyChain` ignores the indexed scope columns queries filter on | Fixed `50470ce` |
| F-12 | Medium | Background processes outlive the turn with the session env | Fixed `94b8f30` |
| F-13 | Medium | Shared managed spool: one session's flush destroys others' buffered events | Fixed `aae60b7` |
| F-14 | Medium | Spool files claimed by a crashed flusher are never replayed | Fixed `f1adfb3` |
| F-15 | Low | Read-only Bash guard ReDoS | Fixed `4a74dfe` |
| F-16 | Low | Limit-notice regexes quadratic (sidecar stall; daemon thread) | Fixed `536be30` |
| F-17 | Low | Decision webhook follows redirects (SSRF pivot) | Fixed `0c85f30` |
| F-18 | Info | Unreachable ingest-token backoff branch after F-03 | Removed `e8f9a65` |
| R-01…R-13 | — | Design-level and out-of-scope findings | Reported below |

## Fixed

### F-01 High — observer token writes into managed sessions
`packages/mod-sessions/src/ingest.ts:164`. Observed-mode hook events resolved the session by claude session id
without checking its mode. Any holder of the shared observer token (every developer machine; also readable by
managed agents in `~/.aoc/client.json`) could take a managed session's claude id from the console and post
`UserPromptSubmit` (recorded as a *supervisor* prompt), `PostToolUse` with `fileChanging: true` (fake evidence,
R9), `PreToolUse` (decision cards, `session.blocked`) or `StopFailure` (Throttled) into it — directly or via
`/ingest/spool`. Observed events can no longer target managed sessions (403).

### F-02 High — client text and bulk data in the chained header
`packages/kernel/src/store/event-store.ts:637` (`headerProblems`), `packages/mod-sessions/src/ingest.ts:20,34`.
`sourceTs` (hook `sentAt`, unvalidated `z.string()`) and the raw client idempotency key were chained in clear and
exported in evidence packs. Any ingest-token holder could write personal data or megabytes into the append-only
log, where it can never be erased (and every evidence pack would carry it). The global idempotency namespace also
let a key used by session A silently swallow session B's event. The store now bounds `sourceTs` (ISO-8601) and
idempotency keys; ingest validates `sentAt` and chains `sha256(mode, aocSessionId, claudeSessionId, clientKey)`.

### F-03 High — unbounded request bodies, parse-before-auth
`packages/kernel/src/host/http.ts:84,99`, `packages/kernel/src/host/runtime.ts:168`,
`packages/mod-intake/src/index.ts:204`. No route capped its body; `/ingest/*` parsed JSON before checking the token;
the portal buffered the whole multipart body before any size check. An anonymous client could make the sole-writer
daemon buffer gigabytes (and every managed PreToolUse hook fails closed while it is stalled). Bodies are now capped
before auth (64 MiB spool, 16 MiB ingest, 4 MiB API, configured attachment allowance on `/portal/`), lazily — a
chunked body is counted as the route reads it, so a refused caller is never buffered (`e637e1f` fixed the
pre-buffering of the first version) — and anonymous `/ingest/*` is a 401 before any handler runs.

### F-04 High — blob path traversal on erasure
`packages/kernel/src/store/body-store.ts:12`. Paths kept `.`/`..` and were not injective; `eraseScope` deletes the
scope directory recursively. `POST /api/audit/erase` accepts `scopeId` matching `^[A-Za-z0-9_.:#@-]+$`
(`packages/mod-audit/src/routes.ts:44-48`), so an erase of scope `..` ran `rm -rf` on the data directory (event
log, body store, KEK): the audit trail destroyed through the erasure API. Erasing `tkt_1` also shredded `tkt/1`'s
media, and a blob could be written outside the blob directory. Ids now map to themselves only when plain, otherwise
to a hash.

### F-05 High — workspace settings subvert the managed harness
`packages/supervisor/src/launch-config.ts:165`, `packages/supervisor/src/supervisor.ts:928`. Every turn is a new
`claude -p` that also loads `<cwd>/.claude/settings.json` and `settings.local.json`, which the agent (or the repo)
controls. `{"disableAllHooks":true}` switched AOC's hooks off from the next turn (no guard, no audit trail);
`env` overrode the supervisor-composed environment: `AOC_MODE=observed` (hooks report-only), `NODE_OPTIONS`/`PATH`
(hijack the hook and MCP binaries), `ANTHROPIC_BASE_URL` (conversation, ingest token and credentials to an attacker).
Turns now fail closed (409 `workspace_settings_override`) when those files set `disableAllHooks` or `env`, or are
not plain JSON.

### F-06 High — credentials in builder-visible output
`packages/supervisor/src/supervisor.ts:951,1060,1095`, `packages/supervisor/src/routes.ts:20`. The session env holds
the type's credential profile (`GIT_PUSH_TOKEN`, UAT `DEPLOY_TOKEN`) and the ingest token; stdout/stderr went
verbatim to `/api/sessions/:id/output` (every builder) and `turn_ended.resultText`. A builder could simply ask the
session to print them (or read a failing push with a tokenised remote URL) — deploy credentials on a developer
machine (§3, R1). Output lines are now redacted (raw and JSON-escaped values). Encoded exfiltration remains: R-02.

### F-07 High — self-modification analyzer ReDoS
`packages/mod-audit/src/selfmod/shell.ts:511-530`. `open\s*\([^)]*['"]…` backtracks over the rest of the input at
every `open(`: 120 KB of `python3 -c "open(open(…"` took 3 s, the 1 MiB cap allows minutes — synchronously on the
daemon thread for every managed `Bash` call, so any (or any prompt-injected) managed agent could make every managed
session's hooks time out and fail closed. `open()` modes are now found in one pass.

### F-08 Medium — erasure residue on disk (G-39)
`packages/kernel/src/store/event-store.ts:187,576`, `packages/mod-registry/src/knowledge.ts:118`. Scrubbed
read-model text stayed in `aoc.db` free pages and WAL images; an FTS5 delete only tombstones, so erased terms stayed
in live knowledge-index segments. `aoc.db` now runs with `secure_delete`, `eraseScope` truncates the WAL, and the
knowledge projector merges (`optimize`) its index when an erasure removed documents. Tests read the raw
`aoc.db`/`-wal` bytes. G-39 / O-24 marked done.

### F-09 Medium — intake erasure incomplete
`packages/mod-intake/src/projector.ts:174`. `itk_sessions.root_cause`/`fix_plan` (ticket-scoped bodies, routinely
quoting the requester's data) survived a PDPA erasure and stayed visible on `/api/tickets/:id`; the live projection
also diverged from a rebuild.

### F-10 Medium — forgeable delimiter in the build prompt
`packages/mod-intake/src/flow.ts:262`. UAT feedback (requester text) reached the write-capable, UAT-credentialed
build session inside a fixed `<<<UAT_FEEDBACK … UAT_FEEDBACK>>>` block; only the exact-case token was stripped, so
`uat_feedback>>>` or homoglyphs closed the block. Now a per-prompt random tag (as triage). G-45 (human review before
a build) remains open.

### F-11 Medium — scope columns outside verification
`packages/kernel/src/store/event-store.ts:543`. Per-session/ticket queries and audit views filter on indexed copies
of the scope that the hash does not cover; rewriting only them hid events while `verifyChain` passed.

### F-12 Medium — background processes outlive the turn
`packages/supervisor/src/supervisor.ts:1131`. After a normal turn end, anything backgrounded (`cmd &`, nohup) kept
running in claude's process group with the full session env, acting after the turn — and the session — outside any
hook. The group is now killed when the turn settles (never the bare pid). `setsid()` still escapes (R-03).

### F-13 Medium — cross-session spool loss
`packages/hooks/src/mode.ts:49`. The supervisor sets no `AOC_SPOOL_DIR`, so all managed sessions spooled into
`~/.aoc/spool/managed`; a flush replays everything with its own token, the daemon refuses other sessions' items and
the client deletes them. Default is now per session.

### F-14 Medium — abandoned spool claims
`packages/client/src/index.ts:154`. A flusher renames a file to `.sending-<pid>` and only ever lists `*.jsonl`; a
hook killed mid-flush lost those events. Claims of dead processes are now taken over (never live ones).

### F-15 / F-16 Low — more quadratic regexes on attacker-influenced text
`packages/mod-sessions/src/ingest.ts:102` (`find.*-exec`, daemon thread, read-only sessions);
`packages/supervisor/src/throttle.ts:20`, `packages/sidecar/src/transcript.ts:214` (contracts'
`(?:\d+-hour|…)\s+limit reached`: a 100 KB transcript system line, e.g. from a repo-defined hook, stalled the
sidecar 10 s). Fixed by independent tests / inspecting only the first 2000 characters.

### F-17 Low — webhook follows redirects
`packages/mod-decisions/src/alerts.ts:184`. The receiver could bounce aocd onto internal endpoints; a 3xx is now a
failed delivery.

### F-18 Info — mod-identity ingest backoff
`packages/mod-identity/src/routes.ts:119`. Unreachable after F-03 (unknown ingest tokens never reach module
middleware); removed. Ingest tokens carry ~208 secret bits; user-token guessing is still throttled.

## Reported (not fixed here)

Wave 2 ([`review-wave2.md`](review-wave2.md)) fixed R-02, R-05, R-07, R-08, R-09, R-10, R-11, R-12 and R-13.

| # | Sev | Finding | Location | Owner / tracking |
| --- | --- | --- | --- | --- |
| R-01 | High | The ingest token is in the model-visible env (Bash, `/proc/<pid>/environ`) and the sidecar uses the same token: an agent forges its own hook events (fake file-changing `PostToolUse`), heartbeats and usage — e.g. zero-token batches carrying its real message ids pre-empt the sidecar's (`if (!fresh.length)` skips them), evading the credit cap | `supervisor/src/supervisor.ts:941,1744`; `mod-sessions/src/ingest.ts:426` | supervisor, mod-identity, mod-sessions — G-44, O-3, O-5 |
| R-02 | High | A builder can still extract the session's credential profile deliberately (ask the session to print it base64-encoded) via the output API: credentials must leave the model-visible env (supervisor-held git credential helper / push proxy) | `supervisor/src/launch-config.ts:100`; `supervisor/src/routes.ts:20` | supervisor, Ops — new |
| R-03 | High | Sessions run as aocd's OS user: agents can read the KEK, `credentialProfilesFile`, `aoc.db`, `~/.aoc/client.json` (observer token) and user-level Claude settings (`disableAllHooks`/`env` there also apply to managed sessions); `setsid` escapes F-12 | — | supervisor — G-01 / O-1 |
| R-04 | Medium | `/ingest/spool` accepts only hook items; spooled usage/throttle/exit reports are counted "rejected" and deleted (metering holes) | `mod-sessions/src/ingest.ts` (spool route) | integration agent — G-10 |
| R-05 | Medium | Evidence-pack generation (whole-chain `verifyChain`, up to 366 days, zip) runs synchronously on the daemon thread and any builder can trigger it repeatedly: all hooks time out and fail closed meanwhile. Move to a worker, single-flight, rate-limit | `mod-evidence/src/index.ts:317-327` | mod-evidence, daemon — new |
| R-06 | Medium | Evidence-pack `verification.ok` compares anchors with `anchor.created` events in the same log; whoever rewrites the chain rewrites those too. Consult mod-audit's off-host verification (needs a service in `ServiceMap`) | `mod-evidence/src/verification.ts:52-65` | mod-evidence, mod-audit — O-29, G-42 |
| R-07 | Medium | Reactor at-least-once can double-launch: `startTriage`/`startBuild` launch before recording; a crash in between relaunches on replay (two writers on `uat/<ticket>`). `LaunchRequest` needs an idempotency key | `mod-intake/src/flow.ts:130-137,273-275` | lead (contracts), supervisor, mod-intake — new |
| R-08 | Low | Usage `firstAt`/`lastAt` are client-chosen and decide the credit period/day: backdate into closed periods. Clamp to a window around receipt | `mod-sessions/src/ingest.ts:62-63`; `mod-credits/src/projection.ts:62` | mod-sessions, mod-credits — new |
| R-09 | Low | `cwd` on launch may be any existing absolute directory: a credentialed session can work outside its project's repo (attribution, credential scope). Constrain to the project repo / workspace | `supervisor/src/supervisor.ts:101,591` | supervisor — new |
| R-10 | Low | The rollover brief (agent-authored text) is placed in the successor's *system prompt*, above the untrusted-data framing: injected instructions persist across rollover. Frame it as data with a random delimiter | `supervisor/src/prompts.ts:104` | supervisor, mod-ledger — new |
| R-11 | Low | `POST /api/tickets/:id/close` needs only `ticket.view_internal`: any builder closes any ticket, even as `withdrawn` | `mod-intake/src/index.ts:340` | lead (roles.ts), mod-intake — new |
| R-12 | Low | Erase API still accepts `.`/`..` scope ids (harmless after F-04); tighten the pattern | `mod-audit/src/routes.ts:44-48` | mod-audit — new (fold into O-28, mandatory approved `decisionId`) |
| R-13 | Low | Observer token is a shared bearer with no rate limits: any holder writes into any observed session and creates unbounded observed sessions | — | O-6, O-16 |

## Reviewed without findings

Decision SoD (`canResolve`, close-key idempotency against double resolves, policy resolution limited to
`credit_topup` by a system actor, escalation only Builder → Approver, requester stays excluded), passkey gates
(`mod-identity` challenges single-use, bound to user/decision/option/card hash, expiring, UV required, counter
checked), credits (bounded amounts, own allocation refused, one auto-grant per user-period, self-approved top-ups
never honoured), FTS5 search (input reduced to quoted word tokens), SQL (parameterised throughout), intake file names
(sanitised before `Content-Disposition`), AES-256-GCM (random nonces; AAD binds body → event id, blob → blob id, DEK →
key id; DEK cache cleared on erasure), ids (`crypto.getRandomValues`), token comparison (constant time), MCP server
(argv-free relay, fails loudly without its env), hooks (managed PreToolUse fails closed on every error path).
