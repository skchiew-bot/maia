# AOC architecture

AOC (Agent Ops Console) wraps Claude Code sessions in a governed, audited and metered project-lifecycle platform.
This document describes how the platform is put together and why. The binding requirements are in
[AOC-SPEC-003](spec/AOC-SPEC-003.md). The shared types, event catalog and service interfaces in
[`packages/contracts/src`](../packages/contracts/src) are the source of truth for every name used below. Where this
document and the contracts disagree, the contracts win; please fix this document.

Related documents:

- Decisions and their trade-offs: [Architecture Decision Records](adr/README.md)
- Security: [threat model and risk register](security/threat-model.md)
- Operations: [runbooks](runbooks/operations.md), including [credential isolation (R1)](runbooks/credential-isolation.md),
  [key custody (R6)](runbooks/key-custody.md), [anchoring (R2)](runbooks/anchoring.md),
  [observed sessions](runbooks/observed-sessions.md) and [incident and break-glass](runbooks/incident-break-glass.md)
- Governance: [self-modification boundary (§13)](compliance/self-modification-boundary.md)
- Verified Claude Code behaviour: [docs/research/claude-code-integration.md](research/claude-code-integration.md)

**Status legend.** This document was written on 2026-10-09, at commit `fb97e98`. **Built** means implemented and
tested in the repository at that commit (not yet independently reviewed; see §17). **Contracted** means the events, configuration and service interfaces are
fixed in `packages/contracts`, and the implementation is being built in parallel. Treat every Contracted
behaviour as a requirement until its module lands.

---

## 1. Context: three roles, two surfaces, one engine

One engine, one audit log, and a per-person identity layer underneath all of it (§6).

| Role | Who | Surface | Holds |
| --- | --- | --- | --- |
| Approver | The CEO | Operator console and CLI | The gates: fix-plan sign-off, go-live, rollback, break-glass, playbook and lesson binding, credit top-ups, FX discrepancies |
| Builder | Developers | Operator console and CLI | Drives managed sessions. Self-approves reversible off-main work. Anything touching main, production or data bounces to the Approver |
| Requester | End users | Intake portal | Files bugs with video, image and comment. Tests fixes on UAT. Sees abstracted status only |

The unit of work is the **project** (§1). A project lives across many disposable **sessions** under a durable
**project thread**. Only build activity is first-class progress: a plan declared, a task done with evidence, a phase
completed, a decision, drift, an enhancement or a rollback. Questions and answers are logged, but they never count
as progress.

## 2. Components

```mermaid
flowchart TB
  subgraph people["People"]
    AP["Approver (CEO)"]
    BU["Builders (developers)"]
    RQ["Requesters (end users)"]
  end
  subgraph surfaces["Two surfaces"]
    CON["Operator console (web) and aoc CLI"]
    POR["Intake portal (web)"]
  end
  AP --> CON
  BU --> CON
  RQ --> POR
  subgraph host["AOC host: service user"]
    subgraph aocd["aocd: one Node process, the sole writer"]
      API["HTTP API and auth"]
      ING["Ingest: /ingest/*"]
      SSE["SSE: event headers only"]
      SCH["Scheduler: jobs"]
      MOD["Module host: sessions, ledger, decisions, change, identity, metering, fx, credits, learning, registry, audit, evidence, intake"]
      SUP["Launcher and supervisor"]
      ES["EventStore.append"]
    end
    DB[("aoc.db: hash-chained events and projections, WAL")]
    BD[("bodies.db and blobs/: per-scope encrypted bodies")]
    KEK["KEK: see key custody"]
    CP["Credential profiles file, 0600"]
  end
  subgraph sess["Per managed session: sandbox user"]
    CL["claude -p: one process per turn"]
    HK["Hook binary"]
    MCP["AOC MCP server: stdio"]
    SC["Sidecar"]
    WS["Workspace: git clone"]
  end
  CON --> API
  POR --> API
  SSE --> CON
  SUP -- "spawn and resume" --> CL
  SUP -- "spawn" --> SC
  CP -. "per-type env" .-> SUP
  CL --> HK
  CL --> MCP
  CL --> WS
  HK --> ING
  MCP --> ING
  SC --> ING
  API --> ES
  ING --> ES
  SCH --> ES
  MOD --> ES
  ES --> DB
  ES --> BD
  KEK -.-> BD
  subgraph dev["Developer machine"]
    OBS["Claude Code, observed: global hooks in observed mode, local spool"]
  end
  OBS --> ING
  subgraph ext["External"]
    GH["GitHub: protected main and release"]
    ANC["Off-host anchor: git remote or RFC 3161 TSA"]
    BNM["BNM exchange rates"]
    ANT["Anthropic API"]
  end
  SUP -- "promotion and rollback: machine user" --> GH
  WS -- "feature and UAT branches: scoped keys" --> GH
  SCH -- "chain head" --> ANC
  SCH -- "daily FX" --> BNM
  CL --> ANT
```

| Component | Package | What it does | Status |
| --- | --- | --- | --- |
| **aocd** | `packages/daemon` | Composition root. One process hosts the HTTP API, ingest, SSE, the job scheduler, every domain module and the launcher/supervisor. It is the **sole writer** of the event log. | Built |
| **Kernel** | `packages/kernel` | `EventStore` (hash chain, idempotency, projections, rebuild, verification, crypto-shred), `BodyStore` (per-scope envelope encryption, blobs), module host (`AocRuntime`), guard policy, broadcaster, reactor bus, job scheduler, git wrapper, test kit. | Built |
| **Launcher / supervisor** | `packages/supervisor` | Spawns `claude -p` per turn with the AOC hooks, the AOC MCP server, the env allowlist and the process type's credential profile. Resumes, nudges, restarts, stops, rolls over, and runs isolated verification commands. | Contracted |
| **Per-session sidecar** | `packages/sidecar` | Started by the supervisor next to each managed session. Heartbeats from the process (hooks cannot fire while the model generates, §2.1). Tails the transcript and subagent transcripts for per-message usage (deduplicated by `message.id`) and plan-limit hits. Spools when aocd is down. | Built |
| **AOC MCP server** | `packages/mcp-server` | The agent's structured voice (§2). Eight schema-validated tools, relayed verbatim to `/ingest/mcp/<tool>`. Refuses to start without a session id, daemon URL and ingest token. Never retries writes. | Built |
| **Hooks** | `packages/hooks` | A thin relay from Claude Code hook events to `/ingest/hook`. The daemon decides the effect; the hook only applies it (ADR-0004). Managed mode fails closed. Observed mode never blocks and spools locally. | Built |
| **Ingest client** | `packages/client` | Timeouts, bounded retries and a local JSONL spool replayed through `/ingest/spool` (idempotent). Shared by the hooks, sidecar, MCP server and CLI. | Built |
| **Domain modules** | `packages/mod-*` | Each exports an `AocModule`: events, projectors, reactors, guards, routes, jobs and services. Modules depend only on the service interfaces in `contracts/services.ts`, never on each other's code. | Built, except `mod-audit` (anchoring, Verify, erasure, the self-modification guard) and `mod-tower`, which are Contracted |
| **Control Tower** | `packages/mod-tower` | The Approver's landing view: an exception-first attention queue ranked by cost of delay, plus flow, fleet, spend, integrity and a portfolio-level anomaly radar (`TowerSnapshot` in [`dto/tower.ts`](../packages/contracts/src/dto/tower.ts)). Never ranks people (R11). | Contracted |
| **Web** | `packages/web` | The operator console and the intake portal: React, infographic-first (§12, ADR-0011). One token set for light and dark. The static mock for CEO approval is [`mocks/aoc-mock.html`](../mocks/README.md). | In progress (shell, pages and charts landed) |
| **Demo seeder** | `packages/demo` | Deterministic demo history for walkthroughs and UI work. | In progress |
| **CLI** | `packages/cli` | `aoc`: `login`, `project create`, `run --type …`, `sessions`, `decisions` and `decide`, `hooks install-observed`, `doctor`, `audit verify` / `anchor` / `evidence`, `serve`. | Built |
| **claude-sim** | `packages/claude-sim` | Deterministic fake `claude` CLI for end-to-end tests and demo data. Tests never call the real binary. | Built |
| **LLM adapters** | `packages/llm` | Structured JSON extraction (Claude CLI, Anthropic SDK, fake) for FX scraping, triage reconciliation and change-record drafting. | Built |

### 2.1 aocd: the sole writer

Hooks fire concurrently. If each hook appended to the database itself, two writers could read the same chain head
and fork the chain (§15.1). So **only aocd writes**. `EventStore.append()` runs synchronously on `node:sqlite`
(`BEGIN IMMEDIATE` … `COMMIT`) inside one Node event loop, so appends are strictly serialised. Hooks, the MCP
server, the sidecar, the CLI and the browser never open the database. They call the API or `/ingest/*`
(ADR-0001, ADR-0002).

aocd's parts:

- **HTTP API** (Hono). Users authenticate with a bearer token or the `aoc_session` cookie. Every route checks a
  permission from [`roles.ts`](../packages/contracts/src/roles.ts). Errors use one envelope:
  `{ error: { code, message, details? } }`.
- **Ingest** (`INGEST_PATHS` in [`ingest.ts`](../packages/contracts/src/ingest.ts)): `/ingest/hook`,
  `/ingest/spool`, `/ingest/heartbeat`, `/ingest/activity`, `/ingest/usage`, `/ingest/throttle`,
  `/ingest/process` and `/ingest/mcp/<tool>`. Ingest uses separate principals (§11): per-session tokens (valid only
  for their own session), an observer token (observed events only) and system tokens.
- **SSE.** Event headers, liveness changes, notifications and activity ticks. Never bodies (§6.11).
- **Scheduler.** Interval jobs and daily jobs at a local time in `config.timezone` (default
  `Asia/Kuala_Lumpur`). Daily jobs run once per local date. Examples: the FX fetch, the metering day close, the
  anchor and the intake diagnosis-budget sweep.
- **Module host** (`AocRuntime`). Projectors are registered first. Then `init` runs (modules provide services),
  routes are mounted, `start` runs (all services are available), reactors catch up and jobs start.

### 2.2 Launcher and supervisor

The supervisor is a module inside aocd (`SupervisorService` in
[`services.ts`](../packages/contracts/src/services.ts)). It owns every `claude` process.

- **Launch** (`aoc run --type <processType>`). The process type comes from the fixed registry
  ([`config/process-types.json`](../config/process-types.json)). The model comes from `routeModel()`, never from the
  agent (§2.2, ADR-0005). The supervisor issues a per-session ingest token, acquires the thread's single writer
  lock, checks credits at the launch boundary, appends `session.launch_requested`, spawns the sidecar, and spawns
  `claude -p` with the AOC hook settings, `--mcp-config` for the `aoc` server, `--model`, the permission mode and
  tool restrictions of the type, and an environment built from `supervisor.envAllowlist`. Everything else in
  aocd's environment is dropped. A credential profile is added only for types that name one, and never for
  read-only types.
- **Turns.** One `claude -p` process is one turn. When it exits, the supervisor appends `session.turn_ended` with
  an outcome (`end_turn`, `decision`, `credit_cap`, `throttled`, `error`, `interrupted`, `crashed`,
  `stop_requested`, `rollover`).
- **Resume** with `claude -p --resume <uuid> "<text>"`, for a decision answer, a top-up, a throttle reset, an
  operator prompt or an auto-continue (`autoContinueLimit`, default 1). **Nudge** ends the current turn and
  resumes with operator text. **Restart** resumes a dead or stalled session from its transcript. **Stop** happens
  at the next task boundary (`task_done` returns `stop_requested`), or at once if the session is idle (ADR-0006).
- **Rollover** to a fresh session with a deterministic handoff brief, only at a clean task boundary (§5, ADR-0008).
- **`runIsolated`** runs rollback verification and promotion commands in a supervisor-controlled environment. It is
  never exposed to agents.

Verified launch facts that the supervisor must respect are in the
[research note](research/claude-code-integration.md) §2. Three of them matter most. Settings files that fail
validation are **silently ignored** in `-p` mode, so validate the generated settings and treat "no `SessionStart`
hook within N seconds" as a launch failure. An MCP server that fails to start leaves the session running without
it, so abort the session unless `aoc` is `connected` in `system/init`. And `--allowedTools mcp__aoc` plus
`"alwaysLoad": true` are needed, or the AOC tools are denied or deferred.

### 2.3 Per-session sidecar

Hooks fire on events, not on a clock, and nothing fires while the model is generating. That is exactly when
Thinking must be told apart from Stalled (§2.1). The sidecar fills that gap:

- It sends a heartbeat every 5 s with `pid` liveness (`process.kill(pid, 0)`), transcript size and the time of the
  last transcript write. Heartbeats are **not chained** (§6, §7).
- It tails `<configDir>/projects/<slug>/<claudeSessionId>.jsonl` and `…/subagents/agent-*.jsonl`. It counts usage
  **once per `message.id`** (assistant responses repeat the same usage on every content-block line), adding only
  the delta when a later line reports more. It splits cache writes into 5-minute and 1-hour buckets and ships
  batches every 10 s or 50 messages, with a content-hash idempotency key.
- It detects plan-limit hits in transcript text (the text fallback in `THROTTLE_PATTERNS`; structured signals
  come first, see §7) and reports `/ingest/throttle`.
- It reports the process exit (`/ingest/process`), flushes and stops. Its offsets and counted state persist in a
  0600 state file, so a restart does not double-count.

### 2.4 AOC MCP server: the agent's structured voice

Server name `aoc`. Tools surface to the model as `mcp__aoc__<tool>`. Every input is validated against the zod schema
in [`mcp.ts`](../packages/contracts/src/mcp.ts) before anything reaches the daemon. Free text is never parsed.

| Tool | Purpose | Daemon effect (owner) |
| --- | --- | --- |
| `declare_plan` | Phases and tasks (id, title, size `xs`/`s`/`m`/`l`/`xl`) | `plan.declared` (ledger). Required before any file-changing tool when the type `requiresPlan` |
| `amend_plan` | Add, remove or resize tasks, with a reason | `plan.amended`: an audited change to the denominator |
| `task_done` | `task_id` plus **mandatory evidence** `{kind: test \| commit \| diff, ref}` | `task.done` with verification flags. Returns progress and a **boundary instruction** (continue, or stop for `credit_cap` / `rollover` / `stop_requested`) |
| `request_decision` | `test` (main, production, irreversible, ambiguity, data), 2 to 6 options, a recommendation | `decision.requested`. The reply tells the agent to **end its turn** |
| `playbook_step` | Step progress through a distilled playbook | `playbook.step_reported` |
| `report_diagnosis` | Triage only: root cause, confidence, fix plan | `ticket.diagnosis_reported` (intake) |
| `report_error` | A repeatable error class plus its fix | `error.observed` (learning) |
| `get_status` | Manifest, progress, open decisions, lessons in scope | Read only (the only tool that is retried) |

Failure modes "fail loudly". Daemon unreachable, a 5xx, a rejected token or an unreadable reply all return an MCP
error that tells the agent to end its turn. Writes are never retried, because a lost reply could otherwise apply
twice.

### 2.5 Hooks

The hook binary is registered for the events in `HOOK_EVENTS`
([`claude-code.ts`](../packages/contracts/src/claude-code.ts)). It POSTs `{mode, aocSessionId, hook, sentAt,
idempotencyKey}` to `/ingest/hook` and applies the daemon's `HookIngestResponse` (exit code, stdout JSON, stderr).

- **Managed mode** (`AOC_MODE=managed`, token from the supervisor-set env). If the daemon is unreachable or the
  session is unknown, the hook **fails closed**: the daemon answers exit 2 for an unknown managed session, and the
  hook binary itself exits 2 on a `PreToolUse` it cannot get a decision for. Other events are spooled and replayed.
  A guard denial from the daemon is returned as a JSON `permissionDecision: "deny"` rather than exit 2, because exit
  2 shows the hook's command line to the model. The hook command line never carries a secret.
- **Git hooks for managed workspaces.** The hooks package also ships a `pre-push` guard (it refuses pushes to `main`,
  `master`, `production` and `release/*` unless `AOC_SUPERVISOR_PUSH=1`, which only the promotion executor sets)
  and a `prepare-commit-msg` hook. Like every client-side hook, they are speed bumps.
- **Observed mode** (global hooks on developer machines, observer token). It never blocks: the ingest does not
  run guards for observed sessions, and the kernel policy would turn any denial into an allow with a "would deny"
  note anyway. When aocd is down, events are buffered in the local spool and replayed later (§2,
  [observed sessions runbook](runbooks/observed-sessions.md)).

The hooks are **not** the security wall. `claude --bare` and `--safe-mode` skip all settings hooks, invalid
settings are silently ignored, and `bash -c`, scripts or Make targets bypass command pattern-matching. The wall is
credential isolation (§3, [runbook](runbooks/credential-isolation.md)). The hook's job is to observe, and to turn an
attempt into a decision card (§2.4).

### 2.6 Web console and intake portal

- **Operator console** for Approvers and Builders. It is a transparent team console: every session and the full audit
  trail are visible to Builders (§6). Live updates come from SSE headers, and bodies are fetched through
  permission-checked API reads.
- **Intake portal** for Requesters. It is a separate route space (`/portal/api/*`). It accepts submissions and
  shows each Requester only their own tickets, with **abstracted status** only ("Received", "Being worked on",
  "Ready for your testing", "Completed", "Closed"). It never shows gate names, the approver's identity, queue
  depth or an implied timeline (§7). Requesters get no SSE stream.
- Untrusted text (transcripts, tool output, intake text) is escaped everywhere it is rendered.

### 2.7 Module map

| Module | Owns (events) | Provides (service) |
| --- | --- | --- |
| `mod-sessions` (Built) | `session.observed`, `session.liveness_changed`, `session.blocked`, `prompt.submitted`, `tool.used`, `tool.denied`, `usage.recorded`, `throttle.*` | `sessions` (directory), `liveness`. Registers the `read-only` guard |
| `supervisor` | `session.launch_requested` / `launched` / `turn_*` / `lifecycle_changed` / `nudged` / `restarted` / `stop_requested` / `ended` / `rollover_*` | `supervisor` |
| `mod-ledger` (Built) | `project.*`, `thread.*`, `plan.*`, `task.done`, `phase.completed`, `drift.detected`, `enhancement.recorded`, `playbook.step_reported` | `ledger` (manifests, progress, boundary state, writer lock, handoff brief) |
| `mod-decisions` (Built) | `decision.requested` / `resolved` / `withdrawn` / `escalated` | `decisions`; aging reminders and the opt-in webhook |
| `mod-change` (Built) | `change.*`, `rollback.*`, `breakglass.*`, `promotion.*`, `git.ref_pinned` | `change` (provenance, drafts, promotion) |
| `mod-identity` (Built) | `user.*`, `token.*`, `passkey.*` | `identity` |
| `mod-metering` (Built) | `ratecard.published`, `subscription.updated`, `rollup.closed` | `metering` |
| `mod-fx` (Built) | `fx.*` | `fx` |
| `mod-credits` (Built) | `credit.*` | `credits` (`checkBoundary`, balances, top-ups) |
| `mod-learning` (Built) | `error.observed`, `rootcause.*`, `offence.transitioned`, `lesson.*` | `learning` |
| `mod-registry` (Built) | `registry.changed`, `playbook.proposed` / `approved` / `rejected` / `retired` | `registry` (`modelFor`); playbook distillation; registry economics; the team knowledge layer (SQLite FTS5, erasure-aware, never indexes requester text) |
| `mod-tower` | none (read-only aggregation) | The Control Tower snapshot |
| `mod-audit` | `anchor.*`, `chain.verified`, `body.erased`, `selfmod.blocked`, `config.changed` | anchoring, verification, erasure, self-modification guard |
| `mod-evidence` (Built) | `evidence_pack.generated`, `mapping.published`, `mapping.stamped` | evidence packs |
| `mod-intake` (Built) | `intake.*`, `ticket.*` | requester portal, triage orchestration |

## 3. Session classes

| | Managed | Observed |
| --- | --- | --- |
| Started by | `aoc run --type …` through the supervisor | A developer running Claude Code directly |
| Process type and model | Fixed at launch from the registry | Whatever the developer chose. Recorded, never trusted |
| Hooks | AOC settings passed per launch, **enforce**: guards can deny | Global hooks, **observe**: never block |
| MCP server | `aoc` server attached, so plan, evidence and decisions are available | None |
| Sidecar | Yes: heartbeats, usage, throttle, exit | No. Usage comes from the observed hook, and liveness is never Dead by silence |
| Daemon down | **Fail closed** ("fail loudly") | Buffer locally, replay later |
| Credentials | Only the credential profile of the process type | Whatever is on the machine. This is why R1 matters |
| Progress, credits, gates | Yes | No. Logged and metered only |

"Fail loudly" applies to managed sessions, not to all Claude Code on the host (§2).

## 4. A managed session, end to end

```mermaid
sequenceDiagram
  autonumber
  actor Op as Operator
  participant D as aocd
  participant S as Supervisor
  participant SC as Sidecar
  participant C as claude -p
  participant H as Hook
  participant M as MCP server
  Op->>D: aoc run --type discovery with a prompt
  D->>S: launch(processType, projectId, prompt)
  S->>D: registry.modelFor, credits.checkBoundary, ledger.acquireWriter
  S->>D: append session.launch_requested
  S->>SC: spawn sidecar for this session
  S->>C: spawn claude -p with settings, mcp-config, model, env allowlist, credential profile
  C->>H: SessionStart
  H->>D: POST /ingest/hook
  C->>M: declare_plan
  M->>D: POST /ingest/mcp/declare_plan
  D-->>M: plan.declared, manifest version 1
  loop every tool call
    C->>H: PreToolUse
    H->>D: guards evaluate
    D-->>H: allow, or deny plus a decision card
    C->>H: PostToolUse
    H->>D: tool.used
  end
  SC->>D: heartbeat every 5 s, usage batches, throttle
  C->>M: task_done with evidence
  M->>D: POST /ingest/mcp/task_done
  D-->>M: progress and boundary instruction
  C->>M: request_decision with options and recommendation
  M->>D: decision.requested
  D-->>M: decision id and END YOUR TURN
  C-->>S: process exits, turn over
  S->>D: session.turn_ended outcome decision, lifecycle waiting_decision
  Note over D: Waiting on you. No process is alive, nothing is consumed.
  Op->>D: resolve the decision, with a passkey for go-live, rollback or break-glass
  D->>S: reactor on decision.resolved calls resume with reason decision_answered
  S->>C: spawn claude -p --resume with the answer injected
  C->>M: task_done for the last task
  C-->>S: process exits
  S->>D: session.ended completed, writer released
```

Session lifecycle (independent of liveness; liveness is derived from lifecycle plus live signals):

```mermaid
stateDiagram-v2
  [*] --> launching: launch requested
  launching --> running: process started
  running --> waiting_decision: decision raised, turn ended
  running --> blocked: credit cap, writer lock or no manifest
  running --> throttled: plan limit hit
  running --> idle: turn ended with plan incomplete
  running --> ended: completed
  running --> failed: crashed or killed
  running --> retired: rolled over to a successor
  waiting_decision --> running: decision resolved, resume
  blocked --> running: top-up or lock released, resume
  throttled --> running: reset time reached, resume
  idle --> running: nudge, operator prompt or auto-continue
  failed --> running: restart from the transcript
  ended --> [*]
  retired --> [*]
```

## 5. Event-sourcing model

Every state change is an event appended through `EventStore.append()`. Read models are projections of the log.
Nothing writes domain tables except projectors (ADR-0001).

### 5.1 The chain row

Table `events` in `aoc.db` (kernel [`event-store.ts`](../packages/kernel/src/store/event-store.ts)):

| Field | Meaning |
| --- | --- |
| `seq` | 1, 2, 3, … with no gaps; assigned by the store |
| `id` | `evt_<ULID>`: time-sortable |
| `ts` | Store-assigned ISO-8601 time (the writer's clock) |
| `type` | A catalog event type, e.g. `task.done` |
| `actor` (`actor_kind`, `actor_id`) | `human` (`usr_…`), `agent` (an AOC session id `ses_…`) or `system` (a component name such as `supervisor` or `scheduler:fx`) |
| `scope` (+ indexed columns `project_id`, `thread_id`, `session_id`, `task_id`, `ticket_id`, `change_id`, `decision_id`, `user_id`) | Ids only, never text |
| `meta` | Chained **in clear**. Ids, enums, numbers, booleans, hashes and short machine labels only. Each type's meta schema is `strict`, so unknown keys are rejected and free text cannot leak into the clear-text chain |
| `payload_hash` | The **blinded** hash of the body (§5.3), or null for header-only events |
| `body_scope` | The encryption-key scope of the body (§5.4) |
| `source` | `hook`, `mcp`, `sidecar`, `supervisor`, `api`, `scheduler`, `cli`, `intake` or `system` |
| `source_ts` | Time at the source, for buffered or observed events |
| `idempotency_key` | Unique. A repeated key returns the original event, so retries and spool replays are exactly-once |
| `causation_id` | The event that caused this one (reactor follow-ups) |
| `prev_hash`, `hash` | The chain link |

`hash = SHA-256(canonicalJSON({v: 1, chainId, seq, id, ts, type, actor, scope, meta, payloadHash, bodyScope,
source, sourceTs, idempotencyKey, causationId, prevHash}))`. The first event links to
`SHA-256("aoc-genesis:" + chainId)`, where `chainId` is 16 random bytes created with the database. Canonical
JSON sorts keys and drops `undefined`, so the chain verifies byte for byte on any machine. `BEFORE UPDATE` and
`BEFORE DELETE` triggers make the table append-only to the application.

### 5.2 Writing an event

```mermaid
flowchart LR
  SRC["hook, MCP, sidecar, API, scheduler"] --> AUTH["auth and zod request validation"]
  AUTH --> APP["EventStore.append: BEGIN IMMEDIATE"]
  APP --> VAL["validateEvent: strict meta, payload schema"]
  VAL --> BLIND["payloadHash = SHA-256 of blind and canonical payload"]
  BLIND --> SEAL["seal blind and payload with the scope DEK, AES-256-GCM"]
  SEAL --> BODIES[("bodies.db and blobs/")]
  BLIND --> HDR["canonical header incl. prevHash"]
  VAL --> HDR
  HDR --> HASH["hash = SHA-256 of the header"]
  HASH --> ROW[("events row: append-only")]
  ROW --> PROJ["projectors: one SAVEPOINT each"]
  PROJ --> COMMIT["COMMIT"]
  COMMIT --> SSEH["SSE: header only"]
  COMMIT --> REACT["reactors: cursor, at-least-once"]
  REACT -- "follow-up events with causationId" --> APP
  ROW -. "scheduled" .-> ANCHOR["anchor the chain head off-host"]
```

`appendMany()` writes several events in one transaction (all or nothing). If the transaction fails, body rows
written in it are deleted again and the in-memory head is reloaded from the database.

### 5.3 Blinded payload hashes

The chain stores `payloadHash = SHA-256(blind + ":" + canonicalJSON(payload))`. The blind is 16 random bytes,
and it is stored **only inside the encrypted body** (`{b: blind, p: payload}`). An unblinded hash of a short value
(a name, an IC number, a one-word answer) could be brute-forced from the chain alone once the body is gone. The
blind prevents that. `verifyBody()` recomputes the hash whenever the body still exists: `false` means tampered,
`null` means erased or header-only (ADR-0003).

### 5.4 Per-scope encrypted bodies and blobs

Bodies (prompts, tool summaries, decision text, intake descriptions, file names) live in `bodies.db`. Large
binaries (intake video and images) live under `blobs/<scope>/<blobId>`, mode 0600.

- **Envelope encryption.** A 32-byte **KEK** (master key) wraps one **DEK** per scope and generation
  (`key_id = <scope>#<generation>`), with AES-256-GCM and AAD `aoc-dek:<keyId>`. Bodies are sealed with the DEK
  under AAD `aoc-body:<eventId>` and blobs under `aoc-blob:<blobId>`. The AAD binds every ciphertext to its own
  record, so ciphertexts cannot be swapped between records.
- **Scope choice.** `bodyScope` defaults to the event's `sessionId`, then `ticketId`, then `projectId`, then
  `global`. Writers set it explicitly when the data belongs elsewhere. Intake uses the ticket, so one ticket can be
  erased without touching the session that worked on it. **The scope decides what can be erased on its own.**
  Identity events use a per-person scope, `user:<userId>`, so one person's profile and passkey data can be
  erased alone. Personal data must never land in `global` (see [threat model](security/threat-model.md) item O-7).
- `bodies.db` runs with `secure_delete = ON`. KEK loading and custody are in the
  [key custody runbook](runbooks/key-custody.md).

### 5.5 Crypto-shred

`EventStore.eraseScope(scopeId)` (exposed through `mod-audit`, permission `audit.erase`):

1. Destroys every wrapped DEK generation of the scope and deletes the scope's body rows, blob rows and blob
   files. It then runs `wal_checkpoint(TRUNCATE)` on `bodies.db`.
2. Calls every projector's `onErase(scopeId)` to scrub free text in read models (they show `[erased]`). Read
   models in `aoc.db` hold **decrypted copies** of some text (ticket descriptions, session titles), so this step
   matters as much as the first. `aoc.db` does not yet use `secure_delete`, so overwritten text can linger in free
   pages and the WAL until they are reused (threat model O-24).
3. Appends `body.erased {scopeId, reason, erasedBy, bodyCount, decisionId}`.

**The chain stays valid**, because only blinded hashes were ever chained. Projectors receive `payload === null`
for erased bodies on every later rebuild and must degrade gracefully. Backups taken before the erasure still hold
the old DEKs, so see the backup retention rule in the [key custody runbook](runbooks/key-custody.md#6-crypto-shred).

### 5.6 Projections, rebuild and degraded-projector isolation

- A projector declares the tables it owns, its DDL, the event types it handles and `apply(ctx, event, payload)`.
  It runs **inside the append transaction**, so read models are always consistent with the log.
- Each projector runs in its **own SAVEPOINT**. If it throws, only its own changes for that event roll back, it is
  marked `degraded` in `projection_health` (with `failed_seq` and `last_error`), and the event still commits.
  **Ingestion is never blocked by a read-model bug.** The console must show degraded projections.
- `rebuildProjections(names?)` drops the named projectors' tables, recreates them and replays the whole log in
  one transaction, decrypting payloads (`null` where erased). On success it clears their health rows. A rebuild
  holds the write lock, so plan it as maintenance (see [operations](runbooks/operations.md#4-rebuilding-projections)).
- Projectors must be deterministic and free of side effects. `ctx.replaying` tells them a rebuild is running, but
  they must behave the same either way.

### 5.7 Reactors: at-least-once, with cursors

- After `COMMIT`, the bus queues each event for every reactor whose `handles` list includes its type. One drain
  loop runs them **sequentially**.
- Each reactor has a cursor (`reactor_cursors`), the highest seq it has processed. On startup, every reactor
  catches up from its cursor. A crash between commit and reaction therefore causes a redelivery, never a loss:
  delivery is **at-least-once**.
- Reactors **must be idempotent**. They check `store.findByCausation(event.id, type)` before appending a follow-up,
  and they set `causationId` on everything they append.
- A reaction gets 3 attempts. If all fail, it is recorded in `reactor_failures` and **the cursor still advances**:
  a poisoned event cannot stall the bus, but the failure is **not retried automatically**. Operators must review
  `reactor_failures` (see [operations](runbooks/operations.md#5-reactor-failures)).
- A newly added reactor starts at the current head and does not process history.

### 5.8 Header-only SSE

The broadcaster sends `event: aoc` with an `EventHeader` (`seq, id, ts, type, actor, scope, meta`), plus `liveness`,
`notification` (filtered by audience role) and `activity` messages. Payloads are **never** streamed. Meta is clear
text by construction, so the stream cannot leak a body. Requester connections receive nothing. Bodies are fetched
through permission-checked reads, which is also where raw media access is logged (`intake.media_accessed`).

### 5.9 Verification and anchoring

`verifyChain()` recomputes every hash and link and reports gaps and the first bad seq. An in-file chain alone is
defeatable by anyone who can write the file: drop the triggers, edit, recompute (R2). Real verification compares
recomputed hashes with **off-host anchors**. A nightly (or more frequent) job writes the chain head `(seq, hash)` to
a signed commit in a separate, remotely pushed repository, or obtains an RFC 3161 timestamp, and appends
`anchor.created`. Verify (`chain.verified`) tests the recomputed chain against **every external anchor**, never
against the anchor records inside the database (ADR-0010, [anchoring runbook](runbooks/anchoring.md)).

## 6. Liveness

Liveness is **derived** from instrumented events, never animated by the UI (§4). The pure function
`deriveLiveness()` in [`liveness.ts`](../packages/contracts/src/liveness.ts) is shared by the server, the
supervisor and the tests. `mod-sessions` evaluates it on every signal and on a 5 s sweep. It **chains only
changes** (`session.liveness_changed {from, to, reason}`); heartbeats stay in memory (at a 5 s interval, chaining
them would add about 17,000 rows per session per day, §13).

**Precedence: Waiting on you > Throttled > Dead > Stalled > Thinking > Working.** The first matching row wins.

| # | State | Derived when | `reason` labels |
| --- | --- | --- | --- |
| — | (no badge) | Lifecycle `ended` or `retired` | `ended`, `retired` |
| 1 | **Waiting on you** | An open decision on the session, or lifecycle `waiting_decision`, `blocked` (credit cap, writer lock, no manifest, awaiting top-up) or `idle` (turn ended with the plan incomplete) | `open_decision`, `blocked`, `turn_ended` |
| 2 | **Throttled** | Lifecycle `throttled`, or a plan-limit reset time still in the future (the badge shows the reset time) | `plan_limit` |
| 3 | **Dead** | Lifecycle `failed`; the sidecar reports the process exited; no heartbeat for more than `deadAfterMs` (45 s); or no heartbeat ever, while running, after twice that | `process_failed`, `process_exited`, `no_heartbeat`, `never_reported` |
| 4 | **Stalled** | One tool in flight longer than `toolStallAfterMs` (20 min), or no tool or model activity for `stallAfterMs` (5 min, can be overridden per process type) | `tool_hung`, `no_activity` |
| 5 | **Thinking** | Alive, with no tool in the last `workingWindowMs` (30 s), while model output streams or the session is starting | `streaming`, `starting` |
| 6 | **Working** | A tool in flight (below the hung threshold), or a tool finished within the last 30 s | `tool_in_flight`, `recent_tool` |

```mermaid
flowchart TD
  A{"lifecycle ended or retired?"} -- yes --> N["no badge"]
  A -- no --> B{"open decision, waiting_decision, blocked or idle?"}
  B -- yes --> W["Waiting on you"]
  B -- no --> C{"throttled, or reset time in the future?"}
  C -- yes --> T["Throttled"]
  C -- no --> D{"failed, exited, heartbeat older than 45 s, or never reported?"}
  D -- yes --> X["Dead"]
  D -- no --> E{"tool in flight?"}
  E -- "for more than 20 min" --> S1["Stalled: tool_hung"]
  E -- "yes" --> WK1["Working: tool_in_flight"]
  E -- no --> F{"no activity for 5 min?"}
  F -- yes --> S2["Stalled: no_activity"]
  F -- no --> G{"tool finished within 30 s?"}
  G -- yes --> WK2["Working: recent_tool"]
  G -- no --> TH["Thinking"]
```

Signals and their sources:

| Signal | Source | Trust |
| --- | --- | --- |
| Process alive or exited | The supervisor (parent of `claude`) and the sidecar (`kill(pid, 0)`) | Supervisor: authoritative. Sidecar: see the threat model |
| Heartbeat | Sidecar, every 5 s | Agent-reachable token (threat model T-3) |
| Tool in flight or finished | `PreToolUse` / `PostToolUse` / `PostToolUseFailure` hooks | Agent-reachable token |
| Model output | stream-json deltas seen by the supervisor; transcript growth seen by the sidecar | Supervisor: authoritative |
| Throttle | `rate_limit_event` (status `rejected`, `resetsAt`), the `StopFailure` hook with `error: rate_limit`, `result.api_error_status: 429`, then the text fallback | Supervisor stream first |

Observed sessions have no sidecar. Any hook event counts as activity, and they are **never declared Dead by
silence** (`deadAfterMs = ∞`), because an idle terminal is not a dead process.

UI rules (§12): liveness is always a badge (colour, icon and a word), never a chart. Thinking is neutral, not amber.
The heartbeat drives a static "alive" indicator that pulses only on activity, never as a steady pulse that a
stalled session would also show.

## 7. Progress

Progress is **measured**, not estimated (§4, §9): weighted tasks done over tasks declared, from the plan manifest.
The pure function `computeProgress()` in [`progress.ts`](../packages/contracts/src/progress.ts) is used by the ledger,
the UI and the tests.

| Size | `xs` | `s` | `m` | `l` | `xl` |
| --- | --- | --- | --- | --- | --- |
| Weight | 1 | 2 | 3 | 5 | 8 |

- **Live tasks** are tasks not `removed`. `pct = round(1000 × doneWeight / totalWeight) / 10`, which is 0 when
  nothing is declared. Phases are computed the same way. A phase is complete when every live task in it is done,
  and completion pins an immutable git tag or SHA (`phase.completed`, §8).
- **ETA** is hidden until at least **3** tasks are done (`etaHiddenReason: fewer_than_3_done`), and hidden again
  when everything is done (`complete`). Otherwise `etaMs = elapsed / doneWeight × (totalWeight − doneWeight)`.
  Example: tasks `m`, `s` and `xs` done and one `xl` open gives done weight 6 of 14 = **42.9 %**. After 2 h elapsed,
  the ETA is 2 h / 6 × 8 = **2 h 40 min**.
- **Evidence rule.** Every `task_done` carries evidence (a test id, a commit SHA or a diff ref). The ledger
  verifies it and sets `flag`: `no_file_change` when the working tree and commits did not change since the
  previous close, and `evidence_unverified` when the ref cannot be confirmed. Flagged tasks still count, and the
  flagged count is shown next to the percentage. The "file changed" fact must come from git (working-tree
  fingerprint or commits), not from tool names (§4; Bash changes files too).
- **No manifest, no work.** A process type with `requiresPlan` is blocked from file-changing tools until
  `declare_plan` (`session.blocked {reason: no_manifest}`).
- **Amendments** (`plan.amended`) record `prevTotalWeight` and `newTotalWeight` under the amending developer's
  name, so the denominator changes visibly and scope creep is never silent (§9).
- **Master timeline.** Project progress spans every session's manifest from every developer. It is drawn as a
  stacked per-phase segment bar with one segment per contributor (`ProjectTimeline`). Its honesty depends on the
  evidence rule (R9).

## 8. Decisions: one engine

Every human-required decision, from an agent's ambiguity question to break-glass, goes through one engine
(`DecisionService`, `mod-decisions`; ADR-0009). There is one inbox, one aging rule, one audit trail and one
resolution path.

```mermaid
stateDiagram-v2
  [*] --> open: decision.requested
  open --> open: decision.escalated, never to the requester
  open --> resolved: decision.resolved by button, passkey or policy
  open --> withdrawn: decision.withdrawn
  open --> expired: decision.expired
  resolved --> [*]
  withdrawn --> [*]
  expired --> [*]
```

Routing comes from `requiredRoleFor()` and `requiresPasskey()` in
[`decisions.ts`](../packages/contracts/src/decisions.ts). An Approver can resolve anything a Builder can, except
the Requester-only UAT sign-off.

| Kind | Raised by | Minimum role | Passkey | Separation of duties and eligibility |
| --- | --- | --- | --- | --- |
| `agent_decision`, test `main` (1), `production` (2), `data` (5) | Agent, `request_decision` | Approver | — | The session owner (requester) is excluded. These tests are also enforced at the tool boundary |
| `agent_decision`, test `irreversible` (3), `ambiguity` (4) | Agent | Builder | — | Owner excluded. These tests are self-reported (§2.4) |
| `protected_operation` | A guard turning a blocked attempt into a card | Approver | — | Owner excluded |
| `fix_plan` | Intake, after triage | Approver | — | Nothing touches code before it clears |
| `go_live` | Promotion, after the provenance check | Approver | **Yes** | Requester excluded |
| `rollback` | Change control, after a clean verification | Approver | **Yes** | Requester excluded |
| `break_glass` | Emergency promotion | Approver | **Yes** | Invoker excluded. The most audited event in the system |
| `change_request`, scope `reversible_off_main` | Developer (AI-drafted) | Builder | — | **Self-approval allowed** in change control (`change.approved {selfApproved: true}`, no card needed). It is still a full change record |
| `change_request`, scope `main`, `production` or `data` | Developer | Approver | — | Requester excluded |
| `playbook_approval`, `lesson_binding`, `fx_discrepancy` | Registry, learning, FX | Approver | — | — |
| `credit_topup` | Button-raised by the capped developer | Approver | — | **Never the requester.** The first cap hit in a period is auto-granted by policy (method `policy`) |
| `triage_reconciliation`, `low_confidence_diagnosis` | Intake | Builder | — | R17: disagreement goes to a human |
| `uat_signoff` | Intake | Requester | — | Eligible: the ticket's own requester only |

- **Separation of duties.** `requesterId` is always added to `excludedApproverIds`, except for UAT sign-off. For a
  card raised by an agent, the requester is the session owner. The engine never lets a requester resolve their own
  card (`canResolve` → `separation_of_duties`), and it refuses to create a card whose eligible users are all
  excluded (`no_eligible_resolver`). Escalations (`decision.escalated`) go to the Approver role, never back to the
  requester (§6). An Approver-level card raised from the **only** Approver's own session has no eligible resolver,
  so a deputy Approver or an audited self-approval rule is needed (open item 4 in §20).
- **Policy resolution** is allowed for exactly one kind: the `credit_topup` auto-grant, once per requester per
  period. Every other kind needs a human.
- **Expiry.** The catalog has a dedicated `decision.expired {decisionId, ageMs}` event. At this commit,
  `mod-decisions` still records expiry as `decision.withdrawn {reason: expired}`, and should move to the dedicated
  event.
- **Passkeys.** For `go_live`, `rollback` and `break_glass`, the WebAuthn challenge is bound to
  `(decisionId, optionId, user)`, and `decision.resolved` records `passkeyVerified`. Elsewhere in v1 a bearer
  token or cookie proves **which token**, not who. That is attribution, not a signature (§6).
- **Ending the turn.** An agent that raises a decision is told to end its turn. The decision then waits at zero
  cost and survives reboots. On resolution, a reactor calls `supervisor.resume(…, 'decision_answered')` with the
  answer injected (§2.3, ADR-0006).
- **Aging (R15).** Every card shows its age. Reminders fire after `decisions.remindAfterMinutes` (30), with an
  in-page notification, a tab badge and an opt-in webhook. `ageMs` is chained on resolution.

## 9. Credits at task boundaries

Credits are **behaviour control**: a hard cap, but one that never terminates a session mid-task (§10, R7,
ADR-0007). `CreditService.checkBoundary()` is called **only** at the launch boundary and on `task_done`. Its answer
travels back to the agent as the `boundary` field of the `task_done` reply.

```mermaid
flowchart TD
  TB["task boundary: launch or task_done"] --> EX{"user exempt?"}
  EX -- yes --> GO["continue"]
  EX -- no --> BAL{"balance above zero?"}
  BAL -- yes --> GO
  BAL -- no --> FIRST{"first cap hit this period?"}
  FIRST -- yes --> AG["credit.auto_granted: up to 25 percent of the allocation, by policy"]
  AG --> GO
  FIRST -- no --> CAP["credit.cap_reached: boundary stop, the agent ends its turn"]
  CAP --> REQ["credit.topup_requested by button, to an Approver, never the requester"]
  REQ --> DEC{"credit_topup decision"}
  DEC -- granted --> RES["credit.topup_granted, the supervisor resumes with reason topup"]
  DEC -- denied --> STOP["credit.topup_denied, the session stays stopped"]
```

- Balance = allocation (default USD 300 notional per month, `credits.defaultMonthlyAllocationUsd`) + grants −
  used. "Used" is the notional cost from metering. The period is the local calendar month.
- The auto-grant happens once per period, is worth at most `autoGrantPct` (25 %) of the original allocation, and
  is recorded as a policy-resolved decision. There is no compounding and no AI repeat grant.
- Every grant and top-up records who, how much, against which task, and the balance before and after.
- A waiting top-up shows as its own aging state ("Waiting on you: awaiting top-up"), not as a stall.
- **Credits never pick the model.** `routeModel()` ignores budget, and the discovery-runs-on-Opus rule overrides
  it (R8).

## 10. Metering, kept separate from credits

| | Metering | Credits |
| --- | --- | --- |
| Purpose | Internal decision support: the Enterprise-migration case and throttle-loss analysis (§10) | Behaviour control: a spending cap per person per period |
| Gates anything? | **Never.** Read-only; it observes | Yes, but only at task boundaries |
| Inputs | `usage.recorded` (per message, deduplicated), `throttle.hit` and `throttle.cleared` (`idleMs`), the rate card, FX, the subscription | Metering's notional USD per user, allocations, grants |
| Output | Notional API-equivalent cost, **labelled as notional** (no per-token bill on a Max plan). Daily `rollup.closed` in USD and RM. Subscription cost shown separately | `BoundaryInstruction`, `credit.*` events |
| Changes | Rate-card versions apply **forward only**. Closed days are never restated (R12) | Allocations and top-ups are audited events |
| Picks the model? | No | No |

Metering facts that the sidecar and metering module rely on (research note §6.3): count each assistant `message.id`
once; tail subagent transcripts too (their usage is not in the main file); price 5-minute and 1-hour cache writes
separately; never sum `total_cost_usd` across `--resume` invocations, because it is cumulative per session.
Throttle idle time is metered too, because the enterprise case is productivity lost to throttling, not only
dollars.

## 11. FX state machine

The daily USD/MYR rate for each local date `D` (§10, R13). Implemented by `mod-fx`. Contracted.

```mermaid
stateDiagram-v2
  [*] --> scheduled: daily job for date D
  scheduled --> inherited: weekend or holiday
  scheduled --> fetching: weekday
  fetching --> inherited: source unreadable
  fetching --> extracting: page read
  extracting --> validating: Haiku extraction
  validating --> reconciling: passes shape and sanity checks
  validating --> escalated: fails
  escalated --> reconciling: Sonnet extraction, once, passes
  escalated --> inherited: Sonnet fails too
  reconciling --> live: equals the official BNM figure
  reconciling --> refetch: mismatch
  refetch --> live: equal after one re-fetch
  refetch --> discrepancy: still mismatched
  discrepancy --> resolved: human fx_discrepancy decision
  live --> [*]
  inherited --> [*]
  resolved --> [*]
```

- **Live**: `fx.rate_recorded {status: live, extractor: haiku | sonnet, validation: pass, reason: fetched}`.
- **Inherited**: carry forward the last live rate, stamped with its `sourceDate` and a reason:
  `weekend_or_holiday`, `source_unreadable` or `validation_failed`. Weekend and holiday gaps carry forward by
  design.
- **Sanity bounds** reject out-of-band values (default 3.5 to 5.5 and at most 3 % change from day to day).
  "Can't read the source" means carry forward with no ticket. "Read but mismatched against the true BNM figure"
  means re-fetch once, and if it is still unreconciled, raise `fx.discrepancy_raised` as an audited Approver
  decision that carries both figures. The day carries forward (`discrepancy_pending`) until a human resolves it
  (`fx.discrepancy_resolved`, recorded as `manual_override`).
- After `fx.carryForwardAlertDays` consecutive carried-forward days, `fx.carry_forward_alert` asks for a manual
  check.
- Rates and rate-card changes apply forward only. A closed `rollup.closed` keeps the rate it was stamped with.

The [BNM research note](research/bnm-fx.md) recommends changes to the Wave 0 FX defaults: pin session 1700 (the
interbank middle rate) and run at 17:45 MYT instead of 12:30; pass `?session=` explicitly to the API; compare at 4
decimal places; count weekdays (alert at 3) rather than calendar days. These are open for the `mod-fx` owner and
the lead.

## 12. Error learning and repeat-offence detection

A distilled lessons registry, not a raw error log (§11). Implemented by `mod-learning`. Contracted.

- **Occurrences.** `error.observed` comes from tools, tests, UAT, rollbacks, hooks, agent reports
  (`report_error`) and CI. It carries a signature, code area, process type, model and cost. Transient errors are
  logged and forgotten.
- **Root-cause classes** (`rootcause.class_defined`) cluster occurrences **by cause, not by error text**, in one
  dimension: `spec`, `context`, `tooling`, `codebase`, `guardrail`, `model_capability`, `environment` or
  `unknown`. The root cause often points outward (an ambiguous spec, a missing guardrail); the agent is frequently
  the symptom.
- **Model as a tested dimension.** A class is `model_capability` only when it recurs on the cheaper model and not on
  the stronger one. The fix is then a targeted per-process-type upgrade, not a blanket one.
- **Priority** is the cost of recurrence, not the count. UAT failures enter with `priority: high`.

```mermaid
stateDiagram-v2
  [*] --> detected: a root-cause class repeats
  detected --> root_caused: class and dimension assigned
  root_caused --> fix_applied: fix shipped through a change record
  fix_applied --> verified_closed: no recurrence in the verify window
  fix_applied --> reopened: recurrence
  verified_closed --> reopened: recurrence
  reopened --> root_caused
```

Lessons are where learning reaches the fleet, so they are gated:

```mermaid
stateDiagram-v2
  [*] --> proposed: lesson.proposed, scoped to a process type or code area
  proposed --> bound: lesson_binding approved by a human
  proposed --> rejected: rejected
  bound --> bound: lesson.applied to a session in scope
  bound --> retired: unused for N runs, superseded or manual
  rejected --> [*]
  retired --> [*]
```

- A lesson becomes binding only through a human decision, because one bad lesson corrupts the fleet.
- Lessons are scoped, never global. They retire after `learning.retireAfterUnusedRuns` (20) unused runs (R10).
  Each one tracks repeats prevented and tokens or time saved.
- Verified closure needs no recurrence for `learning.verifyWindowDays` (14).
- **No per-person blame.** Occurrences and classes carry no user id. Read models aggregate by class, process type,
  code area and model, never by person (R11). See the threat model for the residual (a session id can be joined to
  its owner).

## 13. Change control, rollback, break-glass and provenance

### 13.1 Change requests

Every post-MVP change is a change request: a first-class decision that cannot start until four fields are
supplied and approved. The fields are **impact analysis**, **mitigation plan**, **rollback plan** (naming the
exact commit or tag to return to) and **acceptance test** (§8).

```mermaid
stateDiagram-v2
  [*] --> drafted: change.drafted by AI or a human
  drafted --> drafted: change.field_affirmed, an edit or affirm of each field
  drafted --> submitted: all four fields affirmed
  submitted --> approved: self-approved if reversible off-main, else an Approver decision
  submitted --> rejected: rejected
  approved --> started: change.started in a managed session
  started --> completed: change.completed pins a tag or SHA
  completed --> [*]
  rejected --> [*]
```

"Invisible governance with accountability" (§14): AI drafts the fields, and the developer must edit or affirm each
one. `change.field_affirmed` records `edited`, `editRatio` and `dwellMs`, so a blind one-click confirm is flagged
and a per-developer affirm-without-edit rate is tracked. Self-approved reversible off-main work still produces a
full change record under the developer's name.

### 13.2 Rollback, break-glass and promotion

```mermaid
flowchart LR
  PR["promotion.requested"] --> PV{"provenance: every commit traces to an approved change, UAT and a gate?"}
  PV -- no --> RF["promotion.refused with orphan SHAs"]
  PV -- yes --> GL["go_live decision: Approver, passkey"]
  GL -- approved --> PC["promotion.completed by the supervisor machine user"]
  RR["rollback.requested to a pinned tag or SHA"] --> VS["verification: new branch at the target, acceptance tests, no credentials"]
  VS --> VD{"clean?"}
  VD -- no --> RJ["reported back, no decision offered"]
  VD -- yes --> RD["rollback decision: Approver, passkey"]
  RD -- approved --> RX["rollback.executed"]
  BG["breakglass.invoked: production down"] --> BD["break_glass decision: Approver, passkey"]
  BD -- approved --> BP["promotion.completed with breakglass true, post-incident change due in 24 h"]
  BP --> OD{"post-incident change done within 24 h?"}
  OD -- no --> OV["breakglass.post_incident_overdue"]
```

- **Rollback is real.** Every phase completion and change record pins an immutable git tag or SHA
  (`git.ref_pinned`). Rollback is a human-required, audited decision. The dashboard issues it; the supervisor checks
  the tag out on a new branch, runs that state's acceptance tests (`rollback-verify` process type, no credentials),
  and reports back before anything touches main. The Approver approves only a clean result, with a passkey. There is
  no one-tap rollback from a phone onto the main line. Execution preserves history: the target state is committed
  on top of main as a fast-forward, nothing is force-pushed, and `rollback.failed` records a rollback that could not
  be applied (main is then left unchanged).
- **Break-glass** is permitted when production is down. It is the most heavily audited event, routes straight to the
  Approver, and auto-raises a mandatory post-incident change record due within 24 hours
  ([runbook](runbooks/incident-break-glass.md)).
- **Provenance guarantee** (§14). `ChangeService.provenance(projectId, sha)` checks that every commit between main
  and the candidate traces through an approved change record, a UAT sign-off and a gate. Otherwise the promotion is
  refused (`promotion.refused {reason, orphanShas}`). Break-glass is the sole exception, and it is marked as such.
  Today a commit is "traced" by its `AOC-Session` or `AOC-Change` message trailer (written by the
  `prepare-commit-msg` hook in managed workspaces). Trailers are plain text that anyone can copy, so they must be
  cross-checked against commits AOC itself recorded (threat model T-22).
- Only the supervisor's machine identity can move `main` and `release/*`. That is enforced by GitHub, not by AOC
  ([credential isolation runbook](runbooks/credential-isolation.md)).

## 14. Project thread and context rollover

- **One active writer per thread** (`thread.writer_acquired` / `thread.writer_released`). Rollover is sequential;
  there are never parallel writers on the same code. Parallel agents are allowed only for read-only bug triage
  (§5, §7).
- **When.** The supervisor watches `contextTokens` (from usage) against the model's context window times the type's
  `rolloverContextPct` (default 70 %, 85 % for `migration`). It rolls over **only at a clean task boundary**, so
  `task_done` returns `{continue: false, reason: rollover}`. `LedgerService.boundaryState()` must report no
  half-done task and no risky playbook step. Risky types never roll over mid-operation (R16).
- **How** (ADR-0008). `buildHandoffBrief()` deterministically distils manifest status, key decisions with their
  reasons, open decisions and file pointers. The code is the source of truth, not the transcript. Then
  `validateBrief()` checks the brief against the manifest and open decisions, and the supervisor appends
  `session.rollover_started {briefHash}`, launches the successor with the brief as its opening context, retires the
  old session, and appends `session.rollover_completed`. Any problem appends `session.rollover_aborted {problems}`,
  and the old session keeps the thread.

## 15. Identity model

Identity is done properly before any non-CEO surface ships (§6, §15.3). Implemented by `mod-identity` (Built).

| Principal | Id | Authenticates with | Notes |
| --- | --- | --- | --- |
| Person | `usr_…` | A bearer user token (`aoc_u_…`), or a console cookie session (`aoc_session`, a `web_session` token opened from a user token; TTL `identity.sessionTtlHours`, 12 h) | Role `approver`, `builder` or `requester`, plus the flag `complianceLead`. Only a token's SHA-256 and a short non-secret prefix are stored (`token.issued`). Cookies are `HttpOnly` and `SameSite=Strict`, `Secure` when `publicUrl` is HTTPS, and cookie-authenticated writes must come from AOC's own origin |
| First Approver | — | A one-time bootstrap token from `AOC_BOOTSTRAP_TOKEN`, or generated into `identity.bootstrapTokenFile` (default `<dataDir>/bootstrap-token`, mode 0600; the path is logged, never the token) | Bootstrapping runs only while no user exists. Log in, create a personal token and a passkey, then revoke the bootstrap token and delete the file |
| Passkey | credential id hash | A WebAuthn assertion over a challenge that is the SHA-256 of a binding: user, decision, option, a hash of the card as shown, a nonce and an expiry | Required for `go_live`, `rollback` and `break_glass`. `passkey.asserted` keeps the signed assertion and its binding, so the approval can be re-verified independently later. The signature counter is tracked |
| Managed session | `ses_…` (actor kind `agent`) | A per-session ingest token (`aoc_i_…`) | Issued at launch and revoked when the session ends. **Visible to the model** (it is in the claude environment), so it is scoped to its own session and is append-only (threat model T-3) |
| Observer | — | An observer ingest token (`aoc_o_…`), issued by the Approver with a label and an expiry | Observed events only. It can never post managed events or block |
| System component | name (`supervisor`, `scheduler:fx`) | A system token (`aoc_s_…`) or in-process | Reactors and jobs act as `system` actors |

Identity data (names, emails, labels, passkey material) is stored in encrypted payloads under the per-person scope
`user:<userId>`, so erasing that scope crypto-shreds one person's identity data while the chain stays valid.

Permissions per role are in [`roles.ts`](../packages/contracts/src/roles.ts). In short:

- **Approver**: every permission except the Requester's own UAT sign-off and the compliance stamp.
- **Builder**: view all sessions and the full audit trail; launch and drive their own sessions; create change
  records and self-approve reversible ones; request top-ups, rollbacks, promotions and break-glass; curate
  learning; generate evidence; view internal tickets.
- **Requester**: submit an intake, view their own tickets, sign off their own UAT.
- `mapping.stamp` is granted only by the `complianceLead` flag (to an Approver or a Builder), never by a role (R3).
- Raw intake media stays behind the role boundary. Builders see it only while one of their own active sessions
  works on that ticket, and every access is logged (`intake.media_accessed`).

## 16. Security architecture in one page

The details are in the [threat model](security/threat-model.md). The load-bearing ideas:

1. **Credential isolation is the wall (§3, R1).** Deploy credentials and protected-branch rights exist only in
   supervisor-controlled session environments, only for process types that need them, and never on developer
   machines or in read-only sessions. GitHub branch protection enforces it server-side. Hooks, guards and
   pre-push hooks are speed bumps that turn attempts into decision cards.
2. **The agent can read everything in its own environment.** Hooks, the MCP server and the model's own Bash all
   inherit the `claude` process environment (research §8). Anything placed there, including the ingest token, is
   reachable by the model, and events relayed from hooks are **agent-asserted claims**. Gates rely on facts the
   agent cannot forge: git state checked by AOC, supervisor-observed process and stream state, and human decisions.
3. **Run agents as a separate, unprivileged OS user.** aocd's files (the KEK, `aoc.db`, credential profiles) are
   protected by file permissions, and file permissions protect nothing from a process running as the same user.
4. **Untrusted input is data.** Intake text and media, transcripts and tool output are fenced, escaped and never
   executed as instructions. Triage runs read-only (`--tools Read,Glob,Grep`, no credentials, `read-only` guard
   as defence in depth).
5. **Integrity is anchored off-host** (R2), and **keys have a custodian** (R6).

## 17. Self-modification boundary

The platform may build its own features, but never its own governance, audit or credit core (§13). A PreToolUse
guard blocks AOC-managed agents from editing the protected paths of AOC's own repository and records
`selfmod.blocked`. AOC self-changes are also logged outside AOC, and changes to the core require human code
review. See [docs/compliance/self-modification-boundary.md](compliance/self-modification-boundary.md). **This
repository was AI-built. Its governance core must have a human code review before go-live.**

## 18. ISO/IEC 42001 mapping status

- The 002 mapping table was wrong in at least five rows (§13, R3). The provisional corrected mapping is in
  [docs/compliance/iso42001-annex-a.md](compliance/iso42001-annex-a.md) and `config/iso42001-mapping.json`
  (version `2026.10-draft`, `status: provisional`, `stampedBy: null`). It was compiled from public secondary
  sources, **not** from the purchased standard.
- The five corrections to confirm: event logging is **A.6.2.8**; technical documentation is **A.6.2.7**; roles are
  **A.3.2**; incident communication is **A.8.4**; token and resource use is **A.4** (A.4.2 and A.4.5).
- Until the compliance lead stamps it (`mapping.stamped`), the mapping page must not be cited, and every evidence
  pack is labelled provisional (`evidence_pack.generated {mappingStamped: false}`).
- Open questions for the compliance lead (scope, 6.3 versus 8.1, A.3.3 reporting of concerns, A.5.4 and A.5.5
  impact assessments, retention versus erasure) are listed in section 6 of the mapping note.

## 19. Build sequence (§15)

Each stage needs CEO sign-off. Discovery-class stages run on Opus; work from the UI onward runs on Sonnet. A static
design mock of the three main pages ([`mocks/aoc-mock.html`](../mocks/README.md)) is approved before any UI code,
and the 3D Showcase tab is built last.

| Stage | Delivers | Packages | Sign-off evidence |
| --- | --- | --- | --- |
| **1. Operator console and supervisor engine** (discovery: Opus) | Launcher/supervisor; aocd as sole writer with ingest; MCP server; hooks; sidecar; append-only hash-chained SQLite (WAL) with the off-host anchor; liveness; plan manifest and measured progress; decisions with end-turn and resume; metering; the operator console after mock approval | `kernel`, `daemon`, `supervisor`, `sidecar`, `hooks`, `mcp-server`, `client`, `mod-sessions`, `mod-ledger`, `mod-decisions`, `mod-registry`, `mod-metering`, `mod-audit`, `web` | A managed session end to end on `claude-sim` and on real Claude Code; a decision answered after a daemon restart; Verify passing against an off-host anchor; a tamper drill detected |
| **2. Change control and rollback** (discovery: Opus) | Change requests with four fields; affirm-or-edit tracking; pinned refs; gated rollback with verification; break-glass with a post-incident record; promotion with the provenance guarantee | `mod-change`, `supervisor` (`runIsolated`) | A rollback drill on a pinned tag; a refused orphan-commit promotion; a break-glass drill |
| **3. Identity layer** (before any non-CEO surface) | Per-person users and roles; hashed tokens; cookie sessions; WebAuthn passkeys for go-live, rollback and break-glass; per-session ingest tokens | `mod-identity` | Passkey-signed go-live; revoked token rejected; SoD tests |
| **4. Developer role** on the operator surface | Builder permissions; self-approval of reversible off-main work; developer change records; per-developer affirm-without-edit rate; credits and top-ups | `web`, `cli`, `mod-credits`, `mod-learning` | Builder cannot resolve Approver gates; credit cap enforced only at a boundary |
| **5. End-user intake portal** (last: the heaviest auth and upload risk) | Intake with media limits, scanning and encryption; read-only triage; diagnosis budget; human reconciliation; fix-plan gate; UAT loop; go-live through promotion | `mod-intake`, `web` (portal) | Upload abuse tests; prompt-injection drill; PDPA erasure of a ticket |

FX, evidence packs and the learning registry are not sequenced explicitly in §15. They depend on stage 1 (events,
metering) and stage 2 (change records), and they are enabled once those stages are signed off.

The code base is built in parallel waves against one contract (Wave 0). **Stage order therefore governs
enablement, not coding order.** For example, `mod-intake` is already implemented, but the portal must stay
switched off until the identity stage is signed off (R5).

## 20. Implementation status and open items (2026-10-09)

Built and tested at commit `fb97e98`: contracts, kernel, client, `aocd`, the CLI, the hook binary and git hooks,
the sidecar, the MCP server, `claude-sim`, the LLM adapters, and the modules `mod-sessions`, `mod-ledger`,
`mod-decisions`, `mod-change`, `mod-identity`, `mod-metering`, `mod-fx`, `mod-credits`, `mod-learning`,
`mod-registry`, `mod-evidence` and `mod-intake`. In progress: the launcher/supervisor, `mod-audit` (anchoring,
Verify, erasure, the self-modification guard), `mod-tower`, the web UI (the static mock awaits CEO approval) and the
demo seeder. **Nothing has been independently reviewed yet** (§17).

Open items found while writing this document. Owners and details are in the [threat model](security/threat-model.md#6-requested-changes-and-open-decisions):

1. Agents can get code execution as a privileged user through git configuration and hooks in their own workspace,
   whenever aocd or the supervisor runs git or repository code there (threat model T-2). Today the ledger
   fingerprints workspaces with aocd's own git, and promotion deliberately runs the repository's `pre-push` hook
   with the promotion credential. Privileged git must never run in an agent-writable repository.
2. Agents and aocd must run as different OS users. Otherwise every 0600 file of aocd is readable by every agent.
3. The provenance gate trusts commit-message trailers, which anyone can copy (threat model T-22). Until it checks
   AOC's own records of session commits, it proves only what the commit messages claim.
4. Single-Approver deployments deadlock on separation of duties for Approver-level decisions raised from the
   Approver's own sessions, including a break-glass the Approver invokes.
5. `selfModification.aocRepoPaths` defaults to empty, which leaves the guard inert, and the default
   `protectedPaths` list omits governance-relevant packages (see the
   [self-modification boundary](compliance/self-modification-boundary.md)).
6. Default anchoring (`anchorProvider: git` with no `anchorRemote`) is local only and does not mitigate R2 until a
   remote is configured.
7. FX defaults differ from the BNM research recommendations (§11).

## Glossary

| Term | Meaning |
| --- | --- |
| Turn | One `claude -p` process run. A session is a chain of turns joined by `--resume` |
| Session | One Claude Code conversation (one `claudeSessionId`) under an AOC session id `ses_…` |
| Thread | The durable line of work in a project. It spans many sessions through rollover |
| Manifest | The declared plan: phases and sized tasks. It is the denominator of progress |
| Boundary | The moment between tasks (`task_done`, launch) when credits, rollover and stop requests are enforced |
| Scope (body) | The encryption-key scope of a body. Erasing a scope crypto-shreds all its bodies |
| KEK / DEK | Key-encryption key (master key) / data-encryption key (per scope and generation) |
| Card | A decision as shown in the inbox (`DecisionCard`) |
