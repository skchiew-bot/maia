import type { CSSProperties } from 'react';
import type { MeteringCostRow, MeteringGroupBy, MeteringSummaryDTO, MeteringSummaryRow } from '@aoc/contracts';
import type { ResourceState } from '../../api/useResource';
import { Icon, ResourceView, SegmentedControl, Widget } from '../../components';
import { formatInteger, formatMyr, formatPercent, formatTokens, formatUsd } from '../../lib/format';
import { tokenTypes } from './meteringModel';

export type BreakdownDim = Extract<MeteringGroupBy, 'project' | 'model' | 'processType' | 'actor'>;

const DIMENSIONS: { value: BreakdownDim; label: string }[] = [
  { value: 'project', label: 'Project' },
  { value: 'model', label: 'Model' },
  { value: 'processType', label: 'Process type' },
  { value: 'actor', label: 'Person' },
];

export interface BreakdownPanelProps {
  dim: BreakdownDim;
  onDim: (dim: BreakdownDim) => void;
  summary: ResourceState<MeteringSummaryDTO>;
  labelOf: (dim: BreakdownDim, row: MeteringSummaryRow) => string;
}

function Unpriced({ row }: { row: MeteringSummaryRow }) {
  if (!row.unpriced) return null;
  return (
    <span className="met-flag">
      <Icon name="warn" size={12} />
      {formatTokens(row.unpricedTokens)} unpriced
    </span>
  );
}

/** Notional cost by project, model or process type (bars, largest first); people are a name-ordered list. */
export function BreakdownPanel({ dim, onDim, summary, labelOf }: BreakdownPanelProps) {
  return (
    <Widget
      span={7}
      id="breakdown"
      title="Where the notional cost goes"
      subtitle="Same range and scope as the page"
      actions={<SegmentedControl label="Break down by" size="sm" value={dim} onChange={onDim} options={DIMENSIONS} />}
    >
      <ResourceView
        resource={summary}
        loadingText="Loading the breakdown…"
        isEmpty={(s) => s.rows.length === 0}
        empty={<p className="met-quiet">No metered usage in this range.</p>}
      >
        {(s) => {
          const rows = s.rows.filter((r) => r.notionalUsd > 0 || r.totalTokens > 0);
          if (dim === 'actor')
            return (
              <>
                <p className="met-quiet">
                  Listed by name, never ranked: metering supports decisions about the platform, not about people.
                </p>
                <table className="met-people">
                  <caption className="aoc-sr-only">Notional cost per person, in name order</caption>
                  <thead>
                    <tr>
                      <th scope="col">Person</th>
                      <th scope="col" className="is-end">
                        Notional
                      </th>
                      <th scope="col" className="is-end">
                        Tokens
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...rows]
                      .sort((a, b) => labelOf(dim, a).localeCompare(labelOf(dim, b)))
                      .map((r) => (
                        <tr key={r.key ?? 'unknown'}>
                          <th scope="row">{labelOf(dim, r)}</th>
                          <td className="is-end aoc-num">
                            {formatUsd(r.notionalUsd)}
                            {r.notionalRm !== null && <span className="met-sub">{formatMyr(r.notionalRm)}</span>}
                          </td>
                          <td className="is-end aoc-num">
                            {formatTokens(r.totalTokens)}
                            <Unpriced row={r} />
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </>
            );
          const max = Math.max(...rows.map((r) => r.notionalUsd), 1e-9);
          const total = s.totals.notionalUsd;
          return (
            <ul className="met-bars" aria-label={`Notional cost by ${DIMENSIONS.find((d) => d.value === dim)?.label.toLowerCase()}`}>
              {rows.map((r) => (
                <li key={r.key ?? 'unknown'} className="met-bars__row">
                  <span className="met-bars__label">{labelOf(dim, r)}</span>
                  <span className="met-bars__track" aria-hidden="true">
                    <span className="met-bars__fill" style={{ '--v': r.notionalUsd / max } as CSSProperties} />
                  </span>
                  <span className="met-bars__value aoc-num">
                    <b>{formatUsd(r.notionalUsd)}</b>
                    <span className="met-sub">
                      {total > 0 ? formatPercent(r.notionalUsd / total) : '—'}
                      {r.notionalRm !== null ? ` · ${formatMyr(r.notionalRm)}` : ''} · {formatTokens(r.totalTokens)} tokens
                    </span>
                    <Unpriced row={r} />
                  </span>
                </li>
              ))}
            </ul>
          );
        }}
      </ResourceView>
    </Widget>
  );
}

/** Token types (§10): input, output, cache read and cache write (5-minute and 1-hour), with shares. */
export function TokenTypesPanel({ totals }: { totals: MeteringCostRow }) {
  const rows = tokenTypes(totals);
  const max = Math.max(...rows.map((r) => r.tokens), 1);
  return (
    <Widget
      span={5}
      id="tokens"
      title="Token types"
      subtitle={`${formatTokens(totals.totalTokens)} tokens · ${formatInteger(totals.messages)} messages`}
      info="Cache reads are priced far below fresh input on the rate card, so a high cache-read share keeps notional cost down."
    >
      <ul className="met-bars" aria-label="Tokens by type">
        {rows.map((r) => (
          <li key={r.id} className="met-bars__row">
            <span className="met-bars__label">{r.label}</span>
            <span className="met-bars__track" aria-hidden="true">
              <span className="met-bars__fill met-bars__fill--tokens" style={{ '--v': r.tokens / max } as CSSProperties} />
            </span>
            <span className="met-bars__value aoc-num">
              <b>{formatTokens(r.tokens)}</b>
              <span className="met-sub">{formatPercent(r.share, r.share > 0 && r.share < 0.01 ? 1 : 0)}</span>
            </span>
          </li>
        ))}
      </ul>
    </Widget>
  );
}
