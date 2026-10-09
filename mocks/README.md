# AOC static mock (AOC-SPEC-003 §12)

`aoc-mock.html` is the static mock of the three main pages that the CEO approves before any UI code is
written. It is one self-contained file: inline CSS, inline SVG, the Daythree wordmark as a data URI, and 37
lines of inline JS that only switch views. Open it in any browser; no server, fonts or network needed.

| View | URL | Hero |
| --- | --- | --- |
| Console | `aoc-mock.html#console` (default) | Small-multiple grid of per-session actions-per-minute sparklines |
| Session | `aoc-mock.html#session` | Timeline strip, with the stacked per-phase completion bar beneath it |
| Registry | `aoc-mock.html#registry` | Discovery-vs-execution cost-per-run paired bars plus an 8-week trend per process type |

All names, figures, tags and hashes are sample data for Daythree AI Labs Sdn Bhd (projects CX Copilot,
Claims Intake Bot, AOC Platform and QA Scorecard). "Now" is Fri 9 Oct 2026, 13:42 MYT. USD→MYR is
4.2150 (BNM, fetched live 09:05). Notional cost uses rate card v3 at current API list prices per million
tokens: Opus $4 in / $20 out, Sonnet $2 / $10 (cache read $0.20, cache write $2.50), Haiku $0.10 / $0.50
($0.01, $0.125). The figures agree across views: today's spend ($152.38) is the 9 active tiles plus the 5
"Ended today" rows, and the agent-assist tile equals the Session view's metering total.

## Design rationale

- **One token set.** The `<style>` block opens with `packages/web/src/design/tokens.css` copied byte for
  byte (checked by diff). Every colour in the page is a token; light and dark follow the OS, with no toggle.
- **Colour only where it means something.** Liveness, decisions (purple, the Daythree accent), the five
  timeline mark types, and the paired discovery/execution series. Everything else is neutral ink. Brand red
  appears only in the wordmark, because red means Dead or error in this console.
- **Type.** Source Sans 3 first, then system UI (screenshots fell back to Inter, which is wider, so the
  layout has headroom). 13px base, tabular numerals for live numbers, 20px view titles, 14px panel titles,
  12px captions. A single 32px hero figure sits on the Registry, the one view whose job is a business case.
- **Console.** A KPI strip, then the grid. Tiles sort by liveness precedence (Waiting on you › Throttled ›
  Dead › Stalled › Thinking › Working), so what needs a human is top-left. Every sparkline shares one
  0–15 APM scale and window. A flat line means the same thing on every tile, and it shows a stall
  before the 10-minute stall threshold flips the badge (see ocr-fields s3). The decisions rail lists oldest
  first, puts the recommendation in a tinted box, and keeps Approve/Reject on every card. "Ended today"
  accounts for the rest of today's spend.
- **Session.** Operator actions live in the header, so they come first on phones. Roll over is disabled
  and the reason is printed beside it, not hidden in a tooltip. The timeline covers this session, with
  phases to scale by elapsed time. Tool calls are drawn as one tick per minute, with height equal to that
  minute's count; 1,751 individual ticks would merge into a solid band. Gaps in the ticks line up with the
  decision waits and the throttle. The completion bar below it is the whole manifest, segment width equal
  to declared weight.
- **Registry.** The paired bars share one $0–40 scale and get most of the row width. The savings %
  is the largest number in each row, and the trend shows what retiring a playbook costs (docs, W39).
  Runs, lessons in scope and open repeat offences sit in one facts column. Model routing follows as a
  compact table, led by the rule that discovery runs on Opus and credits never override it.

## Legend

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
| Task meter | thin dark bar | Done ÷ declared weight (tasks weighted xs 1 · s 2 · m 3 · l 5 · xl 8). ETA shows only after 3 tasks |
| Context meter | thin bar with a tick at 70% | Share of the 1M-token window; turns amber with "rollover due" at or above the 70% tick |
| Phase band | grey block; current phase darker | Elapsed time in that phase, to scale |
| Tool-call ticks | grey columns | Calls per minute; empty where the session waited or was throttled |
| Decision | purple ◆ plus line | Request time; the line runs to the answer, so its length is the wait |
| Drift | amber ▼ | Work outside the declared task scope |
| Rollback | red ↺ | Reverted to a pinned state (audited change record) |
| Enhancement | teal ⊕ | Audited manifest amendment that added scope |
| Tag pinned | grey ⚑ | Phase completed and pinned a git tag (rollback target) |
| Throttled span | blue bar on the tick baseline | Plan-limit idle time |
| Now | black or white vertical line | Current time, right edge |
| Completion bar | one segment per phase | Width = declared weight; dark fill = done weight |
| `test` chip | outlined chip | Which decision test tripped: main, production, data, irreversible, ambiguity |
| `policy` chip | dashed chip | Approver-only gate with no decision test (credit top-up, lesson binding) |
| Passkey | key icon | Approval needs a WebAuthn passkey (go-live, rollback) |
| Evidence chip | grey chip: `test`, `commit` or `diff` plus ref | The evidence `task_done` carried |
| ⚑ Closed with no file change | amber flag under a task | No file-changing tool call between start and `task_done` |
| Audited amendment | grey row with ⊕ | Who, when, why, and the denominator change (28 → 29 tasks, 76 → 78 weight) |
| read-only, observed, Managed | chips with lock, eye, shield icons | Triage credentials; hooks-only session; launched under the supervisor |
| Discovery / execution bars | purple / teal | $/run on Opus vs the playbook model; values printed at the bar tips |
| Trend | grey line, end dot; hairline = playbook retired | Blended $/run per week, W34–W41 |
| Playbook status | ✓ approved by CEO · ✎ draft · archive box retired | Distilled playbook state |
| Repeat offences | ⚠ with count | Open root-cause classes (never per developer) |

## Accessibility notes

- **Contrast (WCAG AA, both themes, measured).** Body text runs 5.0–16.6:1. Attention badges use inverse
  text on the solid liveness colour (5.6–10.4:1). Healthy badges use ink text on the soft fill, because
  light `--live-working` on `--live-working-soft` is only 4.36:1. `--text-3` is kept to `--surface` and
  `--bg` (5.03 / 4.65:1); it measures 4.48:1 on `--surface-2`. Drift marks (3.19:1) and tool ticks
  (3.07:1) sit on `--surface`, never on the bands.
- **Never colour alone.** Each liveness state has a distinct silhouette plus its word. The paired series
  carry a legend, fixed order (discovery above execution) and a direct label on every bar.
- **Numbers as text.** Every chart prints its values and is `role="img"` with an `aria-label` and
  `<title>` holding the numbers. Meters carry `sr-only` text, and the timeline has a written summary.
- **Keyboard.** Skip link. The tabs follow the WAI-ARIA tabs pattern (←/→/Home/End, roving tabindex) and
  sync with `location.hash`, including the back button. Timeline marks are buttons whose details show on
  focus as well as hover. Manifest phases use `<details>`. Focus uses the `--focus` double ring.
- **Screen readers.** One `h1` per view. Tables have captions, scoped headers and explicit ARIA roles, so
  they keep their semantics when phones restyle them into cards.
- **Motion.** Nothing moves at rest (`document.getAnimations()` is 0). Hover and disclosure transitions use
  token durations, which collapse to 0 ms under `prefers-reduced-motion`.
- **Responsive.** 16px gutters. No horizontal page scroll at 360, 390, 768, 1024, 1280 or 1440px. The
  grid drops to one column, wide tables become stacked cards, and the dense tables (tasks, ledger,
  decisions, metering) get purpose-built two-line phone layouts. A `forced-colors` fallback outlines
  badges and fills.

## Token findings for the lead (tokens.css is unchanged)

Measured with the dataviz palette validator and WCAG contrast:

1. Light `--live-working` #17804a on `--live-working-soft` is 4.36:1, below 4.5 for small text.
   #167c48 reaches 4.59:1.
2. Light `--text-3` #66707d is 4.48:1 on `--surface-2` and 4.13:1 on `--surface-3`. #606976 clears
   4.5:1 on all three surfaces.
3. Paired series. Light `--series-2` chroma is 0.089, below the 0.10 floor; #00949a passes every check.
   In dark, both series sit above the lightness band (L 0.72 / 0.70) and their CVD separation is 7.5,
   in the warn band, which is legal only with secondary encoding (provided here). #8c79e0 / #00939a pass
   with ΔE 10.4.
4. Light `--mark-drift` is 2.84:1 on `--surface-2` (#d37306 reaches 3.01:1). The mock only places it on
   `--surface`.

## Decisions for the CEO to confirm

1. Liveness badges: solid for the four states that need a human, soft for Working and Thinking.
2. Console tiles ordered by liveness precedence rather than by project. APM means tool calls per minute,
   on a shared 0–15 scale, with a 10-minute stall threshold.
3. Approve applies the recommended option. Should other options be pickable on the card, and should
   Reject require a reason?
4. Credit top-ups and lesson bindings map to none of the five decision tests, so they show a `policy`
   chip. Is that right?
5. Passkey on go-live and rollback only (§6), or also on credit top-ups and break-glass?
6. Tasks flagged "closed with no file change" still count toward completion until reviewed. Count them
   or exclude them?
7. The session timeline covers the current session; earlier sessions appear in rollover history. Is
   that the right scope, rather than the whole thread?
8. Registry RM is the sum of daily rollups at each day's BNM rate (RM 13,861), not total × today's rate
   (RM 13,892).
9. On phones, should Decisions waiting come before the activity grid?
10. Developer names appear on session tiles (transparent team console, §6). Repeat offences are never
    attributed to a person (§11).

## Screenshots

`screenshots/<view>-<width>-<theme>.png`, full page, rendered by Chromium with `colorScheme` emulation:
`console`, `session` and `registry` at 1440×900 and 390×844, each in `light` and `dark` (12 files).
