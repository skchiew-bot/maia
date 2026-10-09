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
  user as aocd, the agent can simply read the 0600 profiles file, the KEK and the database. Run sessions as a
  separate unprivileged user (threat model O-1).
- **Today they do not** (gap G-01). The supervisor spawns `claude` as aocd's own OS user and, through the default
  `envAllowlist`, with aocd's `HOME`. Every session, including a read-only triage session through its `Read`
  tool, can read the profiles file, every key file a profile names, the KEK, both databases and whatever the
  service user's home holds. Until G-01 is done, treat every credential on the AOC host as readable by every
  session.

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

The host that runs aocd and the supervisor:

1. **Users.** aocd runs as a service user (for example `aoc`). Managed sessions run as a separate, unprivileged
   user (for example `aoc-agent`) or in a per-session container (threat model O-1). `aoc-agent` must not be able
   to read anything owned by `aoc`. **Not built yet** (gap G-01): the supervisor spawns sessions as `aoc`, with
   `aoc`'s `HOME`. Until it changes, keep `aoc`'s home free of SSH keys, git credential helpers, `gh` logins and
   cloud CLI profiles, and remember that the anchor deploy key kept there is readable by sessions
   ([anchoring §2](anchoring.md#2-git-anchor-provider-git)).
2. **Credential profiles file.** Path set by `supervisor.credentialProfilesFile` (for example
   `/etc/aoc/credential-profiles.json`). Owned by `aoc`, mode `0600`. Format:

   ```json
   {
     "profiles": {
       "git-feature": { "env": { "GIT_SSH_COMMAND": "ssh -i /etc/aoc/keys/git-feature -o IdentitiesOnly=yes" } },
       "uat-deploy": { "env": { "GIT_SSH_COMMAND": "ssh -i /etc/aoc/keys/uat-deploy -o IdentitiesOnly=yes" } },
       "promotion": { "env": { "GIT_SSH_COMMAND": "ssh -i /etc/aoc/keys/promotion -o IdentitiesOnly=yes" } }
     }
   }
   ```

   The key files are owned by `aoc`, mode `0600`. The supervisor copies the profile's `env` into the session's
   environment as it is, so a key file named there must be readable by the session's user. The target design
   (gap G-01) hands a session key to the sandbox user only for that session (a per-session copy, deleted when
   the session ends), and the `promotion` key never leaves the `aoc` user.
3. **No process type names the promotion profile.** Check:
   `jq -r '.types[].credentialProfile' config/process-types.json | sort -u` must not list `promotion`.
   `config/` is a protected path, and every edit is audited (`registry.changed`).
4. **Environment allowlist.** Review `supervisor.envAllowlist`. Everything not on it is dropped from session
   environments. Remove what you do not need. The Claude credentials on the default list are readable by the model
   (threat model O-14).
5. **Privileged git.** Promotion, tagging and rollback run from a **service-owned clone** that fetches candidate
   commits by SHA, never in an agent's workspace. An agent can plant git hooks and config there (threat model
   [T-2](../security/threat-model.md#t-2-code-execution-through-git-configuration-in-agent-workspaces)). At this
   commit, `mod-change` promotes from the **project's repository path**, without fetching into a separate clone,
   and lets that repository's `pre-push` hook run with the promotion credential. If any session can write that
   repository, or a worktree that shares its `.git` directory, this is exploitable. Managed sessions work in that
   very repository by default. **Do not give the promotion profile a real credential until threat model O-1 and
   O-2 are done** (gaps G-01, G-04): until then any session can also read the key file directly. How `main`
   moves in the meantime is a CEO decision; record it. If a credential is ever used before then, compare the
   repository's `.git/config` and `.git/hooks/` with a known-good checksum kept off the host before each
   promotion.
6. **Read-only types** never receive credentials. The registry schema refuses a read-only type with a
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
   holds no credential variables (`session.launch_requested.meta.credentialProfile` is `null`).
6. **Provenance gate.** Push a commit with no change record to a feature branch, then request promotion → expect
   `promotion.refused {reason: provenance_gap, orphanShas: [...]}`. Then repeat with a commit made on a laptop
   whose message carries a copied `AOC-Change: <approved change id>` trailer. Today that commit **passes** (threat
   model [T-22](../security/threat-model.md#t-22-forged-provenance-trailers)). Record the result until O-27 closes
   the gap.
7. **Sessions cannot read AOC's secrets.** Run a `claude-sim` session, or a shell as the session user, that tries
   to read the credential profiles file, a profile key file, the KEK, `aoc.db` and `~/.ssh` → expect every read
   denied. Today every read succeeds (gap G-01). Record the result until O-1 closes the gap.

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
