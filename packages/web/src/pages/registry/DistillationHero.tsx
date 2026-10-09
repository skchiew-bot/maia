import { Link } from 'react-router-dom';
import type { ModelDimensionReportDTO, PlaybookDTO, RegistryEntry, RegistryRunDTO } from '@aoc/contracts';
import { Icon, RelativeTime } from '../../components';
import { cx } from '../../lib/dom';
import { formatDuration, formatInteger, formatMyr, formatPercent, formatShortDate, formatTokens, formatUsd } from '../../lib/format';
import { CostAxis, CostPair } from './CostPair';
import {
  executionCost,
  heroRowKind,
  heroSummary,
  modelLabel,
  modelSignal,
  niceScale,
  savingRatio,
  trendView,
  unpricedRuns,
  weekLabel,
} from './registryModel';
import { WeeklyTrend, type TrendMarker } from './WeeklyTrend';

export interface DistillationHeroProps {
  entries: readonly RegistryEntry[];
  playbooks: readonly PlaybookDTO[];
  runs: readonly RegistryRunDTO[];
  modelReport?: ModelDimensionReportDTO;
  /** Resolves a user id to a display name when the viewer may see the directory. */
  nameOf: (userId: string | null) => string | null;
}

/** Monday (YYYY-MM-DD) of the trend week holding `iso`, if it is inside the window. */
function weekOf(iso: string | null, weeks: readonly string[]): string | null {
  if (!iso) return null;
  const day = iso.slice(0, 10);
  for (let i = weeks.length - 1; i >= 0; i -= 1) if (day >= weeks[i]!) return weeks[i]!;
  return null;
}

function markersFor(e: RegistryEntry, playbooks: readonly PlaybookDTO[]): TrendMarker[] {
  const weeks = e.trend.map((p) => p.weekStart);
  const out: TrendMarker[] = [];
  for (const p of playbooks) {
    if (p.processType !== e.processType) continue;
    const approved = weekOf(p.approvedAt, weeks);
    if (approved) out.push({ weekStart: approved, kind: 'approved', label: `Playbook v${p.version} approved ${weekLabel(approved)}` });
    const retired = weekOf(p.retiredAt, weeks);
    if (retired) out.push({ weekStart: retired, kind: 'retired', label: `Playbook v${p.version} retired ${weekLabel(retired)}` });
  }
  return out;
}

function PlaybookLine({ e, playbooks, nameOf }: { e: RegistryEntry; playbooks: readonly PlaybookDTO[]; nameOf: DistillationHeroProps['nameOf'] }) {
  const mine = playbooks.filter((p) => p.processType === e.processType);
  if (e.playbook.status === 'approved') {
    const active = mine.find((p) => p.playbookId === e.playbook.activePlaybookId);
    return (
      <>
        <span className="reg-pb reg-pb--approved">
          <Icon name="ok" size={12} />
          Approved by {nameOf(active?.approvedBy ?? null) ?? 'the Approver'}
        </span>
        <span className="reg-sub">
          Playbook v{e.playbook.activeVersion} · {e.playbook.approvedAt ? formatShortDate(e.playbook.approvedAt) : '—'}
        </span>
      </>
    );
  }
  if (e.playbook.status === 'proposed') {
    const pending = mine.find((p) => p.playbookId === e.playbook.pendingPlaybookId);
    return (
      <>
        <span className="reg-pb reg-pb--proposed">
          <Icon name="clock" size={12} />
          Proposed · awaiting the Approver
        </span>
        <span className="reg-sub">
          Playbook v{pending?.version ?? e.playbook.versions}
          {pending && (
            <>
              {' '}
              · waiting <RelativeTime value={pending.proposedAt} />
            </>
          )}
        </span>
      </>
    );
  }
  const retired = mine.filter((p) => p.status === 'retired').sort((a, b) => (a.retiredAt ?? '') < (b.retiredAt ?? '') ? 1 : -1)[0];
  if (retired)
    return (
      <>
        <span className="reg-pb reg-pb--retired">
          <Icon name="retired" size={12} />
          Retired
        </span>
        <span className="reg-sub">
          Playbook v{retired.version} · {retired.retiredAt ? formatShortDate(retired.retiredAt) : '—'}
          {retired.retireReason ? ` · ${retired.retireReason.replace(/_/g, ' ')}` : ''}
        </span>
      </>
    );
  return <span className="reg-pb reg-pb--none">No playbook yet</span>;
}

function Facts({ e, modelReport, unpriced }: { e: RegistryEntry; modelReport?: ModelDimensionReportDTO; unpriced: number }) {
  const signal = modelSignal(modelReport, e.processType);
  const finished = e.discovery.runs + e.execution.runs;
  return (
    <ul className="reg-facts">
      <li>
        <b className="aoc-num">{formatInteger(finished)}</b> finished run{finished === 1 ? '' : 's'}{' '}
        <span className="reg-facts__sub">
          {e.discovery.runs} disc · {e.execution.runs} exec
        </span>
      </li>
      {e.activeRuns > 0 && (
        <li>
          <b className="aoc-num">{e.activeRuns}</b> running now
        </li>
      )}
      {e.lessonsInScope !== null && (
        <li>
          <b className="aoc-num">{e.lessonsInScope}</b> lesson{e.lessonsInScope === 1 ? '' : 's'} in scope
        </li>
      )}
      {signal.modelCapability.length > 0 ? (
        <li className="reg-facts__warn">
          <Icon name="warn" size={12} />
          <Link to="/learning">
            Model capability on {modelLabel(signal.modelCapability[0]!.cheaperTier)}: targeted upgrade
          </Link>
        </li>
      ) : (
        signal.recurring > 0 && (
          <li>
            <Link to="/learning">
              <b className="aoc-num">{signal.recurring}</b> recurring root cause{signal.recurring === 1 ? '' : 's'}
            </Link>{' '}
            <span className="reg-facts__sub">
              {signal.specContextTooling > 0 ? `${signal.specContextTooling} not the model` : ''}
              {signal.specContextTooling > 0 && signal.inconclusive > 0 ? ' · ' : ''}
              {signal.inconclusive > 0 ? `${signal.inconclusive} untested` : ''}
            </span>
          </li>
        )
      )}
      {unpriced > 0 && (
        <li className="reg-facts__warn">
          <Icon name="warn" size={12} />
          <Link to="/metering#rate-card">
            {unpriced} run{unpriced === 1 ? '' : 's'} unpriced (US$0)
          </Link>
        </li>
      )}
    </ul>
  );
}

function Saving({ e }: { e: RegistryEntry }) {
  const exec = executionCost(e);
  const ratio = savingRatio(e);
  if (exec.basis === 'none' || ratio === null)
    return (
      <div className="reg-save reg-save--none">
        <b>—</b>
        <span className="reg-sub">
          {e.class === 'discovery' ? `Stays on ${modelLabel(e.model)} by design` : 'No execution model'}
        </span>
      </div>
    );
  const worse = ratio < 0;
  return (
    <div className={cx('reg-save', worse && 'is-worse')}>
      <b className="aoc-num">{formatPercent(Math.abs(ratio))}</b>
      <span className="reg-sub">{worse ? 'more per run' : 'less per run'}</span>
      <span className="reg-save__basis">{exec.basis === 'projected' ? 'projected' : 'measured'}</span>
    </div>
  );
}

/** First-load placeholder with the hero's frame and row rhythm, so nothing jumps when data lands (static). */
export function HeroSkeleton() {
  return (
    <section className="reg-hero reg-hero--skeleton" aria-busy="true" aria-labelledby="reg-hero-sk">
      <div className="reg-hero__head">
        <div className="reg-hero__fig">
          <h2 id="reg-hero-sk" className="reg-eyebrow">
            Distillation business case · notional
          </h2>
          <p className="reg-sk reg-sk--fig" />
          <p className="reg-sk reg-sk--line" />
          <p className="reg-sk reg-sk--line reg-sk--short" />
        </div>
      </div>
      <div className="reg-sk-rows" role="status">
        <span className="aoc-sr-only">Loading registry economics…</span>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="reg-sk-row">
            <span className="reg-sk reg-sk--name" />
            <span className="reg-sk reg-sk--bar" />
            <span className="reg-sk reg-sk--cell" />
            <span className="reg-sk reg-sk--cell" />
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Registry hero (§12): the distillation business case — discovery vs execution cost per run on one scale,
 * the saving, an 8-week trend per process type, and the headline saving in notional USD and RM.
 */
export function DistillationHero({ entries, playbooks, runs, modelReport, nameOf }: DistillationHeroProps) {
  const summary = heroSummary(entries);
  const rows = entries.filter((e) => heroRowKind(e) !== 'idle');
  const idle = entries.filter((e) => heroRowKind(e) === 'idle');
  const scale = niceScale(
    Math.max(0, ...rows.flatMap((e) => [e.discovery.avgCostUsd ?? 0, executionCost(e).usd ?? 0])),
  );
  const unpriced = unpricedRuns(runs);
  const unpricedBy = (t: string) => unpriced.filter((r) => r.processType === t).length;
  const weeks = entries[0]?.trend ?? [];
  const realized = summary.executionRuns > 0;
  const awaitingFirstRun = entries.filter((e) => e.playbook.status === 'approved' && e.execution.runs === 0);

  const figure = realized
    ? { usd: summary.realizedUsd, rm: summary.realizedRm }
    : { usd: summary.opportunityUsd, rm: summary.opportunityRm };

  return (
    <section className="reg-hero" aria-labelledby="reg-hero-h">
      <div className="reg-hero__head">
        <div className="reg-hero__fig">
          <h2 id="reg-hero-h" className="reg-eyebrow">
            Distillation business case · notional
          </h2>
          <p className="reg-hero__figure">
            <span className="reg-hero__usd">{formatUsd(figure.usd)}</span>
            {figure.rm !== null && <span className="reg-hero__rm">{formatMyr(figure.rm)}</span>}
          </p>
          {realized ? (
            <p className="reg-hero__copy">
              saved to date by <b>{formatInteger(summary.executionRuns)} execution runs</b> on distilled playbooks
              instead of discovery runs
              {summary.weightedSaving !== null && (
                <>
                  . Execution costs <b>{formatPercent(summary.weightedSaving)} less per run</b>, weighted by runs
                </>
              )}
              . Ringgit is the sum of each run day&rsquo;s BNM rate.
              {summary.opportunityUsd > summary.realizedUsd && (
                <> At recent volume, playbooks are worth {formatUsd(summary.opportunityUsd)} across {summary.opportunityTypes} process types.</>
              )}
            </p>
          ) : (
            <p className="reg-hero__copy">
              is what distilled playbooks would save at recent volume:{' '}
              <b>
                {formatInteger(summary.opportunityRuns)} finished run{summary.opportunityRuns === 1 ? '' : 's'} in 8
                weeks
              </b>{' '}
              across {summary.opportunityTypes} process types, run on their execution model instead of discovery
              {summary.weightedSaving !== null && (
                <>
                  {' '}
                  — <b>{formatPercent(summary.weightedSaving)} less per run</b>, weighted by runs
                </>
              )}
              . Projected from rate-card prices until execution runs are measured; ringgit is the sum of each run
              day&rsquo;s BNM rate.
            </p>
          )}
          <p className="reg-hero__note">
            {realized ? (
              <>
                {summary.tokensSaved !== null && (
                  <>
                    <b className="aoc-num">{formatTokens(summary.tokensSaved)}</b> tokens and{' '}
                  </>
                )}
                {summary.timeSavedMs !== null && (
                  <>
                    <b className="aoc-num">{formatDuration(summary.timeSavedMs)}</b> of run time saved ·{' '}
                  </>
                )}
                {summary.opportunityTypes} types with an execution path
              </>
            ) : (
              <>
                <Icon name="info" size={12} /> Saved to date: <b className="aoc-num">{formatUsd(0)}</b> — no
                execution run has finished yet.
                {awaitingFirstRun.length > 0 && (
                  <>
                    {' '}
                    Approved playbooks route the next{' '}
                    {awaitingFirstRun.map((e, i) => (
                      <span key={e.processType}>
                        {i > 0 ? (i === awaitingFirstRun.length - 1 ? ' and ' : ', ') : ''}
                        {e.name} runs to {modelLabel(e.currentModel)}
                      </span>
                    ))}
                    .
                  </>
                )}
              </>
            )}
          </p>
        </div>
        <ul className="reg-legend" aria-label="Chart legend">
          <li>
            <span className="reg-sw reg-sw--disc" aria-hidden="true" />
            Discovery $/run
          </li>
          <li>
            <span className="reg-sw reg-sw--exec" aria-hidden="true" />
            Execution $/run · measured
          </li>
          <li>
            <span className="reg-sw reg-sw--proj" aria-hidden="true" />
            Execution $/run · projected
          </li>
          <li>
            <span className="reg-lg-line" aria-hidden="true" />
            Blended $/run, weekly
          </li>
        </ul>
      </div>

      {rows.length === 0 ? (
        <p className="reg-hero__empty">
          No finished runs yet. The business case appears once runs launched with <code>aoc run --type</code>{' '}
          finish.
        </p>
      ) : (
        <div className="reg-ptab-wrap">
          <table className="reg-ptab" role="table">
            <caption className="aoc-sr-only">
              Cost per run, discovery versus execution, by process type, with the saving and the 8-week trend
            </caption>
            <thead role="rowgroup">
              <tr role="row">
                <th scope="col" role="columnheader" className="reg-ptab__c1">
                  Process type · playbook
                </th>
                <th scope="col" role="columnheader" className="reg-ptab__bars">
                  <span className="aoc-sr-only">Cost per run in US dollars, discovery and execution</span>
                  <CostAxis ticks={scale.ticks} max={scale.max} />
                </th>
                <th scope="col" role="columnheader" className="reg-ptab__save">
                  Saving
                </th>
                <th scope="col" role="columnheader" className="reg-ptab__trend">
                  Cost per run, {weeks[0] ? weekLabel(weeks[0].weekStart) : ''}–
                  {weeks.length ? weekLabel(weeks[weeks.length - 1]!.weekStart) : ''}
                </th>
                <th scope="col" role="columnheader" className="reg-ptab__facts">
                  Runs and quality
                </th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {rows.map((e) => (
                <tr key={e.processType} role="row">
                  <th scope="row" role="rowheader" className="reg-ptab__c1">
                    <span className="reg-ptab__name">
                      {e.name}
                      {e.readOnly && (
                        <span className="reg-chip">
                          <Icon name="eye" size={12} />
                          read-only
                        </span>
                      )}
                      {e.risky && <span className="reg-chip">risky</span>}
                    </span>
                    <code className="reg-ptab__id">{e.processType}</code>
                    <PlaybookLine e={e} playbooks={playbooks} nameOf={nameOf} />
                  </th>
                  <td role="cell" className="reg-ptab__bars" data-label="Cost per run">
                    <CostPair
                      name={e.name}
                      discoveryUsd={e.discovery.avgCostUsd ?? 0}
                      discoveryModel={e.model}
                      execution={executionCost(e)}
                      scaleMax={scale.max}
                    />
                  </td>
                  <td role="cell" className="reg-ptab__save" data-label="Saving">
                    <Saving e={e} />
                  </td>
                  <td role="cell" className="reg-ptab__trend" data-label="8-week trend">
                    <WeeklyTrend name={e.name} view={trendView(e.trend)} markers={markersFor(e, playbooks)} />
                  </td>
                  <td role="cell" className="reg-ptab__facts" data-label="Runs and quality">
                    <Facts e={e} modelReport={modelReport} unpriced={unpricedBy(e.processType)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {idle.length > 0 && (
        <details className="reg-idle">
          <summary>
            {idle.length} process type{idle.length === 1 ? '' : 's'} with no finished run yet
          </summary>
          <ul>
            {idle.map((e) => (
              <li key={e.processType}>
                <b>{e.name}</b> <code>{e.processType}</code> · launches on {modelLabel(e.currentModel)}
                {e.activeRuns > 0 ? ` · ${e.activeRuns} running now` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
      {unpriced.length > 0 && (
        <p className="reg-hero__warn">
          <Icon name="warn" size={12} />
          <span>
            {unpriced.length} finished run{unpriced.length === 1 ? ' is' : 's are'} counted at US$0 because no rate
            card priced {unpriced.length === 1 ? 'its' : 'their'} model on the day (closed days are never restated),
            which lowers the discovery averages.{' '}
            <Link to="/metering#rate-card">Review the rate card</Link>
          </span>
        </p>
      )}
    </section>
  );
}
