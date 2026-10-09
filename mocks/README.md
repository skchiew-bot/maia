# AOC static mock (AOC-SPEC-003 §12)

`aoc-mock.html` is the static mock of the main pages that the CEO approves before any UI code is written.
It is one self-contained file: inline CSS, inline SVG, the Daythree wordmark as a data URI, and 38 lines
of inline JS that only switch views. Open it in any browser; no server, fonts or network needed.

| View | URL | Who lands here | Hero |
| --- | --- | --- | --- |
| Control Tower | `aoc-mock.html#tower` (default) | Approver (CEO) | Attention queue ranked by cost of delay, with inline actions |
| Console | `aoc-mock.html#console` | Builders | Small-multiple grid of per-session actions-per-minute sparklines |
| Session | `aoc-mock.html#session` | — | Timeline strip, with the stacked per-phase completion bar beneath it |
| Registry | `aoc-mock.html#registry` | — | Discovery-vs-execution cost-per-run paired bars plus an 8-week trend per process type |

The signed-in role in the mock is Approver, so a bare URL opens the Control Tower; a builder's bare URL
would open the Console. The Tower tab carries the "needs you" count (12).

All names, figures, tags and hashes are sample data for Daythree AI Labs Sdn Bhd (projects CX Copilot,
Claims Intake Bot, AOC Platform and QA Scorecard). "Now" is Fri 9 Oct 2026, 13:42 MYT. USD→MYR is
4.2150 (BNM, fetched live 09:05). Notional cost uses rate card v3 at current API list prices per million
tokens: Opus $4 in / $20 out, Sonnet $2 / $10 (cache read $0.20, cache write $2.50), Haiku $0.10 / $0.50
($0.01, $0.125).

The views agree with each other:
- Today's spend ($152.38) is the 9 Console tiles plus the 5 "Ended today" rows. The Tower's per-project
  and per-model splits sum to the same figure.
- The agent-assist tile equals the Session view's metering total.
- The Tower queue holds the same six decisions as the Console rail, plus six non-decision items.
- Fleet counts match the Console tiles.

The Tower follows the `TowerSnapshot` contract in `packages/contracts/src/dto/tower.ts`: attention kinds,
severities, `costOfDelay {score, basis}`, action kinds, funnel stages, and the seven anomaly signals.

## Design rationale

- **One token set.** The `<style>` block opens with `packages/web/src/design/tokens.css` copied byte for
  byte (checked by diff after the contrast fixes landed). Every colour in the page is a token; light and
  dark follow the OS, with no toggle.
- **Colour only where it means something.** Liveness, severity, decisions (purple, the Daythree accent),
  the five timeline mark types, and the paired discovery/execution series. Everything else is neutral ink.
  Brand red appears only in the wordmark, because red means Dead, critical or error in this console.
- **Type.** Source Sans 3 first, then system UI (screenshots fell back to Inter, which is wider, so the
  layout has headroom). 13px base, tabular numerals for live numbers, 20px view titles, 14px panel titles,
  12px captions.
- **Control Tower.** It answers "where is the operation at risk and what needs me, across every
  project", so it is built exception-first. Top to bottom:
  1. A one-sentence summary and five KPIs (needs you, flow vs baseline, gate latency vs SLA, customer
     waiting, integrity).
  2. The attention queue, about 60% of the width.
  3. The fleet-health rail beside it.
  4. Three flow charts: tasks per hour, ticket funnel, decision latency.
  5. Spend and capacity.
  6. The integrity and governance strip.
  7. The gaming and anomaly radar.

  The queue is **ranked by cost of delay, not age**: the 47-minute rollover for an open incident is #1,
  while the 3-day-old ticket is #5. Every row prints its score basis in words
  ("Rollback gate · 47m · INC-0093 open, about 38 duplicate claims an hour") and has its action inline
  (Approve with passkey, Approve, Restart, Nudge, Open). The lowest-cost item folds behind a
  `<details>`, so the list stays scannable. The anomaly radar is portfolio-level only. Its scopes are
  the portfolio, a process type or a project, never a person (R11); developer names appear only in the
  credit-cap forecast, which is capacity planning.
- **Console.** A KPI strip, then the grid. Tiles sort by liveness precedence (Waiting on you › Throttled ›
  Dead › Stalled › Thinking › Working). Every sparkline shares one 0–15 APM scale and window. A flat line
  means the same thing on every tile, and it shows a stall before the 10-minute stall threshold flips the
  badge (see ocr-fields s3). The decisions rail lists oldest first, puts the recommendation in a tinted
  box, and keeps Approve/Reject on every card. "Ended today" accounts for the rest of today's spend.
- **Session.** Operator actions live in the header, so they come first on phones. Roll over is disabled
  and the reason is printed beside it. The timeline covers this session, with phases to scale by elapsed
  time. Tool calls are drawn as one tick per minute, with height equal to that minute's count; gaps line
  up with the decision waits and the throttle. The completion bar below it covers the whole manifest.
- **Registry.** The paired bars share one $0–40 scale and get most of the row width. The savings % is the
  largest number in each row, and the trend shows what retiring a playbook costs (docs, W39). Model
  routing follows, led by the rule that discovery runs on Opus and credits never override it.
- **Contract alignment.** Only `main`, `production` and `data` tests bounce to the Approver, and only
  go-live, rollback and break-glass need a passkey. The NRIC-masking decision is therefore a `data` test
  in the CEO's queue. The session's `irreversible` and `ambiguity` decisions were answered by the builder.

## Legend

### Control Tower

| Mark | Looks like | Meaning |
| --- | --- | --- |
| Severity | ❗ octagon Critical (red), ⚠ triangle High (amber), ⊖ Medium, ○ Low, plus a matching left stripe on the row | Mock bands on the score: ≥75 critical, 50–74 high, 25–49 medium, <25 low |
| Cost-of-delay bar | grey bar plus number, 0–100 | Rank key: customer impact + blocked work + idle spend + audit exposure, rising with age |
| Score basis | 12px line under the title | Kind · age · what the delay is blocking |
| Liveness mix | one stacked bar in the liveness colours, counts inside | Live sessions by state; the same badges form the legend |
| Fleet small multiples | six grey column charts, latest bucket darkest, shared 0–10 scale | Sessions per state in 5-minute buckets over 2 hours |
| Stall rate | bar with a black marker | Today's rate against the 7-day average (marker), scale 0–25% |
| Throttle strip | blue spans on a 07:00–14:00 line, black tick at now | When plan limits idled sessions today |
| Rollover pressure | context meters with a tick at 60% | Live sessions above 60% of their window |
| Tasks per hour | grey = verified evidence, amber = flagged close, black line = 7-day same-hour baseline | Flow; the 13:00 bar is still filling |
| Ticket funnel | grey bars per stage; amber row with "work waits here" | Open tickets per stage with median and oldest age; the bottleneck stage is highlighted |
| Decision latency | dark bar to p50, whisker to p90, red line at SLA | Each kind scaled to its own SLA (0 to 2× SLA), so every SLA line sits in the same place |
| Spend bullet | dark bar with a black marker | Today against the 7-day average |
| Model mix | dark / mid / light grey segments | Opus / Sonnet / Haiku share of today's spend (ordinal, darkest = highest tier) |
| Discovery vs execution | purple / teal segments | Runs in 7 days (same series colours as the Registry) |
| Credit runway | bar from today to the projected cap date; black line at 31 Oct; amber if it ends first | Who runs out of credits before the period ends at today's burn |
| Integrity cells | ✓ ok, ⚠ needs action, ⓘ informational | Chain vs anchor, break-glass, post-incident, provenance, self-modification, ISO mapping, projections |
| Radar bars | value indexed to its baseline on a shared 0–3× scale; black marker = baseline; arrowhead = off scale | Grey normal, amber watch, red alert; status uses per-signal thresholds, not the ratio alone |

### Console, Session and Registry

| Mark | Looks like | Meaning |
| --- | --- | --- |
| Waiting on you | solid purple pill, ◆ diamond | Session ended its turn on a human-required decision; the pill shows the decision's age |
| Throttled | solid blue pill, hourglass | Plan limit hit; shows the reset time. Idle minutes are metered |
| Dead | solid red pill, ⊗ | Process gone or heartbeat lost; its sparkline ends in a red × |
| Stalled | solid amber pill, ⚠ | Process alive but no tool calls or tokens beyond the stall threshold |
| Thinking | soft grey pill, ⋯ | Model is generating; neutral on purpose, never amber |
| Working | soft green pill, ▶ | Tool activity within the last minute |
| Solid vs soft pill | — | Solid means a human should look; soft means healthy. Text is never the only cue |
| Alive dot | green dot beside the badge | Heartbeats are arriving. Static at rest; the app adds `.is-event` once per activity event for a single 600 ms ring. It never pulses steadily, because a stalled session would pulse too |
| APM sparkline | grey line, 10% area, end dot | Tool calls per minute, last 30 min, shared 0–15 scale; the number on the right is the current minute |
| Task meter | thin dark bar | Done ÷ declared weight (xs 1 · s 2 · m 3 · l 5 · xl 8). ETA shows only after 3 tasks |
| Context meter | thin bar with a tick at 70% | Share of the 1M-token window; amber with "rollover due" at or above the tick |
| Phase band | grey block; current phase darker | Elapsed time in that phase, to scale |
| Tool-call ticks | grey columns | Calls per minute; empty where the session waited or was throttled |
| Decision | purple ◆ plus line | Request time; the line runs to the answer, so its length is the wait |
| Drift / Rollback / Enhancement / Tag | amber ▼ / red ↺ / teal ⊕ / grey ⚑ | Out-of-scope work / reverted to a pinned state / audited scope addition / phase tag pinned |
| Throttled span, Now | blue bar on the tick baseline, vertical line | Plan-limit idle time; current time |
| Completion bar | one segment per phase | Width = declared weight; dark fill = done weight |
| `test` chip / `policy` chip | outlined / dashed | Which decision test tripped / approver-only gate with no test (credit top-up, lesson binding) |
| Passkey | key icon | WebAuthn passkey required (go-live, rollback, break-glass) |
| Evidence chip, ⚑ flag | `test` / `commit` / `diff` + ref; amber flag | Evidence carried by `task_done`; closed with no file-changing tool call |
| Audited amendment | grey row with ⊕ | Who, when, why, and the denominator change (28 → 29 tasks, 76 → 78 weight) |
| Discovery / execution bars | purple / teal | $/run on Opus vs the playbook model; values at the bar tips |
| Playbook status | ✓ approved by CEO · ✎ draft · archive box retired | Distilled playbook state |

## Accessibility notes

- **Contrast (WCAG AA, both themes, measured).** Body text 5.6–16.6:1 against the updated tokens.
  Attention badges and the liveness mix use inverse text on the solid liveness colours (5.2–10.4:1).
  Healthy badges use ink text on soft fills. Muted text stays on `--surface`/`--bg`. Marks clear 3:1
  against the surface they sit on.
- **Never colour alone.** Liveness, severity and signal status each pair a distinct icon silhouette
  with a word. Charts with several series have a legend plus direct labels. The bottleneck stage says
  "work waits here", and red/amber bars always have printed values.
- **Numbers as text.** Every chart prints its values and is `role="img"` with an `aria-label` (and
  `<title>` on SVG) holding the numbers. The Tower summary sentence carries the headline numbers.
- **Keyboard.** Skip link. The tabs follow the WAI-ARIA tabs pattern (←/→/Home/End, roving tabindex) and
  sync with `location.hash`, including the back button. Timeline marks show details on focus. Manifest
  phases and the folded queue item use `<details>`. Focus uses the `--focus` double ring.
- **Screen readers.** One `h1` per view. Queue rows announce their rank. Tables have captions, scoped
  headers and explicit ARIA roles, so they keep their semantics when phones restyle them as cards.
- **Motion.** Nothing moves at rest (`document.getAnimations()` is 0). Hover and disclosure transitions use
  token durations, which collapse to 0 ms under `prefers-reduced-motion`.
- **Responsive.** 16px gutters. No horizontal page scroll at 360, 390, 768, 1024, 1280, 1300, 1366 or
  1440px in any view. Grids drop to one column; the queue moves score and action under each row; wide
  tables become cards or purpose-built two-line phone layouts. A `forced-colors` fallback outlines
  badges and fills.

## Tokens

The four contrast fixes from the first review are in `tokens.css` (commit 8ea3611) and re-embedded:
`--live-working` #167c48, `--text-3` #606976, light `--series-2` #00949a, and dark `--series-1` #8c79e0 /
`--series-2` #00939a. One known limit remains: light `--mark-drift` (#d97706) is only 2.84:1 on
`--surface-2`, so drift marks are only placed on `--surface`.

## Approval

**Approved by the CEO (Chiew Sin Kwang) on 2026-10-09**, as shown, including the defaults proposed in the nine
decisions below. Confirmed separately the same day: the stall threshold is 10 minutes, and the sole-Approver
fallback is off (`decisions.soleApproverFallback: false`). The live pages are built to this mock.

## Decisions for the CEO to confirm (accepted as proposed, 2026-10-09)

1. **Cost-of-delay score.** Customer impact, blocked work, idle spend and audit exposure, rising with
   age. Severity bands are at 75/50/25. Are these the right weights and cut-offs?
2. **What counts as "needs you".** The queue includes items another human could clear (stalled
   session, FX review, ticket waiting on a requester), because the Approver can act on all of them
   inline. Should it show only the Approver's own gates?
3. **Decision SLAs.** Rollback 30m, agent decision 1h, credit top-up 1h, go-live 2h, fix plan 4h,
   lesson binding 2 days. These drive breaches and the gate-latency KPI.
4. **Credit forecast.** It names developers (capacity planning, never ranked), while the anomaly radar
   stays portfolio-only. Is that the right line?
5. **Liveness badges.** Solid for the four states that need a human; soft for Working and Thinking.
6. **Console ordering.** Tiles ordered by liveness precedence. APM means tool calls per minute, on a
   0–15 scale, with a 10-minute stall threshold.
7. **Approve semantics.** Approve applies the recommended option. Should other options be pickable inline,
   and should Reject require a reason?
8. **Flagged tasks.** Tasks flagged "closed with no file change" still count toward completion until
   reviewed.
9. **RM rollups.** Registry RM is the sum of daily rollups at each day's BNM rate (RM 13,861), not
   total × today's rate.

## Screenshots

`screenshots/<view>-<width>-<theme>.png`, full page, rendered by Chromium with `colorScheme` emulation:
`tower`, `console`, `session` and `registry` at 1440×900 and 390×844, each in `light` and `dark` (16 files).
