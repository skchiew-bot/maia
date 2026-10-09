# 0011. An infographic-first UI that always shows numbers as text

- Status: Accepted
- Date: 2026-10-09
- Deciders: CEO (visual direction, §12). The static mock was approved by the CEO on 2026-10-09, as shown, with its
  proposed defaults ([`mocks/README.md`](../../mocks/README.md))
- Spec: AOC-SPEC-003 §12

## Context

- Data visualisation is the default language wherever performance, progress or measurement is shown: not garnish,
  and text only where it is genuinely needed (§12).
- An ops console that animates on its own lies. A steady pulse looks the same on a stalled session as on a working
  one. Every mark must be event-driven: if a shape moves, an event moved it.
- People read the console on phones and with screen readers, and it must meet WCAG AA.
- Liveness is a glanceable state. It must not need interpreting.

## Decision

1. **Heroes.**
   - Session: a timeline strip with phases as bands scaled to elapsed time, tool-call ticks, decision diamonds and
     amber drift marks, plus the stacked per-phase completion bar beneath it.
   - Console: a small-multiple grid of per-agent actions-per-minute sparklines. A flat line reveals a stall before
     any badge does.
   - Registry: discovery-versus-execution cost per run as paired bars, plus a trend sparkline per process type.
     This is the distillation business case, sized large and shown first.
2. **Numbers as text.** Every chart renders its underlying numbers as text, visible next to the mark and in its
   accessible name. Nothing is shown only as a colour or a length.
3. **Liveness is a badge,** never a chart: colour, icon and a word. Thinking is neutral, not amber.
4. **No idle animation.** Marks move only when an event moves them. The heartbeat drives a static "alive"
   indicator that pulses only on activity. `prefers-reduced-motion` turns every transition into an instant change.
5. **One token set** (`packages/web/src/design/tokens.css`) for light and dark, following the OS. There is no manual
   toggle in v1. Brand red is reserved for the wordmark, because red means Dead or error in an ops console.
6. Compact and high-density, keyboard accessible, WCAG AA, working at 360 px wide. 3D is rejected for the
   operational console. It is allowed only as an optional Showcase tab, 2D by default, built last, and never the
   landing view.

## Consequences

- **Good:** state can be read at a glance and the numbers can be checked. The UI cannot fake activity. It is
  accessible. Charts double as evidence, because the figure is right there.
- **Bad:** more design and test effort per view (both themes, reduced motion, 360 px, screen-reader names). The
  rendering pipeline must be event-driven (SSE headers lead to targeted refetches). Small multiples need shared
  scales so they are not misread.
- The static mock had to be approved before UI code started (§12, §15). The CEO approved it on 2026-10-09 with its
  proposed defaults: solid badges for the four states that need a human and soft badges for Working and Thinking;
  console tiles ordered by liveness precedence; APM as tool calls per minute on a 0 to 15 scale; a 10-minute stall
  threshold; a cost-of-delay ranking in the Control Tower; and a credit forecast that names developers for capacity
  planning, while the anomaly radar stays portfolio-only.

## Implementation status (integration commit `e97e53e`)

The console and the portal are built to the approved mock, with one token set for light and dark. The accessibility
gate (axe, keyboard paths, 360 px, and the WCAG AA contrast of every token pair in both themes) passed when it was last
run; its report names the commit ([`a11y/report.md`](../../packages/web/test/a11y/report.md)). The Showcase is a live 2D
map of the fleet at `/showcase`, driven only by events; there is no 3D view.

## Alternatives rejected

| Alternative | Why rejected |
| --- | --- |
| A table-first console | Slow to read at a glance; hides stalls |
| Animated dashboards or steady pulses | A stalled session would look alive; animation without events is a lie |
| Liveness as a chart | A glanceable state must not need interpreting |
| 3D as the default view | Rejected by the spec for operations; allowed only in the Showcase tab |
| A manual theme toggle | Out of scope for v1; one token set follows the OS |

## References

- `packages/web/src/design/tokens.css`, `packages/contracts/src/dto/sessions.ts` (`ApmSeries`),
  `packages/contracts/src/dto/ledger.ts` (`SessionTimeline`, `ProjectTimeline`)
- [architecture.md §6, §7](../architecture.md)
