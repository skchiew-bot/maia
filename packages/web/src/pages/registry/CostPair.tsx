import type { CSSProperties } from 'react';
import { cx } from '../../lib/dom';
import { formatRunCost, modelLabel, type ExecutionCost } from './registryModel';

export interface CostPairProps {
  /** Process type name, for the accessible summary. */
  name: string;
  discoveryUsd: number;
  discoveryModel: string;
  execution: ExecutionCost;
  /** Shared axis maximum (every row uses the same scale). */
  scaleMax: number;
}

const frac = (v: number, max: number) => Math.max(0, Math.min(1, max > 0 ? v / max : 0));

/**
 * Registry hero pair: discovery $/run (series-1) over execution $/run (series-2) on the hero's shared scale.
 * A projected execution cost is an outlined, dashed bar and says "projected" in words; values sit at the tips.
 */
export function CostPair({ name, discoveryUsd, discoveryModel, execution, scaleMax }: CostPairProps) {
  const exec = execution.usd;
  const summary = `${name}: discovery ${formatRunCost(discoveryUsd)} per run on ${modelLabel(discoveryModel)}${
    exec === null
      ? ', no execution path'
      : `, execution ${formatRunCost(exec)} per run on ${modelLabel(execution.model)}${
          execution.basis === 'projected' ? ' (projected from rate-card prices)' : ''
        }`
  }.`;
  return (
    <div className="reg-pair" role="img" aria-label={summary}>
      <div className="reg-pair__row" style={{ '--v': frac(discoveryUsd, scaleMax) } as CSSProperties}>
        <span className="reg-pair__bar reg-pair__bar--disc" />
        <span className="reg-pair__lab">
          <b className="aoc-num">{formatRunCost(discoveryUsd)}</b> {modelLabel(discoveryModel)}
        </span>
      </div>
      {exec !== null && (
        <div className="reg-pair__row" style={{ '--v': frac(exec, scaleMax) } as CSSProperties}>
          <span
            className={cx(
              'reg-pair__bar',
              'reg-pair__bar--exec',
              execution.basis === 'projected' && 'is-projected',
            )}
          />
          <span className="reg-pair__lab">
            <b className="aoc-num">{formatRunCost(exec)}</b> {modelLabel(execution.model)}
            {execution.basis === 'projected' && <span className="reg-pair__basis"> · projected</span>}
          </span>
        </div>
      )}
    </div>
  );
}

/** Tick labels for the hero's bar column header, positioned on the same scale as the bars. */
export function CostAxis({ ticks, max }: { ticks: readonly number[]; max: number }) {
  return (
    <span className="reg-axis" aria-hidden="true">
      {ticks.map((t) => (
        <span key={t} className="reg-axis__tick" style={{ '--v': frac(t, max) } as CSSProperties}>
          {t === 0 ? '0' : `$${Number.isInteger(t) ? t : t.toFixed(t < 1 ? 2 : 1)}`}
        </span>
      ))}
    </span>
  );
}
