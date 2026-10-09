import { useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../../api/client';
import type { AuthUser } from '../../api/auth';
import {
  FunnelBar,
  LatencyBars,
  Meter,
  MiniBarChart,
  PairedBars,
  RecurrenceTrend,
  SegmentBar,
  SmallMultiples,
  Sparkline,
  StackedBar,
  StackedPhaseBar,
  TimelineStrip,
  TrendSparkline,
} from '../../charts';
import {
  AliveIndicator,
  Badge,
  Button,
  ButtonLink,
  Checkbox,
  Chip,
  ClockProvider,
  CopyableHash,
  CountBadge,
  DataTable,
  DescriptionList,
  Dialog,
  Drawer,
  EmptyState,
  ErrorState,
  FilterBar,
  IconButton,
  InlineAlert,
  Kbd,
  KpiStrip,
  KpiTile,
  LIVENESS_META,
  LIVENESS_PRECEDENCE,
  LIVENESS_STATES,
  LivenessBadge,
  Menu,
  Money,
  PageHeader,
  ProgressBar,
  RankedList,
  RelativeTime,
  RequestStatusBadge,
  SegmentedControl,
  Select,
  Tabs,
  TextArea,
  TextField,
  TokenCount,
  Tooltip,
  Widget,
  WidgetGrid,
  fixedClock,
  formatMyr,
  formatUsd,
  useToast,
  type DataTableColumn,
} from '../../components';
import { useDocumentTitle } from '../../lib/documentTitle';
import { NAV_ITEMS } from '../../shell/navItems';
import { SideNav } from '../../shell/SideNav';
import { ProductMark, TopBar } from '../../shell/TopBar';
import {
  AGENTS,
  COST_TRENDS,
  CREDIT_SEGMENTS,
  DAILY_COST,
  DECISION_LATENCY,
  HOUR,
  MIN,
  NOW,
  PAIRED_ROWS,
  PHASE_PROGRESS,
  RECURRENCE,
  TASKS_BY_PROJECT,
  TASK_STATE_SERIES,
  TICKET_FUNNEL,
  TIMELINE_MARKS,
  TIMELINE_PHASES,
  TIMELINE_START,
  type SampleAgent,
} from './sampleData';
import './gallery.css';

const SECTIONS: ReadonlyArray<[string, string]> = [
  ['foundations', 'Foundations'],
  ['liveness', 'Liveness'],
  ['shell', 'Shell'],
  ['page-header', 'Page header'],
  ['buttons', 'Buttons'],
  ['labels', 'Badges & chips'],
  ['kpis', 'KPI strip'],
  ['console-hero', 'Console hero'],
  ['session-hero', 'Session hero'],
  ['registry-hero', 'Registry hero'],
  ['tower', 'Control Tower kit'],
  ['charts', 'More charts'],
  ['table', 'Data table'],
  ['controls', 'Tabs & controls'],
  ['overlays', 'Overlays'],
  ['feedback', 'Feedback'],
  ['values', 'Values'],
  ['forms', 'Forms'],
];

const SAMPLE_USER: AuthUser = { id: 'usr_ceo', name: 'Aisyah Rahman', role: 'approver', flags: {} };

function Section({
  id,
  title,
  lede,
  children,
}: {
  id: string;
  title: string;
  lede?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="gallery-section" aria-labelledby={`${id}-title`}>
      <header className="gallery-section__header">
        <h2 id={`${id}-title`}>{title}</h2>
        {lede && <p>{lede}</p>}
      </header>
      {children}
    </section>
  );
}

function Specimen({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`gallery-specimen${wide ? ' gallery-specimen--wide' : ''}`}>
      <div className="gallery-specimen__label">{label}</div>
      <div className="gallery-specimen__body">{children}</div>
    </div>
  );
}

function Swatch({ token, note }: { token: string; note?: string }) {
  return (
    <div className="gallery-swatch">
      <span className="gallery-swatch__chip" style={{ background: `var(${token})` }} aria-hidden="true" />
      <code>{token}</code>
      {note && <span className="gallery-swatch__note">{note}</span>}
    </div>
  );
}

const SWATCHES: ReadonlyArray<[string, ReadonlyArray<[string, string?]>]> = [
  [
    'Surfaces',
    [['--bg'], ['--surface'], ['--surface-2'], ['--surface-3'], ['--border'], ['--border-strong']],
  ],
  [
    'Text',
    [
      ['--text', 'primary'],
      ['--text-2', 'secondary'],
      ['--text-3', 'muted'],
    ],
  ],
  ['Brand', [['--accent', 'interactive'], ['--accent-soft'], ['--brand-red', 'wordmark only']]],
  [
    'Liveness',
    [
      ['--live-working'],
      ['--live-thinking', 'neutral'],
      ['--live-stalled'],
      ['--live-dead'],
      ['--live-throttled'],
      ['--live-waiting'],
    ],
  ],
  [
    'Marks',
    [
      ['--mark-decision'],
      ['--mark-drift', 'amber'],
      ['--mark-rollback'],
      ['--mark-enhancement'],
      ['--mark-tool'],
    ],
  ],
  ['Status', [['--ok'], ['--warn'], ['--danger'], ['--info']]],
  [
    'Series (categorical, max 4 adjacent)',
    [['--series-1', 'discovery'], ['--series-2', 'execution'], ['--series-3'], ['--series-4']],
  ],
];

function Foundations() {
  return (
    <Section
      id="foundations"
      title="Foundations"
      lede="One token set (src/design/tokens.css) for light and dark, following the OS. Colour carries meaning only."
    >
      <div className="gallery-swatches">
        {SWATCHES.map(([group, tokens]) => (
          <div key={group} className="gallery-swatch-group">
            <h3>{group}</h3>
            {tokens.map(([t, note]) => (
              <Swatch key={t} token={t} note={note} />
            ))}
          </div>
        ))}
      </div>
      <div className="gallery-type">
        {(
          [
            ['--fs-3xl', 'Hero figure 1,284'],
            ['--fs-2xl', 'KPI value 37'],
            ['--fs-xl', 'Page title'],
            ['--fs-lg', 'Dialog title'],
            ['--fs-md', 'Body and widget titles (14px)'],
            ['--fs-sm', 'Tables, nav and controls (13px)'],
            ['--fs-xs', 'Labels, legends and axis text (12px)'],
          ] as const
        ).map(([token, text]) => (
          <div key={token} className="gallery-type__row">
            <code>{token}</code>
            <span
              style={{
                fontSize: `var(${token})`,
                fontWeight: token === '--fs-xl' || token === '--fs-lg' ? 600 : undefined,
              }}
            >
              {text}
            </span>
          </div>
        ))}
        <div className="gallery-type__row">
          <code>.aoc-num</code>
          <span className="aoc-num">
            1,111,111.11 · 9,999,999.99 — tabular numerals keep metric columns aligned
          </span>
        </div>
      </div>
    </Section>
  );
}

function LivenessSection() {
  const [seq, setSeq] = useState(1);
  return (
    <Section
      id="liveness"
      title="Liveness"
      lede="Always a badge — colour + icon + word, never a chart. Thinking is neutral, not amber. Precedence: Waiting on you > Throttled > Dead > Stalled > Thinking > Working."
    >
      <div className="gallery-row">
        {LIVENESS_STATES.map((s) => (
          <LivenessBadge key={s} state={s} />
        ))}
      </div>
      <div className="gallery-row">
        {LIVENESS_STATES.map((s) => (
          <LivenessBadge key={s} state={s} size="sm" />
        ))}
      </div>
      <div className="gallery-row">
        <LivenessBadge state="throttled" detail="resets 14:05" />
        <LivenessBadge state="waiting_on_you" detail="decision 2h 14m" />
        <LivenessBadge state="stalled" detail="no progress 9m" />
        <LivenessBadge state="dead" detail="no heartbeat 4m" />
      </div>
      <div className="gallery-grid-2">
        <Specimen label="Precedence (highest first)">
          <ol className="gallery-precedence">
            {LIVENESS_PRECEDENCE.map((s) => (
              <li key={s}>
                <LivenessBadge state={s} size="sm" />
                <span>{LIVENESS_META[s].description}</span>
              </li>
            ))}
          </ol>
        </Specimen>
        <Specimen label="AliveIndicator — one pulse per activity event, never a steady pulse">
          <div className="gallery-row">
            <span className="gallery-inline">
              <AliveIndicator activitySeq={seq} label={`Activity event ${seq}`} /> event-driven (seq {seq})
            </span>
            <Button size="sm" icon="plus" onClick={() => setSeq((n) => n + 1)}>
              Emit activity event
            </Button>
          </div>
          <div className="gallery-row">
            <span className="gallery-inline">
              <AliveIndicator activitySeq={7} state="stalled" /> stalled · static
            </span>
            <span className="gallery-inline">
              <AliveIndicator activitySeq={7} state="dead" /> dead · static
            </span>
            <span className="gallery-inline">
              <AliveIndicator activitySeq={7} state="ended" /> ended · static
            </span>
          </div>
        </Specimen>
      </div>
    </Section>
  );
}

function ShellSection() {
  const [nav, setNav] = useState(false);
  return (
    <Section
      id="shell"
      title="Shell"
      lede="Compact top bar and collapsible nav (a drawer at ≤768px). Live status is a static word."
    >
      <div className="gallery-frame">
        <TopBar
          connection="live"
          inboxCount={3}
          user={SAMPLE_USER}
          onSignOut={() => undefined}
          onOpenNav={() => setNav(true)}
          navOpen={nav}
        />
      </div>
      <div className="gallery-frame">
        <TopBar
          connection="reconnecting"
          inboxCount={0}
          user={{ ...SAMPLE_USER, name: 'Wei Jie Tan', role: 'builder' }}
          onSignOut={() => undefined}
          onOpenNav={() => setNav(true)}
          navOpen={nav}
        />
      </div>
      <div className="gallery-navs">
        <div className="gallery-frame gallery-frame--nav">
          <SideNav items={NAV_ITEMS} inboxCount={3} onToggleCollapsed={() => undefined} />
        </div>
        <div className="gallery-frame gallery-frame--nav gallery-frame--rail">
          <SideNav items={NAV_ITEMS} inboxCount={3} collapsed onToggleCollapsed={() => undefined} />
        </div>
      </div>
    </Section>
  );
}

function PageHeaderSection() {
  return (
    <Section
      id="page-header"
      title="Page header"
      lede="Breadcrumbs, the page's single h1, subtitle, actions and a meta row."
    >
      <div className="gallery-canvas">
        <PageHeader
          documentTitle={false}
          title="billing-revamp · migrate"
          subtitle="Schema migration for the billing revamp, launched by Wei Jie Tan."
          breadcrumbs={[
            { label: 'Projects', to: '/dev/gallery' },
            { label: 'Billing revamp', to: '/dev/gallery' },
            { label: 'ses_51be07' },
          ]}
          actions={
            <>
              <Button icon="retry">Nudge</Button>
              <Button variant="primary" icon="decisions">
                Review decision
              </Button>
            </>
          }
          meta={
            <>
              <LivenessBadge state="waiting_on_you" detail="decision 2h 14m" />
              <Chip>Schema migration</Chip>
              <span>
                head <CopyableHash value="0d4e8f2a6c1b9e3d7f5a0c4e8b2d6f1a3c5e7b90" label="commit" />
              </span>
              <span>
                started <RelativeTime value={NOW - 4 * HOUR - 53 * MIN} suffix=" ago" />
              </span>
            </>
          }
        />
      </div>
    </Section>
  );
}

function ButtonsSection() {
  return (
    <Section id="buttons" title="Buttons" lede="One primary per view. Loading shows words, never a spinner.">
      <div className="gallery-row">
        <Button variant="primary">Approve</Button>
        <Button>Request changes</Button>
        <Button variant="ghost">Cancel</Button>
        <Button variant="danger" icon="rollbacks">
          Roll back
        </Button>
        <Button variant="primary" loading>
          Approve
        </Button>
        <Button disabled>Disabled</Button>
      </div>
      <div className="gallery-row">
        <Button variant="primary" size="sm">
          Approve
        </Button>
        <Button size="sm" icon="filter">
          Filter
        </Button>
        <Button variant="ghost" size="sm" iconAfter="chevron-down">
          More
        </Button>
        <Button variant="danger" size="sm">
          Revoke
        </Button>
        <ButtonLink to="/dev/gallery" icon="plus" size="sm">
          New change request
        </ButtonLink>
      </div>
      <div className="gallery-row">
        <IconButton icon="copy" label="Copy" />
        <IconButton icon="retry" label="Refresh" variant="secondary" />
        <IconButton icon="close" label="Close" size="sm" />
        <IconButton icon="inbox" label="Decisions inbox, 3 open" variant="secondary" badge={3} />
        <IconButton icon="rollbacks" label="Roll back" variant="danger" />
      </div>
    </Section>
  );
}

function LabelsSection() {
  const [filters, setFilters] = useState<Record<string, boolean>>({
    waiting: true,
    stalled: false,
    mine: false,
  });
  const [tags, setTags] = useState(['billing', 'payments', 'uat']);
  return (
    <Section
      id="labels"
      title="Badges & chips"
      lede="Status tones always carry a word or an icon; tinted text mixes toward ink so it clears AA."
    >
      <div className="gallery-row">
        {(['neutral', 'accent', 'ok', 'warn', 'danger', 'info'] as const).map((t) => (
          <Badge key={t} tone={t}>
            {t}
          </Badge>
        ))}
      </div>
      <div className="gallery-row">
        {(['neutral', 'accent', 'ok', 'warn', 'danger', 'info'] as const).map((t) => (
          <Badge key={t} tone={t} variant="solid">
            {t}
          </Badge>
        ))}
        <Badge tone="ok" variant="outline" icon="ok">
          passed
        </Badge>
        <Badge tone="danger" variant="outline" icon="danger">
          failed
        </Badge>
        <CountBadge count={3} label="open decisions" />
        <CountBadge count={128} label="events" />
      </div>
      <div className="gallery-row">
        <Chip tone="accent">Approver</Chip>
        <Chip>Builder</Chip>
        <Chip icon="clock">Opus · discovery</Chip>
        {Object.entries(filters).map(([k, v]) => (
          <Chip key={k} selected={v} onToggle={(next) => setFilters((f) => ({ ...f, [k]: next }))}>
            {k === 'waiting' ? 'Waiting on you' : k === 'stalled' ? 'Stalled' : 'Mine'}
          </Chip>
        ))}
        {tags.map((t) => (
          <Chip
            key={t}
            onRemove={() => setTags((all) => all.filter((x) => x !== t))}
            removeLabel={`Remove ${t}`}
          >
            {t}
          </Chip>
        ))}
      </div>
      <div className="gallery-row">
        <span className="gallery-inline">
          Press <Kbd>Esc</Kbd> to close, <Kbd>←</Kbd> <Kbd>→</Kbd> to move between marks
        </span>
      </div>
      <div className="gallery-row">
        <RequestStatusBadge status="submitted" />
        <RequestStatusBadge status="in_progress" />
        <RequestStatusBadge status="ready_for_testing" />
        <RequestStatusBadge status="completed" />
        <span className="gallery-note">Requester portal status — no internal terms.</span>
      </div>
    </Section>
  );
}

function KpiSection() {
  return (
    <Section
      id="kpis"
      title="KPI strip"
      lede="Values always as text; deltas coloured by whether the direction is good."
    >
      <KpiStrip label="Today at a glance">
        <KpiTile
          label="Active sessions"
          value={8}
          delta={{ value: 2, kind: 'absolute', label: 'vs yesterday' }}
          trend={[4, 5, 5, 6, 7, 6, 8]}
          trendLabel="last 7 days"
        />
        <KpiTile
          label="Open decisions"
          value={3}
          tone="warn"
          footnote="oldest waiting 2h 14m"
          href="/dev/gallery"
        />
        <KpiTile
          label="Tasks done"
          value={37}
          unit="of 61"
          delta={{ value: 0.12, label: 'vs yesterday' }}
          info="Tasks closed with evidence (test id, commit or diff). Closes without a file change are flagged."
        />
        <KpiTile
          label="Notional cost"
          value={formatUsd(198.4)}
          footnote={`${formatMyr(935.66)} · notional, not a bill`}
          delta={{ value: -0.08, good: 'down', label: 'vs 7-day avg' }}
        />
        <KpiTile
          label="Throttle idle"
          value="42"
          unit="min"
          delta={{ value: 0.35, good: 'down', label: 'vs yesterday' }}
          tone="danger"
        />
      </KpiStrip>
    </Section>
  );
}

function ConsoleHero({ agents }: { agents: readonly SampleAgent[] }) {
  const yMax = Math.max(...agents.flatMap((a) => a.apm));
  return (
    <Section
      id="console-hero"
      title="Console hero"
      lede="Small multiples of actions per minute on one shared scale — a flat line reveals a stall before any badge."
    >
      <WidgetGrid layout="auto" minTileWidth={272} aria-label="Agents">
        {agents.map((a) => (
          <Widget
            key={a.id}
            headingLevel={3}
            title={a.name}
            subtitle={a.project}
            actions={<LivenessBadge state={a.state} size="sm" />}
            footer={
              <>
                <span className="gallery-inline">
                  <AliveIndicator activitySeq={a.seq} state={a.state} />
                  <RelativeTime value={a.lastActivity} suffix=" ago" />
                </span>
                <span className="aoc-num">
                  {a.done}/{a.declared} tasks
                </span>
              </>
            }
          >
            <Sparkline
              values={a.apm}
              label={`${a.name} actions per minute`}
              unit="APM"
              yMax={yMax}
              flatAfter={3}
              liveness={a.state}
            />
          </Widget>
        ))}
      </WidgetGrid>
    </Section>
  );
}

function MeterDemo() {
  return (
    <div className="gallery-stack">
      <Meter label="ses_7f3a91" value={84_000} max={200_000} detail="84K / 200K tokens" />
      <Meter
        label="ses_51be07"
        value={152_000}
        max={200_000}
        detail="152K / 200K tokens · rollover at a clean boundary"
      />
      <Meter label="ses_c3f2d9" value={186_000} max={200_000} detail="186K / 200K tokens" />
    </div>
  );
}

function SessionHero() {
  return (
    <Section
      id="session-hero"
      title="Session hero"
      lede="Timeline strip: phases to scale, tool-call ticks, decision diamonds, amber drift marks, rollback and enhancement marks. Marks are one tab stop; arrow keys move between them."
    >
      <WidgetGrid>
        <Widget
          span={12}
          title="Timeline"
          subtitle="started 09:12 · 4h 53m"
          info="Bands are phases from the plan manifest, to scale by elapsed time. Every mark is an event from the log."
        >
          <TimelineStrip
            start={TIMELINE_START}
            now={NOW}
            phases={TIMELINE_PHASES}
            marks={TIMELINE_MARKS}
            tableView
          />
        </Widget>
        <Widget
          span={8}
          title="Completion by phase"
          info="Tasks weighted by declared size; the denominator moves when the manifest is amended."
        >
          <StackedPhaseBar phases={PHASE_PROGRESS} />
        </Widget>
        <Widget span={4} title="Context window">
          <MeterDemo />
        </Widget>
      </WidgetGrid>
    </Section>
  );
}

function RegistryHero() {
  return (
    <Section
      id="registry-hero"
      title="Registry hero"
      lede="The distillation business case: discovery (series-1) vs execution (series-2) cost per run, plus the trend per process type."
    >
      <WidgetGrid>
        <Widget
          span={7}
          title="Cost per run"
          subtitle="discovery vs distilled execution"
          info="Notional API-equivalent cost per run."
        >
          <PairedBars rows={PAIRED_ROWS} />
        </Widget>
        <Widget span={5} title="Cost per run trend" subtitle="last 8 weeks">
          <ul className="gallery-trends">
            {PAIRED_ROWS.map((r) => (
              <li key={r.id}>
                <span className="gallery-trends__name">{r.label}</span>
                <TrendSparkline
                  values={COST_TRENDS[r.id] ?? []}
                  label={`${r.label} cost per run`}
                  format={(v) => formatUsd(v)}
                  compareLabel="vs 8 wk ago"
                />
              </li>
            ))}
          </ul>
        </Widget>
      </WidgetGrid>
    </Section>
  );
}

function TowerKit() {
  return (
    <Section
      id="tower"
      title="Control Tower kit"
      lede="The Approver's landing view: what needs a human now, where work is stuck, how fast decisions get made, and fleet activity."
    >
      <WidgetGrid>
        <Widget span={12} title="Needs attention" subtitle="ranked by attention score" flush>
          <RankedList
            label="Needs attention"
            scoreLabel="Attention score"
            now={NOW}
            items={[
              {
                id: 'a1',
                severity: 'critical',
                title: 'fx-scraper · triage is dead',
                href: '/dev/gallery',
                meta: 'FX rates · no heartbeat for 4m',
                since: NOW - 4 * MIN,
                score: 94,
                action: <Button size="sm">Restart</Button>,
              },
              {
                id: 'a2',
                severity: 'high',
                title: 'Fix-plan sign-off: billing-revamp · migrate',
                href: '/dev/gallery',
                meta: 'Billing revamp · decision waiting on you',
                since: NOW - 2 * HOUR - 14 * MIN,
                score: 88,
                action: (
                  <Button size="sm" variant="primary">
                    Review
                  </Button>
                ),
              },
              {
                id: 'a3',
                severity: 'high',
                title: 'Credit top-up request: Intake portal',
                meta: 'Intake portal · one-time 25% grant already used',
                since: NOW - 52 * MIN,
                score: 71,
                action: <Button size="sm">Review</Button>,
              },
              {
                id: 'a4',
                severity: 'medium',
                title: 'fx-scraper · fix is stalled',
                meta: 'FX rates · no progress for 9m',
                since: NOW - 9 * MIN,
                score: 63,
                action: <Button size="sm">Nudge</Button>,
              },
              {
                id: 'a5',
                severity: 'medium',
                title: 'FX rate carried forward for 3 days',
                meta: 'Metering · BNM source unreadable',
                since: NOW - 3 * 24 * HOUR,
                score: 41,
                action: (
                  <Button size="sm" variant="ghost">
                    Check
                  </Button>
                ),
              },
              {
                id: 'a6',
                severity: 'low',
                title: 'Lesson L-14 awaits approval',
                meta: 'Learning · scoped to Bug fix',
                since: NOW - 26 * HOUR,
                score: 22,
                action: (
                  <Button size="sm" variant="ghost">
                    Open
                  </Button>
                ),
              },
            ]}
          />
        </Widget>
        <Widget
          span={12}
          title="Ticket pipeline"
          subtitle="items in each stage now"
          info="Bottleneck = the stage holding the most waiting time (count × median age)."
        >
          <FunnelBar stages={TICKET_FUNNEL} label="Ticket pipeline" unit="tickets" />
        </Widget>
        <Widget span={7} title="Decision latency" subtitle="last 30 days, against SLA">
          <LatencyBars rows={DECISION_LATENCY} label="Decision latency" />
        </Widget>
        <Widget span={5} title="Tasks by state" subtitle="per project">
          <StackedBar series={TASK_STATE_SERIES} rows={TASKS_BY_PROJECT} label="Tasks by state" tableView />
        </Widget>
        <Widget span={12} title="Fleet activity" subtitle="tool calls per minute">
          <SmallMultiples
            label="Tool calls per minute by agent"
            unit="APM"
            rangeLabel="last 30 min"
            series={AGENTS.map((a) => ({ id: a.id, label: a.name, values: a.apm, note: a.project }))}
          />
        </Widget>
      </WidgetGrid>
    </Section>
  );
}

function MoreCharts() {
  return (
    <Section
      id="charts"
      title="More charts"
      lede="Every chart prints its key numbers and has role=img with a summary. No idle animation."
    >
      <WidgetGrid>
        <Widget span={4} title="Sparkline variants">
          <div className="gallery-stack">
            <Sparkline values={AGENTS[0]!.apm} label="Working agent" unit="APM" />
            <Sparkline values={AGENTS[2]!.apm} label="Stalled agent" unit="APM" flatAfter={3} />
            <Sparkline values={[3, 4, 3, 5, 6, 5, 7, 8, 7, 9]} label="Muted trend" tone="muted" />
          </div>
        </Widget>
        <Widget span={4} title="Credits by project" subtitle="period allocation US$1,000">
          <SegmentBar
            segments={CREDIT_SEGMENTS}
            label="Credits used by project"
            total={1000}
            format={(v) => formatUsd(v, { decimals: 0 })}
          />
        </Widget>
        <Widget span={4} title="Daily notional cost" subtitle="last 30 days">
          <MiniBarChart
            data={DAILY_COST}
            label="Daily notional cost"
            format={(v) => formatUsd(v, { decimals: 0 })}
            lastLabel="Today"
            tableView
          />
        </Widget>
        <Widget
          span={12}
          title="Recurrence by root-cause class"
          subtitle="prioritised by cost of recurrence, never by person"
        >
          <RecurrenceTrend classes={RECURRENCE} tableView />
        </Widget>
      </WidgetGrid>
    </Section>
  );
}

function TableSection() {
  const [open, setOpen] = useState<SampleAgent | null>(null);
  const columns = useMemo<DataTableColumn<SampleAgent>[]>(
    () => [
      {
        id: 'name',
        header: 'Session',
        primary: true,
        sortValue: (a) => a.name,
        cell: (a) => a.name,
      },
      {
        id: 'project',
        header: 'Project',
        sortValue: (a) => a.project,
        cell: (a) => a.project,
        hideOnMobile: true,
      },
      {
        id: 'liveness',
        header: 'Liveness',
        sortValue: (a) =>
          LIVENESS_PRECEDENCE.indexOf(a.state) + (LIVENESS_PRECEDENCE.includes(a.state) ? 0 : 99),
        sortLabels: ['most urgent first', 'least urgent first'],
        cell: (a) => <LivenessBadge state={a.state} size="sm" detail={a.detail} />,
      },
      {
        id: 'progress',
        header: 'Progress',
        sortValue: (a) => a.done / a.declared,
        sortLabels: ['least done first', 'most done first'],
        width: '150px',
        cell: (a) => <ProgressBar done={a.done} declared={a.declared} size="sm" showPercent={false} />,
      },
      {
        id: 'tokens',
        header: 'Tokens',
        numeric: true,
        sortValue: (a) => a.tokens,
        cell: (a) => <TokenCount value={a.tokens} unit="" />,
      },
      {
        id: 'cost',
        header: 'Notional cost',
        numeric: true,
        sortValue: (a) => a.usd,
        cell: (a) => <Money usd={a.usd} myr={a.myr} layout="stacked" />,
      },
      {
        id: 'last',
        header: 'Last activity',
        numeric: true,
        sortValue: (a) => a.lastActivity,
        cell: (a) => <RelativeTime value={a.lastActivity} suffix=" ago" />,
      },
      {
        id: 'head',
        header: 'Head',
        cell: (a) => <CopyableHash value={a.head} label="commit" />,
        hideOnMobile: true,
      },
    ],
    [],
  );
  return (
    <Section
      id="table"
      title="Data table"
      lede="32px rows, sortable headers (aria-sort), sticky header inside maxHeight, row click, stacked cards ≤640px."
    >
      <Widget span={12} title="Sessions" subtitle="click a row for details" flush>
        <DataTable
          caption="Sessions"
          columns={columns}
          rows={AGENTS}
          rowKey={(a) => a.id}
          defaultSort={{ columnId: 'liveness', direction: 'asc' }}
          onRowClick={(a) => setOpen(a)}
          rowLabel={(a) => `Open ${a.name}`}
          activeRowKey={open?.id}
          rowTone={(a) => (a.state === 'dead' ? 'danger' : a.state === 'stalled' ? 'warn' : undefined)}
          maxHeight={300}
        />
      </Widget>
      <div className="gallery-spacer" />
      <Widget span={12} title="Rollbacks" flush>
        <DataTable
          caption="Rollbacks"
          columns={[{ id: 'x', header: 'Rollback', cell: () => null }]}
          rows={[]}
          rowKey={() => 'x'}
          empty={
            <EmptyState
              size="sm"
              icon="rollbacks"
              title="No rollbacks"
              body="Rollbacks appear here once one is requested."
            />
          }
        />
      </Widget>
      <Drawer
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open?.name ?? ''}
        description={open?.project}
      >
        {open && (
          <DescriptionList
            columns={1}
            items={[
              { term: 'Liveness', value: <LivenessBadge state={open.state} detail={open.detail} /> },
              { term: 'Process type', value: open.processType },
              {
                term: 'Progress',
                value: (
                  <ProgressBar done={open.done} declared={open.declared} label="Tasks" eta="ETA 16:30" />
                ),
              },
              { term: 'Tokens', value: <TokenCount value={open.tokens} /> },
              { term: 'Notional cost', value: <Money usd={open.usd} myr={open.myr} notional /> },
              { term: 'Head commit', value: <CopyableHash value={open.head} label="commit" /> },
              { term: 'Session id', value: <code>{open.id}</code> },
            ]}
          />
        )}
      </Drawer>
    </Section>
  );
}

function ControlsSection() {
  const [range, setRange] = useState<'today' | '7d' | '30d' | '90d'>('7d');
  const [project, setProject] = useState('all');
  return (
    <Section
      id="controls"
      title="Tabs & controls"
      lede="Roving tabindex: one tab stop, arrow keys move. Filters sit in one row above what they scope."
    >
      <FilterBar end={<span>8 sessions</span>}>
        <SegmentedControl
          label="Time range"
          value={range}
          onChange={setRange}
          options={[
            { value: 'today', label: 'Today' },
            { value: '7d', label: '7 days' },
            { value: '30d', label: '30 days' },
            { value: '90d', label: '90 days' },
          ]}
        />
        <Select
          label="Project"
          fieldClassName="gallery-inline-field"
          value={project}
          onChange={(e) => setProject(e.target.value)}
          options={[
            { value: 'all', label: 'All projects' },
            { value: 'billing', label: 'Billing revamp' },
            { value: 'intake', label: 'Intake portal' },
          ]}
        />
      </FilterBar>
      <Tabs
        label="Session views"
        items={[
          {
            id: 'overview',
            label: 'Overview',
            content: <p className="gallery-note">Overview panel — timeline and progress.</p>,
          },
          {
            id: 'tasks',
            label: 'Tasks',
            count: 14,
            content: <p className="gallery-note">14 declared tasks, 9 done with evidence.</p>,
          },
          {
            id: 'decisions',
            label: 'Decisions',
            count: 1,
            content: <p className="gallery-note">One decision waiting on you.</p>,
          },
          { id: 'transcript', label: 'Transcript', disabled: true },
        ]}
      />
    </Section>
  );
}

function OverlaysSection() {
  const [dialog, setDialog] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const toast = useToast();
  return (
    <Section
      id="overlays"
      title="Overlays"
      lede="Dialog and Drawer trap focus, close on Escape and restore focus. Toasts are announced politely and come only from events."
    >
      <div className="gallery-row">
        <Button variant="danger" icon="rollbacks" onClick={() => setDialog(true)}>
          Roll back…
        </Button>
        <Button onClick={() => setDrawer(true)}>Open drawer</Button>
        <Button
          variant="ghost"
          onClick={() =>
            toast.notify({
              tone: 'ok',
              title: 'Rollback to v1.4.2 passed acceptance tests',
              body: 'Ready for your approval.',
              action: { label: 'Review', onClick: () => undefined },
            })
          }
        >
          Toast: ok
        </Button>
        <Button
          variant="ghost"
          onClick={() => toast.notify({ tone: 'info', title: 'Session rolled over to a fresh context' })}
        >
          Toast: info
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            toast.notify({
              tone: 'warn',
              title: 'FX rate carried forward for 3 days',
              body: 'Check the BNM source manually.',
            })
          }
        >
          Toast: warn
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            toast.notify({
              tone: 'danger',
              title: 'Session ses_9a77c1 is dead',
              body: 'No heartbeat for 4 minutes.',
            })
          }
        >
          Toast: danger
        </Button>
      </div>
      <div className="gallery-row">
        <Tooltip content="Tooltips show on hover and keyboard focus and dismiss with Escape.">
          <Button icon="info">Hover or focus me</Button>
        </Tooltip>
        <Menu
          label="Row actions"
          trigger={
            <>
              Actions <span aria-hidden="true">▾</span>
            </>
          }
          align="start"
          items={[
            { id: 'nudge', label: 'Nudge', icon: 'retry', onSelect: () => undefined },
            { id: 'restart', label: 'Restart', icon: 'working', onSelect: () => undefined },
            { id: 'copy', label: 'Copy session id', icon: 'copy', onSelect: () => undefined },
            { id: 'kill', label: 'Stop session', icon: 'dead', tone: 'danger', onSelect: () => undefined },
          ]}
        />
      </div>
      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        role="alertdialog"
        size="sm"
        title="Roll back billing-revamp to v1.4.2?"
        description="The supervisor checks out the tag on a new branch and runs its acceptance tests. Nothing touches main until you approve the result."
        initialFocus={cancelRef}
        footer={
          <>
            <Button ref={cancelRef} onClick={() => setDialog(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => setDialog(false)}>
              Start rollback
            </Button>
          </>
        }
      >
        <DescriptionList
          columns={1}
          items={[
            {
              term: 'Target',
              value: <CopyableHash value="7a1c9e3b5d2f4a6c8e0b1d3f5a7c9e2b4d6f8a0c" label="tag commit" />,
            },
            { term: 'Change record', value: 'CR-0142 · impact, mitigation, rollback plan, acceptance test' },
          ]}
        />
      </Dialog>
      <Drawer
        open={drawer}
        onClose={() => setDrawer(false)}
        title="Change request CR-0142"
        description="Requested by Wei Jie Tan"
      >
        <InlineAlert tone="warn" title="Touches main">
          This change bounces to the Approver.
        </InlineAlert>
      </Drawer>
    </Section>
  );
}

function FeedbackSection() {
  return (
    <Section id="feedback" title="Feedback" lede="Empty, error and inline alert states.">
      <div className="gallery-grid-2">
        <EmptyState
          icon="decisions"
          title="No open decisions"
          body="Decisions that need a human appear here with their age."
          action={<Button size="sm">View history</Button>}
        />
        <ErrorState
          error={new ApiError(503, 'daemon_unavailable', 'The event store is restarting')}
          onRetry={() => undefined}
        />
      </div>
      <div className="gallery-stack">
        <InlineAlert tone="info" title="Attribution, not signed approval">
          v1 bearer tokens prove which token was used, not who used it.
        </InlineAlert>
        <InlineAlert tone="ok" title="Chain verified">
          Head hash matches the off-host anchor of 2026-10-08.
        </InlineAlert>
        <InlineAlert tone="warn" title="Mapping provisional" action={<Button size="sm">Review</Button>}>
          ISO/IEC 42001 clause mapping awaits the compliance lead&apos;s stamp.
        </InlineAlert>
        <InlineAlert tone="danger" title="Break-glass promotion" onDismiss={() => undefined}>
          A post-incident change record is due within 24 hours.
        </InlineAlert>
      </div>
    </Section>
  );
}

function ValuesSection() {
  return (
    <Section
      id="values"
      title="Values"
      lede="Typed value components so a quantity reads the same everywhere."
    >
      <div className="gallery-values">
        <Specimen label="CopyableHash">
          <CopyableHash
            value="sha256:3f9a1c7e5b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a"
            label="chain head"
          />
        </Specimen>
        <Specimen label="RelativeTime (title = absolute)">
          <span className="gallery-inline">
            <RelativeTime value={NOW - 35_000} suffix=" ago" /> ·{' '}
            <RelativeTime value={NOW - 2 * HOUR - 14 * MIN} prefix="decision " /> ·{' '}
            <RelativeTime value={NOW - 3 * 24 * HOUR - 2 * HOUR} suffix=" ago" />
          </span>
        </Specimen>
        <Specimen label="Money (USD + RM)">
          <div className="gallery-stack">
            <Money usd={12.4} myr={58.3} />
            <Money usd={1284.5} myr={6058.1} notional />
            <Money usd={48210} myr={227390} compact />
          </div>
        </Specimen>
        <Specimen label="TokenCount (title = exact)">
          <div className="gallery-stack">
            <TokenCount value={1_234_567} />
            <TokenCount value={48_210} />
            <TokenCount value={812} />
          </div>
        </Specimen>
        <Specimen label="ProgressBar — ETA hidden until 3 tasks done" wide>
          <div className="gallery-stack">
            <ProgressBar done={2} declared={7} label="Tasks" eta="ETA 17:20" />
            <ProgressBar done={9} declared={14} label="Tasks" eta="ETA 16:30" />
          </div>
        </Specimen>
      </div>
    </Section>
  );
}

function FormsSection() {
  const [desc, setDesc] = useState('');
  return (
    <Section id="forms" title="Forms" lede="Visible labels, hints and errors wired with aria-describedby.">
      <div className="gallery-form">
        <TextField
          label="Change title"
          placeholder="e.g. Add retry to FX fetch"
          hint="Shown in the audit log."
        />
        <TextField
          label="Rollback target"
          required
          error="Name the exact commit or tag to return to."
          defaultValue=""
        />
        <Select
          label="Severity"
          placeholder="Choose severity"
          defaultValue=""
          required
          options={[
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
          ]}
        />
        <TextArea
          label="Impact analysis"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          hint={`${desc.length} characters`}
        />
        <Checkbox
          label="I reviewed each AI-drafted field"
          hint="Blind one-click confirms are flagged (§14)."
        />
      </div>
    </Section>
  );
}

/** Every primitive and chart with rich sample data — the reviewer's and screenshot checks' view of the system. */
export default function GalleryPage() {
  useDocumentTitle('Design system gallery');
  const clock = useMemo(() => fixedClock(NOW), []);
  return (
    <ClockProvider clock={clock}>
      <div className="aoc-standalone gallery">
        <a href="#gallery-main" className="aoc-skip-link">
          Skip to content
        </a>
        <header className="gallery-header">
          <ProductMark to="/dev/gallery" />
          <span className="gallery-header__title">Design system gallery</span>
          <span className="gallery-header__note">
            Sample data at a fixed time · follows the OS colour scheme
          </span>
        </header>
        <div className="gallery-layout">
          <nav className="gallery-toc" aria-label="Gallery sections">
            <ul>
              {SECTIONS.map(([id, label]) => (
                <li key={id}>
                  <a href={`#${id}`}>{label}</a>
                </li>
              ))}
            </ul>
          </nav>
          <main id="gallery-main" className="gallery-main">
            <h1 className="gallery-title">AOC design system</h1>
            <p className="gallery-lede">
              Compact, calm and precise. Pages are composed only from these primitives; numbers are always
              text; nothing moves unless an event moved it.
            </p>
            <Foundations />
            <LivenessSection />
            <ShellSection />
            <PageHeaderSection />
            <ButtonsSection />
            <LabelsSection />
            <KpiSection />
            <ConsoleHero agents={AGENTS} />
            <SessionHero />
            <RegistryHero />
            <TowerKit />
            <MoreCharts />
            <TableSection />
            <ControlsSection />
            <OverlaysSection />
            <FeedbackSection />
            <ValuesSection />
            <FormsSection />
          </main>
        </div>
      </div>
    </ClockProvider>
  );
}
