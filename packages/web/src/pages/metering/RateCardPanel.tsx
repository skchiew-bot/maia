import { useState } from 'react';
import type {
  MeteringSubscriptionDTO,
  RateCardDTO,
  RateCardRate,
  RateCardVersionDTO,
  RateCardVersionsDTO,
} from '@aoc/contracts';
import { Badge, Button, CopyableHash, Icon, Widget } from '../../components';
import { formatNumber, formatShortDate, formatUsd } from '../../lib/format';
import { dayLabel } from './meteringModel';
import { PRICE_FIELDS, RateCardDialog, type RateCardDraft } from './RateCardDialog';

export interface RateCardPanelProps {
  card: RateCardDTO;
  versions?: RateCardVersionsDTO;
  subscription?: MeteringSubscriptionDTO;
  /** ratecard.edit (Approver). The daemon enforces it; this only hides what the viewer cannot do. */
  canEdit: boolean;
  nameOf: (userId: string | null) => string | null;
  onPublish: (draft: RateCardDraft) => Promise<RateCardVersionDTO>;
}

const STATUS_TONE = { active: 'ok', scheduled: 'info', superseded: 'neutral' } as const;
const price = (v: number) => (v < 1 ? formatNumber(v, v < 0.1 ? 3 : 2) : formatNumber(v, 2));

function RatesTable({ version }: { version: RateCardVersionDTO }) {
  const fallbackFor = (model: string) =>
    Object.entries(version.tierFallback)
      .filter(([, m]) => m?.toLowerCase() === model.toLowerCase())
      .map(([tier]) => tier);
  if (version.erased) return <p className="met-quiet">This version&rsquo;s rates were erased; only its hash remains.</p>;
  const name = `Rate card v${version.version}, US dollars per million tokens`;
  const model = (r: RateCardRate) => (
    <>
      <code>{r.model}</code>
      {fallbackFor(r.model).length > 0 && <span className="met-sub">fallback for {fallbackFor(r.model).join(', ')}</span>}
    </>
  );
  return (
    <>
      <div className="met-scroll met-rates-wide">
        <table className="met-rates">
          <caption className="aoc-sr-only">{name}</caption>
          <thead>
            <tr>
              <th scope="col">Model</th>
              {PRICE_FIELDS.map(([f, label]) => (
                <th key={f} scope="col" className="is-end">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {version.rates.map((r) => (
              <tr key={r.model}>
                <th scope="row">{model(r)}</th>
                {PRICE_FIELDS.map(([f]) => (
                  <td key={f} className="is-end aoc-num">
                    {price(r[f])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Phones: the same prices as labelled groups, so the card never scrolls sideways. */}
      <ul className="met-rates-list" aria-label={name}>
        {version.rates.map((r) => (
          <li key={r.model}>
            <p className="met-rates-list__model">{model(r)}</p>
            <dl>
              {PRICE_FIELDS.map(([f, label]) => (
                <div key={f}>
                  <dt>{label}</dt>
                  <dd className="aoc-num">{price(r[f])}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Rate card (§10, R12): versioned notional prices. A change applies forward only — from tomorrow and after the
 * last closed day — so a closed day is never restated.
 */
export function RateCardPanel({ card, versions, subscription, canEdit, nameOf, onPublish }: RateCardPanelProps) {
  const [editing, setEditing] = useState(false);
  const all = versions?.versions ?? [card.active, ...card.scheduled].filter((v): v is RateCardVersionDTO => v !== null);
  const latest = [...all].sort((a, b) => b.version - a.version)[0] ?? null;
  const [shown, setShown] = useState<number | null>(null);
  const version = all.find((v) => v.version === shown) ?? card.active ?? latest;
  const sub = subscription?.active ?? null;
  return (
    <Widget
      span={12}
      id="rate-card"
      title="Rate card"
      subtitle="Notional API-equivalent list prices, US$ per million tokens"
      actions={
        canEdit ? (
          <Button size="sm" icon="plus" onClick={() => setEditing(true)}>
            Schedule a new version
          </Button>
        ) : (
          <span className="met-quiet">Only an Approver can change the rate card</span>
        )
      }
    >
      <p className="met-forward">
        <Icon name="info" size={14} />
        <span>
          <b>Forward only.</b> Today is {dayLabel(card.today)}
          {card.lastClosedDay ? `, the last closed day is ${dayLabel(card.lastClosedDay)}` : ''}: a new version can take
          effect from <b>{dayLabel(card.earliestEffectiveFrom)}</b> at the earliest. Closed days keep the version they
          were frozen with and are never restated.
        </span>
      </p>
      <div className="met-card-grid">
        <div className="met-card-main">
          {version ? (
            <>
              <p className="met-card-head">
                <b>v{version.version}</b>
                <Badge tone={STATUS_TONE[version.status]} icon={version.status === 'active' ? 'ok' : version.status === 'scheduled' ? 'clock' : undefined}>
                  {version.status}
                </Badge>
                <span className="met-sub-inline">
                  effective {dayLabel(version.effectiveFrom)} · published {formatShortDate(version.publishedAt)} by{' '}
                  {nameOf(version.publishedBy) ?? (version.publishedBy === 'metering' ? 'the rate-card file' : 'an Approver')}
                </span>
              </p>
              <RatesTable version={version} />
              {version.note && <p className="met-note">{version.note}</p>}
              <p className="met-quiet">
                Rates hash <CopyableHash value={version.ratesHash} label={`rate card v${version.version} hash`} />
              </p>
            </>
          ) : (
            <p className="met-quiet">No rate card is published yet: all usage is unpriced until one is.</p>
          )}
        </div>
        <div className="met-card-side">
          <h3 className="met-h3">Versions</h3>
          <ol className="met-versions">
            {[...all]
              .sort((a, b) => b.version - a.version)
              .map((v) => (
                <li key={v.version}>
                  <button
                    type="button"
                    className="met-versions__btn"
                    aria-pressed={version?.version === v.version}
                    onClick={() => setShown(v.version)}
                  >
                    <b>v{v.version}</b> <span className="aoc-num">from {formatShortDate(v.effectiveFrom)}</span>
                    <Badge tone={STATUS_TONE[v.status]}>{v.status}</Badge>
                  </button>
                </li>
              ))}
          </ol>
          <h3 className="met-h3">Subscription · actual money</h3>
          {sub ? (
            <p className="met-quiet aoc-num">
              {sub.plan} plan · {sub.seats} seats × {formatUsd(sub.monthlyUsdPerSeat, { decimals: 0 })} ={' '}
              <b>{formatUsd(sub.monthlyUsd, { decimals: 0 })}/month</b> since {formatShortDate(sub.effectiveFrom)}. Shown
              apart from the notional cost; it is never added to it.
            </p>
          ) : (
            <p className="met-quiet">{subscription ? 'No subscription recorded.' : 'Team view only.'}</p>
          )}
        </div>
      </div>
      {canEdit && (
        <RateCardDialog
          open={editing}
          onClose={() => setEditing(false)}
          base={latest}
          earliestEffectiveFrom={card.earliestEffectiveFrom}
          onPublish={onPublish}
        />
      )}
    </Widget>
  );
}
