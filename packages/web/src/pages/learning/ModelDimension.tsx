import { Link } from 'react-router-dom';
import type { ModelDimensionClassDTO, TierStatDTO } from '@aoc/contracts';
import { Badge, Icon, formatInteger } from '../../components';
import { TIER_LABEL, VERDICT_META, verdictDetail } from './model';

function TierTable({ tiers, caption }: { tiers: readonly TierStatDTO[]; caption: string }) {
  return (
    <table className="learning-tiers">
      <caption className="aoc-sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Model tier</th>
          <th scope="col" className="is-end">
            Occurrences
          </th>
          <th scope="col" className="is-end">
            Metered runs
          </th>
        </tr>
      </thead>
      <tbody>
        {tiers.map((t) => (
          <tr key={t.tier} className={t.occurrences > 0 ? 'is-hit' : undefined}>
            <th scope="row">{TIER_LABEL[t.tier]}</th>
            <td className="is-end aoc-num">{formatInteger(t.occurrences)}</td>
            <td className="is-end aoc-num">{formatInteger(t.runs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface ModelVerdictProps {
  cls: ModelDimensionClassDTO;
  minRunsPerTier: number;
  /** Adds the per-process-type breakdown (drawer). */
  detailed?: boolean;
}

/**
 * The model tested as a root-cause dimension (§11). "Model capability" — and the targeted per-process-type
 * upgrade it implies — appears only when the class recurs on the cheaper tier but not the stronger one.
 */
export function ModelVerdict({ cls, minRunsPerTier, detailed }: ModelVerdictProps) {
  const meta = VERDICT_META[cls.verdict];
  const upgrades =
    cls.verdict === 'model_capability'
      ? cls.byProcessType.filter((p) => p.verdict === 'model_capability' && p.cheaperTier && p.strongerTier)
      : [];
  return (
    <div className="learning-verdict">
      <div className="learning-verdict__head">
        <Badge tone={meta.tone} icon={meta.icon}>
          {meta.label}
        </Badge>
      </div>
      <p className="learning-verdict__detail">{verdictDetail(cls.verdict, minRunsPerTier)}</p>
      {upgrades.map((p) => (
        <p key={p.processType} className="learning-verdict__upgrade">
          <Icon name="arrow-up" size={14} />
          <span>
            Targeted upgrade for <strong>{p.processType}</strong> only: {TIER_LABEL[p.cheaperTier!]} →{' '}
            {TIER_LABEL[p.strongerTier!]}, not a blanket upgrade. <Link to="/registry">Model routing</Link>
          </span>
        </p>
      ))}
      <TierTable tiers={cls.byTier} caption={`${cls.name}: occurrences and metered runs by model tier`} />
      {detailed && cls.byProcessType.length > 0 && (
        <table className="learning-ptable">
          <caption className="aoc-sr-only">{`${cls.name}: model test per process type`}</caption>
          <thead>
            <tr>
              <th scope="col">Process type</th>
              <th scope="col">Occurrences / runs by tier</th>
              <th scope="col">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {cls.byProcessType.map((p) => (
              <tr key={p.processType}>
                <th scope="row">{p.processType}</th>
                <td className="aoc-num">
                  {p.tiers
                    .map((t) => `${TIER_LABEL[t.tier]} ${formatInteger(t.occurrences)}/${formatInteger(t.runs)}`)
                    .join(' · ')}
                </td>
                <td>{VERDICT_META[p.verdict].label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export interface ModelDimensionListProps {
  classes: readonly ModelDimensionClassDTO[];
  minRunsPerTier: number;
  onOpen?: (classId: string) => void;
}

/** One card per repeat class: name, verdict and occurrences by tier. Model-capability findings come first. */
export function ModelDimensionList({ classes, minRunsPerTier, onOpen }: ModelDimensionListProps) {
  return (
    <ul className="learning-model">
      {classes.map((c) => (
        <li key={c.classId} className="learning-model__card">
          {onOpen ? (
            <button type="button" className="learning-model__name aoc-link-button" onClick={() => onOpen(c.classId)}>
              {c.name}
            </button>
          ) : (
            <span className="learning-model__name">{c.name}</span>
          )}
          <ModelVerdict cls={c} minRunsPerTier={minRunsPerTier} />
        </li>
      ))}
    </ul>
  );
}
