import { useMemo, type ReactNode } from 'react';
import { MarkShape } from '../../charts/TimelineStrip';
import { ChartTable, HitLayer, estimateTextWidth, useElementWidth, type HitItem } from '../../charts/shared';
import { cx } from '../../lib/dom';
import { formatAge, formatClock, formatInteger, formatShortDate } from '../../lib/format';
import type { HeroDecision, HeroMark, HeroModel } from './model';

export interface SessionTimelineProps {
  model: HeroModel;
  /** Phases declared but not started, for the "next" line of the summary. */
  upcoming: readonly string[];
  className?: string;
}

// Vertical layout (px).
const MARK_Y = 11;
const BAND_Y = 24;
const BAND_H = 24;
const TICK_TOP = 54;
const TICK_BASE = 90;
const THROTTLE_Y = 91;
const AXIS_Y = 96;
const LABEL_Y = 110;
const HEIGHT = 114;
const PAD_X = 8;

const MARK_WORD: Record<HeroMark['kind'], string> = {
  drift: 'Drift',
  rollback: 'Rollback',
  enhancement: 'Enhancement',
  amendment: 'Amendment',
  phase: 'Phase tag pinned',
  flag: 'Flagged task',
};

function niceStep(spanMs: number, widthPx: number): number {
  const minutes = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080];
  const maxTicks = Math.max(1, Math.floor(widthPx / 84));
  for (const m of minutes) if (spanMs / (m * 60_000) <= maxTicks) return m * 60_000;
  return 10080 * 60_000;
}

function PinShape({ x, flagged }: { x: number; flagged?: boolean }) {
  return (
    <g className={cx('session-tl__pin', flagged && 'is-flag')}>
      <line x1={x} x2={x} y1={MARK_Y - 7} y2={MARK_Y + 7} />
      <path d={`M${x},${MARK_Y - 7}h7l-2,3l2,3h-7z`} />
    </g>
  );
}

/** Legend glyph at legend size, drawn with the strip's own shapes. */
function LegendGlyph({ kind }: { kind: 'band' | 'active' | 'tool' | 'decision' | 'drift' | 'rollback' | 'enhancement' | 'phase' | 'flag' | 'throttle' | 'now' }) {
  return (
    <svg width={16} height={14} viewBox="0 0 16 14" aria-hidden="true" className="aoc-legend__glyph">
      {kind === 'band' && <rect x={1} y={3} width={14} height={8} rx={2} className="session-tl__band" />}
      {kind === 'active' && <rect x={1} y={3} width={14} height={8} rx={2} className="session-tl__band is-active" />}
      {kind === 'tool' && (
        <>
          <rect x={3} y={6} width={2} height={7} className="session-tl__col" />
          <rect x={7} y={2} width={2} height={11} className="session-tl__col" />
          <rect x={11} y={5} width={2} height={8} className="session-tl__col" />
        </>
      )}
      {kind === 'decision' && (
        <>
          <line x1={7} x2={15} y1={7} y2={7} className="session-tl__wait" />
          <MarkShape kind="decision" x={6} y={7} r={3.5} />
        </>
      )}
      {(kind === 'drift' || kind === 'rollback' || kind === 'enhancement') && <MarkShape kind={kind} x={8} y={7} r={4} />}
      {(kind === 'phase' || kind === 'flag') && (
        <g className={cx('session-tl__pin', kind === 'flag' && 'is-flag')}>
          <line x1={5} x2={5} y1={1} y2={13} />
          <path d="M5,1h7l-2,3l2,3h-7z" />
        </g>
      )}
      {kind === 'throttle' && <rect x={1} y={5} width={14} height={4} rx={1} className="session-tl__throttle" />}
      {kind === 'now' && <rect x={7} y={1} width={2} height={12} className="session-tl__now-glyph" />}
    </svg>
  );
}

/**
 * The session hero (§12): phases as bands to scale by elapsed time, tool calls per minute as columns,
 * decision diamonds whose line runs to the answer (its length is the wait), amber drift marks, rollback and
 * enhancement marks, phase tag pins and plan-limit (throttle) spans. Marks move only when the data changes.
 */
export function SessionTimeline({ model, upcoming, className }: SessionTimelineProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>(720);
  const { start, end } = model;
  const span = Math.max(1, end - start);
  const innerW = Math.max(1, width - PAD_X * 2);
  const x = (t: number) => PAD_X + ((Math.min(Math.max(t, start), end) - start) / span) * innerW;
  const longSpan = span > 20 * 3600_000;
  const clock = (t: number) => (longSpan ? `${formatShortDate(t)} ${formatClock(t)}` : formatClock(t));

  const peak = model.stats.peak?.count ?? 0;
  const colW = Math.max(1, Math.min(6, (60_000 / span) * innerW - 0.5));

  const bands = model.phases.map((p) => {
    const x0 = x(p.start);
    const w = Math.max(0, x(p.end) - x0 - 2);
    const dur = formatAge(p.end - p.start);
    const full = `${p.code} ${p.name} · ${dur}`;
    const text =
      estimateTextWidth(full) + 12 <= w ? full : estimateTextWidth(`${p.code} ${dur}`) + 12 <= w ? `${p.code} ${dur}` : estimateTextWidth(p.code) + 10 <= w ? p.code : '';
    return { p, x0, w, text };
  });

  const hits: HitItem[] = useMemo(() => {
    const items: (HitItem & { at: number })[] = [];
    const tip = (kind: string, title: ReactNode, meta: ReactNode, extra?: ReactNode) => (
      <>
        <span className="aoc-chart-tip__kind">{kind}</span>
        <strong>{title}</strong>
        <span className="aoc-chart-tip__meta aoc-num">{meta}</span>
        {extra && <span className="aoc-chart-tip__meta">{extra}</span>}
      </>
    );
    for (const d of model.decisions) {
      const waited = formatAge((d.closedAt ?? end) - d.at);
      const outcome = d.closedAt === null ? `waiting ${waited}` : `${d.outcome ? `${d.outcome}, ` : ''}after ${waited}`;
      items.push({
        key: `d-${d.id}`,
        at: d.at,
        x: x(d.at) - 6,
        y: MARK_Y - 6,
        width: 12,
        height: 12,
        label: `Decision${d.test ? `, test ${d.test}` : ''}: ${d.title}, asked ${clock(d.at)}, ${outcome}`,
        tooltip: tip(`Decision${d.test ? ` · test ${d.test}` : ''}`, d.title, `${clock(d.at)}${d.closedAt !== null ? `–${clock(d.closedAt)}` : ''}`, outcome),
      });
    }
    for (const m of model.marks) {
      items.push({
        key: m.id,
        at: m.at,
        x: x(m.at) - 6,
        y: MARK_Y - 6,
        width: 12,
        height: 12,
        label: `${MARK_WORD[m.kind]}: ${m.label}, ${clock(m.at)}${m.detail ? `, ${m.detail}` : ''}`,
        tooltip: tip(MARK_WORD[m.kind], m.label, clock(m.at), m.detail),
      });
    }
    for (const [i, t] of model.throttles.entries()) {
      const x0 = x(t.start);
      items.push({
        key: `t-${i}`,
        at: t.start,
        x: x0,
        y: THROTTLE_Y - 6,
        width: Math.max(4, x(t.end) - x0),
        height: 10,
        label: `Throttled ${formatAge(t.end - t.start)} from ${clock(t.start)}${t.open ? `, still throttled${t.resetAt ? `, resets ${clock(t.resetAt)}` : ''}` : ` to ${clock(t.end)}`}`,
        tooltip: tip('Throttled (idle)', formatAge(t.end - t.start), `${clock(t.start)}–${t.open ? 'now' : clock(t.end)}`, t.open && t.resetAt ? `resets ${clock(t.resetAt)}` : 'plan limit, idle time metered'),
      });
    }
    return items.sort((a, b) => a.at - b.at);
    // x() depends on start, end and width, listed below
  }, [model, start, end, width]);

  const ticks = useMemo(() => {
    const step = niceStep(span, width);
    const out: number[] = [];
    for (let t = Math.ceil(start / step) * step; t < end; t += step) out.push(t);
    return out;
  }, [span, width, start, end]);
  const endLabel = `${model.ended ? 'ended' : 'now'} ${clock(end)}`;
  const endW = estimateTextWidth(endLabel);
  const startLabel = clock(start);
  const tickLabels = ticks.filter((t) => {
    const tx = x(t);
    const w = estimateTextWidth(clock(t));
    return tx - w / 2 > PAD_X + estimateTextWidth(startLabel) + 8 && tx + w / 2 < width - PAD_X - endW - 8;
  });

  const s = model.stats;
  const summary = [
    `Session timeline from ${clock(start)} to ${endLabel}, ${formatAge(s.elapsedMs)}.`,
    model.phases.length
      ? `Phases: ${model.phases.map((p) => `${p.code} ${p.name} ${formatAge(p.end - p.start)}${p.active ? ' (in progress)' : ''}`).join(', ')}.`
      : 'No phase has started yet.',
    `${formatInteger(s.toolCalls)} tool calls${s.peak ? `, peak ${s.peak.count} a minute at ${clock(s.peak.at)}` : ''}.`,
    `${s.decisions} decisions, ${s.drift} drift marks, ${s.rollbacks} rollbacks${s.throttledMs ? `, throttled ${formatAge(s.throttledMs)}` : ''}.`,
  ].join(' ');

  return (
    <figure className={cx('aoc-chart', 'session-tl', className)}>
      <div className="aoc-chart__plot" ref={ref}>
        <svg role="img" aria-label={summary} width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`}>
          {bands.map(({ p, x0, w, text }) => (
            <g key={p.id}>
              <rect x={x0} y={BAND_Y} width={w} height={BAND_H} rx={3} className={cx('session-tl__band', p.active && 'is-active')} />
              {text && (
                <text x={x0 + 6} y={BAND_Y + 16} className={cx('session-tl__band-label', p.active && 'is-active')}>
                  {text}
                </text>
              )}
            </g>
          ))}
          {model.minutes.map((m) => {
            const h = peak > 0 ? Math.max(1.5, (m.count / peak) * (TICK_BASE - TICK_TOP)) : 0;
            return <rect key={m.at} x={x(m.at)} y={TICK_BASE - h} width={colW} height={h} className="session-tl__col" />;
          })}
          {model.throttles.map((t, i) => {
            const x0 = x(t.start);
            const w = Math.max(3, x(t.end) - x0);
            return (
              <g key={`thr-${i}`}>
                <rect x={x0} y={THROTTLE_Y - 2} width={w} height={4} rx={1} className="session-tl__throttle" />
                {w > estimateTextWidth('throttled') + 6 && (
                  <text x={x0 + w / 2} y={THROTTLE_Y - 6} textAnchor="middle" className="session-tl__throttle-label">
                    throttled
                  </text>
                )}
              </g>
            );
          })}
          <line x1={PAD_X} x2={width - PAD_X} y1={AXIS_Y} y2={AXIS_Y} className="session-tl__axis" />
          {ticks.map((t) => (
            <line key={t} x1={x(t)} x2={x(t)} y1={AXIS_Y} y2={AXIS_Y + 4} className="session-tl__axis" />
          ))}
          {model.decisions.map((d: HeroDecision) => (
            <line key={`w-${d.id}`} x1={x(d.at)} x2={x(d.closedAt ?? end)} y1={MARK_Y} y2={MARK_Y} className={cx('session-tl__wait', d.closedAt === null && 'is-open')} />
          ))}
          {model.marks
            .filter((m) => m.kind === 'drift')
            .map((m) => (
              <line key={`r-${m.id}`} x1={x(m.at)} x2={x(m.at)} y1={MARK_Y} y2={BAND_Y + BAND_H} className="session-tl__drift-rule" />
            ))}
          {model.marks.map((m) =>
            m.kind === 'phase' || m.kind === 'flag' ? (
              <PinShape key={m.id} x={x(m.at)} flagged={m.kind === 'flag'} />
            ) : (
              <MarkShape key={m.id} kind={m.kind === 'amendment' ? 'enhancement' : m.kind} x={x(m.at)} y={MARK_Y} r={5} />
            ),
          )}
          {model.decisions.map((d) => (
            <MarkShape key={`dm-${d.id}`} kind="decision" x={x(d.at)} y={MARK_Y} r={5} />
          ))}
          <line x1={x(end)} x2={x(end)} y1={0} y2={AXIS_Y} className="session-tl__now" />
          <text x={PAD_X} y={LABEL_Y} className="session-tl__axis-label">
            {startLabel}
          </text>
          {tickLabels.map((t) => (
            <text key={t} x={x(t)} y={LABEL_Y} textAnchor="middle" className="session-tl__axis-label">
              {clock(t)}
            </text>
          ))}
          <text x={width - PAD_X} y={LABEL_Y} textAnchor="end" className="session-tl__axis-label session-tl__now-label">
            {endLabel}
          </text>
        </svg>
        <HitLayer items={hits} label="Timeline marks: use the arrow keys to move between them" width={width} height={HEIGHT} />
      </div>
      <figcaption className="aoc-legend session-tl__legend">
        <span className="aoc-legend__item">
          <LegendGlyph kind="band" /> Phase, to scale
        </span>
        <span className="aoc-legend__item">
          <LegendGlyph kind="active" /> Current phase
        </span>
        <span className="aoc-legend__item">
          <LegendGlyph kind="tool" /> Tool calls per minute
        </span>
        <span className={cx('aoc-legend__item', s.decisions === 0 && 'is-zero')}>
          <LegendGlyph kind="decision" /> Decision, line = wait <strong className="aoc-num">{s.decisions}</strong>
        </span>
        <span className={cx('aoc-legend__item', s.drift === 0 && 'is-zero')}>
          <LegendGlyph kind="drift" /> Drift <strong className="aoc-num">{s.drift}</strong>
        </span>
        <span className={cx('aoc-legend__item', s.rollbacks === 0 && 'is-zero')}>
          <LegendGlyph kind="rollback" /> Rollback <strong className="aoc-num">{s.rollbacks}</strong>
        </span>
        <span className="aoc-legend__item">
          <LegendGlyph kind="enhancement" /> Enhancement / amendment
        </span>
        <span className="aoc-legend__item">
          <LegendGlyph kind="phase" /> Phase tag pinned
        </span>
        <span className="aoc-legend__item">
          <LegendGlyph kind="flag" /> Flagged close
        </span>
        <span className={cx('aoc-legend__item', model.throttles.length === 0 && 'is-zero')}>
          <LegendGlyph kind="throttle" /> Throttled (idle)
        </span>
        <span className="aoc-legend__item">
          <LegendGlyph kind="now" /> {model.ended ? 'End' : 'Now'}
        </span>
      </figcaption>
      <p className="session-tl__summary">
        {model.phases.length === 0 ? (
          <span>No phase has started yet{upcoming.length ? `; first up: ${upcoming[0]}` : ''}.</span>
        ) : (
          model.phases.map((p, i) => (
            <span key={p.id}>
              {i > 0 && ' · '}
              <strong>
                {p.code} {p.name}
              </strong>{' '}
              {clock(p.start)}–{p.active ? 'now' : clock(p.end)} ({formatAge(p.end - p.start)}
              {p.active ? ', in progress' : ''})
            </span>
          ))
        )}
        {model.phases.length > 0 && upcoming.length > 0 && (
          <span>
            {' · '}
            <strong>Next:</strong> {upcoming.join(', ')}, not started
          </span>
        )}
        {s.peak && (
          <span>
            . Peak {s.peak.count} tool calls a minute at {clock(s.peak.at)}
          </span>
        )}
        {model.decisions.length > 0 && <span>. Decisions at {model.decisions.map((d) => clock(d.at)).join(', ')}</span>}
        {s.drift > 0 && (
          <span>
            ; drift at{' '}
            {model.marks
              .filter((m) => m.kind === 'drift')
              .map((m) => clock(m.at))
              .join(', ')}
          </span>
        )}
        .
        {model.lateMarks.length > 0 && (
          <span className="session-tl__late">
            {' '}
            Recorded after the session ended:{' '}
            {model.lateMarks.map((m) => `${MARK_WORD[m.kind].toLowerCase()} (${m.label}) ${formatShortDate(m.at)} ${formatClock(m.at)}`).join(', ')}.
          </span>
        )}
      </p>
      <ChartTable
        caption="Session timeline marks"
        columns={['Time', 'Kind', 'What', 'Detail']}
        rows={[
          ...model.phases.map((p) => [clock(p.start), 'Phase', `${p.code} ${p.name}`, `${formatAge(p.end - p.start)}${p.active ? ', in progress' : ''}`]),
          ...model.decisions.map((d) => [clock(d.at), 'Decision', d.title, d.closedAt === null ? `waiting ${formatAge(end - d.at)}` : `${d.outcome ?? 'answered'} after ${formatAge(d.closedAt - d.at)}`]),
          ...model.marks.map((m) => [clock(m.at), MARK_WORD[m.kind], m.label, m.detail ?? '']),
          ...model.lateMarks.map((m) => [`${formatShortDate(m.at)} ${formatClock(m.at)}`, MARK_WORD[m.kind], m.label, `after the session ended${m.detail ? `, ${m.detail}` : ''}`]),
          ...model.throttles.map((t) => [clock(t.start), 'Throttled', formatAge(t.end - t.start), t.open ? 'still throttled' : `until ${clock(t.end)}`]),
        ].sort((a, b) => String(a[0]).localeCompare(String(b[0])))}
      />
    </figure>
  );
}
