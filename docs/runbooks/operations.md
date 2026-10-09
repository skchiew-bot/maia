# Runbook: operating aocd

- **Owner:** the platform architect (on call), with the CEO as escalation.
- **Covers:** start and stop, health, projection rebuilds, reactor failures, backups, jobs, upgrades, logs, and
  what happens when aocd is down.
- **Related:** [key custody and backups](key-custody.md), [anchoring](anchoring.md),
  [incidents and break-glass](incident-break-glass.md), [architecture](../architecture.md).

## 1. The service at a glance

| Item | Default | Production |
| --- | --- | --- |
| Process | One Node ≥ 22.13 process, `aocd`: the sole writer | A supervised service (systemd), restarted on failure, running as service user `aoc` |
| Listen | `127.0.0.1:7420` | Loopback, behind a TLS reverse proxy; `publicUrl` and `identity.origin` set to the public HTTPS origin (WebAuthn requires it) |
| Data | `.aoc/data/`: `aoc.db` (chain and read models), `bodies.db` (encrypted bodies), `blobs/`, and `master.key` (dev only) | `/var/lib/aoc/data`, on a disk with monitoring; the KEK elsewhere ([key custody](key-custody.md)) |
| Config | `AocConfigSchema.parse({})` gives a complete, safe local default (`packages/contracts/src/config.ts`) | See the example below |
| Sessions | Up to `supervisor.maxConcurrentSessions` (8) `claude -p` children, plus one sidecar each | Run as a separate sandbox user (threat model O-1) |
| Time zone | `Asia/Kuala_Lumpur`. Daily jobs, rollups and FX days use local dates | Keep it unless the business moves |

**How aocd finds its configuration:** `--config <file>`, else `$AOC_CONFIG`, else `./aoc.config.json`, else the
built-in defaults. Then the environment overrides `AOC_PORT`, `AOC_HOST`, `AOC_DATA_DIR` and `AOC_PUBLIC_URL`.
Relative paths resolve against the config file's directory, or against the working directory when there is no
file. Unknown keys are reported as warnings and ignored, so read the startup log after every config change. In
production, use absolute paths. A minimal production configuration (`/etc/aoc/aoc.config.json`):

```json
{
  "dataDir": "/var/lib/aoc/data",
  "publicUrl": "https://aoc.example.internal",
  "keys": { "masterKeyFile": "/run/credentials/aocd.service/aoc-kek" },
  "registryFile": "/opt/aoc/config/process-types.json",
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
- registers projectors and then guards;
- initialises the modules;
- mounts the routes;
- lets every reactor catch up from its cursor;
- starts the job scheduler (it ticks every 30 s).

Look in the log for `registry.changed` or `config.changed` events. They are expected only when you changed
`config/` on purpose.

**Planned stop:**

1. Announce a maintenance window. Ask Builders to let their sessions reach a task boundary, and use **Stop at next
   boundary** on running sessions (`session.stop_requested`).
2. Wait until no session is in `running`. Sessions that are **waiting** (on a decision, a top-up or a throttle)
   have no process. They survive restarts and resume later by themselves.
3. `systemctl stop aocd`. On SIGTERM aocd stops the scheduler, drains queued reactions, stops modules in reverse
   order and closes the databases.

An **unplanned** stop (crash or kill) loses no committed events. Running turns lose their daemon, so their next
hook fails closed and they stop. Restart them from the console afterwards (`session.restarted`, which resumes from
the transcript).

## 3. Health checks

Daily, or continuously from monitoring:

| Check | How | Healthy |
| --- | --- | --- |
| Service up | `systemctl is-active aocd`; an HTTP request to the console | Active; 200 |
| Integrity | Control Tower integrity panel (`chainOk`, `lastVerifiedAt`, `anchorAgeMs`, `unanchoredEvents`) | `chainOk` true; anchor age within cadence ([anchoring](anchoring.md#5-daily-checks)) |
| Projections | `projection_health` (below); Tower `projection_degraded` | No rows with status `degraded` |
| Reactors | `reactor_failures` in the last 24 h; Tower `reactorFailures24h` | None, or each one explained |
| Jobs | `job_runs.last_status` | `ok` for every job |
| Decisions | The oldest open card; gate latency p90 (Tower) | Within the agreed SLA (R15) |
| Disk | Free space on the data volume; size of `aoc.db-wal` | More than 20 % free; the WAL is checkpointed regularly |
| Backups | The nightly backup exists off-host and is not shrinking | See [key custody](key-custody.md#4-backups-off-host-nightly) |

Read-only SQL checks (WAL mode allows a reader alongside aocd):

```bash
sqlite3 -readonly /var/lib/aoc/data/aoc.db <<'SQL'
SELECT name, status, failed_seq, substr(last_error, 1, 120) FROM projection_health;
SELECT reactor, seq, at, substr(error, 1, 120) FROM reactor_failures ORDER BY id DESC LIMIT 20;
SELECT name, last_run_at, last_status, substr(last_error, 1, 120) FROM job_runs ORDER BY name;
SELECT seq, ts, type FROM events ORDER BY seq DESC LIMIT 5;
SQL
```

Never write to `aoc.db` with `sqlite3` while aocd runs. The only manual write this runbook allows is the reactor
cursor reset in §5, with aocd stopped.

## 4. Rebuilding projections

**When:**

- a projector is marked `degraded`, and the fix has been deployed;
- a new release changed a projector's tables;
- a read model is suspected to be wrong.

**What happens.** `EventStore.rebuildProjections(names)` drops the named projectors' tables, recreates them, and
replays the whole log in **one transaction**, decrypting each payload (`null` where it was erased). On success it
clears their `projection_health` rows. Other projectors are not touched.

**How:**

1. Plan a maintenance window. The rebuild **holds the write lock for its whole duration**. Managed sessions' hooks
   cannot get an answer and fail closed, so stop running sessions first (§2).
2. Take a backup ([key custody](key-custody.md#4-backups-off-host-nightly)).
3. **Make sure the KEK is loaded.** A rebuild without the right key turns every body into `[erased]` in the read
   models.
4. Rebuild the named projectors only (for example `sessions`, `decisions`); rebuilding everything is rarely needed.
   **At this commit no admin command exists for it** (threat model O-26). Until one does, a rebuild means a
   reviewed one-off maintenance script, run with aocd stopped, that composes the same modules as the daemon and
   calls `rebuildProjections(names)`. Treat it as a change record. A degraded projection does not lose events: if
   the read model can wait, wait for the command.
5. Check: no `degraded` rows; spot-check counts against the event log (for example open decisions against
   `decision.requested` minus resolved, withdrawn and expired); run Verify.

A rebuild never changes the chain. If it fails, the transaction rolls back and the old tables remain.

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

The full procedure (what, the order, encryption, retention, keys kept apart) is in
[key custody §4](key-custody.md#4-backups-off-host-nightly), and the restore drill is in
[key custody §7](key-custody.md#7-restore-drill-quarterly). The rules that matter most:

- **Never copy `aoc.db` alone while aocd runs.** Use `sqlite3 … ".backup …"` or `VACUUM INTO`. Copy `aoc.db`
  first, then `bodies.db`, then `blobs/`.
- The KEK is **never** in the same backup set as the data.
- `aoc.db` holds decrypted copies of some text, so encrypt the backup set.
- Back up after the anchor job has run.

## 7. Running a job by hand

Jobs are defined by modules: interval jobs (`everyMs`) and daily jobs (`dailyAt`, local time). Each module
declares its own: for example `intake.diagnosis-budget` and `decisions.aging` (every 60 s), the ledger's overrun
check, the FX fetch, the metering day close and lesson retirement. `SELECT name FROM job_runs` lists the jobs that
have run.

**Anchoring now:** `aoc audit anchor` anchors the current chain head immediately, once `mod-audit` lands. Use it
after a missed anchor, before a backup, or after a high-value event.

**Any other job:** the kernel can run a job immediately (`AocRuntime.runJob(name)`), but **no admin command
exposes it yet** (threat model O-26). Until one does, a missed daily job runs at its next scheduled time; for FX, a
missed day is carried forward and stamped as such, which is the designed behaviour. Every run updates `job_runs`.
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
   run the end-to-end tests.
5. **Deploy:** stop at boundaries (§2); `pnpm install --frozen-lockfile && pnpm build`; restart.
6. **After start:** check that `registry.changed` and `config.changed` appear only if expected; check
   `projection_health`; rebuild the projectors whose tables changed (§4); run Verify; spot-check the console and
   the Control Tower.
7. **Rolling back AOC itself:** reinstall the previous build, and rebuild the projectors whose tables the newer
   build changed. Events written by the newer build stay in the chain. Older projectors ignore event types they do
   not handle. Upgrades must never change the meaning of an existing event type (ADR-0001), which keeps this safe.

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
