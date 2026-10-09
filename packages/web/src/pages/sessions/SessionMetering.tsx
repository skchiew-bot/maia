import type { MeteringSessionDTO, RateCardDTO, SessionDetail } from '@aoc/contracts';
import { Icon } from '../../components/Icon';
import { Money } from '../../components/Money';
import { TokenCount } from '../../components/TokenCount';
import { formatAge, formatClock, formatInteger, formatNumber, formatPercent, formatTokens, formatUsd } from '../../lib/format';
import { ContextMeter } from './ContextMeter';
import { costByTokenType, TOKEN_TYPE_WORD, type TokenType } from './model';
import { modelLabel } from './sessionText';

export interface SessionMeteringProps {
  session: SessionDetail;
  metering: MeteringSessionDTO | undefined;
  rateCard: RateCardDTO | undefined;
  rolloverPct: number;
  fxRate: { rate: number; status: string; sourceDate: string } | null;
}

function Bars({ rows, format }: { rows: { label: string; value: number }[]; format: (v: number) => string }) {
  const max = Math.max(...rows.map((r) => r.value), 0);
  return (
    <ul className="session-bars">
      {rows.map((r) => (
        <li key={r.label} className="session-bars__row">
          <span className="session-bars__label">{r.label}</span>
          <span className="session-bars__track" aria-hidden="true">
            <span style={{ width: `${max > 0 ? (r.value / max) * 100 : 0}%` }} />
          </span>
          <span className="session-bars__value aoc-num">{format(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Metering for one session (§10): tokens by type and model, the notional API-equivalent cost in USD and RM
 * (decision support on a Max plan, never a bill), where that cost comes from, context pressure and throttling.
 */
export function SessionMetering({ session, metering, rateCard, rolloverPct, fxRate }: SessionMeteringProps) {
  const totals = metering?.totals;
  const tokenRows: { type: TokenType; value: number }[] = totals
    ? [
        { type: 'input', value: totals.inputTokens },
        { type: 'output', value: totals.outputTokens },
        { type: 'cacheRead', value: totals.cacheReadTokens },
        { type: 'cacheWrite', value: totals.cacheWriteTokens },
      ]
    : [];
  const split =
    metering && rateCard?.active ? costByTokenType(metering.byModel, rateCard.active, metering.totals.notionalUsd) : null;
  const usedModels = new Set(metering?.byModel.map((r) => r.key) ?? []);
  const rates = rateCard?.active?.rates.filter((r) => usedModels.has(r.model)) ?? [];

  return (
    <div className="session-metering">
      {totals ? (
        <>
          <p className="session-metering__total">
            <Money usd={totals.notionalUsd} myr={totals.notionalRm} className="session-metering__money" />
            <span className="session-metering__since">this session, since {formatClock(session.startedAt)}</span>
          </p>
          <div className="session-metering__scroll">
            <table className="session-mtable">
              <caption className="aoc-sr-only">Tokens and notional cost by model</caption>
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col" className="is-end">Input</th>
                  <th scope="col" className="is-end">Output</th>
                  <th scope="col" className="is-end">Cache read</th>
                  <th scope="col" className="is-end">Cache write</th>
                  <th scope="col" className="is-end">Notional</th>
                </tr>
              </thead>
              <tbody>
                {metering!.byModel.map((r) => (
                  <tr key={r.key ?? 'unknown'}>
                    <th scope="row">
                      {modelLabel(r.key) ?? 'Unknown'}
                      {r.unpriced && <span className="session-mtable__note">unpriced</span>}
                    </th>
                    <td className="is-end aoc-num"><TokenCount value={r.inputTokens} unit="" /></td>
                    <td className="is-end aoc-num"><TokenCount value={r.outputTokens} unit="" /></td>
                    <td className="is-end aoc-num"><TokenCount value={r.cacheReadTokens} unit="" /></td>
                    <td className="is-end aoc-num"><TokenCount value={r.cacheWriteTokens} unit="" /></td>
                    <td className="is-end aoc-num"><strong>{formatUsd(r.notionalUsd)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="session-metering__charts">
            <section aria-label="Tokens by type">
              <h3 className="session-minihead">Tokens by type</h3>
              <Bars
                rows={tokenRows.map((r) => ({ label: TOKEN_TYPE_WORD[r.type], value: r.value }))}
                format={(v) => `${formatTokens(v)} · ${formatPercent(totals.totalTokens > 0 ? v / totals.totalTokens : 0)}`}
              />
            </section>
            {split && (
              <section aria-label="Where the cost comes from">
                <h3 className="session-minihead">Where the cost comes from</h3>
                <Bars rows={split.map((p) => ({ label: TOKEN_TYPE_WORD[p.type], value: p.usd }))} format={(v) => formatUsd(v)} />
              </section>
            )}
          </div>
        </>
      ) : (
        <p className="session-empty-line">
          No token usage reported for this session yet. The sidecar meters every turn from the transcript.
        </p>
      )}

      <section aria-label="Context window" className="session-metering__ctx">
        <h3 className="session-minihead">
          Context
          <span className="session-minihead__value aoc-num">
            {session.contextTokens === null
              ? '—'
              : `${formatTokens(session.contextTokens)}${session.contextWindowTokens ? ` of ${formatTokens(session.contextWindowTokens)} tokens` : ''}${session.contextPct !== null ? ` · ${formatNumber(session.contextPct, 0)}%` : ''}`}
          </span>
        </h3>
        <ContextMeter
          pct={session.contextPct}
          rolloverPct={rolloverPct}
          tokens={session.contextTokens}
          windowTokens={session.contextWindowTokens}
          variant="panel"
        />
      </section>

      <p className="session-metering__foot">
        {metering && metering.throttle.hits > 0 && (
          <>
            <Icon name="throttled" size={12} className="session-metering__thr" /> {formatInteger(metering.throttle.hits)}{' '}
            plan-limit {metering.throttle.hits === 1 ? 'hit' : 'hits'} ({formatAge(metering.throttle.idleMs)} idle
            {metering.throttle.throttledNow ? ', throttled now' : ''}).{' '}
          </>
        )}
        Notional API-equivalent cost on a Max plan: decision support, not a bill.
        {rateCard?.active && (
          <>
            {' '}
            Rate card v{rateCard.active.version} per MTok
            {rates.map((r) => (
              <span key={r.model}>
                {' · '}
                {modelLabel(r.model)} ${formatNumber(r.inputPerMTok, 2)} in, ${formatNumber(r.outputPerMTok, 2)} out, $
                {formatNumber(r.cacheReadPerMTok, 2)} cache read
              </span>
            ))}
            . Rate changes apply forward only.
          </>
        )}
        {fxRate && (
          <>
            {' '}
            FX {formatNumber(fxRate.rate, 4)} (BNM, {fxRate.status === 'live' ? 'live' : `carried from ${fxRate.sourceDate}`}).
          </>
        )}
      </p>
    </div>
  );
}
