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
| **Supervisor machine identity** (`aoc-supervisor` machine user, or a GitHub App) | Update `main` and `release/*`; create `aoc/*` pin tags | The supervisor's `promotion` profile, used only by `SupervisorService.runIsolated` for promotion, rollback and tagging | Any session environment; any developer machine; any process type in the registry |
| **Feature push credential** (profile `git-feature`) | Push feature branches | Credential profiles file; injected only into sessions whose type names `git-feature` | Read-only types; developer machines |
| **UAT credential** (profile `uat-deploy`) | Push `uat/*` branches and deploy to UAT | Credential profiles file; `bug-fix` sessions only | Read-only types; developer machines |
| **Production deploy credentials** | Deploy to production | Only behind the promotion path (`runIsolated`) | Every session; every developer machine |
| **Developers' own GitHub accounts** | Clone; open pull requests; push non-protected branches if the CEO allows it | Developer machines | Rights to update `main` or `release/*`; admin on governed repositories; deploy keys |
| **Read-only triage sessions** | Nothing | None (`credentialProfile: null`, enforced by the registry schema) | — |

Two facts to keep in mind:

- **A session credential is readable by its model.** Everything in the `claude` environment, including
  `GIT_SSH_COMMAND` and any key file it names, is readable by the model's own Bash
  ([research](../research/claude-code-integration.md) §8). That is acceptable only because each session credential
  can do no more than that session type may do. Rulesets (§3) make sure no session credential can move `main`.
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
   | `dataDir` (`aoc.db`, `bodies.db`, `blobs/`) | root | `0700` (aocd creates it so) | The chain, decrypted read models, encrypted bodies |
   | KEK (`keys.masterKeyFile`) | root | `0400` | Outside `dataDir`; see [key custody](key-custody.md) |
   | Credential profiles file | root | `0600` | Names every deploy credential |
   | Key files the profiles name | root | `0600` | Sessions get private copies, never these |
   | aocd's private session files (`<dataDir>/sessions`) | root | inside `dataDir` | System prompts, sidecar state |
   | `supervisor.sessionHomesDir` | root (aocd creates it) | `0711` | Session users reach their own directory, cannot list others; no directory above it may be writable by a session user |
   | `supervisor.workspacesDir` | root | `0755` | aocd creates each new project workspace for `aoc-agent` (`0755`, so `aoc-reader` can read it) |
   | Project repositories registered for a project | `aoc-agent` | `0755` | Builds write them; triage reads them |
   | `claude`, `node`, the AOC hook and MCP bundles | root | readable and executable by all | Session users run them; install `claude` system-wide, not under `/root` |

   Existing workspaces created before isolation belong to root: `chown -R aoc-agent: <workspace>`. Because
   repositories belong to `aoc-agent`, root's git refuses to run in them ("dubious ownership"). That is git's
   protection against threat model T-2 doing its job; **never** set `safe.directory=*` to silence it (see item 9).

3. **Startup self-check.** With isolation on, aocd refuses to start, listing every problem, unless — tested as each
   session user, through the same spawn path as a turn —
   - the session user can read **none** of: `dataDir`, `aoc.db`, `bodies.db`, `blobs/`, the KEK file, the
     credential profiles file, any key file a profile names, aocd's private session files;
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
   - `credentials/` (root's, `0750`) with a copy of each key file of the session's credential profile, owned by
     the session user, mode `0400`. Copies exist **only while a turn runs**: they are written when the turn starts
     and deleted when it ends, when the session ends, and at every aocd start.

   The session's environment replaces aocd's `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `CLAUDE_CONFIG_DIR`, `XDG_*`,
   `SSH_AUTH_SOCK` and `GNUPGHOME` with its own, and sets `GIT_CONFIG_GLOBAL=/dev/null` and
   `GIT_CONFIG_NOSYSTEM=1` (no credential helper, include or hook path from the host) and `GIT_TERMINAL_PROMPT=0`.
   Without a global config git has no identity, so commits are by `AOC agent <aoc-agent@localhost>` unless the
   credential profile sets `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` (for example to its machine user).
   `session.launched` records who each turn ran as (`payload.runAs`).

   The session can write its own `HOME`, so before every turn aocd checks `~/.claude/settings.json` there with the
   rules it applies to the workspace's `.claude/settings*.json`: no `disableAllHooks`, no `env`, plain JSON, no link.
   A turn that planted one ends the session (`session_settings_override`); delete the file as root to restart it.
   Output redaction covers the session's credential values and the text of its profile's key files.

   **Claude credentials.** A fresh `CLAUDE_CONFIG_DIR` holds no login, so give sessions a token through
   `supervisor.envAllowlist`: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY`. The
   model can read it (threat model O-14).

5. **Credential profiles file.** Path set by `supervisor.credentialProfilesFile`. Declare each key file under
   `files` and refer to it as `{{file:<name>}}`: an isolated session gets a private copy at that place, aocd's own
   commands (promotion) the original.

   ```json
   {
     "profiles": {
       "git-feature": {
         "env": { "GIT_SSH_COMMAND": "ssh -i {{file:ssh-key}} -o IdentitiesOnly=yes -o UserKnownHostsFile={{file:known-hosts}}" },
         "files": { "ssh-key": "/etc/aoc/keys/git-feature", "known-hosts": "/etc/aoc/keys/known_hosts" }
       },
       "uat-deploy": {
         "env": { "GIT_SSH_COMMAND": "ssh -i {{file:ssh-key}} -o IdentitiesOnly=yes" },
         "files": { "ssh-key": "/etc/aoc/keys/uat-deploy" }
       },
       "promotion": {
         "env": { "GIT_SSH_COMMAND": "ssh -i {{file:ssh-key}} -o IdentitiesOnly=yes" },
         "files": { "ssh-key": "/etc/aoc/keys/promotion" }
       }
     }
   }
   ```

   A key path written straight into an env value (the old format) still works for aocd's own commands, but an
   isolated session cannot read it. The `promotion` profile is used only by `runIsolated`, as aocd; its key never
   reaches a session user.

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
   `jq -r '.types[].credentialProfile' config/process-types.json | sort -u` must not list `promotion`.
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
9. **Privileged git.** Promotion, tagging and rollback run from a **service-owned clone** that fetches candidate
   commits by SHA, never in an agent's workspace. An agent can plant git hooks and config there (threat model
   [T-2](../security/threat-model.md#t-2-code-execution-through-git-configuration-in-agent-workspaces)). At this
   commit, `mod-change` promotes from the **project's repository path**, without fetching into a separate clone,
   and lets that repository's `pre-push` hook run with the promotion credential. If any session can write that
   repository, or a worktree that shares its `.git` directory, this is exploitable. Managed sessions work in that
   very repository by default. **Do not give the promotion profile a real credential until threat model O-2 is
   done** (gap G-04); with isolation off (O-1) any session can also read the key file directly. How `main` moves in
   the meantime is a CEO decision; record it. If a credential is ever used before then, compare the repository's
   `.git/config` and `.git/hooks/` with a known-good checksum kept off the host before each promotion.

   With isolation on, aocd is root, so this matters more, and two things change until gap G-04 lands:
   - `runIsolated` commands **without** a credential profile (acceptance tests for rollback verification, git
     reads) run as `aoc-agent` with a throwaway `HOME`, never as root;
   - root's git refuses repositories owned by `aoc-agent` (dubious ownership), so promotion pushes, pin tags,
     rollback checkouts and the ledger's commit-evidence check **fail closed** on them. Do not "fix" this with
     `safe.directory`: that would run agent-planted hooks and `core.fsmonitor` as root. G-04 (a service-owned
     clone, inspection as the session user) is the fix.
10. **Read-only types** never receive credentials. The registry schema refuses a read-only type with a
   `credentialProfile`. Do not work around it.

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
push that updates or deletes `main`, `master`, `production` or `release/*` unless `AOC_SUPERVISOR_PUSH=1`, which
only the supervisor's promotion executor sets. Next to it is `prepare-commit-msg`, which adds the `AOC-Session`,
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
2. **Session credential cannot move `main`.** On the AOC host, as the sandbox user, with the `git-feature`
   profile environment: `git push origin HEAD:main` → rejected. `git push origin HEAD:aoc/drill-$(date +%F)` →
   accepted. Delete the drill branch afterwards.
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

Any unexpected success is a **Sev-1 incident**: stop promotions, then follow §8.

## 7. Monitoring

- GitHub organisation audit log: alert on `repository_ruleset.*`, `protected_branch.*`, `public_key.create`,
  `deploy_key.*`, `org.update_member` and role changes. Review weekly.
- AOC: `promotion.completed` events must all be by the supervisor and carry a `decisionId` (or `breakglass: true`).
  `promotion.refused` and `selfmod.blocked` trends appear in the Control Tower integrity panel.
- Compare the GitHub push log for `main` with AOC's `promotion.completed` and `rollback.executed` events. **Any
  push to `main` without a matching event is an R1 breach.**

## 8. If a credential leaks or a rule fails

1. Revoke at once: delete the deploy key in GitHub, or rotate the machine user's key or token.
2. Replace the key in the credential profiles file and restart aocd.
3. Search the GitHub audit log for pushes made with the leaked credential since its last known-good date, and
   check the commits on `main` with AOC's provenance check.
4. Raise a post-incident change record and notify the CEO ([incident runbook](incident-break-glass.md)).
5. If the leak came from a session, crypto-shred the session's body scope if the secret was captured in a prompt
   or tool output (`body.erased {reason: secret_leak}`; see [key custody](key-custody.md#6-crypto-shred)).
