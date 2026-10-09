# The self-modification boundary (§13, R14)

> "The platform may build its own features via its own distillation engine, but never its own governance, audit,
> or credit core — those stay human-built and human-changed, and any AOC self-change is audited outside AOC. The
> system must not mark its own homework." (AOC-SPEC-003 §13)

- **Risk:** R14, High. Self-build quietly corrupts the governance or audit core.
- **Owners:** the CEO (governance) and the platform architect.
- **ISO/IEC 42001 (provisional):** map-026, A.6.1.3 "Processes for responsible AI system design and development".
  Pending the compliance lead's confirmation (R3; [mapping note](iso42001-annex-a.md)).

## 0. Disclosure: this repository was built by AI, and its core needs human review before go-live

This repository, **including its governance, audit and credit core**, was written by AI agents (Claude Code
sessions working in parallel from AOC-SPEC-003). The agents also wrote its tests and these documents. Passing
tests show that the code does what its authors meant. They do not show that the authors meant the right thing,
and the authors were not independent of the code.

Therefore: **before AOC governs real work, one or more humans who were not part of the build must review the
governance, audit and credit core (§1, Tier 1) and sign off.** The scope and the record are in §5. Until that
sign-off exists, treat every AOC control as provisional, and say so in any evidence pack. At integration commit
`a1c8a0c` no such review has taken place ([gap P-06](gaps.md)).

## 1. What the core is

The core is defined by **function**: code or configuration that decides who may approve what (governance), what is
recorded and provable (audit), or what is charged and limited (credit). Anything that can change those outcomes
belongs to it, including the code that loads, wires or feeds the parts.

### Tier 1: core (human-built, human-changed; AOC's agents may never modify it)

| Path | Function | In the default `protectedPaths`? |
| --- | --- | --- |
| `packages/kernel/` | Event store, hash chain, canonical JSON, crypto, body store, guard policy, reactors | Yes |
| `packages/contracts/` | The event catalog (strict meta), routing rules (`decisions.ts`, `roles.ts`), liveness, progress, `routeModel` | Yes |
| `packages/mod-audit/` | Anchoring, Verify, erasure, **this boundary's guard** | Yes |
| `packages/mod-credits/` | Caps, grants, top-ups | Yes |
| `packages/mod-decisions/` | Routing, separation of duties, passkeys, policy resolutions | Yes |
| `packages/mod-identity/` | Users, roles, tokens, passkeys, ingest principals | Yes |
| `packages/hooks/` | Relay of enforcement decisions into Claude Code | Yes |
| `config/` | The process registry (models, credential profiles), the rate card, the ISO mapping | Yes |
| `packages/supervisor/` | Credential injection, `envAllowlist`, model at launch, promotion and rollback execution | Yes |
| `packages/mod-change/` | Change control, the provenance gate, rollback, break-glass | Yes |
| `packages/mod-sessions/` | Ingest authentication, guard dispatch, the read-only guard | Yes |
| `packages/mod-ledger/` | The evidence rule, progress, boundaries, the writer lock, handoff briefs | Yes |
| `packages/mod-metering/` | The notional cost that credits consume; rollups | Yes |
| `packages/mod-registry/` | Model routing and playbook binding | Yes |
| `packages/distill/` | The shared distillation core: the Approver gate and the rule that only a person picking the binding option binds a playbook or lesson | Yes |
| `packages/mod-evidence/` | Evidence packs and the mapping stamp | Yes |
| `packages/daemon/` | Which modules and guards are loaded at all | Yes |
| `packages/client/`, `packages/mcp-server/`, `packages/sidecar/` | Ingest authentication and the telemetry that metering and credits trust | Yes |
| `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `scripts/`, `.github/` | Dependencies, build and CI: a supply-chain path into everything above | Yes |
| `CLAUDE.md`, `docs/spec/`, `docs/compliance/` | The rules every building agent follows; the binding spec; the cited control mapping | Yes |

### Tier 2: features (AOC may build them through normal change control)

`packages/web`, `packages/mod-tower`, `packages/mod-learning`, `packages/mod-fx`, `packages/mod-intake`,
`packages/llm`, `packages/cli`, `packages/claude-sim`, `packages/demo`, `mocks/`, and documentation outside
Tier 1.

Tier 2 changes still get a change record and normal human review. They simply may be produced by AOC-managed
sessions.

The default `selfModification.protectedPaths` (`DEFAULT_PROTECTED_PATHS` in `packages/contracts/src/config.ts`)
lists every row above, plus `packages/*/package.json` so that a feature package cannot add a dependency unseen.
The production list remains a **CEO decision** (threat model O-10, gap P-18): remove nothing without a recorded
decision, and add any path the CEO classes as core. None of it protects anything until `aocRepoPaths` is set
(production refuses to start from a source checkout of AOC while it is empty; §2, Layer 1).

**AOC's audit state** is protected separately, for every managed session, whatever repository it works in: the
data directory, the anchor repository, the RFC 3161 token directory, the external audit log, the KEK file and the
credential profiles file.

## 2. How the boundary is enforced

There are four layers. Each one makes up for the weakness of the layer before it.

### Layer 1: the `self-modification` guard (speed bump and record)

- **Configuration:**
  - `selfModification.aocRepoPaths`: the repository roots that **are** AOC;
  - `selfModification.protectedPaths`: path prefixes relative to such a root;
  - `selfModification.externalAuditLog`.
- **Behaviour** (`mod-audit`, guard order 5; Built): a `PreToolGuard` for managed sessions only; it abstains for
  observed sessions. It denies a call that would change the core of an AOC repository (a target inside an
  `aocRepoPaths` root, under a protected prefix) or AOC's audit state (above):
  - **What it inspects:** the file-changing tools (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`), any other tool
    whose name says it writes (an MCP filesystem server, for example), and Bash: redirects, `rm`, `mv`, `cp`,
    `tee`, `sed -i`, `git checkout --`, `git apply`, `patch`, `sh -c`, inline interpreter code, `find -delete` and
    `xargs`. Inside an AOC repository, a patch must come from a file or a here-document so its paths can be
    checked, and a command too large to inspect is denied.
  - **How it resolves targets:** from the tool input, not the session's working directory, so an absolute path
    from a session in another repository is caught too. `..` is normalised; both spellings of a symlinked path
    are checked; a hard link to a protected file is found; recursive operations (`rm -r`, `mv`, `chmod -R`) on an
    ancestor of a protected tree count.
  - **Then it:** first writes a line to the external audit log (Layer 4); then appends
    `selfmod.blocked {sessionId, rule, pathHash, externalLogged}`, with the path, the tool and the command in the
    encrypted payload; then returns `blockReason: self_modification`, so the session records
    `session.blocked {reason: self_modification}`.
- **No decision card is offered.** There is nothing for a human to approve inside the session. Core changes follow
  the human path (§4).
- A guard that throws counts as a deny (kernel `GuardPolicy`).
- **Two caveats:**
  - **`aocRepoPaths` defaults to an empty list, and with it the guard protects no core code** (the audit state
    stays protected). Production must set it to every clone of the AOC repository that managed sessions can
    reach (gap P-18). aocd enforces what it can see: in `"mode": "production"` it **refuses to start** from a
    source checkout of AOC (the tree it runs from has a `.git` and `packages/kernel`) while the list is empty, and
    the message names `selfModification.aocRepoPaths` and this document. A dist install carries no checkout,
    so aocd cannot tell where its operator keeps clones: listing them stays the operator's duty. Development is
    not asked.
  - Bash can change files without naming them (a script, a Make target, an interpreter reading its program from
    a file), so this layer is a speed bump (§2.4 of the spec makes the same point about command matching). And
    while sessions run as the aocd OS user (threat model O-1), nothing at the file-system level backs it up.

### Layer 2: credentials (the wall)

AOC's managed sessions hold no credential that can update the AOC repository's `main`. That follows from credential
isolation ([runbook](../runbooks/credential-isolation.md)). A session can at most push a feature branch.

### Layer 3: human review on GitHub, which AOC cannot bypass

For the **AOC repository itself**, configure the `main` ruleset differently from product repositories:

- Require a pull request, **require review from Code Owners**, and dismiss stale approvals.
- `.github/CODEOWNERS` assigns every Tier 1 path to the designated human reviewers (at least two people; never a
  machine user). Start from `.github/CODEOWNERS.example`, which a mod-audit test keeps identical to the default
  `protectedPaths`.
- **No bypass actors at all, including AOC's supervisor machine user.** In product repositories the supervisor is
  the only bypass actor, because AOC's go-live gate is the review of record there. In AOC's own repository that
  would let AOC approve its own core, which is exactly what §13 forbids.
- Required status check: the `check` job of `.github/workflows/ci.yml`, which runs `scripts/check.sh` (typecheck,
  tests, the compliance-docs check and the packaging smoke test).

Built (threat model O-10, gap G-41): AOC's own promotion gate refuses any candidate for an AOC repository whose
commits touch Tier 1 paths and trace to a managed session (`promotion.refused {reason: self_modification}`), after
writing the attempt to the external log (Layer 4). It fails closed when an AOC repository cannot be checked.

### Layer 4: audit outside AOC

"Any AOC self-change is audited outside AOC." No record of a self-change may live **only** in AOC's chain, because
the chain is part of what is being protected. Three external records:

1. **The external self-modification log** (`selfModification.externalAuditLog`, default
   `.aoc/selfmod-audit.log`).
   - **Built:** one JSON line per blocked attempt, written before the chained `selfmod.blocked` event, fsync'd,
     mode 0600. Each line carries the SHA-256 of the previous line (`prev`), so an edit or a deletion in the
     middle shows when the file is re-hashed. Lines cut from the end do not: compare the line count with the
     chained `selfmod.blocked {externalLogged: true}` events.
   - **Built (G-41):** one line per promotion through AOC's gate that touches Tier 1 in an AOC repository:
     `selfmod.promotion_refused` (commits, sessions, files) and `selfmod.promoted` (landed, break-glass included).
     Merges made outside AOC (the human path, §4) are recorded by the merging human (step 5).
   - **A local file on the AOC host is not "outside AOC"**, and the aocd user can rewrite it. Ship it off-host as
     it is written: to the central log service, to an append-only bucket, or as commits to the anchor repository
     (gap P-07).
2. **GitHub history, pull-request reviews and the organisation audit log** of the AOC repository. They are owned by
   the organisation, not by the AOC host, and they show who authored, who reviewed and who merged every core change.
3. **The off-host chain anchors** ([anchoring](../runbooks/anchoring.md)). They prove that `selfmod.blocked`
   events and core-related change records were not removed from the chain afterwards.

## 3. What AOC's agents may and may not do

| Action by an AOC-managed session | Allowed? |
| --- | --- |
| Build Tier 2 features in the AOC repository (UI, Control Tower, learning, FX, intake), under change control | Yes |
| Read Tier 1 code (to understand it, to write tests for Tier 2 against it) | Yes |
| Edit, create, delete or rename anything under a Tier 1 path | **No.** Blocked and logged |
| Edit Tier 1 indirectly: generated files, `package.json` scripts, the lockfile, CI, `CLAUDE.md` | **No.** These are Tier 1 |
| Propose a Tier 1 change as text (an issue or a diff in a decision card or a report) for a human to author | Yes. The human remains the author of record |
| Distil a playbook or lesson that instructs agents to touch Tier 1 | **No.** The reviewer of the playbook or lesson must reject it |

## 4. The human path for changing the core

1. **Author.** A named human writes the change and is accountable for every line. They may use tools, including an
   AI assistant on their own machine, but no AOC-managed session may produce Tier 1 changes.
2. **Change request** in AOC at scope `production`, with impact analysis, mitigation plan, a rollback plan naming the
   previous release tag, and an acceptance test. If an architectural decision changes, add or supersede an
   [ADR](../adr/README.md).
3. **Pull request** on GitHub. CI must be green. **A Code Owner other than the author approves.**
4. **A human merges.** No AOC bypass exists in the AOC repository (Layer 3).
5. **External record.** The merge and its review are recorded outside AOC (Layer 4), with the pull-request link and
   the reviewers. AOC writes lines only for promotions through its own gate: for a merge on GitHub the merging
   human does, in the off-host copy of the log or the organisation's change log.
6. **Deploy** following the [operations upgrade procedure](../runbooks/operations.md#8-upgrades). Config changes
   appear as `config.changed` or `registry.changed` at startup. Each one must match an approved change request.

## 5. The go-live code review

**Scope:** every Tier 1 path at the commit proposed for go-live. Minimum checklist:

- [ ] **Event store:** header fields and hash computation; canonical JSON; genesis; atomicity of `appendMany`
      (including the rollback path and the clean-up of body rows); idempotency; `verifyChain`.
- [ ] **Body store and crypto:**
  - AES-256-GCM with random 96-bit nonces and AAD binding;
  - DEK wrapping;
  - erasure completeness (`bodies.db`, blobs, read models, the `aoc.db` gap in threat model O-24);
  - KEK loading (no environment KEK in production, O-13).
- [ ] **Strict meta** across the whole event catalog: nothing personal or free-text in clear.
- [ ] **Ingest authentication:** session-token scoping, observer restrictions, fail-closed paths, system tokens.
- [ ] **Guard policy:** ordering, deny on exception, handling of observed sessions.
- [ ] **Decisions:** routing; separation of duties, including the single-Approver rule (with
      `decisions.soleApproverFallback: false`, the CEO's decision of 2026-10-09, the only Approver can never resolve
      their own request); the binding of passkey assertions to decision, option and card; policy resolution
      (only the credit auto-grant); expiry.
- [ ] **Credits:** enforcement only at boundaries; the auto-grant at most once per period; top-up separation of
      duties.
- [ ] **Identity:**
  - token hashing and revocation;
  - cookie flags and CSRF protection (O-22);
  - WebAuthn ceremonies (challenge binding, origin and rpId checks, signature counter).
- [ ] **Supervisor:**
  - `envAllowlist` and credential-profile injection, including the `HOME` it passes through;
  - the separate sandbox user (O-1, not built);
  - `runIsolated` and no privileged git in workspaces (O-2, not built);
  - settings validation and launch fail-closed checks (O-15);
  - the sidecar's token and principal (O-3).
- [ ] **Change control:** the provenance algorithm (O-27); isolation of rollback verification and its acceptance
      command; break-glass audit; immutable pin tags.
- [ ] **Audit:** anchoring to off-host records; Verify reads the remote and refuses to anchor a chain that no
      longer matches; the erasure API's authorisation (O-28); the self-modification guard (path resolution,
      symlinks, hard links, the Bash analysis, the external log's hash chain).
- [ ] **Evidence:** packs that check anchors against the off-host records (O-29).
- [ ] **Supply chain:** every dependency pinned to an exact version and reviewed; the lockfile matches.

**Record of the review:** reviewer names, the commit SHA reviewed, findings and their dispositions, and a sign-off
statement. Store it in the external self-modification log and in the AOC repository (as a reviewed document), and
attach it to the first evidence pack after go-live.

**Re-review trigger:** any change to a Tier 1 path goes through §4, which includes a human Code Owner review.
