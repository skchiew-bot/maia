import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
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
  findBottleneck,
} from '../src/charts';
import type { TimelineMark } from '../src/charts';
import { formatUsd } from '../src/lib/format';

const MIN = 60_000;
const HOUR = 60 * MIN;
const START = Date.UTC(2026, 9, 8, 1, 12);
const NOW = START + 4 * HOUR + 53 * MIN;

function renderChart(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

/** Every role="img" in the chart has a non-trivial summary. */
function images(container: HTMLElement): HTMLElement[] {
  const imgs = Array.from(container.querySelectorAll<HTMLElement>('[role="img"]'));
  expect(imgs.length).toBeGreaterThan(0);
  for (const img of imgs) expect((img.getAttribute('aria-label') ?? '').length).toBeGreaterThan(10);
  return imgs;
}

describe('Sparkline', () => {
  it('prints the last value and summarises the series', () => {
    const { container } = renderChart(
      <Sparkline values={[4, 9, 31, 12]} label="Actions per minute" unit="APM" />,
    );
    expect(screen.getByText('12 APM')).toBeInTheDocument();
    const [img] = images(container);
    expect(img).toHaveAttribute(
      'aria-label',
      'Actions per minute: last 12 APM, peak 31 APM, low 4 APM over 4 samples',
    );
  });

  it('styles a flat tail as a stall only when enabled and the session should be active', () => {
    const values = [5, 6, 7, 0, 0, 0, 0];
    const { rerender, container } = renderChart(
      <Sparkline values={values} label="APM" unit="APM" flatAfter={3} />,
    );
    expect(screen.getByText(/flat 4m/)).toBeInTheDocument();
    expect(images(container)[0]!.getAttribute('aria-label')).toContain('flat for the last 4 minutes');

    rerender(
      <MemoryRouter>
        <Sparkline values={values} label="APM" unit="APM" flatAfter={3} liveness="waiting_on_you" />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/flat 4m/)).toBeNull();

    rerender(
      <MemoryRouter>
        <Sparkline values={values} label="APM" unit="APM" flatAfter={3} liveness="thinking" />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/flat/)).toBeNull();

    rerender(
      <MemoryRouter>
        <Sparkline values={values} label="APM" unit="APM" />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/flat/)).toBeNull();
  });

  it('handles an empty series', () => {
    const { container } = renderChart(<Sparkline values={[]} label="APM" />);
    expect(images(container)[0]).toHaveAttribute('aria-label', 'APM: no data yet');
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('TrendSparkline', () => {
  it('prints the latest value and the change, coloured by whether it is good', () => {
    const { container } = renderChart(
      <TrendSparkline
        values={[4.2, 2.6, 1.4, 0.38]}
        label="Cost per run"
        format={(v) => formatUsd(v)}
        compareLabel="vs 4 wk ago"
      />,
    );
    expect(screen.getByText('US$0.38')).toBeInTheDocument();
    expect(screen.getByText('\u221291%')).toBeInTheDocument();
    expect(screen.getByText('(improved)')).toBeInTheDocument();
    expect(images(container)[0]!.getAttribute('aria-label')).toContain('Cost per run, \u221291% vs 4 wk ago');
  });
});

describe('TimelineStrip', () => {
  const phases = [
    { id: 'd', label: 'Discovery', start: START, end: START + 72 * MIN },
    { id: 'b', label: 'Build', start: START + 72 * MIN },
  ];
  const marks: TimelineMark[] = [
    ...Array.from({ length: 12 }, (_, i) => ({
      id: `t${i}`,
      kind: 'tool' as const,
      at: START + i * 20 * MIN,
    })),
    { id: 'dec', kind: 'decision', at: START + 55 * MIN, label: 'Fix-plan sign-off', detail: 'Approved' },
    { id: 'dr', kind: 'drift', at: START + 130 * MIN, label: 'Edited files outside the plan' },
    { id: 'rb', kind: 'rollback', at: START + 150 * MIN, label: 'Rolled back to v1.4.2' },
  ];

  it('summarises elapsed time, phases and mark counts, and prints them', () => {
    const { container } = renderChart(
      <TimelineStrip start={START} now={NOW} phases={phases} marks={marks} />,
    );
    const label = images(container)[0]!.getAttribute('aria-label') ?? '';
    expect(label).toContain('4h 53m elapsed');
    expect(label).toContain('Discovery 1h 12m');
    expect(label).toContain('Build 3h 41m (active)');
    expect(label).toContain('12 tool calls, 1 decisions, 1 drift marks, 1 rollbacks');
    const legend = container.querySelector('figcaption') as HTMLElement;
    expect(within(legend).getByText('4h 53m')).toBeInTheDocument();
    expect(within(legend).getByText('Tool calls').nextSibling).toHaveTextContent('12');
    expect(within(legend).getByText('Decisions').nextSibling).toHaveTextContent('1');
  });

  it('makes governance marks keyboard-focusable with one tab stop and arrow keys', async () => {
    const user = userEvent.setup();
    const onMarkSelect = vi.fn();
    renderChart(
      <TimelineStrip start={START} now={NOW} phases={phases} marks={marks} onMarkSelect={onMarkSelect} />,
    );
    const group = screen.getByRole('group', { name: /marks/ });
    const buttons = within(group).getAllByRole('button');
    // tool ticks are aggregated, not focusable; the three governance marks are, in time order
    expect(buttons).toHaveLength(3);
    expect(buttons.map((b) => b.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(buttons[0]).toHaveAccessibleName(
      /^Decision: Fix-plan sign-off, \d\d:\d\d, 3h 58m ago\. Approved$/,
    );

    await user.tab();
    expect(buttons[0]).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(buttons[1]).toHaveFocus();
    expect(buttons[1]).toHaveAccessibleName(/^Drift: Edited files outside the plan/);
    await user.keyboard('{End}');
    expect(buttons[2]).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onMarkSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'rb' }));
    await user.keyboard('{Home}');
    expect(buttons[0]).toHaveFocus();
  });

  it('shows a tooltip on focus with the mark detail', () => {
    renderChart(<TimelineStrip start={START} now={NOW} phases={phases} marks={marks} />);
    const [first] = within(screen.getByRole('group', { name: /marks/ })).getAllByRole('button');
    fireEvent.focus(first!);
    expect(screen.getByText('Fix-plan sign-off')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
  });
});

describe('StackedPhaseBar', () => {
  it('prints overall and per-phase completion and summarises it', () => {
    const { container } = renderChart(
      <StackedPhaseBar
        phases={[
          {
            id: 'a',
            label: 'Discovery',
            doneWeight: 8,
            declaredWeight: 8,
            doneTasks: 5,
            declaredTasks: 5,
            state: 'done',
          },
          {
            id: 'b',
            label: 'Build',
            doneWeight: 15,
            declaredWeight: 26,
            doneTasks: 9,
            declaredTasks: 14,
            state: 'active',
          },
          { id: 'c', label: 'UAT', doneWeight: 0, declaredWeight: 6, doneTasks: 0, declaredTasks: 4 },
        ]}
      />,
    );
    expect(screen.getByText('58%')).toBeInTheDocument();
    expect(screen.getByText('14/23 tasks')).toBeInTheDocument();
    const label = images(container)[0]!.getAttribute('aria-label') ?? '';
    expect(label).toContain('58% of declared weight done, 14 of 23 tasks');
    expect(label).toContain('Build: 9/14 tasks (58%), active');
    expect(label).toContain('UAT: 0/4 tasks (0%)');
  });
});

describe('PairedBars', () => {
  it('prints both costs and the saving for every row', () => {
    const { container } = renderChart(
      <PairedBars
        rows={[
          { id: 'a', label: 'Schema migration', discovery: 18.6, execution: 9.1, runs: 7 },
          { id: 'b', label: 'Triage', discovery: 4.2, execution: 0.38, runs: 46 },
        ]}
      />,
    );
    for (const text of ['US$18.60', 'US$9.10', 'US$4.20', 'US$0.38', '51%', '91%', '46 runs']) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    expect(images(container)[0]!.getAttribute('aria-label')).toContain(
      'Triage — discovery US$4.20, execution US$0.38, 91% saved over 46 runs',
    );
  });
});

describe('Meter', () => {
  it('prints the percentage and a severity word past the thresholds', () => {
    const { container, rerender } = renderChart(
      <Meter label="Context used" value={84_000} max={200_000} detail="84K / 200K tokens" />,
    );
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(images(container)[0]).toHaveAttribute('aria-label', 'Context used: 42% (84K / 200K tokens)');
    rerender(
      <MemoryRouter>
        <Meter label="Context used" value={186_000} max={200_000} detail="186K / 200K tokens" />
      </MemoryRouter>,
    );
    expect(screen.getByText('93%')).toBeInTheDocument();
    expect(screen.getByText('near limit')).toBeInTheDocument();
    expect(images(container)[0]).toHaveAttribute(
      'aria-label',
      'Context used: 93%, near limit (186K / 200K tokens)',
    );
  });
});

describe('SegmentBar', () => {
  it('prints every part with its share and folds a fifth part into Other', () => {
    const { container } = renderChart(
      <SegmentBar
        label="Credits by project"
        total={1000}
        format={(v) => formatUsd(v, { decimals: 0 })}
        segments={[
          { id: 'a', label: 'Billing', value: 412 },
          { id: 'b', label: 'Intake', value: 188 },
          { id: 'c', label: 'FX', value: 64 },
          { id: 'd', label: 'Release', value: 22 },
          { id: 'e', label: 'Audit', value: 9 },
        ]}
      />,
    );
    expect(screen.getByText('Billing')).toBeInTheDocument();
    expect(screen.getByText('US$412')).toBeInTheDocument();
    expect(screen.getByText('41%')).toBeInTheDocument();
    expect(screen.getByText('Other (2)')).toBeInTheDocument();
    expect(screen.getByText('US$31')).toBeInTheDocument();
    expect(screen.getByText('Unused')).toBeInTheDocument();
    expect(images(container)[0]!.getAttribute('aria-label')).toContain('US$305 unused of US$1,000');
  });
});

describe('MiniBarChart', () => {
  it('prints latest, peak and total, and gives each day a focusable value', () => {
    const data = [
      { date: '2026-10-06', value: 30 },
      { date: '2026-10-07', value: 78 },
      { date: '2026-10-08', value: 61 },
    ];
    const { container } = renderChart(<MiniBarChart data={data} label="Daily cost" lastLabel="Today" />);
    expect(screen.getByText('61')).toBeInTheDocument();
    expect(screen.getByText('78')).toBeInTheDocument();
    expect(screen.getByText('169')).toBeInTheDocument();
    expect(images(container)[0]).toHaveAttribute(
      'aria-label',
      'Daily cost, Oct 6 to Oct 8: today 61, peak 78 on Oct 7, total 169.',
    );
    const days = within(screen.getByRole('group', { name: 'Daily cost: days' })).getAllByRole('button');
    expect(days.map((d) => d.getAttribute('aria-label'))).toEqual(['Oct 6: 30', 'Oct 7: 78', 'Oct 8: 61']);
  });
});

describe('RecurrenceTrend', () => {
  it('prints latest, total and peak per class and lists weekly counts in the summary', () => {
    const { container } = renderChart(
      <RecurrenceTrend
        classes={[
          {
            id: 'a',
            label: 'Stale fixtures',
            stage: 'fix_applied',
            weeks: [1, 2, 4, 0].map((count, i) => ({ week: `W${36 + i}`, count })),
          },
        ]}
      />,
    );
    expect(screen.getByText('7 in 4 wk · peak 4')).toBeInTheDocument();
    expect(screen.getByText('Fix applied')).toBeInTheDocument();
    const label = images(container)[0]!.getAttribute('aria-label') ?? '';
    expect(label).toContain('Stale fixtures: 0 in the latest week, 7 over 4 weeks, peak 4 in W38');
    expect(label).toContain('Weekly: W36 1, W37 2, W38 4, W39 0');
  });
});

describe('SmallMultiples', () => {
  it('puts every panel on one printed scale with its latest value', () => {
    const { container } = renderChart(
      <SmallMultiples
        label="APM by agent"
        unit="APM"
        rangeLabel="last 30 min"
        series={[
          { id: 'a', label: 'billing · build', values: [3, 9, 12] },
          { id: 'b', label: 'fx · fix', values: [8, 2, 0] },
        ]}
      />,
    );
    expect(screen.getByText(/One scale:/)).toHaveTextContent('One scale: 0–12 APM · last 30 min');
    expect(screen.getByText('12 APM')).toBeInTheDocument();
    expect(screen.getByText('0 APM')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'APM by agent' })).toBeInTheDocument();
    expect(images(container)).toHaveLength(2);
  });
});

describe('FunnelBar', () => {
  const stages = [
    { id: 'intake', label: 'Intake', count: 4, oldestAgeMs: 2 * HOUR, medianAgeMs: 40 * MIN },
    { id: 'diag', label: 'Diagnosis', count: 7, oldestAgeMs: 27 * HOUR, medianAgeMs: 6 * HOUR },
    { id: 'uat', label: 'UAT', count: 6, oldestAgeMs: 52 * HOUR, medianAgeMs: 26 * HOUR },
    { id: 'done', label: 'Done', count: 42, terminal: true },
  ];

  it('flags the stage holding the most waiting time — never a terminal stage', () => {
    expect(findBottleneck(stages)).toBe('uat');
    expect(
      findBottleneck([
        { id: 'a', label: 'A', count: 3 },
        { id: 'b', label: 'B', count: 5 },
      ]),
    ).toBe('b');
    expect(findBottleneck([{ id: 'done', label: 'Done', count: 9, terminal: true }])).toBeUndefined();
  });

  it('prints counts and ages, and marks the bottleneck with a word', () => {
    const { container } = renderChart(<FunnelBar stages={stages} label="Ticket pipeline" unit="tickets" />);
    expect(screen.getByText('Bottleneck')).toBeInTheDocument();
    expect(screen.getByText('Bottleneck').closest('li')).toHaveTextContent('UAT');
    expect(screen.getByText('oldest 2d 4h · median 1d 2h')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(images(container)[0]!.getAttribute('aria-label')).toContain(
      'UAT 6 tickets (oldest 2d 4h · median 1d 2h), bottleneck',
    );
  });

  it('honours an explicit bottleneck or none', () => {
    const { rerender } = renderChart(<FunnelBar stages={stages} label="Pipeline" bottleneck="intake" />);
    expect(screen.getByText('Bottleneck').closest('li')).toHaveTextContent('Intake');
    rerender(
      <MemoryRouter>
        <FunnelBar stages={stages} label="Pipeline" bottleneck={null} />
      </MemoryRouter>,
    );
    expect(screen.queryByText('Bottleneck')).toBeNull();
  });
});

describe('LatencyBars', () => {
  it('prints p50/p90, the SLA and breach counts in words', () => {
    const { container } = renderChart(
      <LatencyBars
        label="Decision latency"
        rows={[
          {
            id: 'a',
            label: 'Go-live approval',
            p50Ms: 65 * MIN,
            p90Ms: 5 * HOUR + 20 * MIN,
            slaMs: 4 * HOUR,
            breaches: 3,
            total: 9,
          },
          { id: 'b', label: 'Rollback approval', p50Ms: 18 * MIN, p90Ms: 55 * MIN, slaMs: HOUR, breaches: 0 },
        ]}
      />,
    );
    expect(screen.getByText('1h 5m')).toBeInTheDocument();
    expect(screen.getByText('5h 20m')).toBeInTheDocument();
    expect(screen.getByText('SLA 4h')).toBeInTheDocument();
    expect(screen.getByText('3 over SLA')).toBeInTheDocument();
    expect(screen.getByText('within SLA')).toBeInTheDocument();
    expect(container.querySelectorAll('.aoc-latency__over')).toHaveLength(1);
    expect(images(container)[0]!.getAttribute('aria-label')).toContain(
      'Go-live approval — p50 1h 5m, p90 5h 20m, SLA 4h, 3 over SLA',
    );
  });
});

describe('StackedBar', () => {
  it('prints series totals in the legend and row totals, with every value in the summary', () => {
    const { container } = renderChart(
      <StackedBar
        label="Tasks by state"
        series={[
          { id: 'done', label: 'Done' },
          { id: 'wip', label: 'In progress' },
          { id: 'blocked', label: 'Blocked' },
        ]}
        rows={[
          { id: 'a', label: 'Billing', values: { done: 17, wip: 4, blocked: 1 } },
          { id: 'b', label: 'Intake', values: { done: 11, wip: 3 } },
        ]}
      />,
    );
    const legend = container.querySelector('.aoc-stacked__legend') as HTMLElement;
    expect(within(legend).getByText('Done').nextSibling).toHaveTextContent('28');
    expect(within(legend).getByText('In progress').nextSibling).toHaveTextContent('7');
    expect(within(legend).getByText('Total')).toHaveTextContent('Total 36');
    expect(screen.getByText('22')).toBeInTheDocument();
    expect(screen.getByText('14')).toBeInTheDocument();
    const label = images(container)[0]!.getAttribute('aria-label') ?? '';
    expect(label).toContain('Done 28, In progress 7, Blocked 1; total 36');
    expect(label).toContain('Intake: Done 11, In progress 3, Blocked 0');
  });

  it('folds more than four series into Other', () => {
    renderChart(
      <StackedBar
        label="Spend"
        series={['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, label: id.toUpperCase() }))}
        rows={[{ id: 'r', label: 'Row', values: { a: 1, b: 2, c: 3, d: 4, e: 5 } }]}
      />,
    );
    expect(screen.getByText('Other (2)').nextSibling).toHaveTextContent('9');
  });
});
