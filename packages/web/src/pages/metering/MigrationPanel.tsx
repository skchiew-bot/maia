import type { CSSProperties } from 'react';
import type { MigrationRecommendationDTO } from '@aoc/contracts';
import { Icon, Widget } from '../../components';
import { cx } from '../../lib/dom';
import { formatMyr, formatNumber, formatUsd } from '../../lib/format';
import { migrationAxis, VERDICT_TEXT } from './meteringModel';

const SCENARIOS = ['low', 'base', 'high'] as const;
const SCENARIO_LABEL = { low: 'Low', base: 'Base', high: 'High' } as const;

const signedUsd = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${formatUsd(Math.abs(v), { decimals: 0 })}`;

/**
 * Migration recommender (§14): notional spend plus throttle loss against assumed Enterprise pricing, as a range
 * with its assumptions and sensitivity exposed — never one crossover number.
 */
export function MigrationPanel({ m }: { m: MigrationRecommendationDTO }) {
  const axis = migrationAxis(m);
  const pos = (v: number) => ((v - axis.min) / (axis.max - axis.min || 1)) * 100;
  const values = SCENARIOS.map((k) => m.range[k].netMonthlyBenefitUsd);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const base = m.range.base;
  const favourable = m.verdict === 'enterprise_favoured_across_range';
  const summary = `Net monthly benefit of moving to Enterprise: low ${signedUsd(m.range.low.netMonthlyBenefitUsd)}, base ${signedUsd(
    base.netMonthlyBenefitUsd,
  )}, high ${signedUsd(m.range.high.netMonthlyBenefitUsd)}. ${VERDICT_TEXT[m.verdict]}.`;
  return (
    <Widget
      span={5}
      id="migration"
      title="Enterprise migration case"
      subtitle="Net monthly benefit of moving, as a range · positive favours Enterprise"
      info={m.method}
    >
      <p className={cx('met-verdict', favourable ? 'is-ok' : m.verdict === 'depends_on_assumptions' ? 'is-warn' : '')}>
        <Icon name={favourable ? 'ok' : m.verdict === 'depends_on_assumptions' ? 'warn' : 'info'} size={14} />
        {VERDICT_TEXT[m.verdict]}
      </p>
      <p className="met-quiet met-verdict__basis">
        On {m.assumptions.filter((a) => a.source === 'default').length} placeholder assumptions (not a quote) and{' '}
        {m.inputs.notionalUsd30d.coveredDays} day{m.inputs.notionalUsd30d.coveredDays === 1 ? '' : 's'} of metered
        history; replace the seat price with a real quote before deciding.
      </p>
      <div className="met-range" role="img" aria-label={summary}>
        <div className="met-range__track">
          <span className="met-range__zero" style={{ '--x': `${pos(0)}%` } as CSSProperties} />
          <span
            className="met-range__band"
            style={{ '--x0': `${pos(lo)}%`, '--x1': `${pos(hi)}%` } as CSSProperties}
          />
          {SCENARIOS.map((k) => (
            <span
              key={k}
              className={cx('met-range__mark', k === 'base' && 'is-base')}
              style={{ '--x': `${pos(m.range[k].netMonthlyBenefitUsd)}%` } as CSSProperties}
            />
          ))}
        </div>
        <div className="met-range__axis" aria-hidden="true">
          <span style={{ '--x': `${pos(0)}%` } as CSSProperties}>0</span>
        </div>
      </div>
      <dl className="met-scen">
        {SCENARIOS.map((k) => (
          <div key={k} className={cx('met-scen__item', k === 'base' && 'is-base')}>
            <dt>{SCENARIO_LABEL[k]}</dt>
            <dd className="aoc-num">
              <b>{signedUsd(m.range[k].netMonthlyBenefitUsd)}</b>/mo
              {m.range[k].netMonthlyBenefitRm !== null && (
                <span className="met-sub">{formatMyr(m.range[k].netMonthlyBenefitRm!, { decimals: 0 })}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="met-quiet aoc-num">
        Base case: stay {formatUsd(base.current.totalUsd, { decimals: 0 })}/mo (subscription{' '}
        {formatUsd(base.current.subscriptionUsd, { decimals: 0 })} + throttling {formatUsd(base.current.throttleLossUsd, { decimals: 0 })}) vs
        Enterprise {formatUsd(base.enterprise.totalUsd, { decimals: 0 })}/mo · {signedUsd(base.netAnnualBenefitUsd)} a year.
      </p>
      <details className="met-details">
        <summary>What moves it most</summary>
        <ul>
          {m.sensitivity.slice(0, 4).map((s) => (
            <li key={s.driver}>
              <b>{s.label}</b> ±20%: {signedUsd(s.netMonthlyAtMinus20Usd)} to {signedUsd(s.netMonthlyAtPlus20Usd)}/mo
            </li>
          ))}
        </ul>
      </details>
      <details className="met-details">
        <summary>Assumptions ({m.assumptions.filter((a) => a.source === 'default').length} placeholders, not a quote)</summary>
        <ul>
          {m.assumptions.map((a) => (
            <li key={a.key}>
              <b>{a.label}</b>: {formatNumber(a.value, Number.isInteger(a.value) ? 0 : 2)} {a.unit}{' '}
              <span className="met-sub-inline">({a.source === 'data' ? 'measured' : a.source === 'query' ? 'set here' : 'placeholder'})</span>
            </li>
          ))}
        </ul>
        {m.caveats.length > 0 && (
          <ul className="met-caveats">
            {m.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        )}
      </details>
    </Widget>
  );
}
