import { useMemo } from 'react';
import type { ManifestPhaseDTO, ScopeChangeDTO } from '@aoc/contracts';
import { HitLayer, MarkShape, useElementWidth, type HitItem } from '../../charts';
import { formatDateTime, formatInteger, formatPercent, formatShortDate } from '../../lib/format';
import { dayTicks, xAt, type TimeScale } from './lanes';
import { isLiveTask, taskChangeText, weightText } from './model';

const H = 150;
const TOP = 14;
const BOTTOM = 20;

interface Step {
  at: number;
  value: number;
}

/** Step path through (t, value) points, holding each value until the next point and then to `end`. */
function stepPath(
  points: readonly Step[],
  x: (t: number) => number,
  y: (v: number) => number,
  end: number,
): string {
  if (points.length === 0) return '';
  let d = `M${x(points[0]!.at)},${y(0)}V${y(points[0]!.value)}`;
  for (let i = 1; i < points.length; i++) d += `H${x(points[i]!.at)}V${y(points[i]!.value)}`;
  return `${d}H${x(end)}`;
}

/** Smallest round ceiling at or above `v` (…, 100, 150, 200, 250, 300, 400, 500, …). */
export function niceMax(v: number): number {
  if (v <= 10) return 10;
  const mag = 10 ** Math.floor(Math.log10(v));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((n) => n * mag >= v) ?? 10;
  return step * mag;
}

function scopeDescription(s: ScopeChangeDTO): string {
  const who = s.ownerName ?? 'unknown developer';
  const delta = `${s.weightDelta >= 0 ? '+' : '−'}${weightText(Math.abs(s.weightDelta))}`;
  const verb = s.kind === 'declared' ? 'declared' : `amended v${s.manifestVersion}`;
  return `${who} ${verb} (${taskChangeText(s)}): ${delta} → ${weightText(s.projectWeightAfter)}`;
}

/**
 * Burn-up of the master timeline: declared weight (the denominator, a step at every declaration and amendment)
 * against done weight (a step at every evidence-backed close). A jump in the upper line is new scope — never
 * silent, each step is an audited event (§9).
 */
export function BurnUp({
  scope,
  manifest,
  scale,
}: {
  scope: readonly ScopeChangeDTO[];
  manifest: readonly ManifestPhaseDTO[];
  scale: TimeScale;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>(560);
  // Ledger order is the truth for running totals; times only place the steps, held monotonic.
  const points = useMemo(() => {
    let last = Number.NEGATIVE_INFINITY;
    return [...scope]
      .sort((a, b) => a.seq - b.seq)
      .map((s) => {
        last = Math.max(last, Date.parse(s.at));
        return { s, at: last };
      });
  }, [scope]);
  const declared = useMemo<Step[]>(
    () => points.map((p) => ({ at: p.at, value: p.s.projectWeightAfter })),
    [points],
  );
  const done = useMemo<Step[]>(() => {
    const closes = manifest
      .flatMap((p) => p.tasks)
      .filter((t) => isLiveTask(t) && t.status === 'done' && t.doneAt)
      .map((t) => ({ at: Date.parse(t.doneAt!), weight: t.weight }))
      .sort((a, b) => a.at - b.at);
    let sum = 0;
    return closes.map((c) => ({ at: c.at, value: (sum += c.weight) }));
  }, [manifest]);

  const lastDeclared = declared.at(-1)?.value ?? 0;
  const lastDone = done.at(-1)?.value ?? 0;
  const max = niceMax(Math.max(1, ...declared.map((d) => d.value), lastDone));
  const x = (t: number) => xAt(scale, width, t);
  const y = (v: number) => TOP + (1 - v / max) * (H - TOP - BOTTOM);
  const end = Math.max(scale.now, declared.at(-1)?.at ?? 0, done.at(-1)?.at ?? 0);
  const amendments = scope.filter((s) => s.kind === 'amended');
  const ticks = dayTicks(scale, width);

  const hits: HitItem[] = points.map(({ s, at }) => {
    return {
      key: `s${s.seq}`,
      x: x(at) - 4,
      y: y(s.projectWeightAfter) - 4,
      width: 8,
      height: 8,
      label: `${formatDateTime(s.at)}: ${scopeDescription(s)}`,
      tooltip: (
        <>
          <span className="aoc-chart-tip__kind">{s.kind === 'declared' ? 'Plan declared' : 'Amendment'}</span>
          <strong>{s.ownerName ?? 'Unknown developer'}</strong>
          <span className="aoc-chart-tip__meta aoc-num">{formatDateTime(s.at)}</span>
          <span className="aoc-chart-tip__meta aoc-num">
            {weightText(s.projectWeightBefore)} → {weightText(s.projectWeightAfter)} weight
          </span>
        </>
      ),
    };
  });

  const summary = `Burn-up: declared weight ${weightText(declared[0]?.value ?? 0)} at the first plan, ${weightText(
    lastDeclared,
  )} now after ${formatInteger(scope.length)} changes (${formatInteger(amendments.length)} ${
    amendments.length === 1 ? 'amendment' : 'amendments'
  }); done weight ${weightText(lastDone)} (${formatPercent(lastDeclared > 0 ? lastDone / lastDeclared : 0)}).`;

  return (
    <figure className="aoc-chart prj-burnup">
      <figcaption className="prj-burnup__caption">
        <span className="prj-legend__item">
          <span className="prj-burnup__key prj-burnup__key--declared" /> declared weight{' '}
          <strong className="aoc-num">{weightText(lastDeclared)}</strong>
        </span>
        <span className="prj-legend__item">
          <span className="prj-burnup__key prj-burnup__key--done" /> done weight{' '}
          <strong className="aoc-num">{weightText(lastDone)}</strong>
        </span>
        <span className="prj-legend__item">
          <svg width={12} height={12} aria-hidden="true" className="prj-legend__glyph">
            <MarkShape kind="enhancement" x={6} y={6} r={4} />
          </svg>
          amendment <strong className="aoc-num">{formatInteger(amendments.length)}</strong>
        </span>
      </figcaption>
      <div className="aoc-chart__plot" ref={ref}>
        <svg role="img" aria-label={summary} width={width} height={H} viewBox={`0 0 ${width} ${H}`}>
          <line x1={6} x2={width - 6} y1={y(0)} y2={y(0)} className="prj-burnup__axis" />
          <line x1={6} x2={width - 6} y1={y(max)} y2={y(max)} className="prj-burnup__grid" />
          <text x={8} y={y(max) - 3} className="prj-axis__label">
            {formatInteger(max)}
          </text>
          {ticks.map((t) => (
            <text key={t} x={x(t)} y={H - 5} textAnchor="middle" className="prj-axis__label">
              {formatShortDate(t)}
            </text>
          ))}
          {done.length > 0 && (
            <path d={`${stepPath(done, x, y, end)}V${y(0)}Z`} className="prj-burnup__area" />
          )}
          <path d={stepPath(done, x, y, end)} className="prj-burnup__done" />
          <path d={stepPath(declared, x, y, end)} className="prj-burnup__declared" />
          {points
            .filter((p) => p.s.kind === 'amended')
            .map(({ s, at }) => (
              <MarkShape key={s.seq} kind="enhancement" x={x(at)} y={y(s.projectWeightAfter)} r={4} />
            ))}
          <line x1={x(scale.now)} x2={x(scale.now)} y1={TOP - 4} y2={y(0)} className="prj-lane__now" />
        </svg>
        <HitLayer
          items={hits}
          label="Denominator changes: use arrow keys to move between them"
          width={width}
          height={H}
        />
      </div>
    </figure>
  );
}
