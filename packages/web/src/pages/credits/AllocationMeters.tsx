import type { CSSProperties } from 'react';
import type { CreditAccount } from '@aoc/contracts';
import { Badge, Button, Icon, RelativeTime } from '../../components';
import { cx } from '../../lib/dom';
import { formatPercent, formatShortDate, formatUsd } from '../../lib/format';
import {
  CAP_STATE_TEXT,
  capState,
  forecast,
  headroomTotal,
  topupAging,
  type CapState,
  type PeriodClock,
} from './creditsModel';

export interface AllocationMetersProps {
  /** Accounts in name order (the daemon's order; never re-sorted by usage). */
  accounts: readonly CreditAccount[];
  clock: PeriodClock;
  meId: string | null;
  /** Approver action; omitted for viewers who cannot allocate. */
  onAllocate?: (account: CreditAccount) => void;
}

const STATE_TONE: Record<CapState, 'neutral' | 'info' | 'warn'> = {
  exempt: 'neutral',
  within: 'neutral',
  on_auto_grant: 'info',
  capped: 'warn',
  capped_waiting: 'warn',
};
const STATE_ICON = { exempt: 'info', within: 'ok', on_auto_grant: 'credits', capped: 'warn', capped_waiting: 'clock' } as const;

const usd = (v: number) => formatUsd(v);
const pct = (v: number, max: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;

/**
 * Credits hero: allocation vs usage per developer on one shared scale. The track is the allocation, then any
 * grants, then the unused once-per-period 25% auto-grant (dashed: not granted yet); the fill is notional usage;
 * the tick is where this period's pace lands by its last day. Capacity planning — listed by name, never ranked.
 */
export function AllocationMeters({ accounts, clock, meId, onAllocate }: AllocationMetersProps) {
  const scale = Math.max(
    1e-9,
    ...accounts.map((a) => Math.max(headroomTotal(a), a.usedUsd, forecast(a, clock).projectedUsd)),
  );
  return (
    <ul className="crd-meters" aria-label="Allocation and usage per person">
      {accounts.map((a) => {
        const state = capState(a);
        const f = forecast(a, clock);
        const funding = a.allocationUsd + a.grantedUsd;
        const reserve = a.autoGrantUsed || a.exempt ? 0 : a.autoGrantAvailableUsd;
        const aging = a.pendingTopup ? topupAging({ ageMs: a.pendingTopup.ageMs, status: 'pending' }) : null;
        const forecastText =
          f.status === 'closed'
            ? `period closed · ${usd(a.usedUsd)} used`
            : f.status === 'exempt'
              ? 'exempt: never capped'
              : f.status === 'capped'
                ? 'at cap: work pauses at the next task boundary'
                : f.status === 'cap_before_end'
                  ? `reaches the cap ~${formatShortDate(f.capDate!)} at this pace`
                  : `~${usd(f.projectedUsd)} by ${formatShortDate(clock.end)}${f.status === 'tight' ? ' · close to the allocation' : ' · on track'}`;
        const summary = `${a.userName ?? a.userId}: used ${usd(a.usedUsd)} of ${usd(a.allocationUsd)} allocation (${formatPercent(
          a.allocationUsd > 0 ? a.usedUsd / a.allocationUsd : 0,
        )}), granted ${usd(a.grantedUsd)}, balance ${usd(a.balanceUsd)}${
          reserve > 0 ? `, ${usd(reserve)} auto-grant available once` : a.autoGrantUsed ? ', auto-grant used' : ''
        }. ${CAP_STATE_TEXT[state]}. Forecast: ${forecastText}.`;
        return (
          <li key={a.userId} className={cx('crd-meter-row', state.startsWith('capped') && 'is-capped')}>
            <div className="crd-who">
              <b>{a.userName ?? a.userId}</b>
              {a.userId === meId && <span className="crd-you">you</span>}
              <Badge tone={STATE_TONE[state]} icon={STATE_ICON[state]}>
                {CAP_STATE_TEXT[state]}
              </Badge>
              {a.pendingTopup && aging && (
                <span className={cx('crd-aging', aging.overdue && 'is-overdue')}>
                  <Icon name="clock" size={12} />
                  Top-up {usd(a.pendingTopup.amountUsd)} waiting <RelativeTime value={a.pendingTopup.createdAt} />
                  {aging.overdue ? ' · past the 1h SLA' : ''}
                </span>
              )}
            </div>
            <div className="crd-meter" role="img" aria-label={summary}>
              <span className="crd-meter__alloc" style={{ width: pct(a.allocationUsd, scale) } as CSSProperties} />
              {a.grantedUsd > 0 && (
                <span
                  className="crd-meter__granted"
                  style={{ left: pct(a.allocationUsd, scale), width: pct(a.grantedUsd, scale) } as CSSProperties}
                />
              )}
              {reserve > 0 && (
                <span
                  className="crd-meter__reserve"
                  style={{ left: pct(funding, scale), width: pct(reserve, scale) } as CSSProperties}
                />
              )}
              <span
                className={cx('crd-meter__used', state.startsWith('capped') && 'is-capped')}
                style={{ width: pct(Math.min(a.usedUsd, scale), scale) } as CSSProperties}
              />
              {clock.current && !a.exempt && f.projectedUsd > a.usedUsd && (
                <span className="crd-meter__forecast" style={{ left: pct(f.projectedUsd, scale) } as CSSProperties} />
              )}
            </div>
            <div className="crd-nums">
              <span className="aoc-num">
                <b>{usd(a.usedUsd)}</b> of {usd(funding)}
                {a.grantedUsd > 0 ? ` (incl. ${usd(a.grantedUsd)} granted)` : ''}
                <span className="crd-sub"> · balance {usd(a.balanceUsd)}</span>
              </span>
              <span className="crd-sub">
                {a.exempt
                  ? 'exempt'
                  : a.autoGrantUsed
                    ? '25% auto-grant used this period'
                    : `25% auto-grant ${usd(a.autoGrantAvailableUsd)} available once`}
              </span>
              <span className={cx('crd-forecast', f.status === 'cap_before_end' && 'is-warn')}>
                {f.status === 'cap_before_end' && <Icon name="warn" size={12} />}
                {forecastText}
              </span>
            </div>
            {onAllocate && (
              <div className="crd-act">
                {a.userId === meId ? (
                  <span className="crd-sub">Your allocation is set by another Approver</span>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => onAllocate(a)}>
                    Set allocation<span className="aoc-sr-only"> for {a.userName ?? a.userId}</span>
                  </Button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Legend for the meters (shapes and words, not colour alone). */
export function MetersLegend() {
  return (
    <ul className="crd-legend" aria-label="Meter legend">
      <li>
        <span className="crd-sw crd-sw--used" aria-hidden="true" /> Used (notional)
      </li>
      <li>
        <span className="crd-sw crd-sw--alloc" aria-hidden="true" /> Allocation
      </li>
      <li>
        <span className="crd-sw crd-sw--granted" aria-hidden="true" /> Granted top-ups
      </li>
      <li>
        <span className="crd-sw crd-sw--reserve" aria-hidden="true" /> 25% auto-grant, not used yet
      </li>
      <li>
        <span className="crd-sw crd-sw--forecast" aria-hidden="true" /> Pace by period end
      </li>
    </ul>
  );
}
