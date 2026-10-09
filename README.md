# AOC: Agent Ops Console

AOC wraps Claude Code in a governed, audited and metered project-lifecycle platform for a small team. You launch
agent sessions through AOC with a fixed process type, which fixes the model, the tools and the credentials. Each
session declares a plan, closes tasks only with evidence (a test, a commit or a diff), and ends its turn whenever a
human must decide something; AOC resumes it with the answer. Every step lands in one append-only, hash-chained event
log that is anchored off-host and that the CEO and the auditor both read. Around the log sit measured progress,
decisions with separation of duties and passkeys, change control with real rollback, metering of notional cost and
throttle loss, credit caps that act only at task boundaries, error learning, and an intake portal where end users
file bugs. The binding requirements are in [docs/spec/AOC-SPEC-003.md](docs/spec/AOC-SPEC-003.md).

> **Current status, honestly.** All five build stages of the spec are merged and tested, including the operator
> console, the Control Tower and the intake portal. **This repository was written by AI agents, including its
> governance, audit and credit core, and the same agents wrote its tests and its documents. No human has reviewed
> it.** A review of the core by people who were not part of the build is required before go-live
> ([self-modification boundary §0](docs/compliance/self-modification-boundary.md#0-disclosure-this-repository-was-built-by-ai-and-its-core-needs-human-review-before-go-live)).
> Nothing is deployed. The ISO/IEC 42001 mapping is provisional until the compliance lead stamps it. AOC has been
> driven against the real Claude Code 2.1.295 on Haiku, and the real-CLI check lists what it did not cover
> ([research §13](docs/research/claude-code-integration.md#13-verified-against-the-real-cli-on-2026-10-09)).
> What is still open, with owners, is in the [gap list](docs/compliance/gaps.md); the spec coverage, row by row, is
> in the [traceability matrix](docs/compliance/traceability.md). Several decisions are the CEO's and undecided, among
> them which shell a builder session may use (gap P-26).

## Packages

| Path | What it is |
| --- | --- |
| `packages/contracts` | Shared types, zod schemas, the event catalog, DTOs, service interfaces, pure functions (lead-owned) |
| `packages/kernel` | The event store (hash chain, encrypted bodies, blobs), module host, reactors, jobs, git, test kit |
| `packages/daemon` | `aocd`, the composition root: one process, the sole writer of the log |
| `packages/supervisor` | The launcher: spawns `claude -p` per turn, resume, nudge, restart, rollover, the push gateway |
| `packages/mod-*` | Domain modules: sessions, ledger, decisions, change, identity, metering, fx, credits, learning, registry, audit, evidence, intake, tower |
| `packages/hooks`, `mcp-server`, `sidecar` | The Claude Code hook relay, the AOC MCP server, the per-session sidecar |
| `packages/client`, `llm` | The ingest client with its local spool; LLM adapters (claude CLI, Anthropic SDK, fake) |
| `packages/cli` | The `aoc` command |
| `packages/web` | The operator console and the intake portal (React; tokens in `src/design/tokens.css`) |
| `packages/distill` | The shared distillation core for playbooks and lessons, with the Approver gate |
| `packages/claude-sim` | A deterministic fake `claude` for tests and demos |
| `packages/e2e` | End-to-end scenarios on the real binaries, and the opt-in real-CLI suite |
| `packages/demo` | The demo seeder and the `live` launcher (always on `claude-sim`) |
| `config/`, `mocks/`, `docs/`, `scripts/` | Process registry and rate card (governed); the static design mock; documentation; build and checks |

Each package exports from `src/index.ts`; package `exports` point at TypeScript source, so tests need no build.
Contribution rules (imports, event sourcing, security, UI) are in [CLAUDE.md](CLAUDE.md). The overall design is
[docs/architecture.md](docs/architecture.md).

## Build and run (development)

Requirements: Node 22.20 or later (`node:sqlite` with FTS5, and repeated numbered parameters), pnpm 10, git.

```bash
pnpm install
pnpm build                       # bundles aocd, aoc, the hook, MCP server, sidecar and claude-sim into dist/bin/
node dist/bin/aocd.mjs           # http://127.0.0.1:7420 (or: aoc serve)
```

The first start creates `.aoc/data/` with a development KEK and a one-time bootstrap token for the first Approver in
`.aoc/data/bootstrap-token` (the log prints the path). Configuration: `--config <file>`, else `$AOC_CONFIG`, else
`./aoc.config.json`, else safe local defaults ([example](aoc.config.example.json)). Then, in a second terminal:

```bash
alias aoc="node $PWD/dist/bin/aoc.mjs"
aoc login --token - < .aoc/data/bootstrap-token
aoc token create --label laptop                      # a personal token; revoke the bootstrap token afterwards
aoc project create --name "Demo" --repo /path/to/repo
aoc run --type discovery --project <prj_id> --follow "Add a /health endpoint with a test"   # runs the real claude
```

Open <http://localhost:7420>. `aoc --help` lists the commands. With the defaults, managed sessions run as the user that
runs aocd and can read everything it can: development only.

## Run the tests

```bash
pnpm --filter @aoc/<package> test        # one package: the normal loop
pnpm test && pnpm typecheck              # every package
bash scripts/check.sh                    # typecheck, tests, packaging smoke test (slow)
```

Tests use temporary directories, random ports, a fake clock, a fake LLM and `claude-sim`: no network and no real
`claude`. The layers (end to end, seeded property tests and how to replay a seed, the accessibility gate) are in
[docs/testing.md](docs/testing.md). The one exception is opt-in and never part of `pnpm test`:
`AOC_REAL_CLI=1 pnpm --filter @aoc/e2e real-cli` drives the real `claude` on Haiku for a few cents.

## Try the demo

```bash
pnpm --filter @aoc/demo live -- --data-dir "$PWD/.aoc/demo"      # add --reset to rebuild
```

This seeds a deterministic 14-day history into an empty directory, starts aocd on it and keeps a fleet of real managed
sessions running on `claude-sim`. It shows the Control Tower, sessions in all six liveness states, change control with
a rollback and a break-glass waiting for an Approver, intake tickets in every stage of the funnel, credits, FX, and
error learning. It prints the console URL and an Approver token (also in `.aoc/demo/demo-tokens.json`). The demo never
calls the real `claude`; never seed into a production data directory. What it shows and how:
[packages/demo/README.md](packages/demo/README.md).

## Production-shaped start

Production is not the default. `"mode": "production"` makes aocd refuse to start, and say why, unless session
isolation (aocd as root, two unprivileged session users), a KEK file outside the data directory, the promotion
credential profiles and (from a source checkout) `selfModification.aocRepoPaths` are in place. A TLS reverse proxy has
to pass `/ingest/*` and allow bodies of 256 MiB. Follow, in this order:
[operations](docs/runbooks/operations.md) (the configuration, the unit, and **§8.1, the list of changes that need an
operator action**), [credential isolation](docs/runbooks/credential-isolation.md),
[key custody](docs/runbooks/key-custody.md), [backup and restore](docs/runbooks/backup-restore.md) and
[anchoring](docs/runbooks/anchoring.md). Also appoint a second Approver: with one Approver, the Approver's own gates
wait, by the CEO's decision.

## Documentation

[docs/README.md](docs/README.md) is the index, with a reading order for the CEO and compliance lead, the operator, the
security reviewer and the developer. The ones you will want first:

| Document | What it covers |
| --- | --- |
| [Gap list](docs/compliance/gaps.md) and [traceability](docs/compliance/traceability.md) | What is open and who owns it; every requirement of the spec mapped to code and a test |
| [Architecture](docs/architecture.md) and [ADRs](docs/adr/README.md) | How it is put together and why |
| [Threat model](docs/security/threat-model.md) | STRIDE per component, abuse scenarios, the risk register R1 to R17, the requested changes |
| [Runbooks](docs/runbooks/operations.md) | Operations, credential isolation, key custody, backup and restore, anchoring, incidents, observed sessions |
| [Testing](docs/testing.md) | The test layers and the commands |
| [Claude Code facts](docs/research/claude-code-integration.md) | Verified hook, stream-json, transcript and flag behaviour, and AOC against the real CLI |
