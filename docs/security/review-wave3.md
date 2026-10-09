# Security review — wave 3

Adversarial review of the code merged **after** wave 1 (`docs/security/review-wave1.md`), as an attacker who controls
an agent session, a requester account, a builder account, and (separately) an external network position. Scope:
session OS-user isolation (G-01/G-46), privileged git (G-04), backup/restore (G-21) and the audit service,
governance changes (mod-change provenance G-25, selfmod promotion refusal G-41, mod-intake), the client spool and
the shared transcript parser, build/packaging and the e2e/demo helpers, and the web app (XSS/injection sinks,
WebAuthn, CSP, SSE/CSRF). Baseline: `6adc600` (session isolation G-01/G-46, G-04 service-owned clone, backup/restore
G-21, mod-evidence off-host verification G-42 and the governance-core `protectedPaths` default all already merged).

**Not reviewed here, by design** (owned by concurrent waves, per the lead's assignment): R-01…R-13 from wave 1's
"Reported" list (push credential proxy, evidence-pack worker/rate-limit, launch idempotency, usage timestamps,
launch `cwd`, rollover brief framing, ticket-close permission, erase scope ids, observer rate limits) and G-44 (a
separate sidecar ingest principal). I read their descriptions only to avoid overlap.

Severity: **Critical** breaks §3 or the audit chain for everyone · **High** a token holder, agent or requester can
defeat a binding control or take the platform down · **Medium** partial defeat or data-protection gap · **Low**
hardening / defence-in-depth.

## Summary

No Critical or High severity finding. One Low finding, fixed with a regression test.

| # | Sev | Finding | Status |
| --- | --- | --- | --- |
| W3-01 | Low | `ChangeEngine.start()` could link an **observed** (unverified, laptop) session to an approved change record, which is exactly the data the provenance trace's `via: 'session_change'` path reads | Fixed `<see commit>` |

## Fixed

### W3-01 Low — an observed session could be linked to an approved change record (G-25 defence-in-depth)

`packages/mod-change/src/engine.ts`, `start(changeId, sessionId, user)` (was: no mode check at all).

**Why it matters.** The provenance guarantee (§14, G-25) traces a commit through a gate only when its session is
one AOC itself linked to an approved change or an approved fix plan, *and* the commit is reachable from a HEAD that
session actually recorded (`provenance.ts`, `classifyCommit`/`sessionRecorded`). `start()` is the one place that
creates that linkage (`change.started`). It already refused an unknown session and a session from another project,
but not an **observed** one. Observed sessions are explicitly the lowest-trust event source in the system: §2.2 of
the threat model lists them "Unverified… May it gate on its own? Never", and T-12 states "Observed data… never feeds
gates, credits or evidence." Linking one to an approved change is precisely feeding it into a gate.

**Exploit scenario (today: not reachable, which is why this is Low, not High).** The owner of an approved change
record calls `POST /api/changes/:id/start` naming a session id they fully control as an *observed* session (any
holder of the shared, per-machine observer token can create one — credential-isolation.md §4 drill item 6, T-12).
If that observed session could also post a `task.done`/`phase.completed` event recording an arbitrary commit as its
HEAD, the provenance trace would classify that commit as traced via `via: 'session_change'`, without ever having
gone through a managed, credential-isolated session. I verified this second half is **not** currently possible:
`mod-ledger`'s MCP routes (`task_done`, `declare_plan`, …) call `requireIngest(c, { sessionId, allowSystem: false })`
without `allowObserver: true` (`packages/mod-ledger/src/routes.ts:107`), and observed-mode requests never hold a
`'session'`-kind ingest principal in the first place — only the shared `'observer'`-kind token
(`packages/mod-sessions/src/ingest.ts:477`, `mode === 'observed' → allowObserver: true`, never a per-session token
minted for them). So today the second half of the chain is closed, and `start()`'s gap is latent, not live.

**Fix.** `start()` now refuses to link a session whose `mode` is `'observed'` (`422 session_not_managed`), so the
gate holds on its own instead of depending on a property of a different package (mod-ledger's ingest routing) that
could change under a future refactor (e.g. if G-10's "dispatch more spool item kinds to their live handlers" is ever
extended to ledger routes).

**Test.** `packages/mod-change/test/change.test.ts` › "refuses to start an approved change on an observed session":
fails before the fix (200, the observed session is linked) and passes after (422, nothing recorded; a managed
session for the same change still starts normally).

## Reviewed, no finding

Significant adversarial static review turned up no new exploitable bug in the areas below (wave 1's and the
intervening waves' fixes hold up). Listed with what was specifically checked, so the lead can see what "reviewed"
meant here rather than take it on faith.

**Session OS-user isolation (G-01/G-46)** — `packages/supervisor/src/{isolation,launch-config,sandbox,process-utils,supervisor}.ts`,
`packages/kernel/src/{crypto,child-env,git}.ts`, `packages/daemon/src/{config,daemon}.ts`:
- `ensureDir`/`writeOwned` create and chown every AOC-managed path through a no-follow handle
  (`O_DIRECTORY|O_NOFOLLOW` / `O_CREAT|O_EXCL|O_NOFOLLOW`), so a symlink planted at a path AOC is about to create
  is refused, never followed. `prepareSessionDirs`'s `home/` is created root-owned (0700) first and only chowned to
  the session user as the last step, so the session user has no window in which to intervene in its own creation; a
  later mismatch (`lstatSync(home).uid !== user.uid`) refuses the turn rather than trusting a stale directory.
- `handOver`/`reown` (sandbox.ts) walks with `lstatSync` + `lchownSync`, re-owning a symlink entry itself rather than
  its target — confirmed this cannot be used to redirect ownership onto a path outside the handed-over tree.
- The startup self-check (`selfCheck`) runs the exact spawn path a turn uses (`turnSpawn`), not a shortcut, and
  checks every secret path (dataDir, both DBs, the KEK, the profiles file, every key file it names, aocd's own
  session files) is unreadable by each configured session user, under the real runner.
- `turnSpawn`'s `{user}/{uid}/{gid}/{sessionId}/{sessionDir}/{cwd}` placeholders are substituted into **argv array
  elements**, never into a shell string (no shell is ever invoked for the runner), so there is no command injection
  surface through them regardless of what `cwd` (an existing absolute directory, `LaunchRequestSchema`) contains.
- Directory removal on cleanup (`removeKeyFiles`, `dropKeyCopies`, rollback-verification's `rmSync(root, …)`) is a
  recursive `fs.rmSync` running as root over a tree a lower-privileged process may have had write access to in the
  interim (after `handOver`). I confirmed from Node's own `rimrafSync` implementation
  (`lib/internal/fs/rimraf.js`) that it `lstat`s — never `stat`s — at every level of the recursion before deciding
  whether to `unlink` or recurse, and a path that has become a symlink is simply unlinked (the link itself, never
  its target): the classic TOCTOU "swap a subdirectory for a symlink mid-`rm -rf`" attack is not available against
  Node's recursive remove on this Node version, independent of anything AOC does. `credentials/` (where this matters
  most) is additionally `root:<sessionGid>` mode `0750` throughout a turn, so the session user has no write access
  to plant anything there in the first place.
- `childEnv`/`serviceGitEnv`/`isolatedRunEnv`/`buildSessionEnv` are genuine allowlists (`for (const k of ALLOWLIST)`),
  not blocklists, and none of them pass through `AOC_*`.
- Confirmed the one already-documented residual independently: a build and a triage session each share **one** OS
  user across concurrent sessions of the same kind (no per-session uid), so same-kind sessions can read each
  other's key copies and `/proc/<pid>/environ` — this is gaps.md's G-01 residual, not a new finding, and no symlink
  trick is needed or possible to make it worse (same-uid file access is unconditional).

**Privileged git (G-04)** — `packages/mod-change/{clone,engine,repo}.ts`, `packages/kernel/src/git.ts`:
- `transportOf` rejects `ext::` and `fd::`-style helper transports: they have no `://`, aren't `/`-rooted, and the
  scp-like fallback regex's `(?!:)` negative lookahead specifically excludes a second colon, so `ext::sh -c ...`
  matches none of the three accepted schemes and the promotion remote is refused up front
  (`promotion_remote_invalid`), never reaching a `git push`.
- The compare-and-swap push (`--force-with-lease=refs/heads/<branch>:<base>`) only ever moves forward from a base
  AOC itself verified; `default_branch_moved` on a stale lease, never an unchecked push.
- `uploadPackFor` makes the *serving* side of a same-host fetch run as the project repository's owner (via a fixed,
  shell-quoted `node -e` helper with the uid/gid as `process.argv`, not string-interpolated), so root's fetch into
  the service clone never executes the agent-owned repository's hooks or config as root; the fetching side stays
  fsck'd (`transfer.fsckObjects=true`) and tag/transport-restricted.
- `GIT_SAFETY_ARGS` (hooks off, every `gpg.*.program` pointed at `/dev/null`, `protocol.allow=never` plus every
  named transport) is prepended to **every** git invocation (`runServiceGit`, the plain `git()` wrapper, and the
  sandboxed `GitRunner` `engine.ts` builds for `updateProjectBranch`'s worktree merge); `filterDriverOverrides`
  neutralises every `filter.<name>.{clean,smudge,process}` the repository defines before any checkout/merge/diff
  touches the working tree, closing the "custom filter driver runs on `status`/`diff`/checkout" path named in scope.
- `updateProjectBranch`'s worktree branch (writes to a project repository's own checked-out branch) verifies the
  worktree it is about to touch actually shares `--git-common-dir` with the repository being asked about before
  acting in it, so worktree metadata (agent-writable) cannot redirect the write elsewhere.
- Archive/zip-slip equivalent: `isArchivePath`'s per-segment regex (`/^[A-Za-z0-9_~-][A-Za-z0-9_.~-]{0,254}$/`)
  forbids a segment from *starting* with `.`, so no segment can be `.` or `..`; combined with the fixed
  `blobs/<scope>/<id>` (exactly 3 segments) and `anchors|evidence` (2–4 segments) shapes, there is no path outside
  `dataDir` an archive entry can name.

**Backup/restore (G-21) and the audit service** — `packages/mod-audit/src/{backup/*,anchor/*,service}.ts`,
`packages/daemon/src/restore.ts`:
- `SealedReader`/`ArchiveReader` authenticate every frame (AES-256-GCM, AAD = the exact header bytes) before any
  plaintext is used, reject a frame beyond `CHUNK`, and `atEnd()`/the final-frame flag catch a stream truncated
  before its manifest — a partial or edited `.aocbk` fails closed rather than silently restoring a prefix.
- `loadBackupKey` independently checks the key is not world/group-readable, not inside `dataDir` or `backupDir`,
  not beside the KEK file, and not equal to the KEK (`ctx.store.bodies.isKek`) — confirmed these are real
  filesystem/content checks (`realpathSync` + `relative()`), not string prefix comparisons that a symlink or `..`
  could defeat.
- `restoreBackup` recomputes the **whole** chain, every body hash, every blob, and the KEK's ability to unwrap every
  live data key, *before* moving anything into the target directory (`moved` stays false on any problem); the
  target-must-be-empty check (`assertEmptyTarget`) is a real `readdir`, not a `stat`.
- `/api/audit/backup` and `/api/audit/anchor` are both `audit.verify`-gated and the manual-backup path is
  rate-limited (`minBackupIntervalMs`, 429 `backup_too_recent`); backup packing is `fs/promises`-based (never
  blocks the event loop) and the DB snapshot itself runs in a worker thread (`snapshot.ts`), so repeated manual
  triggers cannot stall managed-session hooks the way the pre-wave-1 evidence-pack path could.
- `anchorNow` refuses to anchor when the live head disagrees with a freshly recomputed pass, or when any **already
  known** anchor's hash no longer matches the live chain — so a same-process forge-then-anchor cannot launder a
  rewritten past.

**mod-evidence off-host verification (G-42)** — confirmed `verificationSource()` (`packages/mod-evidence/src/index.ts`)
calls the real `audit.verify()` (which recomputes the chain and checks every anchor against its off-host record),
not an in-chain-only comparison; it degrades to `not_verifiable` (never silently `verified`) when the audit service
is absent or throws. `statusOf` (`verification.ts`) treats any anchor that isn't off-host-confirmed, any
`record: 'missing'`, and any git anchor when the remote couldn't be fetched (`remoteChecked === false`) as grounds
to withhold `verified`, not to grant it — the doc entry in `docs/compliance/gaps.md` marking G-42 "Unassigned" is
stale; the code (and the `1562cae` / `a6366f6` e2e work) already closed it.

**mod-identity passkeys (WebAuthn)** — `packages/mod-identity/src/passkeys.ts`: challenges are single-use
(consumed before the verify `await`, so a concurrent replay of the same challenge cannot both win), bound to
`(rpId, userId, decisionId, optionId, cardHash, nonce, expiresAt)` hashed into the actual WebAuthn challenge
(`decisionChallenge`), and re-checked against the **current** card (`decisionCardHash(card) !== binding.cardHash`
→ `decision_changed`) so an edited or already-resolved card cannot be signed for. `expectedOrigin`/`expectedRPID`
come from server config, never from the request. Counter regression is checked only for a cryptographically verified
assertion (library's own counter gate is disabled and replaced with an explicit post-verification compare), so an
unsigned replay can never trigger the "cloned authenticator" alarm.

**Web app** — `packages/web/src`: no `dangerouslySetInnerHTML`/`innerHTML`/`eval`/`new Function` anywhere; every
dynamic `href`/`to` I found is either an internal route built with `encodeURIComponent` or a `download` link to the
app's own API; upload previews (`useAttachments.ts`) only ever feed object URLs to `<img>`/`<video>` (which do not
execute embedded scripts even for a mis-sniffed SVG); `safeNextPath` rejects `//`- and `/\`-prefixed post-login
redirects and `navigate()` never leaves the SPA regardless. CSP (`packages/daemon/src/http.ts`) is already strict
(`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`, `nosniff`, `no-referrer`,
`X-Frame-Options: DENY`, COOP/CORP `same-origin`, HSTS when `publicUrl` is https) — the task's suggested CSP/frame
headers were already added, nothing to do there. SSE (`daemon/src/sse.ts`) requires `session.view` and the session
cookie is `SameSite=Strict`, so a cross-site page cannot attach it to a stream request; `csrfGuard` independently
checks `Origin` for cookie-authenticated unsafe methods.

## Not fixed (residual / proposal, no code change here)

Nothing met the bar for a design-decision write-up beyond what wave 1 and the threat model already track. The one
adjacent observation worth a line: **W3-01's fix is local to `mod-change`.** If another module later gains a
similar "link this session id to something that feeds a gate" API (lead/contracts-owned pattern, not specific to
any one package), the same `info?.mode === 'observed'` guard belongs there too; I did not find another instance of
the pattern to fix today.
