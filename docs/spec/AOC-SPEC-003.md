# AOC-SPEC-003 — Agent Ops Console Requirements Spec

Oct 9, 2026 · @Chiew Sin Kwang

Supersedes AOC-SPEC-002 where the two differ. Reframes the console from a session monitor into a multi-user project lifecycle platform, incorporating the architecture corrections, infographic-first visual direction, change-control model, three-role access model, metering, error-learning system, and the expert-council roadmap agreed in review.

## 1. What changed from 002, and why

002 treated a *session* as the unit of work. 003 treats the *project* as the unit — a project lives across many sessions over weeks; sessions are disposable episodes under a durable project thread. The console is a build ledger: only build activity (plan declared, task done with evidence, phase complete, decision, drift, enhancement, rollback) is first-class. Pure inquiry and Q&A is logged but never surfaces as progress. The console now serves three roles across two surfaces (§6) and adds change control, metering, and a shared error-learning system.

## 2. Architecture corrections (mandatory — 002's mechanisms do not work as written)

Four mechanisms in 002 cannot work on Claude Code as specified. Each correction is binding.

1. **Heartbeats cannot come from hooks.** Hooks fire on events, not on a clock, and nothing fires while the model is generating — exactly when Thinking vs Stalled matters. Fix: a per-session sidecar, started by the launcher, emits heartbeats from the process itself and tails the session transcript (which also yields per-turn token usage for metering).
2. **Model routing cannot read the manifest.** The model is fixed at launch; the manifest is written afterward. Fix: the process type is declared at launch (aoc run --type) from a fixed registry list — this also closes the gaming path where an agent names its own type to obtain Opus.
3. **"Waits indefinitely" cannot mean a live idle process** (hook timeouts, sleep, and plan limits kill it). Fix: on a human-required decision the session ends its turn cleanly; the supervisor resumes it via --resume with the answer injected. Waiting then costs nothing and survives reboots. The same supervisor powers Restart and Nudge (Nudge = end turn, resume with operator text).
4. **Hooks cannot inspect reasoning ("decision events").** Tests 1, 2, 5 are enforceable at the tool boundary; tests 3, 4 are self-reported. Command pattern-matching is only a speed bump (bash -c, scripts, Make targets bypass it). Fix: the real wall is credential isolation — keep deploy keys and protected-branch push rights out of session environments; branch protection and pre-push hooks do the gating; the hook's job is to turn an attempt into a decision card.

Resulting components: a launcher/supervisor, an AOC MCP server (the agent's structured voice: declare\_plan, task\_done(task\_id, evidence), request\_decision(test, options, recommendation), playbook\_step(step, state) — all schema-validated, no free-text parsing), hooks (observe and enforce), and the per-session sidecar.

Session classes: *Managed* sessions are launched via aoc with full control; *Observed* sessions use global hooks, are read-only, and buffer locally if the backend is down. "Fail loudly" applies to managed sessions, not to all Claude Code on the host.

## 3. Credential isolation — the unanimous make-or-break

Every control in this spec (gates, provenance, metering, audit, the master timeline) depends on work being unable to bypass the platform. If developers hold deploy keys or can push to main from their own terminals, every control is advisory and the audit trail and metering have holes. **Deploy credentials and protected-branch rights live only in supervisor-controlled session environments, never on developer machines.** This is the single highest-priority integrity requirement, and every expert in the review arrived at it independently.

## 4. Liveness, progress, and state precedence

Liveness is derived from instrumented events, never from the UI animating on its own. States: Working; Thinking (neutral, not amber); Stalled; Dead; Throttled (plan-limit hit, shows reset time); Waiting on you. **Precedence: Waiting on you > Throttled > Dead > Stalled > Thinking > Working.**

Progress is measured, not estimated: tasks done over tasks declared, from a plan manifest written at session start (a session without one is blocked). Each task-done event must carry evidence (a test id, commit, or diff); tasks closed with no file-changing tool call are flagged. Tasks are weighted by declared size, and ETA is hidden until at least three tasks are done. Manifest amendments are audited events that visibly update the denominator.

## 5. Project thread & context rollover

A durable project thread persists across many clean-context Claude Code sessions. When context grows large, the supervisor distills state (manifest status, key decisions and their reasons, file pointers) into a compact handoff brief and launches a fresh session seeded with it — the code is the source of truth, not the transcript. One active writer session per thread; rollover is sequential, never parallel writers on the same code. Rollover is an audited event, occurs only at clean task boundaries (never mid-migration or mid-deploy), and the brief is validated against the manifest and open decisions before the old session retires. Parallel agents are permitted only for read-only bug triage (§7).

## 6. Three-role, two-surface access model

One engine, one audit log, a proper per-person identity layer underneath all of it.

- **Approver (CEO)** — holds the gates: fix-plan sign-off, go-live, rollback, playbook approval, credit top-ups.
- **Builder (developers)** — drive the platform like Claude Code via the operator surface. Self-approve reversible, off-main work; anything touching main, production, or data bounces to the CEO. Every developer action is a change record in the audit log under that developer's name.
- **Requester (end users)** — file bugs with video, image, and comment via the intake portal; test on UAT.

Visibility: developers see the full audit trail and all sessions (a transparent team console). End-user portal data (raw uploads, personal data) stays behind the role boundary — developers see the ticket that spawned the work, not the raw media unless their session needs it.

Identity is done properly before any non-CEO surface ships. A shared bearer token proves which token, not who — call it attribution in v1; a per-decision passkey (WebAuthn) for go-live and rollback is the path to real signed approval. Repeat or escalated requests never route back to the requester (separation of duties).

## 7. End-user intake portal (built last)

A user submits an intake (description, video, image, comment, severity), which becomes a ticket that spawns managed session(s). Those sessions diagnose read-only first, root-cause, and propose a fix. Nothing touches code until the fix plan clears a gate. Then: build, push to UAT, user tests and signs off, and promotion to main is a human-required decision under the CEO's name. That is two human gates on the user path (fix-plan, go-live) plus the user's own UAT sign-off.

Risks (mitigations binding): this breaks the localhost single-user assumption (needs real auth, roles, isolation); uploads are an attack and PDPA surface (size and type limits, malware scan, encrypted body store, hashes-only in the audit chain); user text and media are untrusted input to agents (triage agents run read-only with no deploy credentials); vague tickets need a diagnosis budget and must bounce low-confidence root causes to a human. The user sees abstracted status only ("being worked on / ready for your testing / completed") — never internal gate names, the approver's identity, queue depth, or an implied timeline.

## 8. Change control & rollback

Every post-MVP change is a change request — a first-class, human-required decision that cannot start until all four fields are supplied and approved: impact analysis, mitigation plan, rollback plan (naming the exact commit or tag to return to), and acceptance test. Developer self-approval of reversible off-main work still produces a full change record. This maps to ISO 42001 change management.

Rollback is real, not a form: every phase completion and change record pins an immutable git tag or SHA. Rollback is itself a human-required, audited decision. Execution is gated — the dashboard issues the rollback; the supervisor checks out the tag on a new branch, runs that state's acceptance tests, and reports back before anything touches main; the CEO approves once it is shown clean. No one-tap phone rollback onto the main line.

**Break-glass emergency path (council requirement):** emergency promotion is permitted when production is down, but it is the most heavily audited event in the system, auto-raises a mandatory post-incident change record within 24 hours, and routes straight to the CEO. A controlled exception beats a rule bypassed in a crisis.

## 9. Master project timeline

The project's plan manifest is the single master timeline. Developer work declares its project and phase at launch so new tasks land in the right place; adding tasks is an audited manifest amendment under that developer's name, so there is no silent scope creep. Overall completion is tasks done over tasks declared across all developers, shown as a stacked per-phase segment bar (infographic-first, §12). Honesty depends on the per-task evidence rule (§4) — without it the shared timeline inflates with whoever declares the most tasks.

## 10. Metering, credits & FX

**Metering (internal decision-support, not billing).** Capture, per actor, task, project, and model: input, output, cache-read, and cache-write tokens, plus a notional API-equivalent cost — explicitly labelled as such, since on a Max plan there is no per-token bill. The synthetic cost supports a future Claude Enterprise migration decision; subscription cost is shown separately. Also meter plan-limit hits and the resulting idle time, because the enterprise case is productivity lost to throttling, not just dollars. Metering is read-only and fully separate from the credit system — it observes, it never gates.

**Rate card & FX.** A generic, adjustable rate card. FX via a daily Haiku scrape of the BNM site; escalate once to Sonnet on failed self-validation, then stop and carry forward yesterday's rate (flagged). Changing a rate applies forward only — it never restates closed days. Each day's rate is stamped as fetched-live or inherited (with source date). Weekend and holiday gaps carry forward by design. Sanity-bound each fetched rate and reject out-of-band values. "Can't read source" means carry forward; "read but mismatched against the true BNM published figure" (e.g. scraped 4.10 vs BNM 4.15) means re-fetch once, and if still unreconciled raise a discrepancy ticket as an audited, human-reviewed decision carrying both the original confirmed figure and the conflicting one. After N consecutive carried-forward days, notify for a manual check. Daily USD and RM rollups, auditable.

**Credits (behaviour control).** A hard cap, but never terminate a session mid-task — enforce only at task boundaries. The first time a developer hits the cap, the platform auto-grants up to 25% of the original allocation, once per period (AI-approved). Any further need that period is a button-raised request to a human approver (never the requester themselves) — no compounding, no AI repeat grants. All grants and top-ups are audited events (who, how much, against what task, balance before and after); the CEO tops up. Waiting top-up requests show as their own aging state, not a stall. Credits meter cost; they never pick the model — the discovery-runs-on-Opus rule overrides budget.

## 11. Error-learning & repeat-offence detection

**Distilled lessons registry (not a raw error log).** An error earns a lesson only when it is a repeatable class with a stated fix (the same distillation engine as playbooks); transient errors are logged and forgotten. A lesson is a human-required decision before it becomes binding, because one bad lesson corrupts the fleet. Lessons are scoped (to a process type or code area, not global) and retired when unused for N runs — a growing global rulebook poisons speed and tokens. Each lesson tracks repeats-prevented and tokens/time saved; UAT failures feed in with priority.

**Repeat-offence detection.** Cluster on root cause, not error text (the same cause surfaces with different symptoms). A repeat offence is a tracked object with a lifecycle: detected, root-caused, fix applied, then verified closed (no recurrence over a defined window). Prioritise by cost of recurrence, not count — zero-repeats is the wrong target. The dashboard shows a recurrence trend per root-cause class. Root cause may point outward — an ambiguous spec, a confusing codebase, a missing guardrail — and often should; the agent is frequently the symptom. Never used as per-developer or per-user blame data, or error reporting goes dark.

**Model as a tested root-cause dimension.** Using metered per-task model data, only call a repeat "model-capability" if the class recurs on the cheap model but not the stronger one — then the fix is a targeted per-process-type upgrade (not a blanket one), which also feeds distillation economics. If it recurs on both models, the root cause is spec, context, or tooling, not the model.

## 12. Visual design — infographic-first

Data-visualisation is the default language wherever performance, progress, or measurement is shown (not garnish); text where it is genuinely needed. Every mark is event-driven — if a shape moves, an event moved it; no idle animation.

- **Session hero:** the timeline strip — phases as bands to scale by elapsed time, tool-call ticks, decision diamonds, amber drift marks — with the stacked per-phase completion bar beneath.
- **Console hero:** a small-multiple grid of per-agent actions-per-minute sparklines (a flat line reveals a stall before any badge).
- **Registry hero:** discovery-vs-execution cost-per-run paired bars plus a trend sparkline per process type — the distillation business case, sized large and shown first.

Guardrails: liveness stays a badge (colour, icon, and a word, never a chart — a glanceable state must not need interpreting); every chart carries its underlying number as text (phone, screen reader, WCAG AA); dark and light themes from one token set following the OS setting (no manual toggle in v1); reduced-motion collapses every transition to an instant change; the heartbeat drives a static "alive" indicator (pulse on activity only, never a steady pulse a stalled session would also show). 3D is rejected for the operational console; it is allowed only as an optional Showcase tab, 2D by default, built last, never the landing view. A static mock of the three main pages is approved by the CEO before any UI code.

## 13. Audit trail & ISO 42001

One append-only, hash-chained event log is both what the CEO sees and what the auditor sees. Store only payload hashes and metadata in the chain; bodies (file contents, discovery captures) go in a separate per-session encrypted store — so a slipped secret or PDPA data can be erased by destroying the key while the chain stays valid. Audit liveness state *changes*, not raw heartbeats (otherwise about 17,000 rows per session per day). Anchor the nightly chain-head hash off-host (a signed commit to a separate repo, or an RFC 3161 timestamp) — the in-file hash chain alone is defeatable by anyone who can drop the trigger and recompute, so Verify must test against the external anchor.

The ISO 42001 clause numbers in 002's mapping table are wrong in at least five rows — the compliance lead must correct them against ISO/IEC 42001:2023 before the mapping page is built or cited. Known corrections to confirm: event logging A.6.2.8 (not A.6.2.6); technical documentation A.6.2.7 (not change management); roles A.3.2 (A.5 is impact assessment); incident communication A.8.4 (A.8.3 is external reporting); token and resource use A.4 (not A.7).

**Self-modification boundary (council requirement):** the platform may build its own features via its own distillation engine, but never its own governance, audit, or credit core — those stay human-built and human-changed, and any AOC self-change is audited outside AOC. The system must not mark its own homework.

## 14. Council roadmap features (accepted, stress-tested)

- **Frozen, ISO-mapped audit evidence pack** — one button produces a hash-verified, date-ranged, control-mapped evidence bundle, frozen as a dated artifact with rate and mapping versions embedded and a "mapping reviewed by compliance lead on X" stamp (provisional until stamped). Highest strategic value given certification and a public responsible-AI profile.
- **Provenance guarantee** — no orphan commits to main; the platform can prove any production line traces through an approved change record, a UAT sign-off, and a gate, else it refuses to promote (break-glass, §8, is the sole exception).
- **Invisible governance with accountability** — AI drafts the change-record fields; the developer must actively edit or affirm each; blind one-click confirm is itself flagged. Track per-developer affirm-without-edit rate.
- **Cost-per-outcome** — spend tied to the bug fixed or feature shipped, as a portfolio lens only, never individual ranking (ranking corrupts behaviour toward cheap, easy wins).
- **Migration recommender** — models notional spend plus throttle-loss against Claude Enterprise pricing as a range with exposed assumptions and sensitivity, never a single crossover number.
- **Team knowledge layer** — resolved bugs and distilled playbooks become searchable institutional memory.

## 15. Build sequence (per-stage CEO sign-off; discovery-class stages on Opus)

1. **Operator console and supervisor engine** — launcher/supervisor, ingest daemon (the sole writer, since concurrent hooks would fork the hash chain), MCP server, hooks, sidecar, append-only hash-chained SQLite (WAL) with the off-host anchor. Stages 1–2 are discovery-class: use Opus; Sonnet from the UI onward.
2. **Change control and rollback** (gated execution, break-glass).
3. **Identity layer** (before any non-CEO surface).
4. **Developer role** on the operator surface.
5. **End-user intake portal** last (heaviest auth and upload risk).

A static design mock is approved before any UI code. The Showcase tab is built last.

## 16. Risk register

| # | Risk | Severity | Mitigation | Owner |
| --- | --- | --- | --- | --- |
| R1 | Work bypasses the platform (laptop pushes, held deploy keys) — every control advisory, audit and metering holes | Critical | Credential isolation; branch protection; observed-session hooks | CEO / Platform Architect |
| R2 | In-file hash chain defeatable (drop trigger, recompute) | High | Off-host anchor (signed commit / RFC 3161); Verify tests against anchor | Platform Architect |
| R3 | ISO 42001 clause mapping wrong in ≥5 rows | High | Compliance lead corrects vs 42001:2023 before the page is built or cited | Compliance lead |
| R4 | Intake uploads = attack and PDPA surface; untrusted input to code-touching agents | High | Encrypted body store, hashes-only in chain, scan and limits; read-only triage agents, no deploy creds | CEO / CX lead |
| R5 | Scope sprawl — broad shallow build with weak auth bolted on | High | Resequencing (§15); identity before any non-CEO surface; per-stage sign-off | CEO |
| R6 | Audit log / encrypted keys = single point of total data loss | High | Off-host backup; defined key custody before real data lands | Platform Architect |
| R7 | Credit hard cap kills a session mid-task — corrupt build | Medium | Enforce at task boundaries only; 25%-once buffer | CEO / FinOps |
| R8 | Credits push team to the cheap model on work needing Opus | Medium | Credits meter cost only; discovery-on-Opus rule overrides budget | FinOps |
| R9 | Shared timeline inflates without per-task evidence | Medium | Enforce evidence per task; flag no-file-change closes | Platform Architect |
| R10 | Lessons rulebook grows unbounded — slower, costlier agents | Medium | Scope and retire lessons; track payoff; prune | DevEx lead |
| R11 | Repeat-detection becomes per-person blame — reporting goes dark | Medium | Root-cause classes only, never individual ranking | CEO / Governance |
| R12 | Change restated when a generic rate edit reaches back into closed days | Medium | Rate changes apply forward only | FinOps |
| R13 | BNM scrape fragility / bad parse writes a garbage rate | Low | Sanity-bound; Haiku→Sonnet once then carry forward; discrepancy ticket on confirmed mismatch | FinOps |
| R14 | Self-build quietly corrupts governance/audit core | High | Self-modification boundary; AOC self-changes audited outside AOC | CEO / Governance |
| R15 | Indefinite decision waits = silent stalls throttling the whole system | Medium | Decision age on every card; in-page notification and tab badge; opt-in webhook | Platform Architect |
| R16 | Context rollover mid-risky-op loses a constraint | Medium | Roll over only at clean boundaries; validate brief vs manifest first | Platform Architect |
| R17 | Parallel triage agents disagree with no resolution path | Medium | Defined reconciliation to a human decision | Platform Architect |

*Approved for build by Chiew Sin Kwang, CEO, Daythree AI Labs Sdn Bhd.*
