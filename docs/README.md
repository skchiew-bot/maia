# AOC documentation

AOC (Agent Ops Console) wraps Claude Code sessions in a governed, audited and metered project-lifecycle platform. The
binding requirements are in [AOC-SPEC-003](spec/AOC-SPEC-003.md); everything else here says what the repository does
about them, what it does not, and who has to act.

> **Read this first.** This repository, including its governance, audit and credit core, was written by AI agents,
> and the same agents wrote its tests and these documents. **No human has reviewed it.** A review of the core by
> people who were not part of the build is required before go-live
> ([self-modification boundary §0](compliance/self-modification-boundary.md#0-disclosure-this-repository-was-built-by-ai-and-its-core-needs-human-review-before-go-live),
> gap P-06). The ISO/IEC 42001 mapping is **provisional** until the compliance lead stamps it (P-05). "Built" in these
> documents means built and tested in the repository, not reviewed and not deployed.

## Where do I start?

| If you want to know | Read |
| --- | --- |
| What is built, what is not, and who must act | [Gap list](compliance/gaps.md): the summary table, then the open gaps and the process items |
| Whether a spec requirement is met, and where the code and its test are | [Traceability matrix](compliance/traceability.md): the summary by section, then the row |
| What can go wrong and what stops it | [Threat model](security/threat-model.md): section 4 (scenarios), then section 6 (what is still requested) |
| How to install, upgrade and run it | [Operations runbook](runbooks/operations.md), starting with [§8.1 upgrade notes](runbooks/operations.md#81-upgrade-notes-changes-that-need-an-operator-action) |
| How it is put together | [Architecture](architecture.md) |
| Why it is built that way | [Architecture decision records](adr/README.md) |
| How it is tested, and how to replay a failing test | [Testing](testing.md) |
| What was checked against the real Claude Code CLI | [Research note §13](research/claude-code-integration.md#13-verified-against-the-real-cli-on-2026-10-09) |
| A demo you can click through | [Demo README](../packages/demo/README.md) (`pnpm --filter @aoc/demo live`) |

## Reading order by audience

**CEO and compliance lead.** You decide, sign off and stamp; you do not need the code.

1. [Gap list](compliance/gaps.md): the open decisions are the **P-n** rows with your name on them (the builder shell
   policy P-26, the FX session P-19, the UAT rule for change-driven promotions P-25, backup retention P-03).
2. [Self-modification boundary](compliance/self-modification-boundary.md): the disclosure (§0) and the go-live code
   review you have to commission (§5).
3. [Traceability matrix](compliance/traceability.md): the summary, to see what the repository claims against the spec.
4. [ISO/IEC 42001 note](compliance/iso42001-annex-a.md): provisional until the compliance lead stamps it.
5. [Threat model](security/threat-model.md) sections 5 and 6: the risk register and the decisions it asks for.

**Operator.**

1. [Operations](runbooks/operations.md): the service, start and stop, health checks, and **§8.1 before every upgrade**.
2. [Credential isolation](runbooks/credential-isolation.md): users, ownership, the credential profiles, the push
   gateway, GitHub rulesets and the quarterly drill. Required before the first managed session touches a real repository.
3. [Key custody](runbooks/key-custody.md) and [backup and restore](runbooks/backup-restore.md): the KEK, the backup
   key, erasure and the restore drill.
4. [Anchoring](runbooks/anchoring.md): the off-host anchor, Verify and what to do when it fails.
5. [Incidents and break-glass](runbooks/incident-break-glass.md) and [observed sessions](runbooks/observed-sessions.md).

**Security reviewer.**

1. [Threat model](security/threat-model.md): assets, zones, STRIDE per component, 22 abuse scenarios, the risk register
   R1 to R17 and the requested changes O-1 to O-30.
2. The review waves: [wave 1](security/review-wave1.md), [wave 2](security/review-wave2.md),
   [wave 3](security/review-wave3.md), [wave 4](security/review-wave4.md) (a test-driven hunt for invariant violations).
3. [Self-modification boundary](compliance/self-modification-boundary.md): the Tier 1 paths (the governance core) and
   the go-live review checklist.
4. [Gap list](compliance/gaps.md): the residual risks of closed gaps, then [architecture §16](architecture.md#16-security-architecture-in-one-page).

**Developer.**

1. The repository's [CLAUDE.md](../CLAUDE.md) (the rules every agent and developer follows) and the
   [root README](../README.md) (package map, build, run).
2. [Architecture](architecture.md) and the [ADRs](adr/README.md).
3. [Testing](testing.md), then the package's own `test/` directory.
4. [Spec](spec/AOC-SPEC-003.md) and the [traceability matrix](compliance/traceability.md) to find the code behind a requirement.
5. The shared contracts: `packages/contracts/src` (events, DTOs, service interfaces) are the source of truth for every name.

## The documents

### Specification and design

| Document | What it is |
| --- | --- |
| [spec/AOC-SPEC-003.md](spec/AOC-SPEC-003.md) | The binding specification: requirements §1 to §16 and the risk register R1 to R17 |
| [architecture.md](architecture.md) | Components, the managed-session flow, the event-sourcing model, liveness, progress, decisions, credits, FX, learning, change control, identity, security in one page |
| [adr/README.md](adr/README.md) | The 11 decision records (sole writer, SQLite, blinded hashes, guards, fixed process type, waits end the turn, credits at boundaries, deterministic briefs, one decision engine, off-host anchoring, infographic-first UI) |
| [testing.md](testing.md) | The test layers, the commands, seeded tests, the real-CLI suite |

### Compliance

| Document | What it is |
| --- | --- |
| [compliance/gaps.md](compliance/gaps.md) | What is open between AOC and the spec, with owners; the process items for the CEO and operators; what closed; the residual risks |
| [compliance/traceability.md](compliance/traceability.md) | Every spec requirement as a row with its code, its test and a status (Built, Partial, Process), and a summary by section |
| [compliance/self-modification-boundary.md](compliance/self-modification-boundary.md) | The AI-built disclosure, the Tier 1 core, the four layers that protect it and the go-live review checklist |
| [compliance/iso42001-annex-a.md](compliance/iso42001-annex-a.md) | The provisional ISO/IEC 42001 Annex A reference list and AOC's mapping (`config/iso42001-mapping.json`) |

### Security

| Document | What it is |
| --- | --- |
| [security/threat-model.md](security/threat-model.md) | Assets, trust zones, STRIDE per component, abuse scenarios T-1 to T-22, the risk register and the requested changes |
| [security/review-wave1.md](security/review-wave1.md) | The first adversarial review (F-01 to F-18, fixed; R-01 to R-13 reported) |
| [security/review-wave2.md](security/review-wave2.md) | The fixes for the reported findings: the push gateway (R-02), launch idempotency, observer rate limits |
| [security/review-wave3.md](security/review-wave3.md) | The review of the code merged after wave 1: isolation, privileged git, backup and restore |
| [security/review-wave4.md](security/review-wave4.md) | The invariants and authorization hunt: 13 defects found by seeded tests and fixed, and what was found and not fixed |

### Runbooks

| Document | What it is |
| --- | --- |
| [runbooks/operations.md](runbooks/operations.md) | Run, stop, health checks, rebuilds, reactor failures, jobs, upgrades (§8.1: every change that needs an operator action), logs, demo directories |
| [runbooks/credential-isolation.md](runbooks/credential-isolation.md) | R1: who holds which credential, GitHub rulesets, the supervisor host, session users, the push gateway, the drill |
| [runbooks/key-custody.md](runbooks/key-custody.md) | R6: the KEK, its storage and escrow, crypto-shred, loss and compromise |
| [runbooks/backup-restore.md](runbooks/backup-restore.md) | Sealed backups, the backup key, restore and the quarterly drill |
| [runbooks/anchoring.md](runbooks/anchoring.md) | R2: the off-host anchor, Verify, and what to do when it fails |
| [runbooks/incident-break-glass.md](runbooks/incident-break-glass.md) | Severity levels, break-glass, the post-incident record, AOC's own incidents |
| [runbooks/observed-sessions.md](runbooks/observed-sessions.md) | Installing and reading the visibility hooks on developer machines |

### Research

| Document | What it is |
| --- | --- |
| [research/claude-code-integration.md](research/claude-code-integration.md) | Verified Claude Code 2.1.295 behaviour (flags, stream-json, hooks, transcripts, limits) and, in §13, AOC driven against the real CLI |
| [research/bnm-fx.md](research/bnm-fx.md) | How Bank Negara Malaysia publishes the USD/MYR rate, and the FX defaults that follow |
| `research/fixtures/` | Captured Claude Code output and BNM pages that the tests replay (scrubbed) |

### Elsewhere in the repository

| Path | What it is |
| --- | --- |
| [README.md](../README.md) | What AOC is, the package map, build, run, tests, current status |
| [CLAUDE.md](../CLAUDE.md) | The rules for agents and developers: stack, ownership, event-sourcing and security rules |
| [packages/demo/README.md](../packages/demo/README.md) | The seeded demo and the `live` launcher |
| [mocks/README.md](../mocks/README.md) | The static design mock and the CEO's approval of its defaults |
| [aoc.config.example.json](../aoc.config.example.json) | An example configuration |
| `scripts/check-docs.mjs` | Checks the links, anchors and counts in these documents (standalone; run `node scripts/check-docs.mjs`) |
