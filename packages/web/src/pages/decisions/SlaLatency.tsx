import { Icon } from '../../components/Icon';
import { cx } from '../../lib/dom';
import { formatAge, formatInteger } from '../../lib/format';
import type { KindLatency } from './model';

const SCALE = 2;
const pct = (ms: number, sla: number) => `${(Math.min(ms / sla, SCALE) / SCALE) * 100}%`;

/**
 * Time to decide per kind, each row scaled to its own SLA (0 → 2× SLA) so every SLA line sits in the same
 * place (approved mock, "Decision latency"): a solid bar to p50, a whisker to p90, the SLA line in the middle.
 * Kinds without an agreed SLA print their numbers without a bar. Every value is also text.
 */
export function SlaLatency({ rows }: { rows: readonly KindLatency[] }) {
  return (
    <div className="dec-lat">
      <div className="dec-lat__axis" aria-hidden="true">
        <span />
        <span className="dec-lat__scale">
          <i style={{ left: 0 }}>0</i>
          <i style={{ left: '50%' }}>SLA</i>
          <i style={{ left: '100%' }}>2× SLA</i>
        </span>
        <span />
      </div>
      <ol className="dec-lat__rows">
        {rows.map((r) => {
          const summary = `${r.label}: p50 ${formatAge(r.p50Ms)}, p90 ${formatAge(r.p90Ms)}${
            r.slaMs !== null
              ? `, SLA ${formatAge(r.slaMs)}, ${formatInteger(r.breaches ?? 0)} over SLA`
              : ', no SLA agreed'
          }, ${formatInteger(r.total)} resolved.`;
          return (
            <li key={r.kind} className="dec-lat__row">
              <p className="dec-lat__kind">
                {r.label}
                <span>{formatInteger(r.total)} resolved</span>
              </p>
              {r.slaMs !== null ? (
                <div className="dec-lat__track" role="img" aria-label={summary}>
                  <span className="dec-lat__p50" style={{ width: pct(r.p50Ms, r.slaMs) }} />
                  <span
                    className="dec-lat__p90"
                    style={{
                      left: pct(r.p50Ms, r.slaMs),
                      width: `calc(${pct(r.p90Ms, r.slaMs)} - ${pct(r.p50Ms, r.slaMs)})`,
                    }}
                  />
                  <span className="dec-lat__sla" />
                  {r.p90Ms > SCALE * r.slaMs && <span className="dec-lat__clip">›</span>}
                </div>
              ) : (
                <p className="dec-lat__track dec-lat__track--none">No SLA agreed for this kind</p>
              )}
              <p className="dec-lat__txt aoc-num" aria-hidden={r.slaMs !== null || undefined}>
                p50 <b>{formatAge(r.p50Ms)}</b> · p90 <b>{formatAge(r.p90Ms)}</b>
                {r.slaMs !== null ? ` · SLA ${formatAge(r.slaMs)}` : ' · no SLA agreed'}
              </p>
              <p className={cx('dec-lat__br', (r.breaches ?? 0) > 0 && 'is-on')} aria-hidden="true">
                {r.breaches === null ? (
                  <span className="dec-muted">—</span>
                ) : r.breaches > 0 ? (
                  <>
                    <Icon name="warn" size={12} />
                    {formatInteger(r.breaches)} over
                  </>
                ) : (
                  <>
                    <Icon name="ok" size={12} />
                    within
                  </>
                )}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
