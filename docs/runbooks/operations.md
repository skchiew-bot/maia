# Runbook: operating aocd

- **Owner:** the platform architect (on call), with the CEO as escalation.
- **Covers:** start and stop, health, projection rebuilds, reactor failures, backups, jobs, upgrades, logs, what
  happens when aocd is down, and demo data directories.
- **Related:** [key custody and backups](key-custody.md), [anchoring](anchoring.md),
  [incidents and break-glass](incident-break-glass.md), [architecture](../architecture.md).

> **Upgrading?** Read [§8.1](#81-upgrade-notes-changes-that-need-an-operator-action) first. It lists, in one place,
> every change that needs an operator action or changes behaviour you may rely on.

## 1. The service at a glance

| Item | Default | Production |
| --- | --- | --- |
| Process | One Node ≥ 22.20 process, `aocd`: the sole writer | A supervised service (systemd), restarted on failure. It runs as **root** with a reduced capability set, because session isolation, which production requires, needs root to start turns as the session users ([credential isolation §4](credential-isolation.md#4-the-supervisor-host), item 1) |
| Listen | `127.0.0.1:7420` | Loopback, behind a TLS reverse proxy; `publicUrl` and `identity.origin` set to the public HTTPS origin (WebAuthn requires it) |
| Data | `.aoc/data/`: `aoc.db` (chain and read models), `bodies.db` (encrypted bodies), `blobs/`, and `master.key` (dev only) | `/var/lib/aoc/data`, on a disk with monitoring; the KEK elsewhere ([key custody](key-custody.md)) |
| Config | `AocConfigSchema.parse({})` gives a complete, safe local default (`packages/contracts/src/config.ts`) | See the example below |
| Sessions | Up to `supervisor.maxConcurrentSessions` (8) `claude -p` children, plus one sidecar each | With `supervisor.isolation: "user"` (required in production) each turn runs as `supervisor.sessionUser` (read-only types as `readOnlySessionUser`) with its own `HOME`, `CLAUDE_CONFIG_DIR` and `TMPDIR` under `supervisor.sessionHomesDir`; aocd runs as root and refuses to start if a session user can read its data, KEK or credential profiles ([credential isolation §4](credential-isolation.md#4-the-supervisor-host), gap G-01). The sidecars stay with aocd. With isolation off (development) sessions run as aocd's user and share its `HOME`, so they can read whatever that user can: keep that home free of anything a session must not have |
| Request limits | Body caps, checked before authentication or parsing: 4 MiB for the API, 16 MiB for `/ingest/*`, 64 MiB for a spool flush, 256 MiB for a git push through the gateway (`/ingest/git/`), and for the portal the intake total allowance plus 1 MiB (one maximum-size video: 200 MiB + 1 MiB with the defaults, the total `GET /portal/api/limits` publishes; more attachments never raise it); 413 above them. A request to `/ingest/*` without a valid token gets 401 before its body is read | Sessions reach aocd at `publicUrl`, so the reverse proxy carries their hooks, MCP calls and pushes too. Pass `/ingest/*`, and set its body limits to at least 256 MiB on `/ingest/git/` and 201 MiB on `/portal/` (or lower `intake.maxVideoBytes`); a proxy default of 1 MB breaks uploads and pushes ([§8.1](#81-upgrade-notes-changes-that-need-an-operator-action)) |
| Time zone | `Asia/Kuala_Lumpur`. Daily jobs, rollups and FX days use local dates | Keep it unless the business moves |

"The service user" in these runbooks means the user aocd runs as: root when session isolation is on (production), the
developer's own user otherwise.

**How aocd finds its configuration:** `--config <file>`, else `$AOC_CONFIG`, else `./aoc.config.json`, else the
built-in defaults. Then the environment overrides `AOC_PORT`, `AOC_HOST`, `AOC_DATA_DIR` and `AOC_PUBLIC_URL`.
Relative paths resolve against the config file's directory, or against the working directory when there is no
file. Unknown keys are reported as warnings and ignored, so read the startup log after every config change. In
production, use absolute paths. The registry, the rate card and the ISO 42001 mapping (`config/*.json`) fall back to
the copies packaged with aocd (`dist/config` next to `dist/bin`, or the checkout's `config/`) when they are not next
to the config file; the startup banner shows the mapping in use (`mapping  <file> (version …)`) or says that the
built-in default is, which is not a governed mapping. A minimal production configuration
(`/etc/aoc/aoc.config.json`):

```json
{
  "mode": "production",
  "dataDir": "/var/lib/aoc/data",
  "publicUrl": "https://aoc.example.internal",
  "keys": { "masterKeyFile": "/run/credentials/aocd.service/aoc-kek" },
  "registryFile": "/opt/aoc/config/process-types.json",
  "compliance": { "mappingFile": "/opt/aoc/config/iso42001-mapping.json" },
  "supervisor": {
    "sessionUser": "aoc-agent",
    "readOnlySessionUser": "aoc-reader",
    "sessionHomesDir": "/var/lib/aoc-sessions",
    "workspacesDir": "/srv/aoc/workspaces",
    "credentialProfilesFile": "/etc/aoc/credential-profiles.json",
    "maxConcurrentSessions": 8
  },
  "promotion": {
    "projects": { "prj_web": { "promotionRemote": "git@github.com:<org>/web.git" } }
  },
  "metering": { "rateCardFile": "/opt/aoc/config/rate-card.json" },
  "audit": {
    "anchorProvider": "git",
    "anchorRepoPath": "/var/lib/aoc/anchor-repo",
    "anchorRemote": "git@github.com:<anchor-org>/aoc-anchors.git",
    "backupDir": "/var/lib/aoc/backups",
    "backupKeyFile": "/etc/aoc-backup/backup.key"
  },
  "intake": { "scanner": "clamav", "requireScan": true },
  "identity": { "rpId": "aoc.example.internal", "origin": "https://aoc.example.internal" },
  "selfModification": {
    "aocRepoPaths": ["/srv/aoc/workspaces/aoc"],
    "externalAuditLog": "/var/log/aoc/selfmod-audit.log"
  }
}
```

In production aocd **refuses to start**, listing every problem it finds, unless all of these hold:

- Session isolation is set up: `supervisor.sessionUser` and a separate `supervisor.readOnlySessionUser`, each with its
  own uid and primary group, aocd running as root, and the startup self-check passing
  ([credential isolation §4](credential-isolation.md#4-the-supervisor-host), items 1 to 3).
- The KEK is an existing file outside `dataDir` (mode 0400 or 0600, owned by aocd's user) or a systemd credential,
  never `AOC_MASTER_KEY`, and never generated ([key custody §1](key-custody.md#1-what-the-keys-protect)).
- The credential profiles file defines `prod-promote`, or whichever profiles the optional `promotion` section names
  for the push to a protected remote, and no process type names one of them
  ([credential isolation](credential-isolation.md) §4 items 7 and 9).
- An aocd started from a source checkout of AOC has `selfModification.aocRepoPaths` (the example above names the
  clone; a dist install, as in the unit below, is not asked, so list its clones by hand:
  [self-modification boundary](../compliance/self-modification-boundary.md) §2).

Two more rules refuse work rather than startup: with `intake.requireScan` (the default) only an anti-virus engine
counts as a scan, so without ClamAV attachments are refused (503); and no backup runs until `audit.backupKeyFile` is
set ([backup and restore §2](backup-restore.md#2-set-up-before-real-data-lands)).

## 2. Start and stop

**Start** (development): `node dist/bin/aocd.mjs` (or `aoc serve`), after `pnpm build`.

**Start** (production): a systemd unit. Sketch:

```ini
[Unit]
Description=AOC daemon (sole writer)
After=network-online.target

[Service]
User=root
WorkingDirectory=/opt/aoc
LoadCredentialEncrypted=aoc-kek:/etc/credstore.encrypted/aoc-kek
ExecStartPre=/usr/bin/test -s %d/aoc-kek
ExecStart=/usr/bin/node /opt/aoc/dist/bin/aocd.mjs --config /etc/aoc/aoc.config.json
Restart=on-failure
NoNewPrivileges=yes
UMask=0077

[Install]
WantedBy=multi-user.target
```

aocd runs as root because only root can start a turn as another user, stop it, prepare its private directories and
read its 0600 transcript; a non-root aocd with a `sudo` runner is not supported. `NoNewPrivileges=yes` is inherited by
the sessions, so no setuid binary can raise an agent's rights. [Credential isolation §4](credential-isolation.md#4-the-supervisor-host)
(item 1) has a hardened variant of this unit (a capability bounding set, a read-only file system) and the
per-session container alternative (`supervisor.runner`).

**On start**, aocd:

- opens the store;
- registers the projectors, then **rebuilds from the log** every projector that is new on an existing log, whose
  fingerprint changed, or that is marked `degraded` (§4). The log line `projections rebuilt from the log` names
  them. On a large log this makes the start slower;
- registers the guards and initialises the modules. The supervisor runs its production checks and the
  session-isolation self-check here: the log says `session isolation verified`, or aocd refuses to start and lists
  every problem;
- starts the modules. The supervisor recovers sessions: a session recorded as running whose process is gone is
  marked failed (`process_gone_on_restart`) and shows Dead, restartable; a `claude` process that outlived the
  previous daemon is interrupted and marked failed too (`orphaned_on_restart`); queued launches start again; a
  decision answered just before the stop is delivered. Waiting, throttled and blocked sessions stay as they
  were. `mod-audit` checks the governed configuration;
- lets every reactor catch up from its cursor;
- mounts the routes and starts the job scheduler (it ticks every 30 s).

Look in the log for `registry.changed` or `config.changed` events. They are expected only when you changed `config/`
or one of the governed settings on purpose: the audit, self-modification, decisions, credits, liveness and promotion
sections, and the credential profiles file (its existence and mode only, never its content, which is deploy
credentials). Each `config.changed` names its key (`registry_file`, `rate_card_file`, `iso42001_mapping`,
`audit_config`, `selfmod_config`, `decisions_config`, `credits_config`, `liveness_config`, `promotion_config` or
`credential_profiles`) and the new hash.

**Planned stop:**

1. Announce a maintenance window. Ask Builders to let their sessions reach a task boundary, and use **Stop at next
   boundary** on running sessions (`session.stop_requested`).
2. Wait until no session is in `running`. Sessions that are **waiting** (on a decision, a top-up or a throttle)
   have no process. They survive restarts and resume later by themselves.
3. `systemctl stop aocd`. On SIGTERM aocd first lets the modules wind down while it still answers requests: the
   supervisor interrupts any turn still running (SIGINT, then SIGKILL after 2 s) and tells every sidecar to send its
   last usage report, waiting up to 5 s for it (a sidecar still there after that is killed), so the last usage of a
   session that ended just before the stop is not lost; it appends nothing, and starts no new turn or launch (503
   `shutting_down`). Then aocd stops accepting connections and lets in-flight requests finish, stops the scheduler
   (no job starts from then on), drains queued reactions, stops modules in reverse order (a running anchor or backup
   is aborted), waits up to 10 s for a job that is still running so that its run is recorded, and closes the
   databases. Reactions to events a finishing job appends are replayed at the next start. At the next start the
   interrupted sessions are marked failed and show Dead.

An **unplanned** stop (crash or kill) loses no committed events. Running turns lose their daemon, so their next
hook fails closed and they stop. At the next start the supervisor marks them failed, interrupting any that are
still alive. Restart them from the console afterwards (`session.restarted`, which resumes from the transcript).

## 3. Health checks

Daily, or continuously from monitoring:

| Check | How | Healthy |
| --- | --- | --- |
| Service up | `systemctl is-active aocd`; an HTTP request to the console | Active; 200 |
| Integrity | Control Tower integrity panel (`chainOk`, `lastVerifiedAt`, `anchorAgeMs`, `unanchoredEvents`) | `chainOk` true; anchor age within cadence ([anchoring](anchoring.md#5-daily-checks)) |
| Projections | `projection_health` (below); Tower `projection_degraded` | No rows with status `degraded` |
| Malware scanner | `GET /api/health` with a builder or approver token: `checks.intake` (anonymous callers see `ok` only); `aoc doctor` | `ok` true, `avEngine` true (ClamAV). In `mode: production` without an engine, attachments are refused (503) |
| Reactors | `reactor_failures` in the last 24 h; Tower `reactorFailures24h` | None, or each one explained |
| Jobs | `job_runs.last_status` | `ok` for every job |
| Decisions | The oldest open card; gate latency p90 (Tower) | Within the agreed SLA (R15) |
| Disk | Free space on the data volume; size of `aoc.db-wal` | More than 20 % free; the WAL is checkpointed regularly |
| Backups | `aoc backup list`; `/api/audit/health` warnings `backup_*` | The nightly backup exists off-host and is not shrinking ([backup and restore §4](backup-restore.md#4-daily-checks)) |
| Session isolation | The start-up log line `session isolation verified`; `runAs` in the payload of a recent `session.launched` | Turns run as the session user, never as root or as aocd's user |
| Push gateway | `session.git_pushed` events (`forwarded`, `refused` and `failed` counts in the meta); the aocd log | Pushes are forwarded. Investigate every `failed` (network, key or host key), and every `refused` that you did not expect |

Read-only SQL checks (WAL mode allows a reader alongside aocd):

```bash
sqlite3 -readonly /var/lib/aoc/data/aoc.db <<'SQL'
SELECT name, status, failed_seq, substr(last_error, 1, 120) FROM projection_health;
SELECT reactor, seq, at, substr(error, 1, 120) FROM reactor_failures ORDER BY id DESC LIMIT 20;
SELECT name, last_run_at, last_status, substr(last_error, 1, 120) FROM job_runs ORDER BY name;
SELECT seq, ts, type FROM events ORDER BY seq DESC LIMIT 5;
SQL
```

Never write to `aoc.db` with `sqlite3` while aocd runs. The only manual writes this runbook allows are the
`projection_state` reset in §4 and the reactor cursor reset in §5, both with aocd stopped.

## 4. Rebuilding projections

**What a rebuild does.** `EventStore.rebuildProjections(names)` drops the named projectors' tables, recreates them,
and replays the whole log in **one transaction**, decrypting each payload (`null` where it was erased). On success
it clears their `projection_health` rows. Other projectors are not touched. A rebuild **holds the write lock for
its whole duration**.

**Automatic, at every start (back-fill).** Each projector's fingerprint (a hash of its tables, DDL, handled event
types and `version`) is kept in `projection_state`. At startup aocd rebuilds, before it serves anything, every
projector that is new on an existing log, whose fingerprint changed, or that is marked `degraded`. So:

- after an upgrade that changed a projector, the restart is the rebuild;
- after deploying the fix for a `degraded` projector, the restart is the rebuild;
- a change to a projector's `apply` code alone does not change the fingerprint. The release must bump the
  projector's `version`; check that it did when you read the release notes (§8).

**By hand,** when a read model is suspected wrong and no code changed:

1. Plan a maintenance window and stop running sessions first (§2): while the rebuild runs, hooks cannot get an
   answer and fail closed.
2. Take a backup: `aoc anchor`, then `aoc backup now` with the Approver's token ([backup and restore](backup-restore.md)).
3. **Make sure the right KEK is configured.** A rebuild reads every body; with a wrong KEK it fails and rolls
   back. Never let aocd start with a generated key
   ([key custody §3](key-custody.md#3-store-the-kek-options-weakest-to-strongest)).
4. Force the rebuild of the named projectors only (for example `sessions`, `decisions`). No admin command exists
   for it (threat model O-26). With aocd **stopped**, delete their `projection_state` rows; at the next start aocd
   treats them as new and rebuilds them from the log:

   ```bash
   systemctl stop aocd
   sqlite3 /var/lib/aoc/data/aoc.db "DELETE FROM projection_state WHERE name IN ('sessions', 'decisions');"
   systemctl start aocd
   ```

   Record it as a change record: it is an operator action on governed state.
5. Check: the log line `projections rebuilt from the log`; no `degraded` rows; spot-check counts against the event
   log (for example open decisions against `decision.requested` minus resolved, withdrawn and expired); run Verify.

A rebuild never changes the chain. If it fails, its transaction rolls back. At startup that means aocd does not
start (read the journal: usually a wrong KEK or a projector bug), and the projector's tables stay empty until a
start succeeds. `projection_state` is updated only after a successful rebuild, so the next start tries again.

## 5. Reactor failures

**Semantics** ([architecture §5.7](../architecture.md#57-reactors-at-least-once-with-cursors)):

- reactors run after commit, at least once, sequentially;
- each reaction gets 3 attempts;
- after that, the failure is written to `reactor_failures` (reactor, seq, error, time) and **the cursor advances
  anyway**, so the bus never stalls;
- the follow-up is **not retried automatically**.

**Why it matters.** Some follow-ups move work forward:

- a resolved decision resumes a session (the supervisor's `resume`);
- an approved fix plan starts a build (`intake.decisions`);
- a ticket submission starts triage (`intake.triage-on-submit`);
- top-up decisions credit the account (`credits.topup_resolution`);
- playbook decisions take effect (`registry.playbook-decisions`).

A dead-lettered reaction means something that should have happened did not.

**Triage:**

1. Read the newest rows in `reactor_failures` (§3). Note the reactor name and the `seq`.
2. Read the event (`SELECT type, meta FROM events WHERE seq = ?`) and the error. Typical causes: a dependency was
   unavailable (supervisor at capacity, a git repository missing), a module bug, or data erased in between.
3. Fix the cause: deploy the fix, or restore the dependency.
4. **Re-drive.** Until a re-drive command exists (threat model O-26), reset that reactor's cursor, with aocd
   **stopped**:

   ```bash
   systemctl stop aocd
   sqlite3 /var/lib/aoc/data/aoc.db "UPDATE reactor_cursors SET seq = <failed_seq - 1> WHERE name = '<reactor>';"
   systemctl start aocd
   ```

   On start, the reactor catches up from that cursor. Reactors are idempotent (they check `causationId` before
   appending), so events after `failed_seq` that were already handled are skipped. Record the re-drive as a change
   record. It is an operator action on governed state.
5. Confirm that the expected follow-up event now exists (for example `session.turn_started {reason:
   decision_answered}`).

## 6. Backups

aocd backs itself up daily once `audit.backupKeyFile` is set (`aoc backup now` needs the Approver token, `aoc backup list` does not; restore with
`aocd restore`): see the [backup and restore runbook](backup-restore.md). Key custody and the manual procedure are in
[key custody §4](key-custody.md#4-backups-off-host-nightly) and the drill in
[key custody §7](key-custody.md#7-restore-drill-quarterly). The rules that matter most:

- **Never copy `aoc.db` alone while aocd runs.** Use `sqlite3 … ".backup …"` or `VACUUM INTO`. Copy `aoc.db`
  first, then `bodies.db`, then `blobs/`.
- The KEK is **never** in the same backup set as the data.
- `aoc.db` holds decrypted copies of some text, so encrypt the backup set.
- Back up after the anchor job has run.

## 7. Running a job by hand

Jobs are defined by modules: interval jobs (`everyMs`) and daily jobs (`dailyAt`, local time). Each module
declares its own:

| Job | When | What |
| --- | --- | --- |
| `metering.close-days` | Daily 00:15 | Closes the previous days' rollups |
| `audit.anchor` | Daily 02:00 (`audit.anchorAtLocalTime`) | Governed-config check, anchor, Verify |
| `audit.anchor_interval` | Every `audit.anchorIntervalMinutes` (60) | Anchors when anything new was logged (G-40) |
| `audit.backup` | Daily 02:30 (`audit.backupAtLocalTime`), once `audit.backupKeyFile` is set | The sealed backup |
| `evidence.integrity-sweep` | Daily 03:00 | Re-checks the stored evidence packs |
| `learning.verify-offences`, `learning.retire-lessons` | Daily 03:10, 03:20 | Closure verification, retirement of unused lessons |
| `fx.daily`, `fx.retry@HH:MM` | 18:00, 18:30 and 21:00 MYT | The BNM fetch; it first re-checks the previous weekday; the retries run while the 1700 rate is unpublished (architecture §11) |
| `decisions.aging`, `intake.diagnosis-budget`, `ledger.overrun-scan` | Every 60 s | Reminders, the triage budget, plan overruns |
| `change.breakglass-overdue` | Every 10 min | Post-incident records past their 24 h |
| `supervisor.throttle_resume` | Every 30 s | Resumes throttled sessions at their reset |
| `learning.ai` | Every 60 s | The AI distillation passes |

`SELECT name FROM job_runs` lists the jobs that have run.

**Anchoring now:** the nightly `audit.anchor` job runs at `audit.anchorAtLocalTime` (02:00 by default);
`audit.anchor_interval` anchors every `audit.anchorIntervalMinutes` (60) when anything new was logged, and
high-value events are anchored as they happen.
`aoc anchor` anchors the current chain head immediately. Use it after a missed anchor, before a backup, or
after a high-value event ([anchoring](anchoring.md)).

**Any other job:** the kernel can run a job immediately (`AocRuntime.runJob(name)`), but **no admin command
exposes it yet** (threat model O-26). Until one does, a missed daily job runs at its next scheduled time; for FX, a
missed day is carried forward and stamped as such, which is the designed behaviour, and an Approver can re-run the
day's FX attempt with `POST /api/fx/run`. Every run updates `job_runs`.
Jobs must be idempotent: a daily job forced by hand runs again even if it already ran today.

## 8. Upgrades

1. **Read** [§8.1](#81-upgrade-notes-changes-that-need-an-operator-action), the release notes and any new or
   superseded [ADRs](../adr/README.md). If the release touches the governance core, check that it carries a human
   code review ([self-modification boundary](../compliance/self-modification-boundary.md)).
2. **Back up and verify** (§6, [anchoring §6](anchoring.md#6-verify)).
3. **Node.** Stay within `engines` (Node ≥ 22.20). `node:sqlite` behaviour is re-tested on every Node upgrade
   (ADR-0002); do not upgrade Node and AOC in the same window.
4. **Claude Code.** A new Claude Code version can change hook events, stream-json lines, flags or usage-limit
   messages. Before upgrading `claude` on the host, re-run the captures in the
   [research note](../research/claude-code-integration.md) §11, update `@aoc/claude-sim` if anything changed, and
   run the end-to-end tests. `AOC_REAL_CLI=1 pnpm --filter @aoc/e2e real-cli` drives the new `claude` through AOC
   itself (a few cents of Haiku; [§13.8](../research/claude-code-integration.md#138-re-running-and-refreshing)).
5. **Deploy:** stop at boundaries (§2); `pnpm install --frozen-lockfile && pnpm build`; restart.
6. **After start:** check that `registry.changed` and `config.changed` appear only if expected; read the
   `projections rebuilt from the log` line (changed projectors rebuild by themselves, §4); check
   `projection_health`; run Verify; spot-check the console and the Control Tower.
7. **Rolling back AOC itself:** reinstall the previous build and restart. The older projectors' fingerprints
   differ from the ones stored, so they rebuild from the log at start. Events written by the newer build stay in
   the chain. Older projectors ignore event types they do not handle. Upgrades must never change the meaning of
   an existing event type (ADR-0001), which keeps this safe.

Upgrades of AOC are changes like any other: a change request with impact, mitigation, a rollback plan naming the
previous release tag, and an acceptance test.

### 8.1 Upgrade notes: changes that need an operator action

The list below is complete for the code at integration commit `b4fdf57`, compared with the first builds that were
run against real work. Each row names the gap (G-n), review finding (R-n) or process item (P-n) in the
[gap list](../compliance/gaps.md). Do the **A** rows before you start the new version; read the **B** rows so that
nothing surprises you afterwards; **C** is what this release still cannot do.

**A. Do these first.** Production refuses to start, or a feature does not work, until you have.

| # | Change | What to do |
| --- | --- | --- |
| A1 | **Session isolation is required in production** (G-01, P-13). aocd runs as root, and every turn runs as an unprivileged session user with its own `HOME`. aocd refuses to start while a session user can read its data, the KEK or the credential profiles | Create `aoc-agent` and `aoc-reader` (own uid and group each), set `supervisor.sessionUser`, `readOnlySessionUser`, `sessionHomesDir` and `workspacesDir`, fix file ownership, run the unit as root. Existing workspaces belong to root: `chown -R aoc-agent: <workspace>`. [Credential isolation §4](credential-isolation.md#4-the-supervisor-host), items 1 to 3 |
| A2 | **Credential profiles need `push.refs`, and sessions push with `git push aoc …`** (R-02, P-22). A profile's `env` and `files` are now the credential and stay with aocd. A session no longer receives them: it pushes through the gateway at `<publicUrl>/ingest/git/<project>.git`, which accepts only the branches `push.refs` names, only during a turn. A profile without `push.refs` cannot push at all | For every profile a session type names (`git-feature`, `uat-deploy`), add `push.refs`; move what a session must read itself (a registry token, `GIT_AUTHOR_NAME`) into `session`; as root, point each project's service clone at its upstream `origin` ([credential isolation §4](credential-isolation.md#4-the-supervisor-host), items 5 and 11). Check with the drill in [§6 step 2](credential-isolation.md#6-drill-quarterly-and-after-any-change) |
| A3 | **Promotions push from a service-owned clone** (G-04, P-22). `<dataDir>/git/<project>.git` pushes to `promotion.projects.<id>.promotionRemote` (else the clone's `origin`) with the profile `promotion.promoteCredentialProfile` (default `prod-promote`). A repository that has remotes but no configured promotion remote is refused (`promotion_remote_unconfigured`). `AOC_SUPERVISOR_PUSH` no longer exists | Define `prod-promote` (or the profiles your `promotion` section names) in the profiles file; set `promotionRemote` per project; make sure no process type names a promotion profile (aocd refuses the launch with `promotion_profile_forbidden`). [Credential isolation §4](credential-isolation.md#4-the-supervisor-host), item 9 |
| A4 | **A data directory that holds events never gets a new KEK** (G-46, P-03). aocd stops with "refusing to generate a new KEK" when the key file is missing, instead of silently creating a key that cannot unwrap the existing data keys. Production also refuses `AOC_MASTER_KEY` and requires an existing key file outside `dataDir` (mode 0400 or 0600, owned by aocd's user) | If you lose or move the key file, restore the **original** from escrow ([key custody §8](key-custody.md#8-loss-and-compromise)). To start over on purpose, move the data directory aside. Do not point `keys.masterKeyFile` at a new path "to get running" |
| A5 | **Nothing is backed up until `audit.backupKeyFile` is set** (G-21, P-03). Then the job `audit.backup` runs at 02:30, after the anchor; `aoc backup now` needs the **Approver's** token (a Builder gets 403); a second manual run within 10 minutes is refused (429); local files older than `audit.backupRetentionDays` (35) are deleted | Generate and escrow the backup key (a different custodian from the KEK), set `backupDir` and `backupKeyFile`, run `aoc anchor` then `aoc backup now`, and do the first restore drill. [Backup and restore §2](backup-restore.md#2-set-up-before-real-data-lands) |
| A6 | **The reverse proxy carries session traffic and large bodies.** Hooks, MCP calls, sidecar reports and pushes all go to `publicUrl`. With the default intake limits a portal upload is up to 201 MiB (a 200 MiB video plus a 1 MiB form), a gateway push up to 256 MiB, a spool flush up to 64 MiB. A proxy default of 1 MB breaks uploads and pushes (P-21) | Pass `/ingest/*` (git smart HTTP under `/ingest/git/` included). Allow at least 256 MiB on `/ingest/git/`, 201 MiB on `/portal/` and 64 MiB on `/ingest/spool`, or lower `intake.maxVideoBytes`. Do not cut a request off before 60 s without data: the gateway drops a push that is silent that long itself. Keep the PreToolUse path fast (the hook budget is 2.5 s) |
| A7 | **The anchor git gets a minimal environment** (G-46). It, and the `openssl` of the RFC 3161 provider, receive only `PATH`, `HOME`, `USER`, `LOGNAME`, the locale, `TZ`, `TMPDIR`, `TERM`, the proxy and CA variables, plus `GNUPGHOME`, `GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_ASKPASS` and `SSH_AUTH_SOCK`. A deploy key wired through anything else stops working (`anchor.failed {reason: push_failed}`) | Wire the deploy key through one of those variables or through `~/.ssh/config` of the user aocd runs as. After the upgrade run `aoc anchor` and confirm `pushed: true` ([anchoring §2](anchoring.md#2-git-anchor-provider-git)) |
| A8 | **The `claude` that aocd runs itself** (FX scraping, triage reconciliation, change-record drafting) **gets the kernel's allowlist plus exactly five variables**: `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and `NODE_EXTRA_CA_CERTS` (`CLAUDE_CLI_ENV` in `packages/llm`). Any other variable its login relied on (for example `ANTHROPIC_BASE_URL`) no longer reaches it (G-46) | Log the user aocd runs as into `claude`, or use one of the five. This is separate from the sessions' `supervisor.envAllowlist`; on a host with host-managed authentication that list also needs `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` ([research §13.8](../research/claude-code-integration.md#138-re-running-and-refreshing)) |
| A9 | **`selfModification.protectedPaths` defaults to every Tier 1 path** (G-41, P-18, P-24). An explicit list in your config replaces the default; nothing is merged. Production refuses to start from a source checkout of AOC while `aocRepoPaths` is empty | Compare your list with `DEFAULT_PROTECTED_PATHS` in `packages/contracts/src/config.ts`; set `aocRepoPaths`; for the AOC repository itself install `.github/CODEOWNERS.example` (real handles, at least two humans) and `.github/workflows/ci.yml.example` (pin its actions to commit SHAs) and make the job a required check with no bypass actors ([self-modification boundary §2](../compliance/self-modification-boundary.md#layer-3-human-review-on-github-which-aoc-cannot-bypass)) |
| A10 | **`config/process-types.json` grants the write-capable types scoped git and nothing else** (P-26, threat model O-30). `bug-fix`, `feature-build`, `discovery`, `migration`, `test-repair` and `docs` may run `git status`, `diff`, `log`, `show`, `rev-parse`, `add`, `commit`, `checkout -b`, `switch -c` and `git push aoc`; `git merge`, `rebase` and `reset` are denied. Under `claude -p` nobody can answer a permission prompt, so these builders **cannot run tests, linters or builds** and cannot close a task with test evidence. Separately, the supervisor grants blanket `Bash` to a writer type whose registry entry says nothing about Bash. The file is governed configuration: the first start records `registry.changed` and `config.changed` | **The CEO has not decided which shell a builder gets** (A: scoped git only; B: blanket `Bash` minus merge, rebase and reset; C: per-project allow-lists chosen by the operator; the lead recommends B for developer-initiated types and C for the customer-ticket-driven `bug-fix` type, which is a recommendation). Until it is decided, add per-project rules such as `Bash(pnpm test:*)` to the registry if builders must run tests, and review the diff as a change request |
| A11 | **Isolated turns start in namespaces of their own** (G-49). With `supervisor.isolation: "user"` and no runner, aocd starts every turn under `unshare --mount --pid`, so it needs util-linux (`unshare`, `mount`, `setpriv`) in a system directory and `CAP_SYS_ADMIN`. The startup self-check now also starts a peer turn per session user: production refuses to start while a turn could read a concurrent session's directory or environment, which also refuses a `setpriv` runner | If your unit sets `CapabilityBoundingSet`, add `CAP_SYS_ADMIN` ([credential isolation §4 item 1](credential-isolation.md#4-the-supervisor-host)). Leave `supervisor.sessionNamespaces` at `true`; `false` is for development hosts that cannot create namespaces |
| A12 | **Rollback acceptance commands run without a shell** (G-50). A change record's `acceptanceTest`, or a project's `acceptanceCommand`, is run as a program and its arguments. A line with shell syntax (`;`, `&&`, a pipe, a redirect, `$`, backticks, an unquoted glob), `sh`, `bash`, `npx` or `bunx`, inline code (`node -e`, `python -c`), `npm exec` or `pnpm dlx`, or a variable such as `PATH` or `NODE_OPTIONS` is not a command: verification falls back to the project's command, then to `npm test` when the checkout has a `package.json`, else reports that there is no acceptance command | Put a multi-step acceptance test in a script in the repository and name it by path, for example `./scripts/accept.sh` |

**B. Behaviour that changed.** No action is needed, but you will notice these.

| # | Change | What you will see |
| --- | --- | --- |
| B1 | **Stopping aocd takes longer** (the `quiesce` hook). Before the server stops accepting requests, the supervisor interrupts running turns (SIGINT, SIGKILL after 2 s, up to 1 s more) and lets every sidecar send its last usage report (up to 5 s), so the usage of a session that ended just before the stop is not lost | Up to 8 s with sessions running. In the worst case a stop takes about 23 s: those 8 s, up to 5 s for in-flight requests, and up to 10 s for a job that is still running. systemd's default `TimeoutStopSec` (90 s) is enough; raise a shorter custom value. During the wind-down a new launch or turn answers 503 `shutting_down` |
| B2 | **Evidence packs are queued** (R-05). `POST /api/evidence/packs` answers 201 with the pack when nothing else is being built, and 202 with a job (`GET /api/evidence/jobs/<jobId>`) when it had to wait. It answers 429 when you already have a pack pending (`pack_pending`), have asked for 12 in the last hour (`rate_limited`), or 4 are waiting (`queue_full`) | The console and `aoc evidence` follow the job until the pack is built (`aoc evidence` waits up to 10 minutes, G-56). On a 429, `aoc evidence` prints the cause and when to retry |
| B3 | **Observer tokens are rate limited** (R-13). Per token: 600 requests a minute with a burst of 1000, and 60 new observed sessions an hour | 429 with `Retry-After`. A developer flushing a very long spool is slowed down, not refused; the client retries |
| B4 | **Provenance is checked against AOC's own records** (G-25). A commit traces only when its `AOC-Session` trailer names a session the platform linked to an approved change or fix plan **and** the commit is reachable from a HEAD AOC recorded for that session (`task.done`, a phase pin, or the turn-end `session.head_recorded`). A copied trailer proves nothing; an observed session can never be linked to a change | A commit made on a laptop, or by a session outside its change, is an orphan: `promotion.refused {reason: provenance_gap}`. Work done outside AOC reaches `main` through the human path or break-glass. A session that works in a worktree under `workspacesDir` is covered at its task closes and phase pins, so have it commit before it closes a task |
| B5 | **Only the sidecar's own token may post heartbeats, usage, throttle and process reports** (G-44). The session token, which the model can read, gets 403 `sidecar_token_required` | Upgrade at a boundary (§2). Sidecar reports that the old build spooled under the session token are refused when replayed |
| B6 | **Launches are stricter and idempotent** (R-07, R-09, F-05). An unknown project is 404 `unknown_project` and creates nothing; a replayed launch returns the session the key already started; a working directory outside the project's repository or `workspacesDir` ends the turn (409 `cwd_outside_project`); a workspace or session `settings.json` that sets `disableAllHooks` or `env` ends it (409 `workspace_settings_override`, `session_settings_override`) | Create the project before launching into it. Automation that relied on a launch creating the project now gets 404 |
| B7 | **Read-only triage sessions end when their diagnosis is on record** (`completed`, reason `diagnosis_reported`) | They no longer sit in "Waiting on you" after `report_diagnosis` |
| B8 | **More configuration is governed** (O-8): `decisions`, `credits`, `liveness` and `promotion` settings, and the credential profiles file's existence and mode, are hashed into `config.changed` (the file's content never is). Turning `decisions.soleApproverFallback` on is chained | The first start records one `config.changed` per newly governed key. Match each to your change |
| B9 | **Git no longer holds aocd's thread.** The ledger's git calls time out after 4 s (`gitTimeoutMs`) and record `evidence_unverified` with `evidenceReason: git_timeout` instead of blocking every session's hooks | A slow file system shows up as unverified task closes, not as stalled hooks |
| B10 | **Isolated sessions commit as `AOC agent <aoc-agent@localhost>`** unless the profile's `session` part sets `GIT_AUTHOR_*`. **Without isolation (development) a session has no git identity** unless the operator's git configuration provides one, and `git commit` fails | Set the identity in the profile's `session.env` ([research §13.6](../research/claude-code-integration.md#136-not-checked-and-why)) |
| B11 | **Erasure also scrubs `aoc.db`, and takes longer** (G-39, W4-06). It is write-ahead (the `body.erased` record is validated and appended before anything is shredded). `aoc.db` runs with `secure_delete`, and after the shred aocd runs a `VACUUM` of `aoc.db`, then truncates its WAL; the knowledge index is merged. The `VACUUM` runs in aocd's thread for as long as it takes to rewrite `aoc.db`, so the console and the hooks wait that long on a large log, and SQLite needs free disk space of about the size of `aoc.db` for it. Aocd's backups of the erased data expire after `audit.backupRetentionDays` | Erase in a quiet moment. A backup that is reading keeps the WAL from being truncated: aocd logs `the WAL could not be truncated after an erasure`; let the backup finish and the next checkpoint clears it. A failed `VACUUM` is logged (`VACUUM after an erasure failed`) and the erasure is still reported as done; then do the manual step in [key custody §6](key-custody.md#6-crypto-shred). A crash between the record and the shred leaves the bodies readable: run the erasure again (G-57) |

**C. What this release still cannot do.** These are open; the gap list has owners.

| # | Limit | Where |
| --- | --- | --- |
| C1 | Sessions of one kind that run at the same time share an OS user and a network namespace: each turn has its own `/proc` and sees only its own session directory (G-49), but can reach another's `localhost` listeners and abstract Unix sockets | Do not run services on `localhost` that sessions must not reach |
| C2 | Up to `audit.anchorIntervalMinutes` (60) of routine events after the last anchor can be cut off the end of the chain or rewritten; high-value events are anchored as they happen (G-40) | [Anchoring §4](anchoring.md#4-cadence) |
| C3 | The default tool set still lists `RemoteTrigger`, `CronCreate`, `PushNotification`, `WebFetch` and `WebSearch` for writer types. Print mode refuses them unless granted | Deny them in the registry for any type that must never have them (P-26) |
| C4 | Not run against the real Claude Code CLI: the usage-limit path, OAuth or keychain login and per-session config directories, the isolation modes, compaction and automatic rollover, models other than Haiku, and the scoped `Bash` grants live. Not run at all: the `aocd` executable itself | [Research §13.6](../research/claude-code-integration.md#136-not-checked-and-why). Re-run `AOC_REAL_CLI=1 pnpm --filter @aoc/e2e real-cli:full` on your host and Claude Code version |
| C5 | Evidence flags prove change, not correctness: one empty close after real work is not flagged, and a read-only close proves only that the file it names exists (G-52) | Read the flags as prompts to look |
| C6 | A session may hold at most `decisions.maxOpenAgentDecisionsPerSession` (3) open agent decision cards; one more different card is refused (O-16). A managed session's ingest is limited to 600 requests a minute with a burst of 1000, per session and token kind, and answers 429 past it. Uploads per Requester and SSE connections still have no rate limit (G-47) | Watch the decision queue and stop a session that floods it |
| C7 | A sidecar that crashes during a turn is started again, at most three times per turn (G-51); after that, or after a clean exit it was not asked for, its heartbeats stop, so the session shows Dead while its process lives, and the turn's usage is flagged `under_reported`. Usage that grows between two flushes of one message could be under-counted by a Claude Code version that prints usage differently from 2.1.295 | Each turn starts its own sidecar. Read the flag as a prompt to look |

## 9. Logs

- aocd writes JSON lines to stderr (`{t, level, msg, …fields}`). Under systemd they go to the journal; ship them to
  central logging, with retention aligned to the backup retention.
- **Logs never contain bodies or secrets.** Callers pass ids only. If you find a body or a secret in a log, that is
  a bug: file it, and purge the log lines.
- Useful messages: `projector failed`, `reactor failed`, `job failed`, `request failed`, `commit listener failed`.

## 10. When aocd is down

| Who | What they see | What happens |
| --- | --- | --- |
| Managed sessions | The next hook cannot reach the daemon and **fails closed**; MCP calls return "AOC daemon unreachable: end your turn" | The session stops working. No unrecorded work happens. Restart it after recovery |
| Waiting sessions | Nothing | No process exists. They resume when their decision is answered after recovery |
| Sidecars | Heartbeats fail | Usage and throttle reports go to the local spool and are replayed after recovery |
| Observed sessions | Nothing | Events go to each developer's local spool and are replayed later |
| Console and portal | Unavailable | Requesters cannot submit; nothing is lost |

**Recovery:** restart the service. If it does not start, read the journal. If a database is corrupted, restore
([key custody §7](key-custody.md#7-restore-drill-quarterly) on production), then run Verify.

## 11. Demo and test data directories

The demo seeder builds a realistic, deterministic history by driving the real runtime with a moving fake clock, so its
projections, hash chain and anchors are genuine: the people and projects, about thirty finished sessions with plans,
evidence and pinned phases, change control (change records, a gated rollback executed and one waiting, a break-glass
closed and one still inside its 24 hours, promotions that passed provenance), eleven intake tickets in every stage of
the funnel, credits, FX and error learning. Every event is dated at or before the seeding instant. `live` does
everything, including the daemon and a fleet of real managed sessions:

```bash
pnpm --filter @aoc/demo live -- --data-dir /abs/path/to/demo [--port 7420] [--reset]   # seeds if empty, starts aocd, runs the fleet
pnpm --filter @aoc/demo seed -- --data-dir /abs/path/to/demo [--days 14] [--reset]     # the history only (14 to 60 days)
# by hand, on a seeded directory (the seeder prints this command with the paths filled in):
AOC_CONFIG=<dir>/aoc.config.json CLAUDE_CONFIG_DIR=<dir>/claude CLAUDE_SIM_SCENARIO=<dir>/claude/demo-default-scenario.json \
  CLAUDE_SIM_EXEC=1 node --import tsx packages/daemon/src/main.ts
```

`live` replaces the old `pulse`: the sessions of a live demo are real managed processes (supervisor, hooks, AOC MCP
server, sidecar) running a claude-sim scenario, so there is nothing left to fake. [`packages/demo/README.md`](../../packages/demo/README.md)
describes the fleet, the tickets and the change-control history the CEO finds.

- The seeder writes `<dataDir>/aoc.config.json` next to the data. It runs managed sessions on `@aoc/claude-sim`,
  turns the FX fetch off with the fake extractor, and keeps the anchor repository, workspaces and the external
  audit log inside the demo directory. Start a demo daemon **only** with that file (`live` refuses to start unless
  managed sessions run on claude-sim). Never point a demo at the real `claude` CLI: Nudge and Restart would spend
  plan quota and touch real repositories.
- **Layout** of the demo directory: `aoc/` is AOC's data directory (event log, bodies, keys, anchors, and `git/`, the
  service-owned clones promotions run in), `repos/<project>/` the projects' repositories, `workspaces/<project id>/<name>/`
  linked worktrees in which the live fleet's sessions edit files (so a promotion or rollback can always fast-forward
  the checked-out `main`), `claude/` claude-sim's config directory and the generated default scenario,
  `credential-profiles.json`, `aoc.config.json`, `demo-tokens.json`, and `logs/` and `live-fleet.json` for `live`. The
  repositories sit **outside** the data directory on purpose: aocd protects its data directory as audit state and
  refuses a service clone that overlaps a project.
- `<dataDir>/demo-tokens.json` (mode 0600) holds the demo users' tokens, including an Approver's. Treat a demo
  directory as disposable, keep it off shared machines, and delete it when done.
- `<dataDir>/credential-profiles.json` (mode 0600) defines every profile the demo references, each with an **empty**
  environment: a demo holds no real credential, and its promotions need none (the repositories have no remote, so the
  platform updates their own `main`).
- **`--reset` and existing data.** `seed` refuses a directory that already holds an `aoc.db`; `live` seeds an empty
  directory and otherwise starts on the seeded one, so a restart keeps its state. `--reset` deletes the directory
  first, and only an empty directory or one the seeder created (it holds `demo-tokens.json` or `aoc.config.json`); a
  filesystem root, or a directory with other contents, is refused. **Never run the seeder against a production data
  directory.**
- The seeded history was signed with a software passkey that the seeder removes again. Passkey-gated cards (go-live,
  rollback, break-glass) therefore need a passkey of the operator's own, registered in Admin (the WebAuthn origin
  follows the console's port).
- A demo daemon runs the shipped `config/process-types.json`, which grants `bug-fix` and `feature-build` a scoped
  set of git (branch, stage, commit, and the push gateway, never merge, rebase, reset or `main`). That file is
  governed configuration: mod-audit records a changed hash at the first start after it changes.
- A demo directory uses the development defaults: a generated KEK in `<dataDir>/master.key`, a local-only anchor
  repository, and the built-in malware heuristic. None of that is acceptable in production.
