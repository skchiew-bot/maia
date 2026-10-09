import { Link } from 'react-router-dom';
import type { DecisionCardView, FxRateDTO, FxStatusDTO } from '@aoc/contracts';
import { Badge, InlineAlert, RelativeTime, Widget } from '../../components';
import { formatShortDate } from '../../lib/format';
import { FxHistoryChart } from './FxHistoryChart';
import { carryForwardState, dayLabel, fxExtractorText, fxReasonText, fxSessionLabel } from './meteringModel';

export interface FxPanelProps {
  status: FxStatusDTO;
  rates: readonly FxRateDTO[];
  /** fx_discrepancy decisions (open and closed), newest first. */
  tickets: readonly DecisionCardView[];
}

/**
 * USD→MYR (§10): today's stamp and source, the history with carried-forward days flagged, the consecutive
 * carried-forward warning, and discrepancy tickets with both figures. Source: Bank Negara Malaysia.
 */
export function FxPanel({ status, rates, tickets }: FxPanelProps) {
  const today = status.todayRecord;
  const cf = carryForwardState(status);
  const open = status.openDiscrepancy;
  const session = fxSessionLabel(today?.session);
  const discrepancyDates = new Set(tickets.map((t) => t.subjectId));
  return (
    <Widget
      span={12}
      id="fx"
      title="FX · USD→MYR"
      subtitle="Source: Bank Negara Malaysia · one rate per day, stamped live or inherited with its source date"
    >
      <div className="met-fxhead">
        <div className="met-fig">
          <span className="met-fig__value">{status.current ? status.current.rate.toFixed(4) : '—'}</span>
          <span className="met-fig__label">
            {status.current
              ? status.current.status === 'live'
                ? `live today${today ? `, ${fxReasonText(today.reason)}` : ''}`
                : `inherited from ${formatShortDate(status.current.sourceDate)}`
              : 'no rate yet'}
          </span>
        </div>
        <dl className="met-fxfacts">
          <div>
            <dt>BNM session</dt>
            <dd>{session ?? 'not recorded with the rate'}</dd>
          </div>
          <div>
            <dt>Extracted by</dt>
            <dd>{today ? fxExtractorText(today.extractor) : '—'}</dd>
          </div>
          <div>
            <dt>Daily fetch</dt>
            <dd>
              {status.enabled ? `${status.runAtLocalTime} (daemon local time)` : 'off in this deployment'}
            </dd>
          </div>
          <div>
            <dt>Last live rate</dt>
            <dd className="aoc-num">
              {status.lastLive ? `${status.lastLive.rate.toFixed(4)} · ${formatShortDate(status.lastLive.date)}` : '—'}
            </dd>
          </div>
          <div>
            <dt>Carried forward</dt>
            <dd>
              {cf.days} weekday{cf.days === 1 ? '' : 's'} in a row · manual check at {cf.threshold}
            </dd>
          </div>
        </dl>
      </div>

      {cf.level !== 'none' && (
        <InlineAlert
          tone={cf.level === 'alert' ? 'danger' : 'warn'}
          title={
            cf.level === 'alert'
              ? `FX carried forward ${cf.days} weekdays in a row: check BNM manually`
              : `FX carried forward ${cf.days} weekday${cf.days === 1 ? '' : 's'} in a row`
          }
        >
          Since {cf.since ? dayLabel(cf.since) : '—'}. Weekends and public holidays carry forward by design and do not
          count; {cf.threshold} weekdays without a live rate raise a manual check
          {status.carryForward.alerted ? ' (raised).' : '.'}
        </InlineAlert>
      )}

      {open && (
        <div className="met-ticket is-open">
          <p className="met-ticket__head">
            <Badge tone="warn" icon="warn">
              Discrepancy open
            </Badge>
            <b>{dayLabel(open.date)}</b>
            <span className="met-sub-inline">
              raised <RelativeTime value={open.raisedAt} suffix=" ago" />
            </span>
          </p>
          <p className="met-ticket__figs aoc-num">
            Scraped <b>{open.scraped.toFixed(4)}</b>
            {open.extractor ? ` (${open.extractor})` : ''} vs BNM published <b>{open.official.toFixed(4)}</b> · difference{' '}
            {Math.abs(open.scraped - open.official).toFixed(4)}
          </p>
          <p className="met-quiet">
            The day stays carried forward until a human chooses a figure.{' '}
            {status.openDiscrepancyCount > 1 ? `${status.openDiscrepancyCount} discrepancies are open. ` : ''}
            <Link to="/decisions">Review the decision</Link>
          </p>
        </div>
      )}

      {rates.length > 0 ? (
        <FxHistoryChart rates={rates} discrepancyDates={discrepancyDates} />
      ) : (
        <p className="met-quiet">No rates recorded in this range.</p>
      )}

      <h3 className="met-h3">Discrepancy tickets</h3>
      {tickets.length === 0 ? (
        <p className="met-quiet">
          None. A ticket is raised only when a scraped rate passes validation but disagrees with BNM&rsquo;s published
          figure after one re-fetch; an unreadable source just carries the rate forward.
        </p>
      ) : (
        <ul className="met-tickets">
          {tickets.map((t) => (
            <li key={t.id} className="met-ticket">
              <p className="met-ticket__head">
                <Badge tone={t.status === 'open' ? 'warn' : 'neutral'} icon={t.status === 'open' ? 'warn' : 'check'}>
                  {t.status}
                </Badge>
                <b>{t.title}</b>
              </p>
              <p className="met-sub-inline">
                {t.status === 'open' ? (
                  <>
                    waiting <RelativeTime value={t.createdAt} />
                  </>
                ) : (
                  <>
                    closed {t.closedAt ? formatShortDate(t.closedAt) : '—'}
                    {t.resolution ? ` · ${t.options.find((o) => o.id === t.resolution!.optionId)?.label ?? t.resolution.optionId}` : ''}
                  </>
                )}{' '}
                · <Link to="/decisions">decision</Link>
              </p>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}
