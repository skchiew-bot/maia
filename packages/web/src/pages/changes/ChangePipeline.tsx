import type { ChangeStatus } from '@aoc/contracts';
import { Icon } from '../../components/Icon';
import { cx } from '../../lib/dom';
import { formatAge, formatInteger } from '../../lib/format';
import { STATUS_META, pipelineBottleneck, type PipelineStage } from './model';

export interface ChangePipelineProps {
  stages: readonly PipelineStage[];
  /** Stage the list below is filtered to (null = no stage filter). */
  selected: ChangeStatus | null;
  onSelect: (status: ChangeStatus | null) => void;
}

function ageLine(s: PipelineStage): string {
  if (s.count === 0) return s.terminal ? 'none yet' : 'empty';
  if (s.terminal) return s.medianAgeMs !== undefined ? `median lead ${formatAge(s.medianAgeMs)}` : '';
  const parts: string[] = [];
  if (s.oldestAgeMs !== undefined) parts.push(`oldest ${formatAge(s.oldestAgeMs)}`);
  if (s.medianAgeMs !== undefined && s.count > 1) parts.push(`median ${formatAge(s.medianAgeMs)}`);
  return parts.join(' · ');
}

/**
 * The change pipeline (§8): drafting → awaiting approval → approved → in progress → completed, plus the
 * rejected end. Each stage prints its count and how long work has waited there; the stage holding the most
 * waiting time is flagged in words. Stages are filter buttons for the list below.
 */
export function ChangePipeline({ stages, selected, onSelect }: ChangePipelineProps) {
  const bottleneck = pipelineBottleneck(stages);
  const openMax = Math.max(1, ...stages.filter((s) => !s.terminal).map((s) => s.count));
  return (
    <ol className="changes-pipeline" aria-label="Change pipeline">
      {stages.map((s) => {
        const pressed = selected === s.status;
        const meta = STATUS_META[s.status];
        const isBottleneck = s.status === bottleneck;
        return (
          <li
            key={s.status}
            className={cx(
              'changes-pipeline__stage',
              s.terminal && 'is-terminal',
              isBottleneck && 'is-bottleneck',
              pressed && 'is-selected',
            )}
          >
            <button
              type="button"
              className="changes-pipeline__button"
              aria-pressed={pressed}
              onClick={() => onSelect(pressed ? null : s.status)}
            >
              <span className="changes-pipeline__name">
                <Icon name={meta.icon} size={12} />
                {s.label}
              </span>
              <span className="changes-pipeline__count">
                <strong className="aoc-num">{formatInteger(s.count)}</strong>
                <span className="changes-pipeline__unit">{s.count === 1 ? 'record' : 'records'}</span>
              </span>
              {!s.terminal && (
                <span className="changes-pipeline__bar" aria-hidden="true">
                  <span style={{ width: `${(s.count / openMax) * 100}%` }} />
                </span>
              )}
              <span className="changes-pipeline__age aoc-num">{ageLine(s)}</span>
              {isBottleneck && (
                <span className="changes-pipeline__flag">
                  <Icon name="warn" size={12} /> Work waits here
                </span>
              )}
              <span className="aoc-sr-only">{pressed ? ', filtering the list' : ', show in the list'}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
