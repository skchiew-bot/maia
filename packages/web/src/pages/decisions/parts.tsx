import type { ReactNode } from 'react';
import type { DecisionCardView } from '@aoc/contracts';
import { Icon } from '../../components/Icon';
import { cx } from '../../lib/dom';
import { formatAge } from '../../lib/format';
import { AGING_META, KIND_LABEL, TEST_LABEL, agingPhrase, type Aging } from './model';

/** Aging state as colour + icon + words ("Over SLA by 1h 14m"); text follows the minute clock. */
export function AgingBadge({ aging, className }: { aging: Aging; className?: string }) {
  const meta = AGING_META[aging.state];
  return (
    <span className={cx('dec-aging', `aoc-tone--${meta.tone}`, `dec-aging--${aging.state}`, className)}>
      <Icon name={meta.icon} size={12} />
      <span>{agingPhrase(aging)}</span>
    </span>
  );
}

/** Kinds that are approver-only policy gates with no decision test (mock legend: dashed `policy` chip). */
const POLICY_KINDS: ReadonlySet<DecisionCardView['kind']> = new Set([
  'credit_topup',
  'lesson_binding',
  'playbook_approval',
  'fx_discrepancy',
  'erasure_request',
]);

/** Kind word, the decision test or policy chip, and the passkey marker — the card's identity line. */
export function KindLine({ card, children }: { card: DecisionCardView; children?: ReactNode }) {
  return (
    <div className="dec-kindline">
      <span className="dec-kindline__kind">{KIND_LABEL[card.kind]}</span>
      {card.test && (
        <span className="dec-chip dec-chip--test" title={TEST_LABEL[card.test]}>
          <span className="dec-chip__k">test</span>
          {card.test}
        </span>
      )}
      {!card.test && POLICY_KINDS.has(card.kind) && (
        <span className="dec-chip dec-chip--policy" title="Approver-only gate with no decision test">
          policy
        </span>
      )}
      {card.requiresPasskey && (
        <span className="dec-kindline__pk" title="Must be signed with a passkey (WebAuthn)">
          <Icon name="key" size={12} />
          Passkey
        </span>
      )}
      {children}
    </div>
  );
}

const SCALE = 2;

/**
 * Bullet bar of time waited against the allowed time, on one shared scale: the SLA line sits at the middle of
 * every bar and the track ends at 2× SLA (beyond that the bar is clipped and says so). Geometry comes from the
 * last fetched snapshot (`snapshotAgeMs`), so it only moves when a decision event refetched the list.
 */
export function SlaBar({
  aging,
  snapshotAgeMs,
  label,
}: {
  aging: Aging;
  snapshotAgeMs: number;
  /** Accessible summary, e.g. "Waited 2h 14m of a 1h SLA". */
  label: string;
}) {
  if (aging.allowedMs === null) {
    return (
      <p className="dec-sla dec-sla--none">
        <span>No SLA agreed for this kind · waiting {formatAge(aging.ageMs)}</span>
      </p>
    );
  }
  const allowed = aging.allowedMs;
  const ratio = snapshotAgeMs / allowed;
  const clipped = ratio > SCALE;
  const width = (Math.min(ratio, SCALE) / SCALE) * 100;
  const tone = ratio > 1 ? 'over' : ratio >= 0.75 ? 'due_soon' : 'within';
  return (
    <div className="dec-sla" role="img" aria-label={label}>
      <span className="dec-sla__track" aria-hidden="true">
        <span className={cx('dec-sla__fill', `dec-sla__fill--${tone}`)} style={{ width: `${width}%` }} />
        <span className="dec-sla__rule" />
        {clipped && <span className="dec-sla__clip">›</span>}
      </span>
      <span className="dec-sla__text aoc-num" aria-hidden="true">
        {formatAge(aging.ageMs)} <span className="dec-sla__of">of {formatAge(allowed)}</span>
      </span>
    </div>
  );
}
