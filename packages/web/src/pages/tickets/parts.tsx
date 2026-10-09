import type { Severity, TicketStage } from '@aoc/contracts';
import { Icon, type IconName } from '../../components/Icon';
import { SEVERITY_META } from '../../components/RankedList';
import { cx } from '../../lib/dom';
import { formatPercent } from '../../lib/format';
import { GATE_WORD, STAGE_LABEL, type GateState, type Gates } from './model';

/** Severity as icon + word (never colour alone). */
export function SeverityTag({ severity }: { severity: Severity }) {
  const meta = SEVERITY_META[severity];
  return (
    <span className={cx('tkt-sev', `tkt-sev--${severity}`)}>
      <Icon name={meta.icon} size={12} />
      {meta.word}
    </span>
  );
}

export function StageTag({ stage }: { stage: TicketStage }) {
  return <span className={cx('tkt-stage', `tkt-stage--${stage}`)}>{STAGE_LABEL[stage]}</span>;
}

const GATE_ICON: Record<GateState, IconName> = {
  passed: 'ok',
  waiting: 'decisions',
  blocked: 'warn',
  failed: 'danger',
  not_reached: 'dot',
  skipped: 'minus',
};

/** The two human gates and the requester's UAT sign-off, each as an icon and a word. */
export function GateTrail({ gates, compact }: { gates: Gates; compact?: boolean }) {
  const items: [string, GateState][] = [
    ['Fix plan', gates.fixPlan],
    ['UAT', gates.uat],
    ['Go-live', gates.goLive],
  ];
  return (
    <ul className={cx('tkt-gates', compact && 'tkt-gates--compact')} aria-label="Gates">
      {items.map(([label, state]) => (
        <li
          key={label}
          className={cx('tkt-gate', `tkt-gate--${state}`)}
          title={`${label}: ${GATE_WORD[state]}`}
        >
          <Icon name={GATE_ICON[state]} size={12} />
          <span>{label}</span>
          <span className={compact ? 'aoc-sr-only' : 'tkt-gate__word'}>
            {compact ? `: ${GATE_WORD[state]}` : GATE_WORD[state]}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Root-cause confidence as a neutral bar plus the number (higher is better, so no warning colours). */
export function ConfidenceBar({ value, label }: { value: number; label: string }) {
  return (
    <span className="tkt-conf" role="img" aria-label={`${label}: ${formatPercent(value)}`}>
      <span className="tkt-conf__track" aria-hidden="true">
        <span className="tkt-conf__fill" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
      </span>
      <span className="tkt-conf__num aoc-num" aria-hidden="true">
        {formatPercent(value)}
      </span>
    </span>
  );
}
