# AOC: Agent Ops Console

AOC wraps Claude Code in a governed, audited and metered project-lifecycle platform for a small team. You launch
agent sessions through AOC with a fixed process type, which fixes the model, the tools and the credentials. Each
session declares a plan, closes tasks only with evidence (a test, a commit or a diff), and ends its turn whenever a
human must decide something; AOC resumes it with the answer. Every step lands in one append-only, hash-chained event
log. That log is anchored off-host, and it is what the CEO and the auditor both see. Around the log sit measured
progress, decisions with separation of duties and passkeys, change control with real rollback, metering of notional
cost and throttle loss, credit caps that act only at task boundaries, error learning, and an intake portal where end
users file bugs. The binding requirements are in [docs/spec/AOC-SPEC-003.md](docs/spec/AOC-SPEC-003.md).

> **Status: under construction** (AOC-SPEC-003 §15, stage 1). The daemon, CLI, hooks, sidecar, MCP server,
> `claude-sim` and most domain modules are built and tested. The launcher/supervisor, the audit module (anchoring,
> Verify, erasure, the self-modification guard), the Control Tower and the web UI are in progress; `git log` shows
> what has landed. **This repository was written by AI agents. Its governance, audit and credit core needs a human
> code review before go-live** ([self-modification boundary](docs/compliance/self-modification-boundary.md)).

## Three roles, two surfaces

| Role | Who | Surface | Does |
| --- | --- | --- | --- |
| **Approver** | The CEO | Operator console and `aoc` CLI | Holds the gates: fix plans, go-live, rollback, break-glass, playbooks and lessons, credit top-ups |
| **Builder** | Developers | Operator console and `aoc` CLI | Drives managed sessions; self-approves reversible off-main work. Main, production and data go to the Approver |
| **Requester** | End users | Intake portal | Files bugs with video, image and comment; tests fixes on UAT; sees abstracted status only |

## How it fits together

- **`aocd`**: one process and the **sole writer** of the event log. It hosts the API, ingest, SSE, the job
  scheduler, every domain module and the launcher/supervisor.
- **Launcher/supervisor**: spawns `claude -p` per turn with AOC's hooks and MCP server, an environment allowlist and
  the process type's credential profile. It resumes sessions after decisions, nudges, restarts and rolls over.
- **Per-session sidecar**: heartbeats from the process, plus per-message token usage and plan-limit hits read from
  the transcript.
- **AOC MCP server**: the agent's structured voice (`declare_plan`, `task_done` with evidence, `request_decision`,
  …), all schema-validated.
- **Hooks**: a thin relay. aocd decides; managed sessions fail closed, and observed sessions never block.
- **Web**: the operator console (infographic-first) and the intake portal.

Read [docs/architecture.md](docs/architecture.md) for the diagrams, the event-sourcing model, liveness, progress
math, decision routing, credits, FX, error learning, change control and identity.

## Quick start

Requirements: Node ≥ 22.13 (for `node:sqlite`), pnpm 10, git. Tests never call the real `claude` binary
(`@aoc/claude-sim` stands in).

```bash
# 1. Install and build: bundles aocd, aoc, the hook binary, the MCP server, the sidecar and claude-sim into dist/bin/
pnpm install
pnpm build

# 2. Start the daemon (http://127.0.0.1:7420). Config: --config <file>, else $AOC_CONFIG, else ./aoc.config.json,
#    else safe local defaults. The first start creates .aoc/data/ with a development KEK (mode 0600) and writes a
#    one-time bootstrap token for the first Approver to .aoc/data/bootstrap-token (0600). The log prints the path.
node dist/bin/aocd.mjs          # or: aoc serve

# 3. In a second terminal, sign in as the first Approver. "--token -" reads the token from stdin
alias aoc="node $PWD/dist/bin/aoc.mjs"
aoc login --token - < .aoc/data/bootstrap-token
aoc token create --label laptop # a personal token; then revoke the bootstrap token and delete the file

# 4. Create a project that points at a git repository
aoc project create --name "Demo" --repo /path/to/repo

# 5. Launch a managed session. The process type (and so the model) is fixed here, from config/process-types.json
aoc run --type discovery --project <prj_id> --follow "Add a /health endpoint with a test"

# 6. Optional: observe Claude Code sessions you start yourself (read-only; never blocks).
#    Needs an observer token issued by an Approver.
aoc hooks install-observed --observer-token -
aoc doctor                      # credential-isolation posture and health of this machine
```

Then open <http://localhost:7420>. The full command list is in `aoc --help`. Observed sessions are explained in
[docs/runbooks/observed-sessions.md](docs/runbooks/observed-sessions.md).

Also useful:

- **Static UI mock** (for CEO approval before UI code, §12): open [`mocks/aoc-mock.html`](mocks/README.md) in a
  browser.
- **Demo history** (in progress): `pnpm --filter @aoc/demo seed -- --data-dir .aoc/demo`.
- **Without a real `claude`**: point `supervisor.claudeBin` and `supervisor.claudeArgsPrefix` at
  `@aoc/claude-sim` (see `packages/contracts/src/config.ts`).

> **The defaults are for a laptop, not for production.** Before real work or real data: complete
> [credential isolation](docs/runbooks/credential-isolation.md) (R1), move the KEK into proper
> [key custody](docs/runbooks/key-custody.md) (R6), configure an off-host [anchor](docs/runbooks/anchoring.md)
> (R2), run agents as a separate OS user, set the
> [self-modification boundary](docs/compliance/self-modification-boundary.md), and finish the human code review.

## Repository layout

```
packages/contracts   shared types, zod schemas, event catalog, DTOs, service interfaces, pure functions (lead-owned)
packages/kernel      event store (hash chain, encrypted bodies, blobs), module host, reactors, jobs, git, test kit
packages/client      ingest client for hooks, MCP server, sidecar and CLI (retry and local spool)
packages/llm         LLM adapters (claude CLI, Anthropic SDK, fake)
packages/mod-*       domain modules: sessions, ledger, decisions, change, identity, metering, fx, credits,
                     learning, registry, audit, evidence, intake, tower (Control Tower)
packages/supervisor  launcher/supervisor (spawns claude, resume, nudge, restart, rollover)
packages/sidecar     per-session sidecar binary
packages/mcp-server  AOC MCP server binary
packages/hooks       Claude Code hook binary
packages/cli         aoc CLI
packages/daemon      aocd composition root
packages/claude-sim  deterministic fake claude CLI for tests and demos
packages/demo        deterministic demo-history seeder
packages/web         operator console and intake portal (React; design tokens in src/design/tokens.css)
config/              process-type registry, rate card (governed: changes are audited)
mocks/               static design mock of the Console, Session and Registry views
docs/                spec, architecture, ADRs, runbooks, security, compliance
scripts/             build and full-repo checks
```

Each package exports from `src/index.ts`. Package `exports` point at TypeScript source, so tests need no build
step. Contribution rules (imports, the event-sourcing rules, security rules, UI rules) are in [CLAUDE.md](CLAUDE.md).

## Testing

```bash
pnpm test                               # vitest across every package (root vitest.config.ts projects)
pnpm typecheck                          # tsc --noEmit in every package
scripts/check.sh                        # full verification: typecheck + tests per package; CONC=3 by default
pnpm --filter @aoc/<package> test       # one package, e.g. @aoc/kernel
pnpm --filter @aoc/<package> typecheck
```

Tests are deterministic. They use temporary directories, random ports, a fake clock, a fake LLM and `claude-sim`,
with no network and no real `claude`. The kernel test kit (`createTestRuntime`) spins up a full in-memory runtime
for module tests.

## Documentation

| Document | What it covers |
| --- | --- |
| [AOC-SPEC-003](docs/spec/AOC-SPEC-003.md) | The binding requirements |
| [Architecture](docs/architecture.md) | Components, sequences, the event-sourcing model, liveness, progress, decisions, credits, metering, FX, learning, change control, identity, ISO status, build sequence |
| [ADRs](docs/adr/README.md) | Eleven architecture decisions with their trade-offs |
| [Threat model](docs/security/threat-model.md) | STRIDE per component, abuse and gaming scenarios, the risk register R1 to R17, open items |
| [Self-modification boundary](docs/compliance/self-modification-boundary.md) | What the governance core is, how it is protected, the human-review requirement |
| Runbooks | [Credential isolation (R1)](docs/runbooks/credential-isolation.md) · [Key custody, backups, crypto-shred (R6)](docs/runbooks/key-custody.md) · [Anchoring (R2)](docs/runbooks/anchoring.md) · [Observed sessions](docs/runbooks/observed-sessions.md) · [Operations](docs/runbooks/operations.md) · [Incidents and break-glass](docs/runbooks/incident-break-glass.md) |
| [Claude Code facts](docs/research/claude-code-integration.md) | Verified hook, stream-json, transcript and flag behaviour that AOC relies on |
