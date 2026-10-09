# Runbook: credential isolation (R1)

- **Risk:** R1, Critical. Work bypasses the platform (laptop pushes, held deploy keys), so every control is
  advisory and the audit trail and metering have holes.
- **Owner:** CEO, with the platform architect. Changes to anything in this runbook are change requests at scope
  `production`.
- **When:** before the first managed session touches a real repository, then quarterly (the drill in §6), and
  after any change to GitHub organisation settings, rulesets, deploy keys or the credential profiles file.

> **Deploy credentials and protected-branch rights live only in supervisor-controlled session environments, never
> on developer machines.** (AOC-SPEC-003 §3.) This is the single highest-priority integrity requirement. Every
> gate, the provenance guarantee, metering and the audit trail depend on it.

## 1. Why hooks are never the wall

Hooks, guards and the pre-push hook are useful. They observe activity, and they turn an attempt into a decision
card. But none of them can stop a determined person or a manipulated agent:

- `claude --bare` and `claude --safe-mode` skip **all** settings hooks. Anyone running Claude Code themselves can
  do this.
- Settings that fail validation are **ignored silently** in `-p` mode, and a mistyped hook field silently disables
  that hook (verified on Claude Code 2.1.295; see the [research note](../research/claude-code-integration.md) §2.2
  and §4.5).
- Hooks live in `~/.claude/settings.json`, which the developer owns and can edit.
- Matching command patterns is a speed bump. `bash -c`, scripts and Make targets get around it (§2.4).
- `git push --no-verify` skips a pre-push hook. Work done in a plain terminal never touches a Claude Code hook.

So the wall is built from two things only:

1. **Server-side branch protection** on GitHub, which nobody can skip from a client.
2. **The absence of credentials** that could get past it, anywhere outside the supervisor.

## 2. Who holds which credential

| Credential | What it can do | Where it lives | Never on |
| --- | --- | --- | --- |
| **Supervisor machine identity** (`aoc-supervisor` machine user, or a GitHub App) | Update `main` and `release/*`; create `aoc/*` pin tags | The `prod-promote` credential profile, used only by the `git push` from mod-change's service clone (promotion, rollback, break-glass; §4 item 9) | Any session environment; any developer machine; any process type in the registry |
| **Feature push credential** (profile `git-feature`) | Push feature branches | Credential profiles file, read by aocd alone; the push gateway forwards the branches a session pushed with it (§4, item 11) | Every session environment and directory; read-only types; developer machines |
| **UAT credential** (profile `uat-deploy`) | Push `uat/*` branches and deploy to UAT | Credential profiles file, read by aocd alone; the gateway forwards a `bug-fix` session's `uat/<ticket>` with it | Every session environment and directory; read-only types; developer machines |
| **Production deploy credentials** | Deploy to production | Only behind the promotion path (`runIsolated`) | Every session; every developer machine |
| **Developers' own GitHub accounts** | Clone; open pull requests; push non-protected branches if the CEO allows it | Developer machines | Rights to update `main` or `release/*`; admin on governed repositories; deploy keys |
| **Read-only triage sessions** | Nothing | None (`credentialProfile: null`, enforced by the registry schema) | — |

Two facts to keep in mind:

- **Everything in a session's environment is readable by its model**, and through it by every Builder who can read
  the session's output ([research](../research/claude-code-integration.md) §8). Redaction stops an accidental print,
  not a deliberate encoding (`base64`, a split string). So a session **never holds a credential that can push**
  (R-02): the `env` and `files` of a credential profile stay with aocd, which forwards the branches a session
  pushes through the **push gateway** (§4, item 11). What a session does receive from its profile (`session`) is
  for reading, such as a registry token, and is model-visible by design. Rulesets (§3) still make sure no
  credential, aocd's own included, can move `main` outside the supervisor's promotion path.
- **The profiles file only protects anything if agents run as a different OS user.** If `claude` runs as the same
  user as aocd, the agent can simply read the 0600 profiles file, the KEK and the database. aocd now enforces the
  separation when `supervisor.isolation` is `"user"` (§4), and `"mode": "production"` refuses to start without it
  (threat model O-1, gap G-01).
- **With isolation off they do not.** `"isolation": "none"` (the development default) spawns `claude` as aocd's
  own OS user with aocd's `HOME`: every session, including a read-only triage session through its `Read` tool, can
  read the profiles file, every key file a profile names, the KEK, both databases and whatever the service user's
  home holds. On such a host, treat every credential as readable by every session.

## 3. GitHub: protect `main` and `release/*`

Use **repository rulesets** (Settings → Rules → Rulesets), or organisation rulesets that target the governed
repositories. Create **two** rulesets, because bypass actors bypass everything in a ruleset, and some rules must
bind even the supervisor.

### 3.1 Ruleset A: `integrity` (no bypass actors)

- Target branches: `main`, `release/*`.
- Enforcement: **Active**, not Evaluate.
- **Restrict deletions:** on.
- **Block force pushes:** on.
- **Require status checks to pass:** on. Required checks: the CI job that runs `scripts/check.sh` (typecheck and
  tests) and any product acceptance suite. "Require branches to be up to date": on.
- Require linear history: recommended, because it makes provenance checks simpler.
- Bypass list: **empty**. Not the supervisor, not admins, not deploy keys.

### 3.2 Ruleset B: `updates` (the supervisor alone may move the branch)

- Target branches: `main`, `release/*`.
- Enforcement: **Active**.
- **Restrict updates:** on. Only bypass actors can update matching refs.
- **Restrict creations:** on, so nobody else can create a `release/*` branch.
- **Require a pull request before merging:** on. Required approvals: 1. Dismiss stale approvals: on. Require
  review from Code Owners: on (the governance-core paths in the AOC repository have CODEOWNERS; see the
  [self-modification boundary](../compliance/self-modification-boundary.md)).
- **Bypass list: only `aoc-supervisor`** (or the AOC GitHub App). **Never** add the "Repository admin" role,
  "Deploy keys" or "Organization admin".

> **Trade-off.** With the supervisor as the only bypass actor, AOC's passkey-signed go-live decision is the review
> of record, and the supervisor performs the merge. If you want GitHub to enforce a human review independently,
> remove the bypass. The supervisor then opens the pull request, and the Approver also approves it in GitHub. That
> is two gates, which is slower but independent of AOC. This is the CEO's choice; record it as a decision.

### 3.3 Ruleset C: pin tags

- Target tags: `aoc/*` (phase-completion and change-record pins, `git.ref_pinned`).
- Restrict creations, updates and deletions; block force pushes.
- Bypass: `aoc-supervisor` for creation only. Updates and deletions get no bypass at all: pinned refs are
  immutable (§8).

### 3.4 Organisation and repository settings

- Developers get the **Write** role (or **Read**, if all work goes through AOC), never **Admin** or **Maintain**.
  Admins can edit rulesets.
- Organisation owners: the CEO plus at most one break-glass owner whose credentials are held offline. Owners can
  change rulesets: watch the audit log (§7).
- Deploy keys: at most one write key per repository for `git-feature`, and one for `uat-deploy` where UAT applies.
  Name them `aoc-<profile>-<repo>`. No other write deploy keys may exist.
- Disable "Allow GitHub Actions to create and approve pull requests", unless CI needs it.
- If classic branch protection is used instead of rulesets, turn on **"Do not allow bypassing the above
  settings"**. Without it, administrators bypass everything.

### 3.5 Check the configuration from the command line

```bash
OWNER=<org>; REPO=<repo>
gh api repos/$OWNER/$REPO/rules/branches/main | jq '.[].type'
#   expect: deletion, non_fast_forward, required_status_checks, update, pull_request (and creation)
gh api repos/$OWNER/$REPO/rulesets | jq '.[] | {name, enforcement, target}'
gh api repos/$OWNER/$REPO/rulesets/<id> | jq '.bypass_actors'
#   expect: only the aoc-supervisor actor on ruleset B, an empty list on ruleset A
gh api repos/$OWNER/$REPO/keys | jq '.[] | {title, read_only}'
#   expect: only aoc-git-feature-* and aoc-uat-deploy-* with read_only=false
```

## 4. The supervisor host

The host that runs aocd and the supervisor. Items 1–3 are enforced by aocd when `supervisor.isolation` is `"user"`
(gap G-01); `"mode": "production"` refuses to start without them.

1. **Users.** Every managed turn — `claude`, its hooks, its MCP server and every tool the model runs — runs as an
   unprivileged **session user**, never as aocd's user (threat model O-1). Read-only types (bug triage) run as a
   **second** session user, so a triage session, which reads untrusted intake text, can neither open a build
   session's key copy nor read a running build session's environment through `/proc`. The sidecar stays with aocd:
   it reads the session's transcript, which Claude Code writes with mode 0600.

   ```bash
   useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin aoc-agent
   useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin aoc-reader
   ```

   Each needs its own uid **and** its own primary group (aocd refuses otherwise). Neither may be in any group that
   can read AOC's files, and neither may have `sudo` rights.

   **aocd runs as root.** Only root can start a turn as another user, stop it (SIGKILL across users), prepare its
   private directories and read its 0600 transcript; with `isolation: "user"` aocd refuses to start as any other
   user. Keep root's reach small in the unit, for example (guidance, not tested here):

   ```ini
   [Service]
   User=root
   NoNewPrivileges=yes
   CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_CHOWN CAP_FOWNER CAP_KILL CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH
   ProtectSystem=strict
   PrivateTmp=yes
   ReadWritePaths=/var/lib/aoc /var/lib/aoc-sessions /srv/aoc/workspaces
   ```

   `NoNewPrivileges=yes` is inherited by sessions, so no setuid binary (`sudo`, `su`) can raise an agent's rights.

   Configuration:

   ```json
   {
     "mode": "production",
     "dataDir": "/var/lib/aoc/data",
     "keys": { "masterKeyFile": "/etc/aoc/kek" },
     "supervisor": {
       "sessionUser": "aoc-agent",
       "readOnlySessionUser": "aoc-reader",
       "sessionHomesDir": "/var/lib/aoc-sessions",
       "workspacesDir": "/srv/aoc/workspaces",
       "credentialProfilesFile": "/etc/aoc/credential-profiles.json"
     }
   }
   ```

   Naming `sessionUser` turns isolation on (`supervisor.isolation` defaults to `"user"` then, and always in
   production). `"isolation": "none"` is the development default: sessions run as aocd's own user and **can read
   the KEK, both databases and the credential profiles**. aocd logs a warning at startup and on every launch while
   it is on, and production mode refuses it. On such a host keep aocd's home free of SSH keys, git credential
   helpers, `gh` logins and cloud CLI profiles, and remember that the anchor deploy key kept there is readable by
   sessions ([anchoring §2](anchoring.md#2-git-anchor-provider-git)); with isolation on, root's home is out of their
   reach.

2. **File ownership.**

   | Path | Owner | Mode | Why |
   | --- | --- | --- | --- |
   | `dataDir` (`aoc.db`, `bodies.db`, `blobs/`, `git/`) | root | `0700` (aocd creates it so) | The chain, decrypted read models, encrypted bodies, the service clones (item 9) |
   | KEK (`keys.masterKeyFile`) | root | `0400` | Outside `dataDir`; see [key custody](key-custody.md) |
   | Credential profiles file | root | `0600` | Names every deploy credential |
   | Key files the profiles name | root | `0600` | Sessions get private copies, never these |
   | aocd's private session files (`<dataDir>/sessions`) | root | inside `dataDir` | System prompts, sidecar state |
   | Push gateway repositories (`<dataDir>/git`) | root | inside `dataDir` | Everything sessions pushed, and the upstream URL they are forwarded to (item 11) |
   | `supervisor.sessionHomesDir` | root (aocd creates it) | `0711` | Session users reach their own directory, cannot list others; no directory above it may be writable by a session user |
   | `supervisor.workspacesDir` | root | `0755` | aocd creates each new project workspace for `aoc-agent` (`0755`, so `aoc-reader` can read it) |
   | Project repositories registered for a project | `aoc-agent` | `0755` | Builds write them; triage reads them |
   | `claude`, `node`, the AOC hook and MCP bundles | root | readable and executable by all | Session users run them; install `claude` system-wide, not under `/root` |

   Existing workspaces created before isolation belong to root: `chown -R aoc-agent: <workspace>`. Because
   repositories belong to `aoc-agent`, root's git refuses to run in them ("dubious ownership"). That is git's
   protection against threat model T-2 doing its job; **never** set `safe.directory=*` to silence it. AOC's own git
   runs in those repositories as their owner (item 9); run yours as `aoc-agent` too (`sudo -u aoc-agent git …`).

3. **Startup self-check.** With isolation on, aocd refuses to start, listing every problem, unless — tested as each
   session user, through the same spawn path as a turn —
   - the session user can read **none** of: `dataDir`, `aoc.db`, `bodies.db`, `blobs/`, the KEK file, the
     credential profiles file, any key file a profile names, aocd's private session files, the push gateway's
     repositories;
   - the session user **can** reach `sessionHomesDir` and `workspacesDir`, and run `claudeBin` (with its prefix),
     the hook command and the MCP command;
   - the probe really ran as the session user's uid (this catches a runner that does not switch users);
   - `sessionHomesDir` is owned by root and no directory above it is writable by a session user.

   Key copies left behind by a crash are deleted at the same time.

4. **What a session gets.** Each session has a directory `<sessionHomesDir>/<sessionId>/`, owned by root and its
   session user's group (`0750`):
   - `home/` (`0700`, the session user's): `HOME`, with `home/.claude` as `CLAUDE_CONFIG_DIR` (transcripts);
   - `tmp/` (`0700`, the session user's): `TMPDIR`;
   - `mcp.json` and `settings.json` (`0640`, root's): readable by the session, never writable by it, so the
     hooks cannot be edited away during a turn;
   - `credentials/` (root's, `0750`) with a copy of each key file of the profile's `session` part, owned by the
     session user, mode `0400` (never a file of the credential itself, item 5). Copies exist **only while a turn
     runs**: they are written when the turn starts and deleted when it ends, when the session ends, and at every
     aocd start.

   The session's environment replaces aocd's `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `CLAUDE_CONFIG_DIR`, `XDG_*`,
   `SSH_AUTH_SOCK` and `GNUPGHOME` with its own, and sets `GIT_CONFIG_GLOBAL=/dev/null` and
   `GIT_CONFIG_NOSYSTEM=1` (no credential helper, include or hook path from the host) and `GIT_TERMINAL_PROMPT=0`.
   Without a global config git has no identity, so commits are by `AOC agent <aoc-agent@localhost>` unless the
   credential profile sets `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` (for example to its machine user).
   `session.launched` records who each turn ran as (`payload.runAs`).

   The session can write its own `HOME`, so before every turn aocd checks `~/.claude/settings.json` there with the
   rules it applies to the workspace's `.claude/settings*.json`: no `disableAllHooks`, no `env`, plain JSON, no link.
   A turn that planted one ends the session (`session_settings_override`); delete the file as root to restart it.
   Output redaction covers the values and key-file text of the profile (held and `session` parts alike) and the
   session's ingest token. A session whose profile has `push.refs` also gets git settings in its environment
   (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n`: remote `aoc`, see item 11), which outrank every
   config file, so the workspace cannot repoint them.

   **Claude credentials.** A fresh `CLAUDE_CONFIG_DIR` holds no login, so give sessions a token through
   `supervisor.envAllowlist`: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY`. The
   model can read it (threat model O-14).

5. **Credential profiles file.** Path set by `supervisor.credentialProfilesFile`. A profile has two halves with
   different readers. Declare each key file under `files` and refer to it as `{{file:<name>}}`.

   | Field | Who gets it | What it is for |
   | --- | --- | --- |
   | `env`, `files` | **aocd only.** Never a session's environment, never a file in a session directory, not even as a per-turn copy | The credential: the push gateway forwards a session's pushes with it (item 11), `runIsolated` uses it for promotion |
   | `push.refs` | The gateway's policy | The branches this profile's sessions may push: globs, `*` within a path segment, `**` across segments; `{sessionId}` `{projectId}` `{threadId}` `{ticketId}` stand for the session's own ids. No `push`: sessions of the type cannot push at all |
   | `session.env`, `session.files` | The session (model-visible by design) | Read-only credentials such as a package-registry token, and identity (`GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`). Key files come as private per-turn copies. **Never a key that can push** |

   ```json
   {
     "profiles": {
       "git-feature": {
         "env": { "GIT_SSH_COMMAND": "ssh -i {{file:ssh-key}} -o IdentitiesOnly=yes -o UserKnownHostsFile={{file:known-hosts}}" },
         "files": { "ssh-key": "/etc/aoc/keys/git-feature", "known-hosts": "/etc/aoc/keys/known_hosts" },
         "push": { "refs": ["refs/heads/feature/**", "refs/heads/aoc/{threadId}/**"] },
         "session": { "env": { "GIT_AUTHOR_NAME": "AOC builder", "GIT_AUTHOR_EMAIL": "builder@example.com" } }
       },
       "uat-deploy": {
         "env": { "GIT_SSH_COMMAND": "ssh -i {{file:ssh-key}} -o IdentitiesOnly=yes" },
         "files": { "ssh-key": "/etc/aoc/keys/uat-deploy" },
         "push": { "refs": ["refs/heads/uat/{ticketId}"] }
       },
       "prod-promote": {
         "env": { "GIT_SSH_COMMAND": "ssh -i {{file:ssh-key}} -o IdentitiesOnly=yes -o UserKnownHostsFile={{file:known-hosts}}" },
         "files": { "ssh-key": "/etc/aoc/keys/promotion", "known-hosts": "/etc/aoc/keys/known_hosts" }
       }
     }
   }
   ```

   **Upgrading from the earlier format.** A profile that had only `env` and `files` used to hand them to its
   sessions, so `git push` worked inside the session. Now those fields are the credential and stay with aocd: add
   `push.refs` for the branches the type may push, and move anything a session itself must read into `session`.
   Without `push`, sessions of the type have no way to push. A key path written straight into an env value still
   works for aocd's own commands. The `prod-promote` profile (mod-change's `promoteCredentialProfile`) is used
   only by the push from the service clone, as aocd (item 9); it has no `push` and its key never reaches a session
   user.

6. **A per-session container instead of a uid switch.** Set `supervisor.runner` to an argv prefix that starts the
   command in a per-session container (or any other wrapper). aocd still runs as root, prepares the session
   directory and reads the transcript; the runner must run the command as the session user's uid, with the
   environment it is given, the workspace and the session directory mounted at the same paths, and forward
   SIGINT/SIGTERM/SIGKILL. Placeholders: `{user}` `{uid}` `{gid}` `{sessionId}` `{sessionDir}` `{cwd}`. An example
   wrapper (a sketch, not shipped or tested), configured as
   `["/usr/local/bin/aoc-container-run", "{uid}", "{gid}", "{sessionDir}", "{cwd}", "--"]`:

   ```bash
   #!/bin/bash
   uid=$1 gid=$2 dir=$3 cwd=$4; shift 5   # the rest is the claude command line
   exec podman run --rm -i --init --user "$uid:$gid" --network aoc-egress \
     -v "$dir:$dir" -v "$cwd:$cwd" -w "$cwd" --env-file <(env) aoc-session-image "$@"
   ```

   The startup self-check runs through the runner too, so a runner that does not switch users is refused. A plain
   uid switch through a runner: `["setpriv", "--reuid={uid}", "--regid={gid}", "--clear-groups", "--"]` (the same as
   aocd does by itself when no runner is set).

7. **No process type names the promotion profile.** Check:
   `jq -r '.types[].credentialProfile' config/process-types.json | sort -u` must not list `prod-promote`.
   `config/` is a protected path, and every edit is audited (`registry.changed`).
8. **Environment allowlist.** Review `supervisor.envAllowlist`. Everything not on it is dropped from session
   environments. Remove what you do not need. The Claude credentials on the default list are readable by the model
   (threat model O-14). Helpers aocd starts itself get a fixed allowlist of their own, never `AOC_*`, API keys or
   tokens (gap G-46): the kernel's git; the anchor git (plus `GNUPGHOME`, `GIT_SSH_COMMAND`, `GIT_SSH`,
   `GIT_ASKPASS` and `SSH_AUTH_SOCK`) and `openssl`; the claude CLI of the LLM adapter (plus its Claude login:
   `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `NODE_EXTRA_CA_CERTS`);
   and the ClamAV client. The one deliberate exception is the backup copy command, which gets aocd's environment
   minus `AOC_*`, `ANTHROPIC_*` and `CLAUDE_CODE_OAUTH*` because it carries the operator's own transfer credentials
   ([backup and restore](backup-restore.md) §2).
9. **Privileged git (gap G-04: enforced).** Promotion, rollback, break-glass, pin tags and rollback verification
   never run git or repository code with privilege in a tree an agent can write (threat model
   [T-2](../security/threat-model.md#t-2-code-execution-through-git-configuration-in-agent-workspaces), O-2). aocd
   is root (item 1) and project repositories belong to the session user (item 2), so the rule is: root's git runs
   only in repositories that only root can write.

   - **A service-owned clone per project**, `<dataDir>/git/<projectId>.git`: a bare repository that only aocd
     writes (it sits inside `dataDir`, item 2). AOC refuses to use it when it would overlap the project's working
     tree or git directory, so keep `dataDir` outside every project. Candidate commits enter it by id only:
     `git fetch --no-tags -- <project repository> <sha>` with `protocol.allow=never` and `protocol.file.allow=user`
     (the local transport and nothing else; `protocol.file.allow=never` would refuse this very fetch) and
     `transfer.fsckObjects=true`. The repository belongs to the session user, so git's serving side
     (`upload-pack`) runs **as that user** (`--upload-pack` with a uid/gid switch, supplementary groups dropped):
     root never reads the project's config, hooks or attributes. The fetching side, and everything it writes,
     stays aocd's.
   - **Every git command in the clone** runs with hooks off (`core.hooksPath=/dev/null`), no fsmonitor, no signing
     or signature-verification program, no submodule recursion or automatic gc, and every transport denied unless
     that step needs one. It sees no system or global config (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`)
     and nothing of aocd's environment but `PATH`, the locale and the time zone.
   - **Every other git command AOC runs in a project repository** (does a commit exist, where does a ref point,
     the recorded-heads walk of the provenance trace, the working-tree fingerprint, commit evidence, the ledger's
     phase pins) goes through the kernel git service. When aocd is root and the directory belongs to someone else,
     it runs git **as that owner**: no supplementary groups, `HOME=/nonexistent`, no system or global config, the
     same safety settings as above, and the repository's filter drivers switched off for `status` and `diff`.
     git's ownership check then passes by itself: **AOC never sets `safe.directory`, and neither should you**
     (a wildcard would let root's git read every agent-written repository).
   - **Provenance and the fast-forward checks** run in the clone, against where AOC last moved the branch, and run
     again when the approved promotion executes. The project repository's own view of `main` cannot hide an orphan.
   - **The push target is AOC's configuration, never the project's.** It is the service clone's `origin`
     (`remote.origin.pushurl` wins over `url`). `remote.*`, `pushurl` and `url.*.insteadOf` in the project's
     `.git/config` are ignored. Only ssh, https and absolute local paths are accepted. When the project repository
     has remotes and the clone has none configured, promotions, rollbacks and break-glass are refused
     (`promotion_remote_unconfigured`), already when they are requested, so no approver is asked first. A project
     with no remote at all has its own branch moved.
   - **The promotion credential reaches one process:** `git push --no-verify` from the service clone. The push is a
     compare-and-swap of a verified fast-forward (`--force-with-lease=<branch>:<verified base>`): the branch moves
     only from the commit whose delta passed the gate, and never backwards, so ruleset A needs no bypass. If the
     remote is not where AOC left it, nothing is pushed (`default_branch_moved`); a `main` moved outside AOC is an
     R1 breach (§7). The project repository's `pre-push` hook no longer runs, and `AOC_SUPERVISOR_PUSH` is no
     longer set.
   - **Rollback verification** checks the pinned target out of the clone into a fresh, standalone checkout (its own
     `.git`, no link back to the clone) in a directory that aocd then hands over to the session user. Its
     acceptance tests run as the session user (`supervisor.sessionUser`, gap G-01), never with a credential, with
     nothing of aocd's environment but `PATH`, the locale and proxy settings: a test that writes outside its
     checkout, or reads aocd's files, gets `Permission denied`. With isolation off (development only) they run as
     the aocd user, still without credentials, and aocd logs a warning. The evidence branch `aoc/rollback/<id>`
     and the change pins `aoc/change/<id>` live in the clone.
   - **Writes to the project repository** (a project without a remote, and the project's branch following a push)
     run as the session user, with hooks, fsmonitor and the repository's filter drivers switched off. A worktree
     that has the branch checked out is fast-forwarded in place only when it belongs to that repository and is clean.

   **Can the promotion profile hold a real credential now?** Yes, once session isolation is on (item 1) and its
   startup self-check passes; production mode requires both. Sessions then run as their own OS user: they cannot
   read the profiles file or the key file, and cannot write the service clone. With `isolation: "none"` (the
   development default) any session can do all of that: never put a real credential in the profile there.

   1. Define the `prod-promote` profile (item 5). The key file is root's, mode `0600` (item 2). The push runs as
      aocd, so the key never reaches a session. Pin the host key (`UserKnownHostsFile`), as in the example.
   2. Point each project's clone at the protected remote, once, as root:
      `git --git-dir=<dataDir>/git/<projectId>.git remote add origin git@github.com:<org>/<repo>.git`.
      AOC creates the clone on first use; the `promotion_remote_unconfigured` refusal prints its exact path. A
      local-path remote must belong to root too (git insists on it), because its hooks run inside the push, with
      the credential.
   3. Keep `dataDir` private to root (item 2). Keep aocd's temporary directory traversable by the session user:
      verification checkouts are made there, then handed over to that user.
   4. A candidate whose objects fail git's checks is refused. To accept a known, harmless problem in old history,
      set `fetch.fsck.<msg-id>=warn` in that project's clone (`git --git-dir=… config`).

   The **push gateway** (item 11) uses the same clone. What sessions push enters it through `git receive-pack` that
   aocd runs with the same safety settings (no hooks, fsmonitor or gc; objects checked), and leaves it through the
   same kind of credentialed `git push` from aocd, to the clone's `origin`. One `origin` therefore serves
   promotions and feature pushes, each with its own credential profile. The gateway never writes the clone's
   `refs/aoc/*`, tags or `refs/heads/aoc/rollback/*`, nor `main`, `master`, `production` or `release/*`.
10. **Read-only types** never receive credentials. The registry schema refuses a read-only type with a
   `credentialProfile`. Do not work around it.
11. **Push gateway (R-02).** A session cannot push by itself: it holds nothing that can. It runs
   `git push aoc <commit>:refs/heads/<branch>`, and remote `aoc` is the supervisor's gateway,
   `<publicUrl>/ingest/git/<project>.git`, set in the session's environment (`GIT_CONFIG_*`, item 4) and
   authenticated by the session's own ingest token, **only while one of its turns is running** (a token alone,
   after the turn, is refused). aocd receives the push into a **service-owned bare repository**, checks every ref
   against the profile's `push.refs`, and forwards the allowed ones to the upstream with the credential only it
   holds (`runIsolated`: as aocd, never in a session). The model reads the system prompt's rule 9, which names the
   remote and the branches its profile allows with its own ids filled in.

   What the gateway decides:
   - **Always refused, whatever the profile says:** `main`, `master`, `production`, `HEAD`, `release/*`; tags and
     anything outside `refs/heads/`; deletions; ref names git itself would refuse. Upstream pushes are never forced.
     Only `refs/heads/...` patterns are accepted in `push.refs`.
   - **All or nothing:** a push naming one refused ref is refused whole, so no branch moves half-way.
   - **Limits:** a pack up to 256 MiB (git's `receive.maxInputSize` and every HTTP layer; counted after gzip
     too), 30 pushes per 10 minutes per session (HTTP 429 with `Retry-After`), 100 refs per push, one push at a
     time per project, a request that sends nothing for 60 seconds is dropped, objects checked with `fsck`, hooks
     and automatic gc off.
   - **What git executes is what was checked:** the gateway rebuilds the command section it hands to
     `git receive-pack` from the commands it parsed and approved, with only the capabilities it speaks (no side
     band, atomic or push options).
   - **What the model is told:** a refusal reaches it as `fatal: remote error: aoc: …` before anything is sent.
     Git's own words from the upstream are never relayed (they can carry a URL with a token); only a per-ref
     summary is.
   - **Audit:** every push is a `session.git_pushed` event: counts and the profile name in the clear chain, ref
     names and shas in the encrypted body.

   **Operator set-up, once per project.** The gateway pushes into the project's service clone,
   `<dataDir>/git/<project id>.git` (item 9; a project id that is not a plain name becomes `p-<hash>.git`), and
   forwards to its `origin` (`remote.origin.pushurl` wins over `url`). If promotions are already set up for the
   project, there is nothing more to do. Otherwise, as root, point `origin` at the real upstream and seed the
   clone so that first pushes carry only new objects:

   ```bash
   R=/var/lib/aoc/data/git/<project id>.git
   git init --bare --template= --initial-branch=aoc-service-clone "$R"   # aocd creates it at the first push if you do not
   git --git-dir="$R" remote add origin git@github.com:<org>/<repo>.git
   git --git-dir="$R" fetch origin '+refs/heads/*:refs/remotes/origin/*'
   ```

   `origin` must be an `ssh://` or scp-style, `https://` or `file://`/absolute-path URL, as for promotions; anything
   else (`ext::`, helper remotes, plain `http://`) is refused. The credential comes from the **profile**
   (`GIT_SSH_COMMAND`, a credential helper), never from the URL. A push to a project whose clone has no usable
   `origin` is refused, and aocd logs the clone's path.

   | The model sees | Meaning |
   | --- | --- |
   | `aoc: pushes are accepted only while a turn of the session is running` | The token was used outside a turn |
   | `aoc: protected branch; it moves only through a gated promotion` | `main`, `master`, `production`, `HEAD` or `release/*` |
   | `aoc: not a branch this session's credential profile may push` | The branch matches none of `push.refs` |
   | `aoc: no upstream remote is configured for this project` | The set-up above was not done |
   | `aoc: upstream [remote rejected] …` | The upstream refused (GitHub rulesets, hooks); the reason is in GitHub's audit log, not in the session |
   | `aoc: the upstream push failed (see the aocd log)` | Network, key or host-key failure; the log has the exit code only |
   | HTTP 429 | The per-session push rate limit |

   Operating notes:
   - The repository is a staging copy: it holds what sessions pushed and what you seeded, not live upstream state.
     A branch the upstream refused goes back to where it was; its objects stay until
     `git --git-dir="$R" gc --prune=now`, which you run in a quiet moment (aocd never runs gc there).
   - The gateway creates a SHA-1 clone. A project that uses SHA-256 needs the clone created beforehand with
     `--object-format=sha256` (promotions create it in the project's own format).
   - Deletions and forced pushes are not supported through the gateway. A branch is removed in GitHub, or by an
     Approver-gated change.
   - `isolation: "none"` weakens this: aocd's own user holds the gateway repository, the profiles file and the keys,
     and a session of the same user can read them (item 1). The gateway is a wall only with isolation on.
   - The ingest token that authenticates the gateway is model-visible (threat model T-3, R-01). It lets a model
     push exactly what `push.refs` allows, during a turn, which is what it could do with the tool itself. A
     separate principal for the gateway needs the same change as O-3.
   - Credentials for anything other than git (a deploy API, a cloud CLI) have no proxy yet: do not put one in a
     profile's `env` for a session type. Until it has one, only the `session` part reaches sessions.

## 5. Developer machines

### 5.1 Checklist

Every Builder, before getting access, and then every quarter:

- [ ] No private key on the machine matches a fingerprint in the AOC deploy-key inventory (§5.3).
- [ ] The developer's GitHub role on governed repositories is Write or Read, never Admin or Maintain:
      `gh api repos/$OWNER/$REPO --jq .permissions`.
- [ ] `gh auth status` shows only the developer's own account, with no organisation-admin scopes.
- [ ] No production or UAT deploy credentials: no cloud CLI profiles for production (`~/.aws`, `~/.config/gcloud`,
      `~/.azure`), no production contexts in `~/.kube/config`, no deploy tokens in shell profiles or `.env` files.
- [ ] A push to `main` from this machine is rejected (§6, step 1).
- [ ] Observed hooks are installed and point at aocd, using the developer's **own** observer token
      ([observed sessions runbook](observed-sessions.md)).
- [ ] The pre-push speed bump is installed (§5.2).
- [ ] Shell profiles do not alias `claude` to `--bare` or `--safe-mode` (best effort: this is observation, not
      enforcement).
- [ ] `aoc doctor` reports green.

### 5.2 The pre-push speed bump

AOC ships the guard in `packages/hooks/git/pre-push`. It carries the marker `aoc:pre-push-guard`. It refuses any
push that updates or deletes `main`, `master`, `production` or `release/*` unless `AOC_SUPERVISOR_PUSH=1`. AOC's
own pushes never meet it: they run from the service clone with hooks switched off (§4 item 9). Next to it is
`prepare-commit-msg`, which adds the `AOC-Session`,
`AOC-Change` and `AOC-Ticket` trailers inside managed sessions and does nothing elsewhere. The supervisor does not
install either hook in managed workspaces yet (gap G-37).

Install it for every repository on a developer machine:

```bash
git config --global core.hooksPath /path/to/aoc/packages/hooks/git
```

Or install it per repository, by copying `pre-push` into `.git/hooks/` and making it executable.

It is **a speed bump**. `--no-verify`, `-c core.hooksPath=…`, another clone, or simply setting
`AOC_SUPERVISOR_PUSH=1` by hand all skip it. It exists to turn a habit into a prompt at the moment of the attempt,
not to enforce anything. The server-side rulesets in §3 enforce.

### 5.3 `aoc doctor`

`aoc doctor` (`packages/cli`) checks the machine it runs on and reports each check as pass, warn, fail or skip,
naming things only, never printing a secret:

| Check | What it looks at |
| --- | --- |
| Daemon reachable, logged in | The configured daemon answers; the stored token is accepted |
| Client config permissions | `~/.aoc/client.json` is mode 0600 |
| Observed hooks | The AOC hook is registered in the Claude Code settings for every hook event |
| No deploy secrets in the shell | Deploy-grade variables such as `GH_TOKEN`, `GITHUB_TOKEN`, `AWS_*` keys, `AZURE_*`, `GOOGLE_APPLICATION_CREDENTIALS`, `*_DEPLOY_*`, `NPM_TOKEN`, `KUBECONFIG` |
| No private keys in `~/.ssh` | Warns on any private key, so that its owner confirms it is neither a deploy key nor able to push protected branches |
| No git credential helpers | Configured credential helpers and plaintext credential stores |
| Pre-push guard | The current repository's `pre-push` hook is the AOC guard and is executable |

`aoc doctor` does **not** check the developer's GitHub role, the repository rulesets, cloud CLI profile files, or
whether a key on disk matches an AOC deploy key. Check those by hand with the commands in §3.5 and §5.1:

```bash
gh api repos/$OWNER/$REPO --jq .permissions             # admin must be false
gh api repos/$OWNER/$REPO/rules/branches/main | jq '.[].type'
for k in ~/.ssh/*; do ssh-keygen -lf "$k" 2>/dev/null; done   # compare with the published AOC deploy-key fingerprints
```

## 6. Drill (quarterly, and after any change)

Use a disposable branch and record the results as an AOC change record (or attach them to the next evidence pack).

1. **Developer push to `main` is rejected.** From a developer machine:
   `git push origin HEAD:main` → expect `GH013` (ruleset violation) or a protected-branch error.
2. **A session cannot move `main`, and holds no credential that could.** Run a `feature-build` session (on
   `claude-sim`, or a throw-away real one) and, through its Bash tool: `git push aoc HEAD:refs/heads/main` →
   `fatal: remote error: aoc: protected branch …`; `git push aoc HEAD:refs/heads/feature/drill-$(date +%F)` →
   accepted (a `session.git_pushed` event with `forwarded: 1`; delete the drill branch in GitHub afterwards). Then,
   still in that session, `env | grep -iE 'ssh|token|key'` and `ls /var/lib/aoc-sessions/<session id>/credentials`
   show nothing of the profile's `env` or `files`, and a direct
   `git push git@github.com:<org>/<repo>.git HEAD:refs/heads/feature/drill-x` fails for lack of a key. The
   automated version is `packages/supervisor/test/gateway.test.ts`.
3. **Even the supervisor cannot force-push.** In a test repository with the same rulesets, as `aoc-supervisor`:
   `git push --force origin HEAD~1:main` → rejected by ruleset A.
4. **Pinned tags are immutable.** Try to delete or move an `aoc/*` tag with any identity → rejected.
5. **Triage sessions hold nothing.** Launch a `bug-triage` session on `claude-sim` and check that its environment
   holds no credential variables (`session.launch_requested.meta.credentialProfile` is `null`) and that it ran as
   the read-only session user (`session.launched.payload.runAs` is `aoc-reader`).
6. **Sessions cannot read AOC's secrets.** Restart aocd and confirm the log says `session isolation verified`. Then
   run a `claude-sim` session, or a shell as each session user, that tries to read the credential profiles file, a
   profile key file, the KEK, `aoc.db` and aocd's `~/.ssh`, for example
   `sudo -u aoc-agent cat /etc/aoc/credential-profiles.json /etc/aoc/kek /etc/aoc/keys/git-feature` and
   `sudo -u aoc-reader ls /var/lib/aoc/data` → every read `Permission denied`. While a build turn runs,
   `sudo -u aoc-reader cat /proc/<its pid>/environ` → `Permission denied`; once it ends,
   `ls /var/lib/aoc-sessions/<session id>/credentials` → no such directory. The automated version of this drill
   is `packages/supervisor/test/isolation.test.ts` (it needs root). With isolation off every read succeeds.
7. **Provenance gate.** Push a commit with no change record to a feature branch, then request promotion → expect
   `promotion.refused {reason: provenance_gap, orphanShas: [...]}`. Then repeat with a commit made on a laptop
   whose message carries a copied `AOC-Change: <approved change id>` trailer. Today that commit **passes** (threat
   model [T-22](../security/threat-model.md#t-22-forged-provenance-trailers)). Record the result until O-27 closes
   the gap.
8. **Planted git configuration does nothing.** In a disposable project, as the session user
   (`sudo -u aoc-agent`), add a `pre-push` hook and a `core.sshCommand` that each create a marker file inside the
   project's `.git`, and set `remote.origin.pushurl` to a decoy repository. Take a change through promotion and
   approve it, then a rollback. Expect: both complete against the clone's remote, no marker exists, the decoy is
   untouched, and the clone AOC created has no `hooks` directory (`ls -A <dataDir>/git/<projectId>.git`). The automated
   version is `packages/mod-change/test/privileged-git.test.ts` (the parts that switch users need root).

Any unexpected success is a **Sev-1 incident**: stop promotions, then follow §8.

## 7. Monitoring

- GitHub organisation audit log: alert on `repository_ruleset.*`, `protected_branch.*`, `public_key.create`,
  `deploy_key.*`, `org.update_member` and role changes. Review weekly.
- AOC: `promotion.completed` events must all be by the supervisor and carry a `decisionId` (or `breakglass: true`).
  `promotion.refused` and `selfmod.blocked` trends appear in the Control Tower integrity panel.
- `promotion.failed` or `rollback.failed` with reason `default_branch_moved`: the protected remote's branch was not
  where AOC left it, so nothing was pushed (the lease failed). Treat it as an R1 breach until someone explains the
  push.
- Compare the GitHub push log for `main` with AOC's `promotion.completed` and `rollback.executed` events. **Any
  push to `main` without a matching event is an R1 breach.**

## 8. If a credential leaks or a rule fails

1. Revoke at once: delete the deploy key in GitHub, or rotate the machine user's key or token.
2. Replace the key in the credential profiles file and restart aocd.
3. Search the GitHub audit log for pushes made with the leaked credential since its last known-good date, and
   check the commits on `main` with AOC's provenance check.
4. Raise a post-incident change record and notify the CEO ([incident runbook](incident-break-glass.md)).
5. If the leak came from a session, crypto-shred the session's body scope if the secret was captured in a prompt
   or tool output (`body.erased {reason: secret_leak}`; see [key custody](key-custody.md#6-crypto-shred)). A push
   credential (`env`, `files`) is never in a session: what a session leaked is its profile's `session` part, or the
   host runs with `isolation: "none"` and the session read the profiles file (§4, item 1) — then treat every
   credential on the host as leaked.
