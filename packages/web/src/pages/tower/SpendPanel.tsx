import type { TowerSpend } from '@aoc/contracts';
import { Link } from 'react-router-dom';
import { Icon, Money, Widget, formatPercent, formatShortDate, formatUsd, useNow } from '../../components';
import { cx } from '../../lib/dom';
import { bulletScale, capOutlook, orderModelMix, periodEndOf, shareText, tierLabel } from './towerModel';

/** Ordinal greys for the model mix: darkest = highest tier. */
const MIX_CLASS = ['tower-mm__seg--t1', 'tower-mm__seg--t2', 'tower-mm__seg--t3', 'tower-mm__seg--t4'];

/**
 * Today's notional spend (USD with RM alongside, always labelled notional — §10), its split by project and
 * model tier, discovery vs execution runs, and the credit-cap forecast (capacity planning, never a ranking).
 */
export function SpendPanel({ spend }: { spend: TowerSpend }) {
  const now = useNow();
  const scaleTop = bulletScale(spend.notionalUsdToday, spend.avg7dUsd);
  const vsAvg = spend.avg7dUsd > 0 ? (spend.notionalUsdToday - spend.avg7dUsd) / spend.avg7dUsd : null;
  const mix = orderModelMix(spend.modelMix);
  const projectTop = Math.max(1e-9, ...spend.byProject.map((p) => p.usdToday));
  const projectTotal = spend.byProject.reduce((n, p) => n + p.usdToday, 0);
  const runs = spend.discoveryRuns7d + spend.executionRuns7d;
  const periodEnd = periodEndOf(now);
  const monthName = new Date(periodEnd).toLocaleString('en-US', { month: 'long' });

  return (
    <Widget
      title="Spend and capacity"
      subtitle="Notional API-equivalent cost, not a bill"
      info="Metering observes and never gates (§10). On a Max plan there is no per-token bill; RM uses each day's stamped BNM rate."
      actions={
        <span className="tower-actions">
          <Link to="/metering" className="tower-link">
            Metering
          </Link>
          <Link to="/credits" className="tower-link">
            Credits
          </Link>
        </span>
      }
      flush
      className="tower-spend"
    >
      <div className="tower-spend__grid">
        <div className="tower-spend__col">
          <div>
            <h3 className="tower-minihead">Notional spend today</h3>
            <p className="tower-bigfig">
              <Money usd={spend.notionalUsdToday} myr={spend.notionalRmToday} notional />
            </p>
            {vsAvg !== null && (
              <p className="tower-spend__vs">
                <Icon name={vsAvg <= 0 ? 'arrow-down' : 'arrow-up'} size={12} />
                {formatPercent(Math.abs(vsAvg))} {vsAvg <= 0 ? 'below' : 'above'} the 7-day average of{' '}
                <span className="aoc-num">{formatUsd(spend.avg7dUsd)}</span>
              </p>
            )}
            <div
              className="tower-bullet"
              role="img"
              aria-label={`Today ${formatUsd(spend.notionalUsdToday)} against a 7-day average of ${formatUsd(spend.avg7dUsd)}.`}
            >
              <span
                className="tower-bullet__bar"
                style={{ width: `${Math.min(100, (spend.notionalUsdToday / scaleTop) * 100)}%` }}
              />
              <span className="tower-bullet__mark" style={{ left: `${Math.min(100, (spend.avg7dUsd / scaleTop) * 100)}%` }} />
            </div>
            <p className="tower-bullet__axis" aria-hidden="true">
              <span>US$0</span>
              <span className="tower-bullet__avg" style={{ left: `${Math.min(100, (spend.avg7dUsd / scaleTop) * 100)}%` }}>
                7-day avg
              </span>
              <span>{formatUsd(scaleTop, { decimals: 0 })}</span>
            </p>
          </div>
          <div>
            <h3 className="tower-minihead">Model mix today</h3>
            {mix.length === 0 ? (
              <p className="tower-note">No model usage recorded today.</p>
            ) : (
              <>
                <div
                  className="tower-mm"
                  role="img"
                  aria-label={`Model mix of today's notional spend: ${mix
                    .map((m) => `${tierLabel(m.tier)} ${shareText(m.pct)} (${formatUsd(m.usdToday)})`)
                    .join(', ')}.`}
                >
                  {mix.map((m, i) => (
                    <span
                      key={m.tier}
                      className={cx('tower-mm__seg', MIX_CLASS[Math.min(i, MIX_CLASS.length - 1)])}
                      style={{ flexGrow: Math.max(m.usdToday, 0.001) }}
                    />
                  ))}
                </div>
                <ul className="tower-legend tower-legend--stack">
                  {mix.map((m, i) => (
                    <li key={m.tier}>
                      <span
                        className={cx('tower-sw', MIX_CLASS[Math.min(i, MIX_CLASS.length - 1)])}
                        aria-hidden="true"
                      />
                      {tierLabel(m.tier)} <b className="aoc-num">{shareText(m.pct)}</b>{' '}
                      <span className="aoc-num">{formatUsd(m.usdToday)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>

        <div className="tower-spend__col">
          <div>
            <h3 className="tower-minihead">By project today</h3>
            {spend.byProject.length === 0 ? (
              <p className="tower-note">No project has spend today.</p>
            ) : (
              <dl className="tower-hbars">
                {spend.byProject.map((p) => (
                  <div key={p.projectId} className="tower-hbars__row">
                    <dt>
                      <Link to={`/projects/${encodeURIComponent(p.projectId)}`}>{p.name}</Link>
                    </dt>
                    <dd className="tower-hbar" aria-hidden="true">
                      <span style={{ width: `${(p.usdToday / projectTop) * 100}%` }} />
                    </dd>
                    <dd className="tower-hbar__v aoc-num">
                      <b>{formatUsd(p.usdToday)}</b> {projectTotal > 0 ? shareText((p.usdToday / projectTotal) * 100) : ''}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
          <div>
            <h3 className="tower-minihead">
              <Link to="/registry">Discovery vs execution · 7 days</Link>
            </h3>
            {runs === 0 ? (
              <p className="tower-note">No runs in the last 7 days.</p>
            ) : (
              <>
                <div
                  className="tower-mm"
                  role="img"
                  aria-label={`Runs in the last 7 days: ${spend.discoveryRuns7d} discovery, ${spend.executionRuns7d} execution${
                    spend.savingsPct !== null ? `; execution runs cost ${Math.round(spend.savingsPct)}% less` : ''
                  }.`}
                >
                  {spend.discoveryRuns7d > 0 && (
                    <span className="tower-mm__seg tower-mm__seg--disc" style={{ flexGrow: spend.discoveryRuns7d }} />
                  )}
                  {spend.executionRuns7d > 0 && (
                    <span className="tower-mm__seg tower-mm__seg--exec" style={{ flexGrow: spend.executionRuns7d }} />
                  )}
                </div>
                <ul className="tower-legend tower-legend--stack">
                  <li>
                    <span className="tower-sw tower-mm__seg--disc" aria-hidden="true" />
                    Discovery <b className="aoc-num">{spend.discoveryRuns7d}</b> runs on Opus
                  </li>
                  <li>
                    <span className="tower-sw tower-mm__seg--exec" aria-hidden="true" />
                    Execution <b className="aoc-num">{spend.executionRuns7d}</b> runs on playbooks
                    {spend.savingsPct !== null ? (
                      <>
                        {' '}
                        · <b className="aoc-num">{Math.round(spend.savingsPct)}%</b> cheaper per run
                      </>
                    ) : null}
                  </li>
                </ul>
              </>
            )}
          </div>
        </div>

        <div className="tower-spend__col tower-spend__col--caps">
          <h3 className="tower-minihead">Credit cap forecast · {monthName} period</h3>
          <p className="tower-note">
            Capacity planning, not a ranking: who runs out of credits before{' '}
            <span className="aoc-num">{formatShortDate(periodEnd)}</span> at today's burn rate.
          </p>
          {spend.capForecast.length === 0 ? (
            <p className="tower-note">Every developer's credits last the period at today's burn rate.</p>
          ) : (
            <>
              <div className="tower-cap__axis" aria-hidden="true">
                <span />
                <span className="tower-cap__scale">
                  <i style={{ left: 0 }}>today</i>
                  <i style={{ left: `${capOutlook(null, now, periodEnd).endPct}%` }}>{formatShortDate(periodEnd)}</i>
                </span>
                <span />
              </div>
              <ol className="tower-caps">
                {spend.capForecast.map((c) => {
                  const o = capOutlook(c.projectedCapAt, now, periodEnd);
                  const name = c.name ?? 'Unnamed developer';
                  const when =
                    o.kind === 'today'
                      ? 'caps today'
                      : o.kind === 'before_end' && o.at !== null
                        ? `caps ${formatShortDate(o.at)}`
                        : 'lasts the period';
                  const risk = o.kind !== 'lasts';
                  return (
                    <li key={c.userId} className={cx('tower-cap', risk && 'is-risk')}>
                      <p className="tower-cap__name">
                        <b>{name}</b>
                        <span className="aoc-num">
                          {formatUsd(c.balanceUsd)} left · {formatUsd(c.burnPerDayUsd)}/day
                        </span>
                      </p>
                      <div
                        className="tower-cap__track"
                        role="img"
                        aria-label={`${name}: ${formatUsd(c.balanceUsd)} left at ${formatUsd(c.burnPerDayUsd)} a day; ${when}.`}
                      >
                        <span className="tower-cap__bar" style={{ width: `${o.barPct}%` }} />
                        <span className="tower-cap__end" style={{ left: `${o.endPct}%` }} />
                      </div>
                      <p className="tower-cap__when">
                        {risk && <Icon name="warn" size={12} className="tower-tone--warn" />}
                        {when}
                      </p>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </div>
      </div>
    </Widget>
  );
}
