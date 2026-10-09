# Runbook: operating aocd

- **Owner:** the platform architect (on call), with the CEO as escalation.
- **Covers:** start and stop, health, projection rebuilds, reactor failures, backups, jobs, upgrades, logs, what
  happens when aocd is down, and demo data directories.
- **Related:** [key custody and backups](key-custody.md), [anchoring](anchoring.md),
  [incidents and break-glass](incident-break-glass.md), [architecture](../architecture.md).

## 1. The service at a glance

| Item | Default | Production |
| --- | --- | --- |
| Process | One Node ≥ 22.13 process, `aocd`: the sole writer | A supervised service (systemd), restarted on failure, running as service user `aoc` |
| Listen | `127.0.0.1:7420` | Loopback, behind a TLS reverse proxy; `publicUrl` and `identity.origin` set to the public HTTPS origin (WebAuthn requires it) |
| Data | `.aoc/data/`: `aoc.db` (chain and read models), `bodies.db` (encrypted bodies), `blobs/`, and `master.key` (dev only) | `/var/lib/aoc/data`, on a disk with monitoring; the KEK elsewhere ([key custody](key-custody.md)) |
| Config | `AocConfigSchema.parse({})` gives a complete, safe local default (`packages/contracts/src/config.ts`) | See the example below |
| Sessions | Up to `supervisor.maxConcurrentSessions` (8) `claude -p` children, plus one sidecar each | With `supervisor.isolation: "user"` (required in production) each turn runs as `supervisor.sessionUser` (read-only types as `readOnlySessionUser`) with its own `HOME`, `CLAUDE_CONFIG_DIR` and `TMPDIR` under `supervisor.sessionHomesDir`; aocd runs as root and refuses to start if a session user can read its data, KEK or credential profiles ([credential isolation §4](credential-isolation.md#4-the-supervisor-host), gap G-01). The sidecars stay with aocd. With isolation off (development) sessions run as aocd's user and share its `HOME`, so they can read whatever that user can: keep that home free of anything a session must not have |
| Request limits | Body caps, checked before authentication or parsing: 4 MiB for the API, 16 MiB for `/ingest/*`, 64 MiB for a spool flush, and for the portal the intake total allowance plus 1 MiB (one maximum-size video: 200 MiB + 1 MiB with the defaults, the total `GET /portal/api/limits` publishes; more attachments never raise it); 413 above them. A request to `/ingest/*` without a valid token gets 401 before its body is read | Set the reverse proxy's body limit to at least the portal allowance, or lower `intake.maxVideoBytes`; a proxy default of 1 MB breaks uploads |
| Time zone | `Asia/Kuala_Lumpur`. Daily jobs, rollups and FX days use local dates | Keep it unless the business moves |

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
    "workspacesDir": "/var/lib/aoc/workspaces",
    "credentialProfilesFile": "/etc/aoc/credential-profiles.json",
    "maxConcurrentSessions": 8
  },
  "metering": { "rateCardFile": "/opt/aoc/config/rate-card.json" },
  "audit": {
    "anchorProvider": "git",
    "anchorRepoPath": "/var/lib/aoc/anchor-repo",
    "anchorRemote": "git@github.com:<anchor-org>/aoc-anchors.git"
  },
  "intake": { "scanner": "clamav", "requireScan": true },
  "identity": { "rpId": "aoc.example.internal", "origin": "https://aoc.example.internal" },
  "selfModification": {
    "aocRepoPaths": ["/var/lib/aoc/workspaces/aoc"],
    "externalAuditLog": "/var/log/aoc/selfmod-audit.log"
  }
}
```

## 2. Start and stop

**Start** (development): `node dist/bin/aocd.mjs` (or `aoc serve`), after `pnpm build`.

**Start** (production): a systemd unit. Sketch:

```ini
[Unit]
Description=AOC daemon (sole writer)
After=network-online.target

[Service]
User=aoc
WorkingDirectory=/opt/aoc
LoadCredentialEncrypted=aoc-kek:/etc/credstore.encrypted/aoc-kek
ExecStartPre=/usr/bin/test -s %d/aoc-kek
ExecStart=/usr/bin/node /opt/aoc/dist/bin/aocd.mjs --config /etc/aoc/aoc.config.json
Restart=on-failure
NoNewPrivileges=no
UMask=0077

[Install]
WantedBy=multi-user.target
```

`NoNewPrivileges` must stay off **only** if the supervisor switches to the sandbox user through a narrow `sudo`
rule. With per-session containers, turn it on.

**On start**, aocd:

- opens the store;
- registers the projectors, then **rebuilds from the log** every projector that is new on an existing log, whose
  fingerprint changed, or that is marked `degraded` (§4). The log line `projections rebuilt from the log` names
  them. On a large log this makes the start slower;
- registers the guards and initialises the modules;
- starts the modules. The supervisor recovers sessions: a session recorded as running whose process is gone is
  marked failed (`process_gone_on_restart`) and shows Dead, restartable; a `claude` process that outlived the
  previous daemon is interrupted and marked failed too (`orphaned_on_restart`); queued launches start again; a
  decision answered just before the stop is delivered. Waiting, throttled and blocked sessions stay as they
  were. `mod-audit` checks the governed configuration;
- lets every reactor catch up from its cursor;
- mounts the routes and starts the job scheduler (it ticks every 30 s).

Look in the log for `registry.changed` or `config.changed` events. They are expected only when you changed
`config/`, the audit settings, the self-modification settings or the credential profiles file on purpose.

**Planned stop:**

1. Announce a maintenance window. Ask Builders to let their sessions reach a task boundary, and use **Stop at next
   boundary** on running sessions (`session.stop_requested`).
2. Wait until no session is in `running`. Sessions that are **waiting** (on a decision, a top-up or a throttle)
   have no process. They survive restarts and resume later by themselves.
3. `systemctl stop aocd`. On SIGTERM aocd stops the scheduler (no job starts from then on), drains queued reactions,
   stops modules in reverse order (a running anchor or backup is aborted), waits up to 10 s for a job that is still
   running so that its run is recorded, and closes the databases. Reactions to events a finishing job appends are
   replayed at the next start. The supervisor interrupts any turn still running (SIGINT, then SIGKILL after 2 s) and
   stops the sidecars, without appending anything. At the next start those sessions are marked failed and show Dead.

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
2. Take a backup: `aoc anchor`, then `aoc backup now` ([backup and restore](backup-restore.md)).
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

aocd backs itself up daily once `audit.backupKeyFile` is set (`aoc backup now` / `aoc backup list`; restore with
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
declares its own: for example `intake.diagnosis-budget` and `decisions.aging` (every 60 s), the ledger's overrun
check, the FX fetch (`fx.daily` at 18:00 MYT, which first re-checks the previous weekday, then `fx.retry@18:30`
and `fx.retry@21:00` while BNM's 1700 rate is unpublished; architecture §11), the metering day close and lesson
retirement. `SELECT name FROM job_runs` lists the jobs that have run.

**Anchoring now:** the nightly `audit.anchor` job runs at `audit.anchorAtLocalTime` (02:00 by default).
`aoc anchor` anchors the current chain head immediately. Use it after a missed anchor, before a backup, or
after a high-value event ([anchoring](anchoring.md)).

**Any other job:** the kernel can run a job immediately (`AocRuntime.runJob(name)`), but **no admin command
exposes it yet** (threat model O-26). Until one does, a missed daily job runs at its next scheduled time; for FX, a
missed day is carried forward and stamped as such, which is the designed behaviour, and an Approver can re-run the
day's FX attempt with `POST /api/fx/run`. Every run updates `job_runs`.
Jobs must be idempotent: a daily job forced by hand runs again even if it already ran today.

## 8. Upgrades

1. **Read** the release notes and any new or superseded [ADRs](../adr/README.md). If the release touches the
   governance core, check that it carries a human code review
   ([self-modification boundary](../compliance/self-modification-boundary.md)).
2. **Back up and verify** (§6, [anchoring §6](anchoring.md#6-verify)).
3. **Node.** Stay within `engines` (Node ≥ 22.13). `node:sqlite` behaviour is re-tested on every Node upgrade
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
