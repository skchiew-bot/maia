# Testing AOC

How the code is tested, what each layer proves, and the commands. Test counts are not quoted here: run the commands
and read the result, or read the [gap list](compliance/gaps.md) for the last figure the lead wrote down.

None of these layers is a human review. The agents that wrote the code wrote its tests, so a passing run shows that
the code does what its authors meant, not that they meant the right thing ([self-modification boundary
§0](compliance/self-modification-boundary.md#0-disclosure-this-repository-was-built-by-ai-and-its-core-needs-human-review-before-go-live)).

## The layers

| Layer | Where | What it proves | Command |
| --- | --- | --- | --- |
| Unit and module tests | `packages/*/test`, vitest | One package against the kernel's in-memory test runtime (`createTestRuntime`), a temporary directory, a random port, a fake LLM and no network. Never the real `claude` | `pnpm --filter @aoc/<package> test` |
| Contracts and typecheck | every package | The shared types, zod schemas and event catalog agree with their users | `pnpm --filter @aoc/<package> typecheck`, or `pnpm typecheck` for the repo |
| End to end on the real binaries | `packages/e2e` | `aocd`, the hook binary, the MCP server, the sidecar and the supervisor, driven with `@aoc/claude-sim` (a deterministic fake `claude`): sessions, decisions, credits, intake, the push gateway | `pnpm --filter @aoc/e2e test` |
| Demo end to end | `packages/demo/test/*.e2e.test.ts` | The seeder and the `live` launcher against a real daemon and claude-sim, including a clean stop | `pnpm --filter @aoc/demo test` |
| Seeded property, concurrency and authorization tests | kernel, daemon, mod-ledger, mod-sessions, mod-decisions, mod-metering, mod-identity | Invariants against models and oracles: the chain verifies, a rebuild equals the live state, erasure leaves no plaintext, every route answers every kind of caller correctly ([wave 4](security/review-wave4.md)) | the package's `test`, below |
| The real Claude Code CLI (opt-in) | `packages/e2e/real-cli` | AOC driving the real `claude` on Haiku: hooks, MCP, resume, the decision round trip, triage, the push gateway, stop and restart. A few cents per scenario. Never part of `pnpm test` | `AOC_REAL_CLI=1 pnpm --filter @aoc/e2e real-cli` (two sessions); `real-cli:full` for every scenario |
| Accessibility and UI gate | `packages/web/test/a11y` | Every route as each role at 1440 and 360 px, light and dark: axe, no horizontal scroll, no idle animation, charts that print their numbers, keyboard reach, no console errors | `pnpm --filter @aoc/web a11y` (about 7 minutes; writes `packages/web/test/a11y/report.md`) |
| Whole repo | `scripts/check.sh` | Typecheck, the tests of every package, then the packaging smoke test | `bash scripts/check.sh` (slow; `CONC=<n>` sets the concurrency; logs in `/tmp/aoc-*.log`) |
| Packaging smoke test | `scripts/smoke-dist.mjs` | The bundles build and run from a copy of `dist/` | `node scripts/smoke-dist.mjs` (after `pnpm build`) |

The documentation links, anchors and counts are checked by `node scripts/check-docs.mjs` (no dependencies; it is not
wired into any other script).

## Seeded tests: replaying and soaking

The property tests run through `forSeeds` (`packages/kernel/src/testing/random.ts`). Each runs seeds 1 to 25 unless the
test says otherwise, plus any seed that was pinned after an earlier failure.

- A failure prints `FAILED with seed=<n>`. Replay exactly that seed with `AOC_SEED=<n>`
  (a comma-separated list is allowed), fix the defect, then pin the seed in the test so it stays a regression case.
- Soak with more seeds: `AOC_SEEDS=<count>` runs seeds 1 to count. The projection-purity test takes 35 to 45 seconds
  at its default (it seeds a 14-day demo history), and a soak of 30 to 60 seeds takes two to three minutes.

```bash
AOC_SEED=187 pnpm --filter @aoc/kernel test erase-residue      # replay one seed
AOC_SEEDS=60 pnpm --filter @aoc/daemon test projection-purity   # soak
```

## The real-CLI suite

Nothing runs without `AOC_REAL_CLI=1`: the runner refuses and the tests skip. It boots the production aocd
composition on a random port with the built hook, MCP-server and sidecar bundles and the real `claude`, then checks
what AOC believed against what the CLI printed. Its captures are scrubbed and kept as fixtures that the parser tests
replay (`docs/research/fixtures/claude-code/aoc-*`). What it verified, what it found and what it did not check
(the usage-limit path, OAuth or keychain login and per-session config directories, the isolation modes, models other
than Haiku, compaction and automatic rollover, the shipped scoped `Bash` grants run live) is in
[research §13](research/claude-code-integration.md#13-verified-against-the-real-cli-on-2026-10-09); the options
(`AOC_REAL_CLI_CLAUDE`, `AOC_REAL_CLI_CAPTURE`, `AOC_REAL_CLI_KEEP`, `AOC_REAL_CLI_RUNS`) are in
[§13.8](research/claude-code-integration.md#138-re-running-and-refreshing). Run it again after every Claude Code
upgrade.

## Rules the tests follow

Temporary directories, random ports, no network, no real `claude` binary (`@aoc/claude-sim` instead), a fake LLM, and
an injected `Clock` in domain code so that tests are deterministic. The shared host runs other agents: do not run the
whole suite casually, run the package you changed.
