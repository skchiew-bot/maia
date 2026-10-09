import type { FxRateDTO, MeteringDayDTO } from '@aoc/contracts';
import { Badge, DataTable, EmptyState, Icon, Widget, type DataTableColumn } from '../../components';
import { formatMyr, formatTokens, formatUsd } from '../../lib/format';
import { dayLabel, formatIdle, fxSessionLabel, fxStampText } from './meteringModel';

export interface DailyRollupsProps {
  /** Metered days, newest first. */
  days: readonly MeteringDayDTO[];
  fxByDate: ReadonlyMap<string, FxRateDTO>;
  lastClosedDay: string | null;
  scope: 'org' | 'mine';
}

/** Daily USD and RM rollups, each stamped with its FX status and source date (§10). Closed days are frozen. */
export function DailyRollups({ days, fxByDate, lastClosedDay, scope }: DailyRollupsProps) {
  const columns: DataTableColumn<MeteringDayDTO>[] = [
    {
      id: 'date',
      header: 'Day',
      primary: true,
      sortValue: (d) => d.date,
      firstSort: 'desc',
      cell: (d) => <span className="aoc-num">{dayLabel(d.date)}</span>,
    },
    {
      id: 'status',
      header: 'Rollup',
      cell: (d) =>
        d.status === 'closed' ? (
          <Badge icon="check" variant="outline">
            Closed · frozen
          </Badge>
        ) : (
          <Badge icon="clock">Open · metering</Badge>
        ),
    },
    {
      id: 'usd',
      header: 'Notional US$',
      numeric: true,
      sortValue: (d) => d.notionalUsd,
      cell: (d) => formatUsd(d.notionalUsd),
    },
    {
      id: 'rm',
      header: 'Notional RM',
      numeric: true,
      sortValue: (d) => d.notionalRm,
      cell: (d) => (d.notionalRm === null ? <span className="met-muted">no rate</span> : formatMyr(d.notionalRm)),
    },
    {
      id: 'fx',
      header: 'FX stamp',
      cell: (d) => {
        const rec = fxByDate.get(d.date);
        const session = fxSessionLabel(rec?.session);
        return (
          <span className="met-stamp">
            <span className="aoc-num">{d.fx.rate !== null ? d.fx.rate.toFixed(4) : '—'}</span>
            <span className={`met-stamp__word met-stamp__word--${d.fx.status}${rec?.flagged ? ' is-flagged' : ''}`}>
              {rec?.flagged && <Icon name="warn" size={12} />}
              {fxStampText(d.fx)}
            </span>
            {session && <span className="met-sub">BNM {session}</span>}
          </span>
        );
      },
    },
    {
      id: 'card',
      header: 'Rate card',
      align: 'center',
      sortValue: (d) => d.rateCardVersion,
      cell: (d) => (d.rateCardVersion > 0 ? `v${d.rateCardVersion}` : <span className="met-muted">none</span>),
    },
    {
      id: 'throttle',
      header: 'Throttle idle',
      numeric: true,
      sortValue: (d) => d.throttleIdleMs,
      cell: (d) => (d.throttleIdleMs > 0 ? `${formatIdle(d.throttleIdleMs)} · ${d.throttleHits}×` : <span className="met-muted">—</span>),
    },
    {
      id: 'unpriced',
      header: 'Unpriced',
      numeric: true,
      sortValue: (d) => d.unpricedTokens,
      cell: (d) =>
        d.unpriced ? (
          <span className="met-flag">
            <Icon name="warn" size={12} />
            {formatTokens(d.unpricedTokens)}
          </span>
        ) : (
          <span className="met-muted">—</span>
        ),
    },
  ];
  return (
    <Widget
      span={12}
      id="rollups"
      title="Daily rollups"
      subtitle={`USD and RM per day at that day's BNM rate${lastClosedDay ? ` · last closed day ${dayLabel(lastClosedDay)}` : ''}${
        scope === 'mine' ? ' · your sessions only' : ''
      }`}
      info="A closed day is frozen with the rate-card version and FX stamp it used; later rate changes never restate it."
      flush
    >
      <DataTable
        caption="Daily rollups with FX stamps"
        columns={columns}
        rows={days}
        rowKey={(d) => d.date}
        defaultSort={{ columnId: 'date', direction: 'desc' }}
        maxHeight={360}
        rowTone={(d) => (d.unpriced ? 'warn' : undefined)}
        empty={<EmptyState size="sm" title="No metered days in this range" body="Daily rollups start on the first day with usage." />}
      />
    </Widget>
  );
}
