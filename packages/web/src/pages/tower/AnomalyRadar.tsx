import type { AnomalySignal, TowerAnomaly } from '@aoc/contracts';
import { Chip, Icon, Widget } from '../../components';
import { cx } from '../../lib/dom';
import { TowerIcon } from './towerIcons';
import {
  ANOMALY_STATUS_WORD,
  formatRatio,
  formatSignalValue,
  orderAnomalies,
  radarMarks,
  scopeLabel,
} from './towerModel';

/** The seven gaming/anomaly signals in contract order (packages/contracts/src/dto/tower.ts). */
const SIGNAL_ORDER: readonly AnomalySignal[] = [
  'no_file_change_closes',
  'xs_heavy_manifests',
  'late_denominator_growth',
  'blind_affirm_rate',
  'discovery_with_playbook',
  'evidence_unverified',
  'self_approval_rate',
];

function SignalStatus({ status }: { status: TowerAnomaly['status'] }) {
  return (
    <span className={cx('tower-sig', `tower-sig--${status}`)}>
      {status === 'normal' ? (
        <Icon name="ok" size={13} />
      ) : status === 'watch' ? (
        <TowerIcon name="watch" size={13} />
      ) : (
        <Icon name="warn" size={13} />
      )}
      {ANOMALY_STATUS_WORD[status]}
    </span>
  );
}

/**
 * Gaming and anomaly radar: each signal indexed to its baseline on a shared 0–3× scale. Scopes are the
 * portfolio, a process type or a project — never a person (R11); a watch or alert opens a root-cause review.
 */
export function AnomalyRadar({ anomalies }: { anomalies: readonly TowerAnomaly[] }) {
  const rows = orderAnomalies(anomalies, SIGNAL_ORDER);
  return (
    <Widget
      title="Gaming and anomaly radar"
      subtitle="Portfolio level only · never ranked per person (R11)"
      flush
      className="tower-radar"
    >
      {rows.length === 0 ? (
        <p className="tower-note tower-note--pad">
          No signals computed yet: they need a few days of task, manifest and change-record history.
        </p>
      ) : (
        <>
          <div className="tower-rad tower-rad--axis" aria-hidden="true">
            <span>Signal</span>
            <span className="tower-rad__scale">
              <i style={{ left: 0 }}>0</i>
              <i style={{ left: '33.33%' }}>baseline</i>
              <i style={{ left: '66.67%' }}>2×</i>
              <i style={{ left: '100%' }}>3×</i>
            </span>
            <span>What it measures</span>
          </div>
          <ol className="tower-rads">
            {rows.map((a) => {
              const m = radarMarks(a);
              const value = formatSignalValue(a.value, a.unit);
              const baseline = a.baseline === null ? null : formatSignalValue(a.baseline, a.unit);
              const scope = scopeLabel(a.scope);
              const versus =
                m.ratio !== null
                  ? `, ${formatRatio(m.ratio)} the baseline of ${baseline}`
                  : m.note === 'zero_baseline'
                    ? ', above a zero baseline'
                    : baseline !== null
                      ? `, baseline ${baseline}`
                      : ', no baseline yet';
              const summary = `${a.label}: ${value}${versus}; status ${ANOMALY_STATUS_WORD[a.status].toLowerCase()}.`;
              return (
                <li key={a.signal} className={cx('tower-rad', `tower-rad--${a.status}`)}>
                  <div className="tower-rad__head">
                    <SignalStatus status={a.status} />
                    <p className="tower-rad__name">
                      {a.label}
                      <Chip>
                        {scope.kind && <span className="aoc-sr-only">{scope.kind} </span>}
                        <span title={scope.kind ?? undefined}>{scope.text}</span>
                      </Chip>
                    </p>
                  </div>
                  <div className="tower-rad__viz">
                    <div className="tower-rad__track" role="img" aria-label={summary}>
                      {m.barPct !== null && (
                        <span className={cx('tower-rad__bar', m.over && 'is-over')} style={{ width: `${m.barPct}%` }} />
                      )}
                      {m.showBaseline && <span className="tower-rad__base" />}
                    </div>
                    <p className="tower-rad__nums">
                      <b className="aoc-num">{value}</b>
                      {baseline !== null ? (
                        <>
                          {' '}
                          vs baseline <span className="aoc-num">{baseline}</span>
                        </>
                      ) : (
                        ' · no baseline yet'
                      )}
                      {m.ratio !== null ? (
                        <>
                          {' '}
                          · <b className="aoc-num">{formatRatio(m.ratio)}</b>
                          {m.over ? ' (off scale)' : ''}
                        </>
                      ) : m.note === 'zero_baseline' ? (
                        ' · above a zero baseline'
                      ) : null}
                    </p>
                  </div>
                  <p className="tower-rad__why">{a.explanation}</p>
                </li>
              );
            })}
          </ol>
          <p className="tower-rad__foot">
            <Icon name="info" size={14} />
            <span>
              Thresholds are set per signal on the absolute level and the sample size as well as the ratio, so a small
              sample can stay on watch at a high ratio. Signals point at process, specs and guardrails: a watch or
              alert opens a root-cause review, never a person's scorecard.
            </span>
          </p>
        </>
      )}
    </Widget>
  );
}
